import { error, isHttpError } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { dedupeRolling, isValidLang, parseJson3, parseSubtitles, type Cue } from '$lib/captions';
import {
	AUDIO_TAGS,
	DEFAULT_OPTIONS,
	DEFAULT_SETTINGS,
	formatEntry,
	hostOf,
	isFinished,
	isRunning,
	SUBTITLE_LANG,
	SUBTITLE_MODES,
	typeEntry,
	type AddingState,
	type Choice,
	type DownloadType,
	type DownloadEvent,
	type DownloadFile,
	type DownloadItem,
	type DownloadOptions,
	type DownloadProgress,
	type DownloadSettings,
	type ProbeEntry,
	type ProbeInfo,
	type ProbeSelection,
	type Subscription,
	type YtdlpStatus,
} from '$lib/downloads';
import { AUDIO_EXTS, VIDEO_EXTS } from '$lib/media';
import { deleteTrack, saveTrack } from './captions.js';
import { runFfmpeg } from './ffmpeg.js';
import { probeFile } from './probe.js';
import { CACHE_DIR, createBin, DATA_DIR, getBin, isInside, isValidBinName, MEDIA_ROOT, sanitizeFileName } from './paths.js';
import {
	cachedYtdlpStatus,
	downloadJob,
	installYtdlp,
	liveWorkers,
	probeParams,
	runOnce,
	setYtdlpFlags,
	spawnWorker,
	YtdlpMissing,
	ytdlpStatus,
	type Worker,
	type WorkerEvent,
} from './ytdlp.js';

/**
 * The download manager — WaveWeaver's take on MeTube's DownloadQueue.
 *
 * You give it a link; it asks yt-dlp what the link is (a video, a playlist,
 * a channel), turns that into one row per video, and runs them a few at a
 * time. Each download writes into its own work folder under
 * media/.cache/downloads/<id>/ and is filed into a bin only when it has
 * finished, so a bin never holds half a file:
 *
 *   media/<bin>/sources/    the video or audio — shows up in the Library
 *   media/<bin>/captions/   caption files you downloaded on their own, and
 *                           the editable tracks of "captions alongside"
 *   media/<bin>/extras/     thumbnails and anything else yt-dlp wrote
 *
 * State is plain JSON in media/.downloads/ (queue, subscriptions, settings),
 * so the queue survives a restart: a download that was running picks up where
 * its .part file left off.
 *
 * cookies.txt is a login, so it stays out of the media folder, which is often
 * Documents and often synced. The desktop app keeps it in %LOCALAPPDATA%.
 */

const STATE_DIR = join(MEDIA_ROOT, '.downloads');
const WORK_ROOT = join(CACHE_DIR, 'downloads');
const QUEUE_FILE = join(STATE_DIR, 'queue.json');
const SUBS_FILE = join(STATE_DIR, 'subscriptions.json');
const SETTINGS_FILE = join(STATE_DIR, 'settings.json');
export const COOKIES_FILE = join(DATA_DIR, 'cookies.txt');
const OLD_COOKIES_FILE = join(STATE_DIR, 'cookies.txt');

const MAX_LOG_LINES = 400;
const MAX_SEEN = 5000;
const TICK_MS = 30_000;

const SUBTITLE_EXTS = new Set(['.vtt', '.srt', '.json3', '.srv1', '.srv2', '.srv3', '.ttml', '.sbv', '.scc', '.dfxp', '.ass', '.lrc', '.txt']);
const PARTIAL = /\.(part|ytdl|temp)$|\.part-Frag\d+|\.f\d+\.\w+\.part$/i;

/** Postprocessor keys (yt-dlp's pp_key) → what the row says while it runs. */
const PP_LABELS: Record<string, string> = {
	Merger: 'merging',
	ExtractAudio: 'extracting audio',
	VideoRemuxer: 'remuxing',
	VideoConvertor: 'converting',
	Metadata: 'tagging',
	EmbedThumbnail: 'adding cover',
	ThumbnailsConvertor: 'converting cover',
	SubtitlesConvertor: 'converting captions',
	SplitChapters: 'splitting chapters',
	SponsorBlock: 'finding sponsors',
	ModifyChapters: 'cutting sponsors',
	FixupM3u8: 'fixing up',
	FixupM4a: 'fixing up',
	FixupStretched: 'fixing up',
	FixupDuplicateMoov: 'fixing up',
	FixupTimestamp: 'fixing up',
	FixupDuration: 'fixing up',
	MoveFiles: 'finishing',
};

const EMPTY_PROGRESS: DownloadProgress = { phase: null, ratio: null, downloaded: null, total: null, speed: null, eta: null, fragment: null };

/** Server-side extras on a row: never sent to the page, never written to disk. */
interface Item extends DownloadItem {
	password?: string | null;
}

interface SubRecord extends Omit<Subscription, 'seenCount' | 'checking'> {
	seen: string[];
}

interface Run {
	worker: Worker | null;
	/** Why we're ending it: drop the row, keep it for later, or finish a live recording. */
	stop: 'cancel' | 'pause' | 'keep' | 'reload' | null;
	/** The clip, cut here after a full download — or downloaded as a range by yt-dlp. */
	cut: [number, number | null] | null;
	ranged: [number, number | null] | null;
	main: string | null;
	workdir: string;
	/** A live recording reports no progress (ffmpeg does it); watch the file grow instead. */
	meter: ReturnType<typeof setInterval> | null;
	roles: Map<string, DownloadFile['role']>;
	terminal: 'done' | 'stopped' | 'error' | null;
	error: string | null;
	stderr: string[];
}

interface FeedContext {
	kind: 'playlist' | 'channel';
	title: string;
	id: string | null;
	index: number;
	count: number;
}

export interface AddResult {
	added: number;
	skipped: string[];
	errors: string[];
}

export class DownloadError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

const newId = () => randomBytes(5).toString('hex');

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/* --------------------------------------------------------------------------
 * Small file helpers
 * -------------------------------------------------------------------------- */

async function readJson<T>(path: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(path, 'utf8')) as T;
	} catch {
		return null;
	}
}

function writeJsonSync(path: string, value: unknown) {
	mkdirSync(STATE_DIR, { recursive: true });
	const tmp = `${path}.${newId()}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 1));
	renameSync(tmp, path);
}

async function writeJson(path: string, value: unknown) {
	await mkdir(STATE_DIR, { recursive: true });
	const tmp = `${path}.${newId()}.tmp`;
	await writeFile(tmp, JSON.stringify(value, null, 1));
	await rename(tmp, path);
}

async function walk(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(abs)));
		else if (entry.isFile() && !PARTIAL.test(entry.name)) out.push(abs);
	}
	return out;
}

/** Names handed out but not yet on disk, so two downloads finishing together can't collide. */
const reserved = new Set<string>();

/** `name.ext`, or `name (2).ext` if that's taken. Downloads never overwrite. */
async function freePath(dir: string, fileName: string): Promise<string> {
	await mkdir(dir, { recursive: true });
	const ext = extname(fileName);
	const stem = fileName.slice(0, fileName.length - ext.length);
	for (let n = 1; ; n++) {
		const path = join(dir, n === 1 ? fileName : `${stem} (${n})${ext}`);
		if (reserved.has(path) || (await stat(path).catch(() => null))) continue;
		reserved.add(path);
		setTimeout(() => reserved.delete(path), 60_000).unref();
		return path;
	}
}

async function moveFile(from: string, to: string) {
	try {
		await rename(from, to);
	} catch {
		// Another volume (a junction under media/): copy, then remove.
		await copyFile(from, to);
		await rm(from, { force: true });
	}
}

/** A playlist or channel title → a bin name the filesystem and isValidBinName accept. */
function binNameFrom(title: string): string {
	const name = title
		.normalize('NFKC')
		.replace(/[^\p{L}\p{N} ._-]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.replace(/^[^\p{L}\p{N}]+/u, '')
		.slice(0, 60)
		.replace(/[ .]+$/, '');
	return isValidBinName(name) ? name : '';
}

function cleanForName(value: string): string {
	return value.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').trim();
}

/**
 * Fill a playlist's own fields into an output template now: each item is
 * later downloaded on its own, where yt-dlp no longer knows the playlist.
 * Everything else (`%(title)s`, `%(ext)s`…) is left for yt-dlp.
 */
function fillFeedFields(template: string, ctx: FeedContext): string {
	const padded = String(ctx.index).padStart(String(ctx.count).length, '0');
	return template.replace(
		/%\((playlist_index|playlist_autonumber|playlist_title|playlist|playlist_id|playlist_count|channel_index|n_entries)\)(0?\d*)([sd])/g,
		(_m, field: string, width: string, conv: string) => {
			let value: string | number;
			if (field === 'playlist_title' || field === 'playlist') value = cleanForName(ctx.title);
			else if (field === 'playlist_id') value = cleanForName(ctx.id ?? ctx.title);
			else if (field === 'playlist_count' || field === 'n_entries') value = ctx.count;
			else value = conv === 's' && !width ? padded : ctx.index;
			if (conv === 'd') return String(value).padStart(Number(width) || 0, width.startsWith('0') ? '0' : ' ');
			return String(value);
		},
	);
}

/**
 * yt-dlp reports a channel as a playlist. A channel *tab* has the channel's
 * id as its own; a channel addressed by handle has the handle (MeTube's
 * is_channel_extraction).
 */
function isChannelFeed(info: ProbeInfo): boolean {
	if (!info.channel_id || !info.id) return false;
	if (info.id === info.channel_id) return true;
	const handle = info.uploader_id?.toLowerCase();
	const id = info.id.toLowerCase();
	return !!handle && (handle === id || handle === `@${id}`);
}

function isNestedFeed(e: ProbeEntry): boolean {
	return (e.type === 'url' || e.type === 'playlist') && /tab|playlist/i.test(e.url) && !/watch\?|\/shorts\/|youtu\.be\//.test(e.url);
}

/** The language a subtitle file is in: `Title.en.json3` → `en`, `Title.en-orig.vtt` → `en`. */
function subtitleLang(file: string): string {
	const parts = basename(file).split('.');
	const tag = parts.length >= 3 ? parts[parts.length - 2] : '';
	return tag.replace(/-orig$/, '');
}

/* --------------------------------------------------------------------------
 * The manager
 * -------------------------------------------------------------------------- */

type Listener = { send: (e: DownloadEvent) => void; close: () => void };

export class DownloadManager {
	private items = new Map<string, Item>();
	private subs = new Map<string, SubRecord>();
	private settings: DownloadSettings = structuredClone(DEFAULT_SETTINGS);
	private runs = new Map<string, Run>();
	private logs = new Map<string, string[]>();
	private listeners = new Set<Listener>();
	private adding: AddingState | null = null;
	private addGeneration = 0;
	private addsInFlight = 0;
	private canceledUrls = new Set<string>();
	private checking = new Set<string>();
	private probeAt = new Map<string, number>();
	private probeFailures = new Map<string, number>();
	private inspectCache = new Map<string, { raw: unknown; at: number }>();
	private updateLog: string[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private writing: Promise<void> = Promise.resolve();
	private disposed = false;
	readonly ready: Promise<void>;

	constructor() {
		this.ready = this.load();
	}

	private async load() {
		const [queue, subs, settings] = await Promise.all([
			readJson<{ items?: Item[] }>(QUEUE_FILE),
			readJson<{ subscriptions?: SubRecord[] }>(SUBS_FILE),
			readJson<Partial<DownloadSettings>>(SETTINGS_FILE),
		]);
		this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...(settings ?? {}) };
		for (const raw of queue?.items ?? []) {
			const item: Item = { ...raw, options: { ...DEFAULT_OPTIONS, ...raw.options } };
			// Running when the server stopped: queue it again. yt-dlp continues
			// from the .part file in its work folder.
			if (isRunning(item.status)) {
				item.status = 'queued';
				item.progress = { ...EMPTY_PROGRESS, ratio: item.progress?.ratio ?? null };
			}
			this.items.set(item.id, item);
		}
		for (const s of subs?.subscriptions ?? []) this.subs.set(s.id, { ...s, options: { ...DEFAULT_OPTIONS, ...s.options } });
		await this.moveOldCookies();
		setYtdlpFlags({ cookies: existsSync(COOKIES_FILE) });
		this.timer = setInterval(() => this.tick(), TICK_MS);
		this.timer.unref?.();
		// A moment's grace: after a dev reload the previous instance's workers
		// are still being killed.
		setTimeout(() => {
			this.pump();
			this.tick();
		}, 1500).unref?.();
		ytdlpStatus().then((s) => this.emit({ type: 'ytdlp', ytdlp: { ...s, cookies: existsSync(COOKIES_FILE) } }));
	}

	/** A dev-server reload replaces this module: hand the queue over intact. */
	dispose() {
		this.disposed = true;
		if (this.timer) clearInterval(this.timer);
		if (this.saveTimer) clearTimeout(this.saveTimer);
		for (const [id, run] of this.runs) {
			run.stop = 'reload';
			run.worker?.kill();
			const item = this.items.get(id);
			if (item) item.status = 'queued';
		}
		try {
			this.saveSync();
		} catch (err) {
			console.error('[downloads] could not save state on reload:', err);
		}
		for (const l of this.listeners) l.close();
		this.listeners.clear();
	}

	/* ---------------------------------------------------------------- views */

	private view(item: Item): DownloadItem {
		const { password: _password, ...rest } = item;
		return rest;
	}

	private subView(s: SubRecord): Subscription {
		const { seen, ...rest } = s;
		return { ...rest, seenCount: seen.length, checking: this.checking.has(s.id) };
	}

	snapshot(): DownloadEvent {
		return {
			type: 'snapshot',
			items: [...this.items.values()].map((i) => this.view(i)),
			subscriptions: [...this.subs.values()].map((s) => this.subView(s)),
			settings: this.settings,
			adding: this.adding,
			ytdlp: this.ytdlp(),
		};
	}

	private ytdlp(): YtdlpStatus {
		return { ...cachedYtdlpStatus(), cookies: existsSync(COOKIES_FILE) };
	}

	getSettings(): DownloadSettings {
		return this.settings;
	}

	activeCount(): number {
		let n = 0;
		for (const i of this.items.values()) if (isRunning(i.status) || i.status === 'queued') n++;
		return n;
	}

	/** Downloads not finished yet that will land in this bin. */
	activeInBin(bin: string): number {
		let n = 0;
		for (const i of this.items.values()) if (i.bin === bin && !isFinished(i.status)) n++;
		return n;
	}

	detail(id: string): { item: DownloadItem; logs: string[] } | null {
		const item = this.items.get(id);
		return item ? { item: this.view(item), logs: this.logs.get(id) ?? [] } : null;
	}

	/** Absolute path of one of a finished row's files, checked to be inside media/. */
	filePath(id: string, index: number): { path: string; name: string } | null {
		const f = this.items.get(id)?.files[index];
		if (!f) return null;
		const path = join(MEDIA_ROOT, f.bin, f.folder, f.name);
		return isInside(MEDIA_ROOT, path) ? { path, name: f.name } : null;
	}

	/* --------------------------------------------------------------- events */

	on(send: (e: DownloadEvent) => void, close: () => void): () => void {
		const l = { send, close };
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}

	private emit(e: DownloadEvent) {
		for (const l of this.listeners) {
			try {
				l.send(e);
			} catch {
				this.listeners.delete(l);
			}
		}
	}

	private changed(item: Item, persist = true) {
		this.emit({ type: 'item', item: this.view(item) });
		if (persist) this.scheduleSave();
	}

	private notice(level: 'info' | 'error', message: string) {
		this.emit({ type: 'notice', level, message });
	}

	private setAdding(a: AddingState | null) {
		this.adding = a;
		this.emit({ type: 'adding', adding: a });
	}

	private log(id: string, line: string) {
		let lines = this.logs.get(id);
		if (!lines) this.logs.set(id, (lines = []));
		lines.push(line);
		if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
	}

	/* ---------------------------------------------------------- persistence */

	private state() {
		return {
			queue: { version: 1, items: [...this.items.values()].map((i) => this.view(i)) },
			subs: { version: 1, subscriptions: [...this.subs.values()] },
		};
	}

	private scheduleSave() {
		if (this.saveTimer || this.disposed) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			const { queue, subs } = this.state();
			this.writing = this.writing
				.then(() => Promise.all([writeJson(QUEUE_FILE, queue), writeJson(SUBS_FILE, subs)]))
				.then(() => {})
				.catch((err) => console.error('[downloads] could not save state:', err));
		}, 600);
	}

	private saveSync() {
		const { queue, subs } = this.state();
		writeJsonSync(QUEUE_FILE, queue);
		writeJsonSync(SUBS_FILE, subs);
	}

	/* ----------------------------------------------------------------- bins */

	private async binFor(name: string): Promise<string> {
		const wanted = name || this.settings.defaultBin || 'inbox';
		try {
			return (await getBin(wanted)).name;
		} catch {
			if (isValidBinName(wanted)) return (await createBin(wanted)).name;
			return (await createBin('inbox')).name;
		}
	}

	private cookies(): string | null {
		return existsSync(COOKIES_FILE) ? COOKIES_FILE : null;
	}

	/* ------------------------------------------------------------------ add */

	/**
	 * Add one or more links. A playlist or channel becomes one row per video,
	 * in its own bin if you asked for that. Returns once every link has been
	 * read — for a big channel that takes a while; the page shows progress
	 * from the `adding` events and can stop it with cancelAdd().
	 */
	async add(urls: string[], options: DownloadOptions, password: string | null = null, feedTitle: string | null = null): Promise<AddResult> {
		await this.ready;
		// Entries picked out of a playlist in Inspect: still that playlist's bin.
		if (feedTitle && options.binPerPlaylist) options = { ...options, bin: binNameFrom(feedTitle) || options.bin, binPerPlaylist: false };
		const result: AddResult = { added: 0, skipped: [], errors: [] };
		const gen = this.addGeneration;
		this.addsInFlight++;
		try {
			for (const raw of urls) {
				if (gen !== this.addGeneration) break;
				const url = raw.trim();
				if (!url) continue;
				this.canceledUrls.delete(url);
				this.setAdding({ url, title: null, added: 0, total: null });
				try {
					await this.addUrl(url, options, password, gen, result, 0);
				} catch (err) {
					const msg = errorText(err);
					result.errors.push(msg);
					this.recordFailure(url, msg, options);
				}
			}
		} finally {
			this.addsInFlight--;
			if (this.addsInFlight === 0) {
				this.canceledUrls.clear();
				this.setAdding(null);
			}
		}
		return result;
	}

	/** Stop expanding the playlist being added. Rows already added stay. */
	cancelAdd() {
		this.addGeneration++;
	}

	private async addUrl(url: string, options: DownloadOptions, password: string | null, gen: number, result: AddResult, depth: number): Promise<void> {
		if (!/^https?:\/\//i.test(url)) throw new DownloadError(`Not a web link: ${url}`);
		const { info } = await runOnce<ProbeInfo>(
			{
				cmd: 'probe',
				url,
				params: { ...probeParams(options, this.settings, this.cookies(), false), extract_flat: true, noplaylist: true, ...(password ? { videopassword: password } : {}) },
				playlist_end: options.playlistLimit > 0 ? options.playlistLimit : undefined,
				process: true,
			},
			{ timeoutMs: 15 * 60_000 },
		);

		if ((info.type === 'url' || info.type === 'url_transparent') && info.url) {
			if (depth >= 3 || info.url === url) throw new DownloadError(`yt-dlp kept redirecting: ${url}`);
			return this.addUrl(info.url, options, password, gen, result, depth + 1);
		}

		if (info.type === 'playlist' || info.type === 'multi_video') {
			const channel = isChannelFeed(info);
			const title = (channel ? info.channel || info.uploader : null) || info.title || hostOf(url);
			let entries = (info.entries ?? []).filter((e) => e.url);
			if (options.playlistLimit > 0) entries = entries.slice(0, options.playlistLimit);
			if (!entries.length) throw new DownloadError(`Nothing to download at ${url}`);
			const bin = options.binPerPlaylist ? await this.binFor(binNameFrom(title) || options.bin) : await this.binFor(options.bin);
			this.setAdding({ url, title, added: 0, total: entries.length });
			for (const [i, e] of entries.entries()) {
				if (gen !== this.addGeneration) {
					result.skipped.push(`Stopped after ${i} of ${entries.length} from ${title}`);
					return;
				}
				if (isNestedFeed(e) && depth < 2) {
					// A channel's Playlists tab lists playlists, not videos.
					await this.addUrl(e.url, options, password, gen, result, depth + 1).catch((err) => result.errors.push(errorText(err)));
				} else {
					this.createItem(e, options, password, bin, { kind: channel ? 'channel' : 'playlist', title, id: info.id, index: i + 1, count: entries.length }, result, null);
				}
				this.setAdding({ url, title, added: i + 1, total: entries.length });
			}
			return;
		}

		const bin = await this.binFor(options.bin);
		this.createItem(
			{
				id: info.id,
				url: info.url || url,
				title: info.title || url,
				duration: info.duration,
				thumbnail: info.thumbnail,
				uploader: info.uploader,
				live_status: info.live_status,
				availability: info.availability,
				release_timestamp: info.release_timestamp,
				timestamp: info.timestamp,
				view_count: info.view_count,
				type: 'video',
			},
			options,
			password,
			bin,
			null,
			result,
			null,
		);
	}

	private templateFor(options: DownloadOptions, ctx: FeedContext | null): string {
		const s = this.settings;
		let t = (ctx?.kind === 'playlist' ? s.playlistTemplate : ctx?.kind === 'channel' ? s.channelTemplate : s.template) || s.template;
		if (ctx) t = fillFeedFields(t, ctx);
		const prefix = cleanForName(options.namePrefix ?? '');
		return prefix ? `${prefix} ${t}` : t;
	}

	private createItem(
		e: ProbeEntry,
		options: DownloadOptions,
		password: string | null,
		bin: string,
		ctx: FeedContext | null,
		result: AddResult,
		subscription: string | null,
	): Item | null {
		const url = e.url;
		if (this.canceledUrls.has(url)) return null;
		for (const other of this.items.values()) {
			if (other.url === url && other.options.type === options.type && !isFinished(other.status)) {
				result.skipped.push(`Already in the queue: ${other.title}`);
				return null;
			}
		}
		const live = e.live_status ?? null;
		const item: Item = {
			id: newId(),
			url,
			title: e.title || url,
			status: live === 'is_upcoming' ? 'scheduled' : options.autoStart ? 'queued' : 'pending',
			options: structuredClone(options),
			bin,
			template: this.templateFor(options, ctx),
			thumbnail: e.thumbnail ?? null,
			duration: e.duration ?? null,
			uploader: e.uploader ?? null,
			playlist: ctx ? { title: ctx.title, index: ctx.index, count: ctx.count } : null,
			live,
			releaseAt: e.release_timestamp ? e.release_timestamp * 1000 : null,
			progress: { ...EMPTY_PROGRESS },
			files: [],
			captions: [],
			error: null,
			warnings: [],
			subscription,
			unresolved: false,
			attempts: 0,
			createdAt: Date.now(),
			startedAt: null,
			finishedAt: null,
			password,
		};
		this.items.set(item.id, item);
		this.changed(item);
		result.added++;
		this.pump();
		return item;
	}

	/** A link that failed before it became a download, kept as a failed row you can retry. */
	private recordFailure(url: string, msg: string, options: DownloadOptions) {
		const item: Item = {
			id: newId(),
			url,
			title: hostOf(url),
			status: 'error',
			options: structuredClone(options),
			bin: '',
			template: '',
			thumbnail: null,
			duration: null,
			uploader: null,
			playlist: null,
			live: null,
			releaseAt: null,
			progress: { ...EMPTY_PROGRESS },
			files: [],
			captions: [],
			error: msg,
			warnings: [],
			subscription: null,
			unresolved: true,
			attempts: 0,
			createdAt: Date.now(),
			startedAt: null,
			finishedAt: Date.now(),
		};
		this.items.set(item.id, item);
		this.changed(item);
	}

	/* -------------------------------------------------------------- inspect */

	/**
	 * Read a link without downloading anything: for a video its formats
	 * (with the ones your options would pick), captions and chapters; for a
	 * playlist or channel its entries. The preview before the commit.
	 */
	async inspect(url: string, options: DownloadOptions, password: string | null): Promise<ProbeInfo> {
		if (!/^https?:\/\//i.test(url)) throw new DownloadError(`Not a web link: ${url}`);
		await this.ready;
		const { info, raw } = await runOnce<ProbeInfo>(
			{
				cmd: 'probe',
				url,
				params: { ...probeParams(options, this.settings, this.cookies()), extract_flat: 'in_playlist', noplaylist: true, ...(password ? { videopassword: password } : {}) },
				playlist_end: options.playlistLimit > 0 ? options.playlistLimit : undefined,
				raw: true,
			},
			{ timeoutMs: 10 * 60_000 },
		);
		if (raw) {
			this.inspectCache.set(url, { raw, at: Date.now() });
			if (this.inspectCache.size > 6) this.inspectCache.delete(this.inspectCache.keys().next().value!);
		}
		return info;
	}

	/** Which formats these options pick, re-using the last Inspect of this link (offline, ~1 s). */
	async select(url: string, options: DownloadOptions): Promise<ProbeSelection | null> {
		const cached = this.inspectCache.get(url);
		if (!cached || Date.now() - cached.at > 30 * 60_000) return (await this.inspect(url, options, null)).selected ?? null;
		const { info } = await runOnce<{ selected: ProbeSelection | null }>(
			{ cmd: 'select', info: cached.raw, params: probeParams(options, this.settings, this.cookies()) },
			{ timeoutMs: 60_000 },
		);
		return info.selected;
	}

	/* -------------------------------------------------------------- running */

	private pump() {
		if (this.disposed) return;
		const max = Math.min(10, Math.max(1, Math.round(this.settings.concurrency) || 1));
		if (this.runs.size >= max) return;
		const queued = [...this.items.values()].filter((i) => i.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
		for (const item of queued) {
			if (this.runs.size >= max) break;
			void this.run(item);
		}
	}

	private async run(item: Item) {
		const workdir = join(WORK_ROOT, item.id);
		const run: Run = { worker: null, stop: null, cut: null, ranged: null, main: null, workdir, meter: null, roles: new Map(), terminal: null, error: null, stderr: [] };
		this.runs.set(item.id, run);
		item.status = 'preparing';
		item.startedAt = Date.now();
		item.finishedAt = null;
		item.attempts++;
		item.error = null;
		item.progress = { ...EMPTY_PROGRESS, phase: 'reading link', ratio: item.progress.ratio };
		this.logs.set(item.id, []);
		this.changed(item);

		try {
			await mkdir(workdir, { recursive: true });
			const job = downloadJob(item.options, this.settings, item.template, this.cookies(), item.password ?? null, item.duration);
			run.cut = job.cut;
			run.ranged = job.clip;
			run.worker = spawnWorker(
				{ cmd: 'download', url: item.url, workdir, params: job.params, clip: job.clip },
				(e) => this.onWorkerEvent(item, run, e),
				(line) => {
					this.log(item.id, line);
					run.stderr.push(line);
					if (run.stderr.length > 20) run.stderr.shift();
				},
			);
			// A stop asked for before the worker existed.
			if (run.stop === 'cancel' || run.stop === 'pause') run.worker.kill();
			const code = await run.worker.exited;
			if (!run.terminal && !run.stop) run.error = run.stderr.slice(-6).join('\n') || `yt-dlp worker exited ${code}`;
		} catch (err) {
			run.terminal = 'error';
			run.error = errorText(err);
		} finally {
			if (run.meter) clearInterval(run.meter);
			this.runs.delete(item.id);
		}
		if (this.disposed) return;

		if (run.stop === 'cancel') {
			this.items.delete(item.id);
			this.logs.delete(item.id);
			await rm(workdir, { recursive: true, force: true }).catch(() => {});
			this.emit({ type: 'remove', ids: [item.id] });
			this.scheduleSave();
		} else if (run.stop === 'pause' || (run.terminal === 'stopped' && run.stop !== 'keep')) {
			item.status = 'paused';
			item.progress = { ...EMPTY_PROGRESS, ratio: item.progress.ratio };
			this.changed(item);
		} else if (run.terminal === 'done' || run.terminal === 'stopped') {
			await this.finalize(item, run, workdir);
		} else {
			item.status = 'error';
			item.error = run.error ?? 'yt-dlp failed';
			item.finishedAt = Date.now();
			item.progress = { ...EMPTY_PROGRESS };
			this.changed(item);
		}
		this.pump();
	}

	private onWorkerEvent(item: Item, run: Run, e: WorkerEvent) {
		switch (e.event) {
			case 'progress': {
				if (e.status === 'downloading' || e.status === 'finished') {
					const downloaded = (e.downloaded as number | null) ?? null;
					const total = (e.total as number | null) ?? null;
					const kind = String(e.kind ?? 'media');
					if (item.status !== 'postprocessing') item.status = 'downloading';
					if (e.live) item.live = 'is_live';
					item.progress = {
						phase: e.live ? 'recording' : kind === 'media' ? 'downloading' : kind,
						ratio: e.status === 'finished' ? 1 : total && downloaded != null ? Math.min(1, downloaded / total) : null,
						downloaded,
						total,
						speed: (e.speed as number | null) ?? null,
						eta: (e.eta as number | null) ?? null,
						fragment: Array.isArray(e.fragment) && e.fragment[1] ? [Number(e.fragment[0]) || 0, Number(e.fragment[1])] : null,
					};
					this.changed(item, false);
				}
				break;
			}
			case 'postprocess': {
				if (e.status === 'started') {
					item.status = 'postprocessing';
					item.progress = { ...EMPTY_PROGRESS, phase: PP_LABELS[String(e.name)] ?? String(e.name).toLowerCase() };
					this.changed(item, false);
				}
				break;
			}
			case 'file': {
				const path = String(e.path ?? '');
				const role = (String(e.role) as DownloadFile['role']) || 'other';
				run.roles.set(path, role);
				if (role === 'main') run.main = path;
				break;
			}
			case 'log': {
				const msg = String(e.msg ?? '');
				this.log(item.id, e.level === 'info' ? msg : `${String(e.level).toUpperCase()}: ${msg}`);
				// The download proper starts here (cover conversion and such can run before it).
				if (msg.startsWith('[download] Destination:') && item.status !== 'downloading') {
					item.status = 'downloading';
					if (item.live === 'is_live' && !run.meter) this.meterRecording(item, run);
					this.changed(item, false);
				}
				if (e.level === 'warning' && msg && !item.warnings.includes(msg)) {
					item.warnings = [...item.warnings, msg].slice(-5);
				}
				break;
			}
			case 'done':
				run.terminal = 'done';
				break;
			case 'stopped':
				run.terminal = 'stopped';
				break;
			case 'error':
				run.terminal = 'error';
				run.error = String(e.msg ?? 'yt-dlp failed');
				break;
		}
	}

	private meterRecording(item: Item, run: Run) {
		const since = Date.now();
		item.progress = { ...EMPTY_PROGRESS, phase: 'recording' };
		run.meter = setInterval(async () => {
			let bytes = 0;
			for (const name of await readdir(run.workdir).catch(() => [] as string[])) {
				bytes += (await stat(join(run.workdir, name)).catch(() => null))?.size ?? 0;
			}
			if (item.status !== 'downloading') return;
			// ffmpeg writes in bursts; the average since the start reads steadier.
			const speed = bytes / ((Date.now() - since) / 1000);
			item.progress = { ...EMPTY_PROGRESS, phase: run.stop === 'keep' ? 'closing recording' : 'recording', downloaded: bytes, speed: speed > 0 ? speed : null };
			this.changed(item, false);
		}, 2000);
	}

	/**
	 * File what yt-dlp wrote into the bin. Media goes to sources/ (and so the
	 * Library), caption files to captions/, the rest to extras/. Captions
	 * fetched alongside a video become an editable track on it.
	 */
	private async finalize(item: Item, run: Run, workdir: string) {
		item.status = 'postprocessing';
		item.progress = { ...EMPTY_PROGRESS, phase: 'filing' };
		this.changed(item, false);
		try {
			const bin = await getBin(await this.binFor(item.bin));
			item.bin = bin.name;
			const written = await walk(workdir);
			const isMedia = (f: string) => VIDEO_EXTS.has(extname(f).toLowerCase()) || AUDIO_EXTS.has(extname(f).toLowerCase());
			const media = written.filter(isMedia);
			let main = run.main && media.includes(run.main) ? run.main : null;
			if (!main && media.length) {
				const sizes = await Promise.all(media.map(async (f) => (await stat(f)).size));
				main = media[sizes.indexOf(Math.max(...sizes))];
			}
			// ffmpeg can be refused mid-request (a ranged clip, an expired URL)
			// and still exit 0 with nothing but a header written.
			if (main && (await stat(main)).size < 4096) {
				throw new Error('yt-dlp reported success but the file is empty — the site refused the request. Retry, or try without the clip.');
			}

			// Where the file starts on the source's timeline, for the captions.
			let offset = 0;
			let until = Infinity;
			if (main && run.cut) {
				item.progress = { ...EMPTY_PROGRESS, phase: 'cutting clip' };
				this.changed(item, false);
				const cut = await this.cutClip(item, main, run.cut);
				media[media.indexOf(main)] = cut;
				main = cut;
				[offset, until] = [run.cut[0], run.cut[1] ?? Infinity];
			} else if (main && run.ranged) {
				// yt-dlp's range starts at the keyframe before the start; the end
				// is where it was asked to be, so the length tells where it began.
				const length = (await probeFile(main).catch(() => null))?.duration ?? null;
				const end = run.ranged[1] ?? item.duration;
				offset = length && end ? Math.min(run.ranged[0], Math.max(0, end - length)) : run.ranged[0];
				until = run.ranged[1] ?? Infinity;
			}
			const files: DownloadFile[] = [];
			const place = async (from: string, folder: DownloadFile['folder'], role: DownloadFile['role'], dir: string) => {
				// yt-dlp swaps characters Windows forbids for look-alikes ("：", "⧸",
				// "？", "＂"). "Part 1: Intro" reads better as "Part 1 - Intro", "24/7"
				// as "24-7", and a question needs no mark at all.
				const friendly = basename(from)
					.replace(/\s*[:：]\s*/g, ' - ')
					.replace(/⧸/g, '-')
					.replace(/[？?]/g, '')
					.replace(/[＂"]/g, "'");
				const dest = await freePath(dir, sanitizeFileName(friendly));
				await moveFile(from, dest);
				const file: DownloadFile = { role, bin: bin.name, folder, name: basename(dest), sizeBytes: (await stat(dest)).size };
				files.push(file);
				return file;
			};

			let mainFile: DownloadFile | null = null;
			for (const f of media) {
				const placed = await place(f, 'sources', f === main ? 'main' : run.roles.get(f) === 'chapter' ? 'chapter' : 'other', bin.sourcesDir);
				if (f === main) mainFile = placed;
			}

			const subtitles = written.filter((f) => SUBTITLE_EXTS.has(extname(f).toLowerCase()));
			const captionsDir = join(bin.dir, 'captions');
			const extrasDir = join(bin.dir, 'extras');
			if (item.options.type === 'captions') {
				for (const f of subtitles) {
					let from = f;
					if (item.options.format === 'txt' && extname(f).toLowerCase() !== '.txt') from = await this.toText(f);
					await place(from, 'captions', 'subtitle', captionsDir);
				}
			} else if (mainFile && item.options.captions && subtitles.length) {
				const imported = await this.importCaptions(item, mainFile, subtitles, offset, until);
				item.captions = imported;
				for (const f of subtitles) await rm(f, { force: true });
			} else {
				for (const f of subtitles) await place(f, 'extras', 'subtitle', extrasDir);
			}

			for (const f of written) {
				if (isMedia(f) || SUBTITLE_EXTS.has(extname(f).toLowerCase()) || !existsSync(f)) continue;
				const image = /\.(jpe?g|png|webp)$/i.test(f);
				await place(f, 'extras', image ? 'thumbnail' : 'other', extrasDir);
			}

			await rm(workdir, { recursive: true, force: true }).catch(() => {});
			// Cancelled while it was being filed: the row is gone already.
			if (!this.items.has(item.id)) return;
			if (!files.length && !item.captions.length) {
				const why =
					item.options.type === 'captions'
						? `No ${item.options.subtitleLanguage} captions for this video (see Inspect for the languages it has).`
						: 'yt-dlp finished without writing a file. Is it in a download archive set in your options?';
				throw new Error(why);
			}
			item.files = files;
			item.status = 'done';
			item.error = null;
			item.progress = { ...EMPTY_PROGRESS, ratio: 1 };
		} catch (err) {
			item.status = 'error';
			item.error = errorText(err);
			item.progress = { ...EMPTY_PROGRESS };
		}
		if (!this.items.has(item.id)) return;
		item.finishedAt = Date.now();
		this.changed(item);
	}

	/**
	 * Cut a clip out of a finished download. Audio is copied (every audio
	 * frame is a keyframe, so the cut is exact and the cover and tags stay);
	 * video is re-encoded to H.264 so it starts on the exact frame.
	 */
	private async cutClip(item: Item, path: string, [start, end]: [number, number | null]): Promise<string> {
		const info = await probeFile(path);
		const video = !!info.video && item.options.type === 'video';
		const clock = (s: number) => {
			const t = Math.round(s);
			const h = Math.floor(t / 3600);
			const m = Math.floor((t % 3600) / 60);
			const sec = String(t % 60).padStart(2, '0');
			return h ? `${h}h${String(m).padStart(2, '0')}m${sec}s` : `${m}m${sec}s`;
		};
		const length = end != null ? end - start : null;
		const ext = video ? '.mp4' : extname(path);
		const out = join(dirname(path), `${basename(path, extname(path))} (clip ${clock(start)}-${end != null ? clock(end) : 'end'})${ext}`);
		const args = ['-ss', String(start), ...(length != null ? ['-t', String(length)] : []), '-i', path];
		if (video) {
			args.push('-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p');
			args.push('-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
		} else {
			args.push('-map', '0', '-c', 'copy');
		}
		args.push(out);
		this.log(item.id, `$ ffmpeg ${args.join(' ')}`);
		await runFfmpeg(args, {
			expectedDuration: length ?? (info.duration ? info.duration - start : null),
			onLog: (line) => this.log(item.id, line),
			onProgress: (p) => {
				item.progress = { ...EMPTY_PROGRESS, phase: 'cutting clip', ratio: p.ratio };
				this.changed(item, false);
			},
		});
		await rm(path, { force: true });
		return out;
	}

	private async toText(file: string): Promise<string> {
		const text = await readFile(file, 'utf8');
		const cues = extname(file).toLowerCase() === '.json3' ? parseJson3(text) : dedupeRolling(parseSubtitles(text));
		const out = file.replace(/\.[^.]+$/, '.txt');
		await writeFile(out, cues.map((c) => c.text.replace(/\n/g, ' ')).join('\n') + '\n');
		await rm(file, { force: true });
		return out;
	}

	/**
	 * Subtitle files → caption tracks on the downloaded file, one per
	 * language. `from`/`to`: the part of the source the file holds (a clip).
	 */
	private async importCaptions(item: Item, main: DownloadFile, subtitles: string[], from: number, to: number): Promise<string[]> {
		const done: string[] = [];
		// Exact language before the -orig auto track, json3 before vtt/srt.
		const rank = (f: string) => (basename(f).includes('-orig.') ? 2 : 0) + (f.endsWith('.json3') ? 0 : 1);
		for (const f of [...subtitles].sort((a, b) => rank(a) - rank(b))) {
			const lang = subtitleLang(f);
			if (!isValidLang(lang) || done.includes(lang)) continue;
			try {
				const text = await readFile(f, 'utf8');
				let cues: Cue[] = f.endsWith('.json3') ? parseJson3(text) : dedupeRolling(parseSubtitles(text));
				// The captions are timed to the whole video; a clip starts later.
				if (from > 0 || to < Infinity) {
					cues = cues
						.filter((c) => c.end > from && c.start < to)
						.map((c) => ({
							...c,
							start: Math.max(0, c.start - from),
							end: Math.min(to, c.end) - from,
							words: c.words?.map((w) => ({ ...w, s: Math.max(0, w.s - from), e: Math.max(0, w.e - from) })),
						}));
				}
				if (!cues.length) continue;
				await saveTrack({
					version: 1,
					lang,
					source: { bin: main.bin, kind: 'sources', name: main.name },
					origin: { kind: 'import', file: basename(f) },
					updatedAt: Date.now(),
					cues,
				});
				done.push(lang);
			} catch (err) {
				this.log(item.id, `WARNING: could not import ${basename(f)} as captions: ${errorText(err)}`);
			}
		}
		return done;
	}

	/* -------------------------------------------------------------- actions */

	private targets(ids: string[]): Item[] {
		return ids.map((id) => this.items.get(id)).filter((i): i is Item => !!i);
	}

	/** Start pending/paused rows, or a scheduled live stream right now. */
	start(ids: string[]) {
		for (const item of this.targets(ids)) {
			if (item.status === 'pending' || item.status === 'paused' || item.status === 'scheduled') {
				item.status = 'queued';
				this.changed(item);
			}
		}
		this.pump();
	}

	/** Stop running rows but keep what's downloaded; Start resumes from there. */
	pause(ids: string[]) {
		for (const item of this.targets(ids)) {
			const run = this.runs.get(item.id);
			if (run) {
				run.stop = 'pause';
				run.worker?.kill();
			} else if (item.status === 'queued' || item.status === 'pending') {
				item.status = 'paused';
				this.changed(item);
			}
		}
	}

	/** Remove waiting or running rows and throw away their partial download. */
	cancel(ids: string[]) {
		const removed: string[] = [];
		for (const item of this.targets(ids)) {
			if (this.addsInFlight) this.canceledUrls.add(item.url);
			const run = this.runs.get(item.id);
			if (run) {
				run.stop = 'cancel';
				run.worker?.kill();
			} else if (!isFinished(item.status)) {
				this.items.delete(item.id);
				this.logs.delete(item.id);
				removed.push(item.id);
				void rm(join(WORK_ROOT, item.id), { recursive: true, force: true }).catch(() => {});
			}
		}
		if (removed.length) {
			this.emit({ type: 'remove', ids: removed });
			this.scheduleSave();
		}
	}

	/** A live recording: finish the file with what's been recorded so far. */
	stopRecording(ids: string[]) {
		for (const item of this.targets(ids)) {
			const run = this.runs.get(item.id);
			if (!run?.worker) continue;
			run.stop = 'keep';
			run.worker.stop();
			item.progress = { ...item.progress, phase: 'closing recording' };
			this.changed(item, false);
			const worker = run.worker;
			// If ffmpeg won't close in time, end it; Windows keeps the file playable.
			setTimeout(() => worker.kill(), 45_000).unref?.();
		}
	}

	async retry(ids: string[]) {
		for (const item of this.targets(ids)) {
			if (item.status !== 'error') continue;
			if (item.unresolved) {
				// It never got past reading the link: read it again.
				this.items.delete(item.id);
				this.emit({ type: 'remove', ids: [item.id] });
				void this.add([item.url], item.options, item.password ?? null);
				continue;
			}
			// Keep partial downloads to resume from; drop anything finished,
			// which yt-dlp would otherwise skip as "already downloaded" even if
			// it's what broke.
			const workdir = join(WORK_ROOT, item.id);
			for (const name of await readdir(workdir).catch(() => [] as string[])) {
				if (!/\.(part|ytdl)$|\.part-Frag\d+/i.test(name)) await rm(join(workdir, name), { recursive: true, force: true }).catch(() => {});
			}
			item.status = 'queued';
			item.error = null;
			item.warnings = [];
			item.progress = { ...EMPTY_PROGRESS };
			item.finishedAt = null;
			this.changed(item);
		}
		this.pump();
	}

	/**
	 * Remove finished rows. With `deleteFiles` (and the setting allowing it)
	 * the files they produced go too, caption tracks included.
	 */
	async remove(ids: string[], deleteFiles: boolean) {
		const mode = this.settings.deleteFiles;
		const wipe = mode === 'always' || (mode === 'ask' && deleteFiles);
		const removed: string[] = [];
		for (const item of this.targets(ids)) {
			if (!isFinished(item.status)) continue;
			if (wipe) {
				for (const f of item.files) {
					const path = join(MEDIA_ROOT, f.bin, f.folder, f.name);
					if (isInside(MEDIA_ROOT, path)) await rm(path, { force: true }).catch(() => {});
				}
				const main = item.files.find((f) => f.role === 'main');
				if (main) for (const lang of item.captions) await deleteTrack({ bin: main.bin, kind: 'sources', name: main.name }, lang).catch(() => {});
			}
			await rm(join(WORK_ROOT, item.id), { recursive: true, force: true }).catch(() => {});
			this.items.delete(item.id);
			this.logs.delete(item.id);
			removed.push(item.id);
		}
		if (removed.length) {
			this.emit({ type: 'remove', ids: removed });
			this.scheduleSave();
		}
	}

	/* ------------------------------------------------------------- settings */

	async updateSettings(patch: Partial<DownloadSettings>): Promise<DownloadSettings> {
		await this.ready;
		const next = { ...this.settings, ...patch };
		next.concurrency = Math.min(10, Math.max(1, Math.round(Number(next.concurrency)) || 3));
		next.clearAfterHours = Math.max(0, Number(next.clearAfterHours) || 0);
		next.subscriptionScan = Math.min(500, Math.max(5, Math.round(Number(next.subscriptionScan)) || 50));
		if (!['never', 'ask', 'always'].includes(next.deleteFiles)) next.deleteFiles = 'ask';
		for (const key of ['template', 'playlistTemplate', 'channelTemplate', 'chapterTemplate'] as const) {
			const t = String(next[key] ?? '').trim();
			if (key === 'template' && !t) throw new DownloadError('The file name template can’t be empty.');
			if (t && !t.includes('%(ext)s')) throw new DownloadError(`Templates need %(ext)s: ${t}`);
			if (t && (/(^|[\\/])\.\.([\\/]|$)/.test(t) || /^([a-z]:|[\\/])/i.test(t))) throw new DownloadError(`Templates stay inside the download folder: ${t}`);
			next[key] = t;
		}
		if (next.defaultBin && !isValidBinName(next.defaultBin)) throw new DownloadError(`Not a valid bin name: ${next.defaultBin}`);
		if (next.rateLimit && !/^\s*\d+(\.\d+)?\s*[kmgt]?i?b?\s*$/i.test(next.rateLimit)) throw new DownloadError('Rate limit looks like 500K or 4.2M.');
		this.settings = next;
		await writeJson(SETTINGS_FILE, next);
		this.emit({ type: 'settings', settings: next });
		this.pump();
		return next;
	}

	/** From when they lived in the media folder. Copied, because the two can be on different drives. */
	private async moveOldCookies() {
		if (!existsSync(OLD_COOKIES_FILE)) return;
		if (!existsSync(COOKIES_FILE)) {
			await mkdir(DATA_DIR, { recursive: true });
			await copyFile(OLD_COOKIES_FILE, COOKIES_FILE);
		}
		await rm(OLD_COOKIES_FILE, { force: true });
	}

	async setCookies(text: string | null) {
		if (text === null) await rm(COOKIES_FILE, { force: true });
		else {
			if (!/^(# (Netscape )?HTTP Cookie File|[^\t\n]+\t(TRUE|FALSE)\t)/m.test(text)) {
				throw new DownloadError('That isn’t a cookies.txt (Netscape format). Export one with a "Get cookies.txt" browser extension.');
			}
			await mkdir(DATA_DIR, { recursive: true });
			await writeFile(COOKIES_FILE, text);
		}
		setYtdlpFlags({ cookies: existsSync(COOKIES_FILE) });
		this.emit({ type: 'ytdlp', ytdlp: this.ytdlp() });
	}

	async updateYtdlp(): Promise<{ ok: boolean; log: string[] }> {
		if (cachedYtdlpStatus().updating) throw new DownloadError('Already updating.', 409);
		this.updateLog = [];
		setYtdlpFlags({ updating: true });
		this.emit({ type: 'ytdlp', ytdlp: this.ytdlp() });
		let ok = true;
		try {
			await installYtdlp((line) => {
				this.updateLog.push(line);
				if (this.updateLog.length > 200) this.updateLog.shift();
			});
		} catch (err) {
			ok = false;
			this.updateLog.push(errorText(err));
		}
		setYtdlpFlags({ updating: false });
		const s = await ytdlpStatus(true);
		this.emit({ type: 'ytdlp', ytdlp: this.ytdlp() });
		this.notice(ok ? 'info' : 'error', ok ? `yt-dlp ${s.ytdlp} is installed.` : 'Updating yt-dlp failed — see the log.');
		return { ok, log: this.updateLog };
	}

	getUpdateLog(): string[] {
		return this.updateLog;
	}

	/* -------------------------------------------------------- subscriptions */

	async subscribe(url: string, options: DownloadOptions, opts: { intervalMinutes: number; titleFilter: string; skipMembersOnly: boolean }) {
		await this.ready;
		url = url.trim();
		if (!/^https?:\/\//i.test(url)) throw new DownloadError(`Not a web link: ${url}`);
		if ([...this.subs.values()].some((s) => s.url === url)) throw new DownloadError('You’re already subscribed to that.');
		if (opts.titleFilter) {
			try {
				new RegExp(opts.titleFilter);
			} catch (err) {
				throw new DownloadError(`Title filter isn’t a valid regex: ${errorText(err)}`);
			}
		}
		const info = await this.scan(url, options);
		if (info.type !== 'playlist') throw new DownloadError('That link is a single video, not a channel or playlist. Use Download instead.');
		const name = (isChannelFeed(info) ? info.channel || info.uploader : null) || info.title || info.uploader || hostOf(url);
		// What's there now counts as seen; only new uploads get queued. A
		// stream that hasn't started yet isn't seen, so it's caught live.
		const seen = (info.entries ?? []).filter((e) => e.live_status !== 'is_upcoming').map((e) => e.id ?? e.url);
		const sub: SubRecord = {
			id: newId(),
			name,
			url,
			enabled: true,
			intervalMinutes: Math.max(5, Math.round(opts.intervalMinutes) || 60),
			options: structuredClone(options),
			titleFilter: opts.titleFilter,
			skipMembersOnly: opts.skipMembersOnly,
			lastChecked: Date.now(),
			lastFound: 0,
			error: null,
			createdAt: Date.now(),
			seen: [...new Set(seen)],
		};
		this.subs.set(sub.id, sub);
		this.emitSubs();
		return this.subView(sub);
	}

	updateSubscription(id: string, patch: Partial<Pick<Subscription, 'enabled' | 'intervalMinutes' | 'titleFilter' | 'skipMembersOnly' | 'name'>>) {
		const sub = this.subs.get(id);
		if (!sub) throw new DownloadError('No such subscription.', 404);
		if (patch.titleFilter) {
			try {
				new RegExp(patch.titleFilter);
			} catch (err) {
				throw new DownloadError(`Title filter isn’t a valid regex: ${errorText(err)}`);
			}
		}
		if (patch.enabled !== undefined) sub.enabled = !!patch.enabled;
		if (patch.intervalMinutes !== undefined) sub.intervalMinutes = Math.max(5, Math.round(Number(patch.intervalMinutes)) || 60);
		if (patch.titleFilter !== undefined) sub.titleFilter = String(patch.titleFilter);
		if (patch.skipMembersOnly !== undefined) sub.skipMembersOnly = !!patch.skipMembersOnly;
		if (patch.name !== undefined && String(patch.name).trim()) sub.name = String(patch.name).trim().slice(0, 120);
		this.emitSubs();
		return this.subView(sub);
	}

	removeSubscriptions(ids: string[]) {
		for (const id of ids) this.subs.delete(id);
		this.emitSubs();
	}

	checkNow(ids: string[]) {
		for (const id of ids) {
			const sub = this.subs.get(id);
			if (sub) void this.checkSubscription(sub);
		}
	}

	private emitSubs() {
		this.emit({ type: 'subscriptions', subscriptions: [...this.subs.values()].map((s) => this.subView(s)) });
		this.scheduleSave();
	}

	private async scan(url: string, options: DownloadOptions): Promise<ProbeInfo> {
		const { info } = await runOnce<ProbeInfo>(
			{
				cmd: 'probe',
				url,
				params: {
					...probeParams(options, this.settings, this.cookies(), false),
					extract_flat: true,
					lazy_playlist: true,
					// Leave YouTube's private/deleted placeholders out, or a video
					// added while still private would be marked seen for good.
					compat_opts: ['no-youtube-unavailable-videos'],
				},
				playlist_end: this.settings.subscriptionScan,
				process: true,
			},
			{ timeoutMs: 10 * 60_000 },
		);
		return info;
	}

	private async checkSubscription(sub: SubRecord) {
		if (this.checking.has(sub.id)) return;
		this.checking.add(sub.id);
		this.emitSubs();
		try {
			const info = await this.scan(sub.url, sub.options);
			if (info.type !== 'playlist') throw new DownloadError('This link no longer resolves to a channel or playlist.');
			const seen = new Set(sub.seen);
			const entries = (info.entries ?? []).filter((e) => e.url && !isNestedFeed(e));
			// A stream seen while it was upcoming is queued again once it's live.
			const fresh = entries.filter((e) => !seen.has(e.id ?? e.url) || e.live_status === 'is_live');
			let filter: RegExp | null = null;
			try {
				filter = sub.titleFilter ? new RegExp(sub.titleFilter) : null;
			} catch {
				filter = null;
			}
			const skipped: string[] = [];
			const queue: ProbeEntry[] = [];
			for (const e of fresh) {
				if ((filter && !filter.test(e.title)) || (sub.skipMembersOnly && e.availability === 'subscriber_only')) skipped.push(e.id ?? e.url);
				else queue.push(e);
			}
			const result: AddResult = { added: 0, skipped: [], errors: [] };
			const bin = sub.options.binPerPlaylist ? await this.binFor(binNameFrom(sub.name) || sub.options.bin) : await this.binFor(sub.options.bin);
			const channel = isChannelFeed(info);
			// Feeds list newest first; queue oldest first.
			for (const e of [...queue].reverse()) {
				const ctx: FeedContext = { kind: channel ? 'channel' : 'playlist', title: sub.name, id: info.id, index: entries.indexOf(e) + 1, count: entries.length };
				this.createItem(e, sub.options, null, bin, ctx, result, sub.id);
			}
			const queuedIds = queue.map((e) => e.id ?? e.url);
			sub.seen = [...new Set([...queuedIds, ...skipped, ...sub.seen])].slice(0, MAX_SEEN);
			sub.lastFound = result.added;
			sub.error = null;
			if (result.added) this.notice('info', `${sub.name}: ${result.added} new ${result.added === 1 ? 'video' : 'videos'} queued.`);
		} catch (err) {
			sub.error = errorText(err);
		} finally {
			sub.lastChecked = Date.now();
			this.checking.delete(sub.id);
			this.emitSubs();
		}
	}

	/* ----------------------------------------------------------------- tick */

	/** Every 30 s: due subscriptions, upcoming live streams, auto-clear. */
	private tick() {
		if (this.disposed) return;
		const now = Date.now();
		let checks = this.checking.size;
		for (const sub of this.subs.values()) {
			if (checks >= 2) break;
			if (!sub.enabled || this.checking.has(sub.id)) continue;
			if (now - (sub.lastChecked ?? 0) >= sub.intervalMinutes * 60_000) {
				checks++;
				void this.checkSubscription(sub);
			}
		}
		for (const item of this.items.values()) {
			if (item.status === 'scheduled') void this.probeScheduled(item, now);
		}
		const hours = this.settings.clearAfterHours;
		if (hours > 0) {
			const old = [...this.items.values()].filter((i) => i.status === 'done' && i.finishedAt && now - i.finishedAt > hours * 3600_000);
			if (old.length) void this.remove(old.map((i) => i.id), false);
		}
	}

	/** An upcoming stream: look again around its start time, then start it once it's live. */
	private async probeScheduled(item: Item, now: number) {
		const due = this.probeAt.get(item.id) ?? 0;
		if (now < due) return;
		if (item.releaseAt && item.releaseAt - now > 2 * 60_000) {
			this.probeAt.set(item.id, item.releaseAt - 60_000);
			return;
		}
		this.probeAt.set(item.id, now + 10 * 60_000);
		try {
			const { info } = await runOnce<ProbeInfo>(
				{ cmd: 'probe', url: item.url, params: { ...probeParams(item.options, this.settings, this.cookies(), false), extract_flat: true }, process: false },
				{ timeoutMs: 120_000 },
			);
			this.probeFailures.delete(item.id);
			if (item.status !== 'scheduled') return;
			if (info.live_status === 'is_upcoming') {
				item.releaseAt = info.release_timestamp ? info.release_timestamp * 1000 : item.releaseAt;
				const wait = item.releaseAt ? Math.min(3600_000, Math.max(60_000, item.releaseAt - Date.now())) : 60_000;
				this.probeAt.set(item.id, Date.now() + wait);
				this.changed(item);
			} else {
				item.live = info.live_status;
				item.status = 'queued';
				this.probeAt.delete(item.id);
				this.changed(item);
				this.pump();
			}
		} catch (err) {
			const failures = (this.probeFailures.get(item.id) ?? 0) + 1;
			this.probeFailures.set(item.id, failures);
			this.probeAt.set(item.id, Date.now() + 60_000);
			if (failures >= 5 && item.status === 'scheduled') {
				item.status = 'error';
				item.error = `Couldn’t check the stream: ${errorText(err)}`;
				item.finishedAt = Date.now();
				this.changed(item);
			}
		}
	}
}

/* --------------------------------------------------------------------------
 * Request validation
 * -------------------------------------------------------------------------- */

/**
 * Turn a failure into an HTTP error for the routes. yt-dlp's own messages
 * are what you need to see ("Video unavailable", "Sign in to confirm…"),
 * so they pass through as they are.
 */
export function httpError(err: unknown): never {
	if (err instanceof DownloadError) throw error(err.status, err.message);
	if (err instanceof YtdlpMissing) throw error(503, err.message);
	if (isHttpError(err)) throw err;
	throw error(502, errorText(err));
}

/** Options from the page, checked against the catalog. Throws DownloadError. */
export function parseDownloadOptions(raw: unknown, settings: DownloadSettings): DownloadOptions {
	const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const str = (k: string, d: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : d);
	const bool = (k: string, d: boolean) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : d);
	const num = (k: string): number | null => {
		const v = o[k];
		if (v === null || v === undefined || v === '') return null;
		const n = Number(v);
		if (!Number.isFinite(n) || n < 0) throw new DownloadError(`${k} must be a time in seconds.`);
		return n;
	};
	const pick = (k: string, d: string, choices: Choice[] | undefined) => {
		const v = str(k, d);
		if (choices && !choices.some((c) => c.id === v)) throw new DownloadError(`${k} must be one of ${choices.map((c) => c.id).join(', ')}.`);
		return v;
	};

	const type = str('type', 'video') as DownloadType;
	const entry = typeEntry(type);
	if (!entry) throw new DownloadError(`Unknown download type: ${type}`);
	const codec = entry.codecs ? pick('codec', 'auto', entry.codecs) : 'auto';
	const format = pick('format', entry.defaultFormat, entry.formats);
	const quality = pick('quality', 'best', formatEntry(type, format)?.qualities ?? [{ id: 'best', text: '' }]);
	const subtitleLanguage = str('subtitleLanguage', 'en') || 'en';
	if (!SUBTITLE_LANG.test(subtitleLanguage)) throw new DownloadError('Subtitle language is a code like en, pt-BR or zh-Hans.');
	const captions = str('captions', '');
	if (captions && !SUBTITLE_LANG.test(captions)) throw new DownloadError('Captions language is a code like en, pt-BR or zh-Hans.');
	const bin = str('bin', '');
	if (bin && !isValidBinName(bin)) throw new DownloadError(`Not a valid bin name: ${bin}`);
	const formatSpec = str('formatSpec', '');
	if (formatSpec.length > 300 || /[\r\n]/.test(formatSpec)) throw new DownloadError('Format selector is one line, up to 300 characters.');
	const clipStart = num('clipStart');
	const clipEnd = num('clipEnd');
	if (clipStart != null && clipEnd != null && clipEnd <= clipStart) throw new DownloadError('Clip end must come after clip start.');
	const chapterTemplate = str('chapterTemplate', '');
	if (chapterTemplate && !chapterTemplate.includes('%(ext)s')) throw new DownloadError('The chapter template needs %(ext)s.');
	const presets = Array.isArray(o.presets) ? o.presets.map(String).filter((p) => p in settings.presets) : [];
	const overrides = o.overrides ?? {};
	if (typeof overrides !== 'object' || Array.isArray(overrides) || overrides === null) throw new DownloadError('yt-dlp options must be a JSON object.');

	return {
		type,
		codec,
		format,
		quality,
		audioTags: pick('audioTags', 'with_cover', AUDIO_TAGS),
		subtitleLanguage,
		subtitleMode: pick('subtitleMode', 'prefer_manual', SUBTITLE_MODES),
		bin,
		binPerPlaylist: bool('binPerPlaylist', true),
		namePrefix: cleanForName(str('namePrefix', '')).slice(0, 60),
		formatSpec,
		captions: type === 'video' || type === 'audio' ? captions : '',
		playlistLimit: Math.max(0, Math.min(100_000, Math.round(Number(o.playlistLimit) || 0))),
		autoStart: bool('autoStart', true),
		splitChapters: bool('splitChapters', false),
		chapterTemplate,
		sponsorblock: bool('sponsorblock', false),
		clipStart: type === 'video' || type === 'audio' ? clipStart : null,
		clipEnd: type === 'video' || type === 'audio' ? clipEnd : null,
		presets,
		overrides: overrides as Record<string, unknown>,
	};
}

/**
 * One manager per server. In dev, editing a server file re-evaluates this
 * module: the old manager saves, stops its workers (their .part files stay)
 * and closes its event streams, and the new one picks the queue up from disk.
 */
const KEY = Symbol.for('waveweaver.downloads');
const g = globalThis as unknown as Record<symbol, DownloadManager | boolean | undefined>;
(g[KEY] as DownloadManager | undefined)?.dispose();
export const downloads = new DownloadManager();
g[KEY] = downloads;

const EXIT_HOOK = Symbol.for('waveweaver.downloads.exit');
if (!g[EXIT_HOOK]) {
	g[EXIT_HOOK] = true;
	process.once('exit', () => {
		for (const w of liveWorkers()) w.kill();
	});
}

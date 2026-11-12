import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { DownloadOptions, DownloadSettings, YtdlpStatus } from '$lib/downloads';
import { formatEntry } from '$lib/downloads';
import { CancelledError } from './ffmpeg.js';
import { ENGINE_DIR, pythonPath, VENV_DIR } from './engine.js';

/**
 * Bridge to yt-dlp. The studio starts `python -m engine.fetch` (the backend
 * venv's python, where yt-dlp is installed) once per download or probe,
 * exactly the way it starts ffmpeg: a child process per job, structured
 * output on stdout, killed on cancel. The worker only drives yt-dlp; the
 * queue, naming and bins live in server/downloads.ts.
 *
 * Nothing here needs the engine's HTTP server to be running.
 */

export interface WorkerEvent {
	event: string;
	[key: string]: unknown;
}

export interface Worker {
	child: ChildProcess;
	/** Ask yt-dlp to finish up. A live recording is closed cleanly and kept. */
	stop(): void;
	/** End it now, along with every ffmpeg it started. */
	kill(): void;
	/** Resolves with the exit code once the process is gone. */
	exited: Promise<number | null>;
}

const live = new Set<Worker>();

/** Windows: TerminateProcess only ends the python, not the ffmpeg it started. */
export function killTree(child: ChildProcess) {
	if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
	if (process.platform === 'win32') {
		spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
	} else {
		try {
			process.kill(-child.pid, 'SIGKILL');
		} catch {
			child.kill('SIGKILL');
		}
	}
}

export class YtdlpMissing extends Error {}

export function spawnWorker(
	job: Record<string, unknown>,
	onEvent: (e: WorkerEvent) => void,
	onStderr: (line: string) => void = () => {},
): Worker {
	const py = pythonPath();
	if (!py) {
		throw new YtdlpMissing(`No Python environment at ${VENV_DIR}. Install Python and yt-dlp from Setup.`);
	}
	const child = spawn(py, ['-m', 'engine.fetch'], {
		cwd: ENGINE_DIR,
		env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', WAVEWEAVER_NODE: process.execPath },
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
		// Its own process group on POSIX, so a kill reaches ffmpeg too.
		detached: process.platform !== 'win32',
	});
	child.stdin!.on('error', () => {});
	child.stdin!.write(`${JSON.stringify(job)}\n`);

	let buf = '';
	child.stdout!.on('data', (chunk: Buffer) => {
		buf += chunk.toString('utf8');
		const lines = buf.split(/\r?\n/);
		buf = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.startsWith('@ww ')) {
				if (line.trim()) onStderr(line);
				continue;
			}
			try {
				onEvent(JSON.parse(line.slice(4)) as WorkerEvent);
			} catch {
				onStderr(line);
			}
		}
	});
	let errBuf = '';
	child.stderr!.on('data', (chunk: Buffer) => {
		errBuf += chunk.toString('utf8');
		const lines = errBuf.split(/\r?\n/);
		errBuf = lines.pop() ?? '';
		for (const line of lines) if (line.trim()) onStderr(line);
	});

	const exited = new Promise<number | null>((res) => {
		child.on('error', (err) => {
			onEvent({ event: 'error', msg: `Could not start ${py}: ${err.message}` });
			res(null);
		});
		child.on('close', (code) => res(code));
	});
	const worker: Worker = {
		child,
		stop: () => {
			try {
				child.stdin!.write('stop\n');
			} catch {
				// already gone
			}
		},
		kill: () => killTree(child),
		exited,
	};
	live.add(worker);
	exited.finally(() => live.delete(worker));
	return worker;
}

/** Every worker still running — so a module reload or shutdown can stop them. */
export function liveWorkers(): Worker[] {
	return [...live];
}

/* --------------------------------------------------------------------------
 * One-shot jobs: probe, select, version
 * -------------------------------------------------------------------------- */

const MAX_PROBES = 4;
let probing = 0;
const probeWaiters: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
	if (probing >= MAX_PROBES) await new Promise<void>((r) => probeWaiters.push(r));
	probing++;
	try {
		return await fn();
	} finally {
		probing--;
		probeWaiters.shift()?.();
	}
}

/**
 * Run a job that answers with one `info` event. Rejects with the worker's
 * error message (yt-dlp's own words, with the warnings that led up to it).
 */
export function runOnce<T>(
	job: Record<string, unknown>,
	opts: { signal?: AbortSignal; timeoutMs?: number; onLog?: (line: string) => void } = {},
): Promise<{ info: T; raw: unknown }> {
	return slot(
		() =>
			new Promise((resolve, reject) => {
				if (opts.signal?.aborted) return reject(new CancelledError());
				let result: { info: T; raw: unknown } | null = null;
				let failure: string | null = null;
				const stderr: string[] = [];
				let worker: Worker;
				try {
					worker = spawnWorker(
						job,
						(e) => {
							if (e.event === 'info') result = { info: e.info as T, raw: e.raw ?? null };
							else if (e.event === 'error') failure = String(e.msg ?? 'yt-dlp failed');
							else if (e.event === 'log' && e.level !== 'info') opts.onLog?.(String(e.msg ?? ''));
						},
						(line) => {
							stderr.push(line);
							if (stderr.length > 30) stderr.shift();
						},
					);
				} catch (err) {
					return reject(err);
				}
				const timer = setTimeout(() => {
					failure = `yt-dlp didn't answer within ${Math.round((opts.timeoutMs ?? 0) / 1000)} s`;
					worker.kill();
				}, opts.timeoutMs ?? 180_000);
				const onAbort = () => worker.kill();
				opts.signal?.addEventListener('abort', onAbort, { once: true });
				worker.exited.then((code) => {
					clearTimeout(timer);
					opts.signal?.removeEventListener('abort', onAbort);
					if (opts.signal?.aborted) return reject(new CancelledError());
					if (result) return resolve(result);
					reject(new Error(failure ?? (stderr.join('\n').trim() || `yt-dlp worker exited ${code}`)));
				});
			}),
	);
}

let status: YtdlpStatus = {
	ready: false,
	ytdlp: null,
	ejs: null,
	python: null,
	node: null,
	error: null,
	cookies: false,
	updating: false,
};
let statusAt = 0;
let statusRun: Promise<YtdlpStatus> | null = null;

/** Which yt-dlp is installed (cached; `fresh` re-asks). */
export function ytdlpStatus(fresh = false): Promise<YtdlpStatus> {
	if (!fresh && statusAt && Date.now() - statusAt < 10 * 60_000) return Promise.resolve(status);
	statusRun ??= (async () => {
		try {
			const { info } = await runOnce<{ ytdlp: string; ejs: string | null; python: string; node: string | null }>(
				{ cmd: 'version' },
				{ timeoutMs: 30_000 },
			);
			status = { ...status, ready: true, ...info, error: null };
		} catch (err) {
			status = { ...status, ready: false, ytdlp: null, error: err instanceof Error ? err.message : String(err) };
		}
		statusAt = Date.now();
		return status;
	})().finally(() => {
		statusRun = null;
	});
	return statusRun;
}

export function cachedYtdlpStatus(): YtdlpStatus {
	return status;
}

export function setYtdlpFlags(flags: Partial<Pick<YtdlpStatus, 'cookies' | 'updating'>>) {
	status = { ...status, ...flags };
}

/**
 * Install or upgrade yt-dlp in the venv. Sites change constantly and yt-dlp
 * keeps up with frequent releases, so this is a button, not a setup step.
 */
export function installYtdlp(onLine: (line: string) => void): Promise<void> {
	const py = pythonPath();
	if (!py) return Promise.reject(new YtdlpMissing(`No Python environment at ${VENV_DIR}. Install Python from Setup.`));
	return new Promise((resolve, reject) => {
		const child = spawn(py, ['-m', 'pip', 'install', '-U', '--disable-pip-version-check', 'yt-dlp[default,curl-cffi]'], {
			cwd: ENGINE_DIR,
			windowsHide: true,
			env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
		});
		const forward = (b: Buffer) => {
			for (const line of b.toString('utf8').split(/\r?\n/)) if (line.trim()) onLine(line);
		};
		child.stdout.on('data', forward);
		child.stderr.on('data', forward);
		child.on('error', reject);
		child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pip exited ${code}`))));
	});
}

export function enginePresent(): boolean {
	return existsSync(ENGINE_DIR) && pythonPath() !== null;
}

/* --------------------------------------------------------------------------
 * Options → yt-dlp (the port of MeTube's dl_formats)
 * -------------------------------------------------------------------------- */

/** Every codec in the catalog other than "auto" needs an entry here. */
const CODEC_FILTER: Record<string, string> = {
	h264: "[vcodec~='^(h264|avc)']",
	h265: "[vcodec~='^(h265|hevc)']",
	av1: "[vcodec~='^av0?1']",
	vp9: "[vcodec~='^vp0?9']",
};

/**
 * FFmpegExtractAudio targets for "auto" audio, in yt-dlp's --audio-format
 * rule syntax. With tags, keep the codec the site served and only move it
 * into a container that can carry tags and a cover (YouTube's webm Opus →
 * .opus, by stream copy). Without tags, keep the audio exactly as served;
 * only the container changes when it's a video one. Unlike MeTube this
 * includes webm: the Library goes by extension, and an audio-only .webm
 * would show up as video.
 */
const AUTO_AUDIO_TAGGABLE = 'wav>flac/aiff>flac/wma>mp3/best';
const AUTO_AUDIO_AS_SERVED = ['webm', 'mp4', 'm4v', 'mov', 'mkv', 'flv', 'avi', '3gp', 'wmv', 'mpg', 'ogv'].map((e) => `${e}>best`).join('/');

/**
 * Keep the containers the studio reads as they are; remux anything else
 * (a live recording's .ts, an old .flv) into Matroska, which takes any codec.
 */
const VIDEO_REMUX = 'mp4>mp4/mkv>mkv/webm>webm/mov>mov/m4v>m4v/avi>avi/mkv';

export function formatSelector(o: DownloadOptions): string {
	if (o.formatSpec.trim()) return o.formatSpec.trim();
	if (o.type === 'thumbnail' || o.type === 'captions') return 'bestaudio/best';
	if (o.type === 'audio') return o.format === 'auto' ? 'bestaudio/best' : `bestaudio[ext=${o.format}]/bestaudio/best`;
	const [vfmt, afmt] = o.format === 'mp4' || o.format === 'ios' ? ['[ext=mp4]', '[ext=m4a]'] : ['', ''];
	if (o.quality === 'worst') return `worstvideo${vfmt}+worstaudio${afmt}/worst${vfmt}/worst`;
	const vres = o.quality !== 'best' ? `[height<=${o.quality}]` : '';
	const vcombo = vres + vfmt;
	if (o.format === 'ios') {
		const hevcOrAvc = "[vcodec~='^((he|a)vc|h26[45])']";
		return `bestvideo${hevcOrAvc}${vres}+bestaudio[acodec=aac]/bestvideo${hevcOrAvc}${vres}+bestaudio${afmt}/bestvideo${vcombo}+bestaudio${afmt}/best${vcombo}`;
	}
	const cf = CODEC_FILTER[o.codec];
	if (cf) return `bestvideo${cf}${vcombo}+bestaudio${afmt}/bestvideo${vcombo}+bestaudio${afmt}/best${vcombo}`;
	return `bestvideo${vcombo}+bestaudio${afmt}/best${vcombo}`;
}

type Params = Record<string, unknown>;
type Postprocessor = Record<string, unknown>;

function subtitleLangs(mode: string, lang: string): { writesubtitles: boolean; writeautomaticsub: boolean; subtitleslangs: string[] } {
	// `-orig` is YouTube's tag for the original-language auto captions.
	switch (mode) {
		case 'manual_only':
			return { writesubtitles: true, writeautomaticsub: false, subtitleslangs: [lang] };
		case 'auto_only':
			return { writesubtitles: false, writeautomaticsub: true, subtitleslangs: [`${lang}-orig`, lang] };
		case 'prefer_auto':
			return { writesubtitles: true, writeautomaticsub: true, subtitleslangs: [`${lang}-orig`, lang] };
		default:
			return { writesubtitles: true, writeautomaticsub: true, subtitleslangs: [lang, `${lang}-orig`] };
	}
}

/** The format selector and postprocessors for one download type. */
function typeParams(o: DownloadOptions, user: Params): { params: Params; postprocessors: Postprocessor[] } {
	const params: Params = { format: formatSelector(o) };
	const pps: Postprocessor[] = [];

	if (o.type === 'video') {
		pps.push({ key: 'FFmpegVideoRemuxer', preferedformat: VIDEO_REMUX });
	}

	if (o.type === 'audio') {
		const tags = o.audioTags;
		const preferredcodec = o.format === 'auto' ? (tags === 'none' ? AUTO_AUDIO_AS_SERVED : AUTO_AUDIO_TAGGABLE) : o.format;
		pps.push({ key: 'FFmpegExtractAudio', preferredcodec, preferredquality: o.quality === 'best' ? 0 : o.quality });
		// A writethumbnail key in your own options means you manage thumbnails
		// yourself, so the tagging chain stays off.
		const taggable = formatEntry('audio', o.format)?.tags ?? false;
		if (taggable && tags !== 'none' && !('writethumbnail' in user)) {
			if (tags === 'with_cover') {
				params.writethumbnail = true;
				pps.push({ key: 'FFmpegThumbnailsConvertor', format: 'jpg', when: 'before_dl' });
			}
			pps.push({ key: 'FFmpegMetadata' });
			if (tags === 'with_cover') pps.push({ key: 'EmbedThumbnail' });
		}
	}

	if (o.type === 'thumbnail') {
		params.skip_download = true;
		params.writethumbnail = true;
		pps.push({ key: 'FFmpegThumbnailsConvertor', format: 'jpg', when: 'before_dl' });
	}

	if (o.type === 'captions') {
		params.skip_download = true;
		const wanted = o.format === 'txt' ? 'srt' : o.format;
		params.subtitlesformat = `${wanted}/best`;
		// subtitlesformat is only a preference (YouTube has no native srt).
		// ffmpeg can convert to srt and vtt, so guarantee those two.
		if (wanted === 'srt' || wanted === 'vtt') pps.push({ key: 'FFmpegSubtitlesConvertor', format: wanted, when: 'before_dl' });
		Object.assign(params, subtitleLangs(o.subtitleMode, o.subtitleLanguage || 'en'));
	}

	// Captions alongside the media, imported as an editable caption track.
	// json3 first: YouTube's json3 carries per-word timings for auto
	// captions, which the Captions editor can reflow into proper subtitles.
	if ((o.type === 'video' || o.type === 'audio') && o.captions) {
		Object.assign(params, subtitleLangs('prefer_manual', o.captions));
		params.subtitlesformat = 'json3/vtt/srt/best';
	}
	return { params, postprocessors: pps };
}

/** yt-dlp's --limit-rate syntax: "500K", "4.2M". */
export function parseRate(text: string): number | null {
	const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?\s*$/i.exec(text);
	if (!m) return null;
	const exp = ' kmgt'.indexOf(m[2].toLowerCase() || ' ');
	return Math.round(Number(m[1]) * 1024 ** Math.max(0, exp));
}

/** Global options, then presets in order, then this download's overrides. */
function userOptions(o: DownloadOptions, settings: DownloadSettings): Params {
	const merged: Params = structuredClone(settings.ytdlOptions ?? {});
	for (const name of o.presets) Object.assign(merged, structuredClone(settings.presets[name] ?? {}));
	Object.assign(merged, structuredClone(o.overrides ?? {}));
	return merged;
}

function authParams(settings: DownloadSettings, cookiesFile: string | null, user: Params): Params {
	const p: Params = {};
	if (cookiesFile && !('cookiefile' in user)) p.cookiefile = cookiesFile;
	if (settings.cookiesFromBrowser && !('cookiesfrombrowser' in user)) p.cookiesfrombrowser = [settings.cookiesFromBrowser];
	return p;
}

/**
 * Options for a probe. With `select`, the same format and subtitle choice
 * the download would make, so Inspect can show exactly what will be
 * fetched; without, just enough to read the link (cookies, your options).
 * Nothing is ever written.
 */
export function probeParams(o: DownloadOptions, settings: DownloadSettings, cookiesFile: string | null, select = true): Params {
	const user = userOptions(o, settings);
	const { postprocessors: _pp, outtmpl: _o, paths: _p, ...rest } = user;
	const params = select ? typeParams(o, user).params : {};
	return { windowsfilenames: true, ...params, ...authParams(settings, cookiesFile, user), ...rest };
}

export interface DownloadJob {
	params: Params;
	/** A range for yt-dlp to download (ffmpeg seeks the remote file; cuts at keyframes). */
	clip: [number, number | null] | null;
	/** A range the studio cuts out of the finished download itself (exact). */
	cut: [number, number | null] | null;
}

/**
 * Up to this long, a clip is downloaded whole and cut locally. yt-dlp's
 * ranged download has ffmpeg seek inside the remote file, which YouTube's
 * fragmented MP4 streams make crawl at about real time, and which can only
 * cut at keyframes. A full download uses yt-dlp's fast chunked downloader,
 * and the local cut is exact — so captions line up too.
 */
const LOCAL_CUT_MAX_SECONDS = 2 * 3600;

/** Everything the worker needs to download one item. */
export function downloadJob(
	o: DownloadOptions,
	settings: DownloadSettings,
	template: string,
	cookiesFile: string | null,
	password: string | null,
	duration: number | null = null,
): DownloadJob {
	const user = userOptions(o, settings);
	const { params, postprocessors } = typeParams(o, user);
	const pps: Postprocessor[] = [...postprocessors, ...((user.postprocessors as Postprocessor[] | undefined) ?? [])];

	// SponsorBlock before chapter splitting: yt-dlp runs same-stage
	// postprocessors in list order, and the chapter list has to lose the
	// sponsor segments before the file is cut up by it.
	if (o.sponsorblock) {
		pps.push({ key: 'SponsorBlock', categories: ['sponsor'], when: 'after_filter' });
		pps.push({ key: 'ModifyChapters', remove_sponsor_segments: ['sponsor'], force_keyframes: false });
	}
	if (o.splitChapters) pps.push({ key: 'FFmpegSplitChapters', force_keyframes: false });

	const outtmpl: Params = {
		default: template,
		chapter: o.chapterTemplate || settings.chapterTemplate,
		...(typeof user.outtmpl === 'string' ? { default: user.outtmpl } : ((user.outtmpl as Params) ?? {})),
	};
	const rate = settings.rateLimit ? parseRate(settings.rateLimit) : null;
	const { postprocessors: _pp, outtmpl: _o, paths: _p, ...rest } = user;

	const merged: Params = {
		// Files end up on a Windows-safe name whatever the host, and short
		// enough that the work folder + name stays under MAX_PATH.
		windowsfilenames: true,
		trim_file_name: 120,
		noplaylist: true,
		...params,
		...(rate ? { ratelimit: rate } : {}),
		...authParams(settings, cookiesFile, user),
		...(password ? { videopassword: password } : {}),
		...rest,
		outtmpl,
		postprocessors: pps,
	};
	const range: [number, number | null] | null =
		(o.type === 'video' || o.type === 'audio') && (o.clipStart != null || o.clipEnd != null) ? [o.clipStart ?? 0, o.clipEnd] : null;
	const local = range !== null && duration !== null && duration <= LOCAL_CUT_MAX_SECONDS;
	return { params: merged, clip: local ? null : range, cut: local ? range : null };
}

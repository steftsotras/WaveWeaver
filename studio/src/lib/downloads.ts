/**
 * Downloads: the shared (client + server) vocabulary — what can be asked
 * for, what a queued download looks like, and the catalog of choices.
 *
 * The catalog is the one place the options are defined (as in MeTube's
 * format_catalog): the form renders it, the server validates against it,
 * and server/ytdlp.ts maps every entry onto a yt-dlp format selector and
 * postprocessors.
 */

export type DownloadType = 'video' | 'audio' | 'captions' | 'thumbnail';

export interface Choice {
	id: string;
	text: string;
}

interface FormatChoice extends Choice {
	qualities?: Choice[];
	/** Audio: whether tags and a cover can be written into this container. */
	tags?: boolean;
}

interface TypeEntry {
	id: DownloadType;
	text: string;
	codecs?: Choice[];
	formats: FormatChoice[];
	defaultFormat: string;
}

const VIDEO_QUALITIES: Choice[] = [
	{ id: 'best', text: 'Best' },
	{ id: '2160', text: '2160p' },
	{ id: '1440', text: '1440p' },
	{ id: '1080', text: '1080p' },
	{ id: '720', text: '720p' },
	{ id: '480', text: '480p' },
	{ id: '360', text: '360p' },
	{ id: '240', text: '240p' },
	{ id: 'worst', text: 'Worst' },
];

function audioQualities(...kbps: string[]): Choice[] {
	return [{ id: 'best', text: 'Best' }, ...kbps.map((k) => ({ id: k, text: `${k} kbps` }))];
}

export const CATALOG: TypeEntry[] = [
	{
		id: 'video',
		text: 'Video',
		codecs: [
			{ id: 'auto', text: 'Auto' },
			{ id: 'h264', text: 'H.264' },
			{ id: 'h265', text: 'H.265' },
			{ id: 'av1', text: 'AV1' },
			{ id: 'vp9', text: 'VP9' },
		],
		formats: [
			{ id: 'any', text: 'Auto', qualities: VIDEO_QUALITIES },
			{ id: 'mp4', text: 'MP4', qualities: VIDEO_QUALITIES },
			{ id: 'ios', text: 'iOS compatible', qualities: VIDEO_QUALITIES },
		],
		defaultFormat: 'any',
	},
	{
		id: 'audio',
		text: 'Audio',
		formats: [
			{ id: 'auto', text: 'Auto', qualities: audioQualities(), tags: true },
			{ id: 'm4a', text: 'M4A', qualities: audioQualities('192', '128'), tags: true },
			{ id: 'mp3', text: 'MP3', qualities: audioQualities('320', '192', '128'), tags: true },
			{ id: 'opus', text: 'Opus', qualities: audioQualities(), tags: true },
			{ id: 'wav', text: 'WAV', qualities: audioQualities(), tags: false },
			{ id: 'flac', text: 'FLAC', qualities: audioQualities(), tags: true },
		],
		defaultFormat: 'm4a',
	},
	{
		id: 'captions',
		text: 'Captions',
		formats: [
			{ id: 'srt', text: 'SRT' },
			{ id: 'txt', text: 'TXT' },
			{ id: 'vtt', text: 'VTT' },
			{ id: 'ttml', text: 'TTML' },
			{ id: 'sbv', text: 'SBV' },
			{ id: 'scc', text: 'SCC' },
			{ id: 'dfxp', text: 'DFXP' },
		],
		defaultFormat: 'srt',
	},
	{
		id: 'thumbnail',
		text: 'Thumbnail',
		formats: [{ id: 'jpg', text: 'JPG' }],
		defaultFormat: 'jpg',
	},
];

export const AUDIO_TAGS: Choice[] = [
	{ id: 'with_cover', text: 'Tags + cover' },
	{ id: 'no_cover', text: 'Tags only' },
	{ id: 'none', text: 'As served' },
];

export const SUBTITLE_MODES: Choice[] = [
	{ id: 'prefer_manual', text: 'Prefer manual' },
	{ id: 'prefer_auto', text: 'Prefer auto' },
	{ id: 'manual_only', text: 'Manual only' },
	{ id: 'auto_only', text: 'Auto only' },
];

/** Suggestions; any tag matching SUBTITLE_LANG is accepted. */
export const SUBTITLE_LANGUAGES: Choice[] = [
	['en', 'English'], ['el', 'Greek'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
	['pt', 'Portuguese'], ['pt-BR', 'Portuguese (Brazil)'], ['nl', 'Dutch'], ['pl', 'Polish'], ['tr', 'Turkish'],
	['ru', 'Russian'], ['uk', 'Ukrainian'], ['ar', 'Arabic'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['bn', 'Bengali'],
	['ja', 'Japanese'], ['ko', 'Korean'], ['zh-Hans', 'Chinese (Simplified)'], ['zh-Hant', 'Chinese (Traditional)'],
	['sv', 'Swedish'], ['no', 'Norwegian'], ['da', 'Danish'], ['fi', 'Finnish'], ['ro', 'Romanian'], ['bg', 'Bulgarian'],
	['cs', 'Czech'], ['sk', 'Slovak'], ['hu', 'Hungarian'], ['sr', 'Serbian'], ['ca', 'Catalan'], ['id', 'Indonesian'],
	['ms', 'Malay'], ['th', 'Thai'], ['vi', 'Vietnamese'], ['ta', 'Tamil'], ['te', 'Telugu'], ['ur', 'Urdu'],
].map(([id, text]) => ({ id, text }));

export const SUBTITLE_LANG = /^[A-Za-z0-9][A-Za-z0-9-]{0,34}$/;

export function typeEntry(type: string): TypeEntry | undefined {
	return CATALOG.find((t) => t.id === type);
}

export function formatEntry(type: string, format: string): FormatChoice | undefined {
	return typeEntry(type)?.formats.find((f) => f.id === format);
}

/**
 * Everything a download is asked for, besides the URL. One value, carried
 * whole through add → playlist expansion → retry → subscriptions, so an
 * option can't get dropped on one of those paths.
 */
export interface DownloadOptions {
	type: DownloadType;
	codec: string;
	format: string;
	quality: string;
	audioTags: string;
	subtitleLanguage: string;
	subtitleMode: string;
	/** Where the files land. Empty = the default bin from settings. */
	bin: string;
	/** A playlist or channel gets a bin of its own, named after it. */
	binPerPlaylist: boolean;
	namePrefix: string;
	/** A yt-dlp format selector (`-f`) that replaces type/codec/quality. */
	formatSpec: string;
	/** Video/audio: also fetch this language's captions as an editable track. */
	captions: string;
	playlistLimit: number;
	autoStart: boolean;
	splitChapters: boolean;
	chapterTemplate: string;
	sponsorblock: boolean;
	clipStart: number | null;
	clipEnd: number | null;
	presets: string[];
	/** Raw yt-dlp API options for this download only. */
	overrides: Record<string, unknown>;
}

export const DEFAULT_OPTIONS: DownloadOptions = {
	type: 'video',
	codec: 'auto',
	format: 'any',
	quality: 'best',
	audioTags: 'with_cover',
	subtitleLanguage: 'en',
	subtitleMode: 'prefer_manual',
	bin: '',
	binPerPlaylist: true,
	namePrefix: '',
	formatSpec: '',
	captions: '',
	playlistLimit: 0,
	autoStart: true,
	splitChapters: false,
	chapterTemplate: '',
	sponsorblock: false,
	clipStart: null,
	clipEnd: null,
	presets: [],
	overrides: {},
};

/**
 * pending:   added with auto-start off — waits for Start
 * paused:    stopped by you; the partial download is kept and resumes
 * queued:    waiting for a free slot
 * scheduled: an upcoming live stream; starts when it goes live
 * preparing → downloading → postprocessing: running
 * done / error: finished (the row stays until you clear it)
 */
export type DownloadStatus =
	| 'pending'
	| 'paused'
	| 'queued'
	| 'scheduled'
	| 'preparing'
	| 'downloading'
	| 'postprocessing'
	| 'done'
	| 'error';

export const RUNNING: DownloadStatus[] = ['preparing', 'downloading', 'postprocessing'];
export const WAITING: DownloadStatus[] = ['pending', 'paused', 'queued', 'scheduled'];

export function isRunning(s: DownloadStatus): boolean {
	return RUNNING.includes(s);
}

export function isFinished(s: DownloadStatus): boolean {
	return s === 'done' || s === 'error';
}

/** Where each file a download produced ended up. */
export interface DownloadFile {
	/** main · chapter · subtitle · thumbnail · other */
	role: 'main' | 'chapter' | 'subtitle' | 'thumbnail' | 'other';
	bin: string;
	/** sources (media, shows in the Library) · captions · extras */
	folder: 'sources' | 'captions' | 'extras';
	name: string;
	sizeBytes: number;
}

export interface DownloadProgress {
	/** What's happening right now: "video", "audio", "merging", "tagging"… */
	phase: string | null;
	ratio: number | null;
	downloaded: number | null;
	total: number | null;
	/** Bytes per second. */
	speed: number | null;
	/** Seconds. */
	eta: number | null;
	fragment: [number, number] | null;
}

export interface DownloadItem {
	id: string;
	url: string;
	title: string;
	status: DownloadStatus;
	options: DownloadOptions;
	/** The bin it lands in (resolved when it was added). */
	bin: string;
	/** yt-dlp output template, playlist fields already filled in. */
	template: string;
	thumbnail: string | null;
	duration: number | null;
	uploader: string | null;
	playlist: { title: string; index: number; count: number } | null;
	live: string | null;
	/** Upcoming live stream: when it's due to start (ms). */
	releaseAt: number | null;
	progress: DownloadProgress;
	files: DownloadFile[];
	/** Languages imported as caption tracks on the main file. */
	captions: string[];
	error: string | null;
	warnings: string[];
	subscription: string | null;
	/** Failed before it became a download (the link couldn't be read). Retry reads it again. */
	unresolved: boolean;
	attempts: number;
	createdAt: number;
	startedAt: number | null;
	finishedAt: number | null;
}

export interface Subscription {
	id: string;
	name: string;
	url: string;
	enabled: boolean;
	intervalMinutes: number;
	options: DownloadOptions;
	/** Only titles matching this (JavaScript) regex are queued. Empty = all. */
	titleFilter: string;
	skipMembersOnly: boolean;
	lastChecked: number | null;
	/** How many new entries the last check queued. */
	lastFound: number;
	seenCount: number;
	checking: boolean;
	error: string | null;
	createdAt: number;
}

export type DeleteFilesMode = 'never' | 'ask' | 'always';

export interface DownloadSettings {
	concurrency: number;
	defaultBin: string;
	/** yt-dlp output templates. */
	template: string;
	playlistTemplate: string;
	channelTemplate: string;
	chapterTemplate: string;
	/** e.g. "5M" — bytes per second, yt-dlp's --limit-rate. Empty = unlimited. */
	rateLimit: string;
	/** Hours before finished rows clear themselves. 0 = never. */
	clearAfterHours: number;
	deleteFiles: DeleteFilesMode;
	/** yt-dlp --cookies-from-browser, e.g. "firefox". Empty = off. */
	cookiesFromBrowser: string;
	/** yt-dlp API options for every download. */
	ytdlOptions: Record<string, unknown>;
	/** Named option bundles, picked per download. */
	presets: Record<string, Record<string, unknown>>;
	/** Newest entries read on each subscription check. */
	subscriptionScan: number;
}

export const DEFAULT_SETTINGS: DownloadSettings = {
	concurrency: 3,
	defaultBin: 'inbox',
	template: '%(title)s.%(ext)s',
	playlistTemplate: '%(playlist_index)s - %(title)s.%(ext)s',
	channelTemplate: '%(title)s.%(ext)s',
	chapterTemplate: '%(title)s - %(section_number)02d - %(section_title)s.%(ext)s',
	rateLimit: '',
	clearAfterHours: 0,
	deleteFiles: 'ask',
	cookiesFromBrowser: '',
	ytdlOptions: {},
	presets: {},
	subscriptionScan: 50,
};

export const COOKIE_BROWSERS = ['firefox', 'chrome', 'edge', 'brave', 'chromium', 'opera', 'vivaldi', 'safari'];

/** What the page needs to know about the yt-dlp install. */
export interface YtdlpStatus {
	ready: boolean;
	ytdlp: string | null;
	ejs: string | null;
	python: string | null;
	node: string | null;
	error: string | null;
	cookies: boolean;
	updating: boolean;
}

/** A URL being expanded into downloads (a playlist can take a while). */
export interface AddingState {
	url: string;
	title: string | null;
	added: number;
	total: number | null;
}

export type DownloadEvent =
	| {
			type: 'snapshot';
			items: DownloadItem[];
			subscriptions: Subscription[];
			settings: DownloadSettings;
			adding: AddingState | null;
			ytdlp: YtdlpStatus;
	  }
	| { type: 'item'; item: DownloadItem }
	| { type: 'remove'; ids: string[] }
	| { type: 'subscriptions'; subscriptions: Subscription[] }
	| { type: 'settings'; settings: DownloadSettings }
	| { type: 'adding'; adding: AddingState | null }
	| { type: 'ytdlp'; ytdlp: YtdlpStatus }
	| { type: 'notice'; level: 'info' | 'error'; message: string };

/* --------------------------------------------------------------------------
 * Probe results (Inspect)
 * -------------------------------------------------------------------------- */

export interface ProbeFormat {
	id: string;
	ext: string;
	width: number | null;
	height: number | null;
	fps: number | null;
	vcodec: string | null;
	acodec: string | null;
	abr: number | null;
	vbr: number | null;
	tbr: number | null;
	asr: number | null;
	channels: number | null;
	size: number | null;
	approx: boolean;
	note: string | null;
	protocol: string | null;
	hdr: string | null;
	language: string | null;
}

export interface ProbeSelection {
	ids: string[];
	ext: string;
	width: number | null;
	height: number | null;
	fps: number | null;
	vcodec: string | null;
	acodec: string | null;
	size: number | null;
	approx: boolean;
	subtitles: string[];
}

export interface ProbeEntry {
	id: string | null;
	url: string;
	title: string;
	duration: number | null;
	thumbnail: string | null;
	uploader: string | null;
	live_status: string | null;
	availability: string | null;
	release_timestamp: number | null;
	timestamp: number | null;
	view_count: number | null;
	type: string;
}

export interface ProbeInfo {
	type: 'video' | 'playlist' | 'multi_video' | 'url' | 'url_transparent';
	id: string | null;
	title: string | null;
	url: string | null;
	extractor: string | null;
	uploader: string | null;
	uploader_url: string | null;
	channel: string | null;
	channel_id: string | null;
	uploader_id: string | null;
	duration: number | null;
	upload_date: string | null;
	timestamp: number | null;
	thumbnail: string | null;
	live_status: string | null;
	release_timestamp: number | null;
	availability: string | null;
	view_count: number | null;
	description: string | null;
	formats?: ProbeFormat[];
	chapters?: { start: number | null; end: number | null; title: string | null }[];
	subtitles?: Record<string, { exts: string[]; name: string | null }>;
	auto_captions?: Record<string, { exts: string[]; name: string | null }>;
	selected?: ProbeSelection | null;
	entries?: ProbeEntry[];
	playlist_count?: number;
}

/* --------------------------------------------------------------------------
 * Formatting
 * -------------------------------------------------------------------------- */

export function formatSpeed(bps: number | null | undefined): string {
	if (bps == null || !Number.isFinite(bps) || bps <= 0) return '—';
	if (bps < 1024) return `${Math.round(bps)} B/s`;
	if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(0)} KB/s`;
	return `${(bps / 1024 ** 2).toFixed(bps < 10 * 1024 ** 2 ? 1 : 0)} MB/s`;
}

export function formatEta(sec: number | null | undefined): string {
	if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
	const s = Math.round(sec);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
	return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** "M:SS", "H:MM:SS" or plain seconds → seconds. Null when blank, NaN when unreadable. */
export function parseClock(text: string): number | null {
	const t = text.trim();
	if (!t) return null;
	if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
	const parts = t.split(':');
	if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN;
	return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '') || url;
	} catch {
		return url;
	}
}

/** One line describing what a download asks for: "Video · 1080p · H.264". */
export function optionsLine(o: DownloadOptions): string {
	if (o.formatSpec) return `${typeEntry(o.type)?.text ?? o.type} · -f ${o.formatSpec}`;
	const t = typeEntry(o.type);
	const f = formatEntry(o.type, o.format);
	const parts = [t?.text ?? o.type];
	if (o.type === 'video') {
		if (o.quality !== 'best') parts.push(VIDEO_QUALITIES.find((q) => q.id === o.quality)?.text ?? o.quality);
		if (o.codec !== 'auto') parts.push(t?.codecs?.find((c) => c.id === o.codec)?.text ?? o.codec);
		if (o.format !== 'any') parts.push(f?.text ?? o.format);
	} else if (o.type === 'audio') {
		parts.push(f?.text ?? o.format);
		if (o.quality !== 'best') parts.push(`${o.quality}k`);
	} else if (o.type === 'captions') {
		parts.push(o.subtitleLanguage, f?.text ?? o.format);
	}
	if (o.clipStart != null || o.clipEnd != null) parts.push('clip');
	return parts.join(' · ');
}

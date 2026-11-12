/**
 * Shared (client + server) media vocabulary: kinds, extensions, URL builders
 * and the human formatting used across every page.
 */

export const MEDIA_KINDS = ['sources', 'renders'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v']);
export const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.opus']);
/** Stills and GIFs only ever come out of WaveWeaver; you can't upload them. */
export const IMAGE_EXTS = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp']);

export type MediaType = 'video' | 'audio' | 'image';

export function extOf(name: string): string {
	const i = name.lastIndexOf('.');
	return i === -1 ? '' : name.slice(i).toLowerCase();
}

export function stemOf(name: string): string {
	const i = name.lastIndexOf('.');
	return i <= 0 ? name : name.slice(0, i);
}

export function mediaTypeOf(name: string): MediaType | null {
	const ext = extOf(name);
	if (VIDEO_EXTS.has(ext)) return 'video';
	if (AUDIO_EXTS.has(ext)) return 'audio';
	if (IMAGE_EXTS.has(ext)) return 'image';
	return null;
}

export function isUploadable(name: string): boolean {
	const ext = extOf(name);
	return VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext);
}

export interface VideoStreamInfo {
	codec: string | null;
	width: number;
	height: number;
	fps: number | null;
}

export interface AudioStreamInfo {
	codec: string | null;
	channels: number;
	sampleRate: number | null;
	/** The audio stream's own length — can stop short of the container's. */
	duration?: number | null;
}

export interface MediaInfo {
	duration: number | null;
	container: string | null;
	bitrateKbps: number | null;
	video: VideoStreamInfo | null;
	audio: AudioStreamInfo | null;
}

export interface MediaFile {
	bin: string;
	kind: MediaKind;
	name: string;
	type: MediaType;
	sizeBytes: number;
	modified: number;
	info: MediaInfo | null;
}

function seg(s: string): string {
	return encodeURIComponent(s);
}

export interface MediaRefLike {
	bin: string;
	kind: MediaKind;
	name: string;
}

export function mediaUrl(r: MediaRefLike): string {
	return `/api/media/${seg(r.bin)}/${r.kind}/${seg(r.name)}`;
}

export function thumbUrl(r: MediaRefLike): string {
	return `/api/thumb/${seg(r.bin)}/${r.kind}/${seg(r.name)}`;
}

export function peaksUrl(r: MediaRefLike): string {
	return `/api/peaks/${seg(r.bin)}/${r.kind}/${seg(r.name)}`;
}

export function deskUrl(r: MediaRefLike): string {
	return `/desk?bin=${seg(r.bin)}&kind=${r.kind}&file=${seg(r.name)}`;
}

export function refKey(r: MediaRefLike): string {
	return `${r.bin}/${r.kind}/${r.name}`;
}

/** 83.4 → "1:23", 3725 → "1:02:05". Null/zero → "—". */
export function formatDuration(sec: number | null | undefined): string {
	if (sec == null || !Number.isFinite(sec) || sec <= 0) return '—';
	const total = Math.round(sec);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const ss = String(s).padStart(2, '0');
	if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
	return `${m}:${ss}`;
}

/** Timecode with tenths, for the waveform and step inputs: "1:23.4". */
export function formatTimecode(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) sec = 0;
	const m = Math.floor(sec / 60);
	const s = sec - m * 60;
	return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Long-form runtime for stat rows: "4.2h", "38m", "52s". */
export function formatRuntime(sec: number): string {
	if (!sec || sec <= 0) return '0s';
	if (sec >= 3600) return `${(sec / 3600).toFixed(1)}h`;
	if (sec >= 60) return `${Math.round(sec / 60)}m`;
	return `${Math.round(sec)}s`;
}

export function formatBytes(bytes: number | null | undefined): string {
	if (bytes == null || !Number.isFinite(bytes)) return '—';
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let v = bytes / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatResolution(info: MediaInfo | null): string {
	if (!info?.video) return '—';
	return `${info.video.width}×${info.video.height}`;
}

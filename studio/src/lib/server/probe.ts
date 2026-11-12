import { stat } from 'node:fs/promises';
import type { MediaInfo } from '$lib/media';
import { runCapture } from './ffmpeg.js';

interface FfprobeStream {
	codec_type?: string;
	codec_name?: string;
	width?: number;
	height?: number;
	avg_frame_rate?: string;
	r_frame_rate?: string;
	channels?: number;
	sample_rate?: string;
	duration?: string;
	disposition?: { attached_pic?: number };
	tags?: { rotate?: string };
	side_data_list?: { rotation?: number }[];
}

interface FfprobeOutput {
	streams?: FfprobeStream[];
	format?: { duration?: string; format_name?: string; bit_rate?: string };
}

function parseRate(rate: string | undefined): number | null {
	if (!rate) return null;
	const [n, d] = rate.split('/').map(Number);
	if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n === 0) return null;
	return Math.round((n / d) * 1000) / 1000;
}

function rotationOf(s: FfprobeStream): number {
	const fromSide = s.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation;
	const raw = fromSide ?? (s.tags?.rotate ? Number(s.tags.rotate) : 0);
	return ((Math.round(raw / 90) * 90) % 360 + 360) % 360;
}

/**
 * ffprobe a file down to the handful of facts the UI and the weave compiler
 * care about. Two traps handled here:
 *
 *  - MP3s with cover art report a "video" stream. It's an attached picture,
 *    not footage, so it's ignored.
 *  - Phone footage stores rotation as metadata. ffmpeg auto-rotates frames
 *    on decode, so width/height are swapped here to match what the filter
 *    graph will actually see.
 */
export async function probeFile(path: string): Promise<MediaInfo> {
	const { stdout, code, stderr } = await runCapture('ffprobe', [
		'-v',
		'error',
		'-print_format',
		'json',
		'-show_format',
		'-show_streams',
		path,
	]);
	if (code !== 0) throw new Error(`ffprobe failed: ${stderr.trim().slice(-300)}`);
	const data = JSON.parse(stdout) as FfprobeOutput;
	const streams = data.streams ?? [];
	const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
	const a = streams.find((s) => s.codec_type === 'audio');
	const duration = Number(data.format?.duration);
	const bitrate = Number(data.format?.bit_rate);

	let video: MediaInfo['video'] = null;
	if (v && v.width && v.height) {
		const sideways = rotationOf(v) % 180 === 90;
		video = {
			codec: v.codec_name ?? null,
			width: sideways ? v.height : v.width,
			height: sideways ? v.width : v.height,
			fps: parseRate(v.avg_frame_rate) ?? parseRate(v.r_frame_rate),
		};
	}

	return {
		duration: Number.isFinite(duration) && duration > 0 ? duration : null,
		container: data.format?.format_name ?? null,
		bitrateKbps: Number.isFinite(bitrate) ? Math.round(bitrate / 1000) : null,
		video,
		audio: a
			? {
					codec: a.codec_name ?? null,
					channels: a.channels ?? 2,
					sampleRate: a.sample_rate ? Number(a.sample_rate) : null,
					duration: Number(a.duration) > 0 ? Number(a.duration) : null,
				}
			: null,
	};
}

/**
 * Probe results keyed by path and invalidated by size+mtime. The library
 * page probes every file on load, so this matters: ffprobe costs ~50–100ms
 * per file on Windows.
 */
const cache = new Map<string, { sig: string; info: MediaInfo }>();

export async function probeCached(path: string): Promise<MediaInfo> {
	const st = await stat(path);
	const sig = `${st.size}:${st.mtimeMs}`;
	const hit = cache.get(path);
	if (hit && hit.sig === sig) return hit.info;
	const info = await probeFile(path);
	cache.set(path, { sig, info });
	return info;
}

export function forgetProbe(path: string): void {
	cache.delete(path);
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	async function worker() {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

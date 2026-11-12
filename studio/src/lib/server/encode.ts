import type { OutputFormat, Quality } from '$lib/weave';

/**
 * Encoder flags per output format and quality tier. One table so the weave,
 * stitch and split pipelines all produce files that look and sound the same.
 *
 *   draft    — fast previews; fine for checking a cut
 *   standard — what you'd post
 *   high     — archival-ish; slow presets, low CRF
 */
const X264 = {
	draft: { preset: 'ultrafast', crf: '28', ab: '128k' },
	standard: { preset: 'veryfast', crf: '20', ab: '192k' },
	high: { preset: 'slow', crf: '17', ab: '256k' },
};

const VP9 = {
	draft: { crf: '40', deadline: 'realtime', cpu: '8', ab: '96k' },
	standard: { crf: '32', deadline: 'good', cpu: '4', ab: '128k' },
	high: { crf: '26', deadline: 'good', cpu: '2', ab: '160k' },
};

const MP3_Q = { draft: '6', standard: '2', high: '0' };
const VORBIS_Q = { draft: '3', standard: '5', high: '7' };
const OPUS_B = { draft: '64k', standard: '96k', high: '160k' };
const AAC_B = { draft: '128k', standard: '192k', high: '256k' };

export function encoderArgs(
	format: OutputFormat,
	quality: Quality,
	streams: { video: boolean; audio: boolean },
): string[] {
	switch (format) {
		case 'mp4': {
			const q = X264[quality];
			return [
				...(streams.video
					? ['-c:v', 'libx264', '-preset', q.preset, '-crf', q.crf, '-pix_fmt', 'yuv420p']
					: []),
				...(streams.audio ? ['-c:a', 'aac', '-b:a', q.ab] : []),
				'-movflags',
				'+faststart',
			];
		}
		case 'webm': {
			const q = VP9[quality];
			return [
				...(streams.video
					? [
							'-c:v',
							'libvpx-vp9',
							'-crf',
							q.crf,
							'-b:v',
							'0',
							'-row-mt',
							'1',
							'-deadline',
							q.deadline,
							'-cpu-used',
							q.cpu,
							'-pix_fmt',
							'yuv420p',
						]
					: []),
				...(streams.audio ? ['-c:a', 'libopus', '-b:a', q.ab] : []),
			];
		}
		case 'gif':
			return ['-loop', '0'];
		case 'mp3':
			return ['-c:a', 'libmp3lame', '-q:a', MP3_Q[quality]];
		case 'wav':
			return ['-c:a', 'pcm_s16le'];
		case 'flac':
			return ['-c:a', 'flac', '-compression_level', '5'];
		case 'ogg':
			return ['-c:a', 'libvorbis', '-q:a', VORBIS_Q[quality]];
		case 'opus':
			return ['-c:a', 'libopus', '-b:a', OPUS_B[quality]];
		case 'm4a':
			return ['-c:a', 'aac', '-b:a', AAC_B[quality], '-movflags', '+faststart'];
	}
}

/** Canvas sizes used when WaveWeaver has to invent a picture. */
export const CANVAS: Record<string, { w: number; h: number }> = {
	'16:9': { w: 1280, h: 720 },
	'9:16': { w: 720, h: 1280 },
	'1:1': { w: 1080, h: 1080 },
	'4:5': { w: 1080, h: 1350 },
	'4:3': { w: 960, h: 720 },
	'21:9': { w: 1680, h: 720 },
};

export function even(n: number): number {
	return Math.max(2, Math.round(n / 2) * 2);
}

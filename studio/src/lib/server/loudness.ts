import type { Loudness } from '$lib/jobs';
import { runFfmpeg } from './ffmpeg.js';

/**
 * EBU R128 integrated loudness, loudness range and true peak, via ffmpeg's
 * ebur128 meter. Used on preview excerpts so A/B comparisons show numbers,
 * not just ears: "B is −14.0 LUFS, peak −1.0 dBTP".
 */
export async function measureLoudness(path: string, signal?: AbortSignal): Promise<Loudness> {
	const stderr = await runFfmpeg(['-i', path, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], {
		loglevel: 'info',
		forwardStderr: false,
		signal,
	});
	const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
	const grab = (label: string): number | null => {
		const m = new RegExp(`${label}\\s+(-?[\\d.]+|-inf)`).exec(summary);
		if (!m || m[1] === '-inf') return null;
		const v = parseFloat(m[1]);
		return Number.isFinite(v) ? v : null;
	};
	return { lufs: grab('I:'), lra: grab('LRA:'), truePeak: grab('Peak:') };
}

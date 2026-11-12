import type { JobResult } from '$lib/jobs';
import { stemOf } from '$lib/media';
import type { JobContext } from '../jobs.js';
import { resolveMedia, type MediaRef } from '../paths.js';
import { probeCached } from '../probe.js';
import { encodeTo, renderPath } from './common.js';

export interface SnapshotParams {
	source: MediaRef;
	mode: 'frame' | 'sheet';
	/** Seconds into the source (frame mode). */
	at: number;
	cols: number;
	rows: number;
}

/**
 * Stills from a video: a single full-resolution frame, or a contact sheet of
 * evenly spaced frames — the fastest way to see what's in a long file.
 */
export async function runSnapshot(params: SnapshotParams, ctx: JobContext): Promise<JobResult> {
	const path = await resolveMedia(params.source);
	const info = await probeCached(path);
	if (!info.video) throw new Error('Snapshots need a video stream.');
	const D = info.duration ?? 0;
	const stem = stemOf(params.source.name);
	ctx.phase('render');

	if (params.mode === 'frame') {
		const at = Math.min(Math.max(0, params.at), Math.max(0, D - 0.05));
		const tag = `frame-${at.toFixed(1).replace('.', 's')}`;
		const out = await renderPath(params.source.bin, stem, tag, 'png');
		const output = await encodeTo(out, ['-ss', at.toFixed(3), '-i', path, '-frames:v', '1', '-update', '1'], ctx, {
			graph: null,
			expectedDuration: null,
		});
		return { outputs: [output] };
	}

	// Skip the first 2% (black leaders, logos), then take one frame every
	// (remaining / cells) seconds and tile them.
	const cells = params.cols * params.rows;
	const skip = D * 0.02;
	const every = Math.max(0.04, (D - skip) / cells);
	const vf = [
		`fps=1/${every.toFixed(4)}`,
		'scale=360:-2',
		`tile=${params.cols}x${params.rows}:padding=6:margin=6:color=white`,
	].join(',');
	const out = await renderPath(params.source.bin, stem, `sheet-${params.cols}x${params.rows}`, 'png');
	const output = await encodeTo(out, ['-ss', skip.toFixed(3), '-i', path, '-vf', vf, '-frames:v', '1', '-update', '1'], ctx, {
		graph: null,
		expectedDuration: D - skip,
	});
	return { outputs: [output] };
}

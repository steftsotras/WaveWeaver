import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobResult, PreviewResult, PreviewSide } from '$lib/jobs';
import { mediaTypeOf, type MediaInfo } from '$lib/media';
import { isVideoFormat, newStep, type OutputSpec, type Step } from '$lib/weave';
import { runEngine } from '../engine.js';
import type { JobContext } from '../jobs.js';
import { measureLoudness } from '../loudness.js';
import { CACHE_DIR, resolveMedia, type MediaRef } from '../paths.js';
import { probeCached } from '../probe.js';
import { encodeFile, graphArgs } from './common.js';
import { compileResolved } from './weave.js';

/**
 * Previews: before a tool touches a two-hour file, run it on a short
 * excerpt and hear both versions side by side.
 *
 * Every preview produces two files in media/.cache/previews/<job id>/:
 *   a.*  the untouched excerpt (the "before")
 *   b.*  the same excerpt through the weave / tool / mix (the "after")
 * plus EBU R128 loudness for both, so the comparison has numbers.
 *
 * Previews run in their own job lane, so they never wait behind renders.
 */

export const PREVIEW_DIR = join(CACHE_DIR, 'previews');
const MAX_WINDOW = 90;
const KEEP_PREVIEWS = 40;

export interface PreviewWindow {
	start: number;
	duration: number;
}

export type PreviewParams =
	| { kind: 'weave'; source: MediaRef; window: PreviewWindow; steps: Step[]; output: OutputSpec }
	| { kind: 'tool'; source: MediaRef; window: PreviewWindow; tool: string; params: Record<string, unknown> };

export function clampWindow(w: PreviewWindow, duration: number | null): PreviewWindow {
	const D = duration ?? w.start + w.duration;
	const start = Math.min(Math.max(0, w.start), Math.max(0, D - 0.5));
	return { start, duration: Math.max(0.5, Math.min(w.duration, MAX_WINDOW, D - start)) };
}

/** Delete all but the newest previews. They're cheap to remake. */
async function prune(): Promise<void> {
	const dirs = await readdir(PREVIEW_DIR).catch(() => [] as string[]);
	const withTimes = await Promise.all(
		dirs.map(async (d) => ({ d, t: (await stat(join(PREVIEW_DIR, d)).catch(() => null))?.mtimeMs ?? 0 })),
	);
	withTimes.sort((a, b) => b.t - a.t);
	await Promise.all(withTimes.slice(KEEP_PREVIEWS).map(({ d }) => rm(join(PREVIEW_DIR, d), { recursive: true, force: true })));
}

export function previewUrl(id: string, file: string): string {
	return `/api/previews/${id}/${file}`;
}

/** The "before": the same window, untouched — video if B will be video, else lossless WAV. */
export async function renderOriginal(
	path: string,
	info: MediaInfo,
	w: PreviewWindow,
	video: boolean,
	dir: string,
	ctx: JobContext,
): Promise<string> {
	const seek = ['-ss', w.start.toFixed(3), '-t', w.duration.toFixed(3), '-i', path];
	if (video && info.video) {
		const out = join(dir, 'a.mp4');
		await encodeFile(
			out,
			[...seek, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', ...(info.audio ? ['-c:a', 'aac', '-b:a', '192k'] : []), '-movflags', '+faststart'],
			ctx,
			{ graph: null, expectedDuration: w.duration },
		);
		return out;
	}
	const out = join(dir, 'a.wav');
	await encodeFile(out, [...seek, '-vn', '-ar', '48000', '-c:a', 'pcm_s16le'], ctx, { graph: null, expectedDuration: w.duration });
	return out;
}

export async function describeSide(id: string, path: string, ctx: JobContext): Promise<PreviewSide> {
	const file = path.split(/[\\/]/).pop()!;
	const info = await probeCached(path).catch(() => null);
	const type = mediaTypeOf(file) ?? 'audio';
	const loudness = info?.audio ? await measureLoudness(path, ctx.signal).catch(() => null) : null;
	return { url: previewUrl(id, file), type, duration: info?.duration ?? null, loudness };
}

export async function finishPreview(
	id: string,
	window: PreviewWindow,
	aPath: string,
	bPath: string,
	notes: string[],
	ctx: JobContext,
): Promise<JobResult> {
	ctx.phase('measure');
	const [a, b] = await Promise.all([describeSide(id, aPath, ctx), describeSide(id, bPath, ctx)]);
	const timing = a.duration != null && b.duration != null && Math.abs(a.duration - b.duration) > 0.15 ? 'changed' : 'same';
	const preview: PreviewResult = { id, window, a, b, timing, notes };
	prune().catch(() => {});
	return { outputs: [], preview };
}

export async function runPreview(id: string, p: PreviewParams, ctx: JobContext): Promise<JobResult> {
	const path = await resolveMedia(p.source);
	const info = await probeCached(path);
	const w = clampWindow(p.window, info.duration);
	const dir = join(PREVIEW_DIR, id);
	await mkdir(dir, { recursive: true });
	const notes: string[] = [];
	ctx.log(`Preview window ${w.start.toFixed(1)}s + ${w.duration.toFixed(1)}s`);

	if (p.kind === 'weave') {
		// The excerpt becomes a leading trim (an input seek), replacing any
		// trim the recipe starts with — the preview window *is* the trim.
		const enabled = p.steps.filter((s) => s.on);
		const rest = enabled[0]?.op === 'trim' ? enabled.slice(1) : enabled;
		const trim = newStep('trim');
		if (trim.op === 'trim') Object.assign(trim, { start: w.start, end: w.start + w.duration });
		const steps = [trim, ...rest];
		if (rest.some((s) => s.op === 'loudnorm' || s.op === 'jumpcut')) {
			notes.push('Loudness and pauses are measured on this excerpt; the full render measures the whole file.');
		}
		const videoOut = isVideoFormat(p.output.format);
		ctx.phase('original');
		const a = await renderOriginal(path, info, w, videoOut, dir, ctx);
		ctx.phase('analyse');
		const c = await compileResolved(path, info, { source: p.source, steps, output: p.output }, ctx);
		notes.push(...c.warnings.filter((x) => !/spans kept/.test(x)));
		ctx.phase('render');
		const b = join(dir, `b.${c.ext}`);
		const g = await graphArgs(c.graph);
		try {
			await encodeFile(b, [...c.inputArgs, ...g.args, ...c.outputArgs], ctx, { graph: c.graph, expectedDuration: c.duration });
		} finally {
			await g.cleanup();
		}
		return finishPreview(id, w, a, b, notes, ctx);
	}

	// Engine tools always preview as audio: they only touch the sound, and a
	// WAV A/B is sample-accurate in the browser.
	ctx.phase('original');
	const a = await renderOriginal(path, info, w, false, dir, ctx);
	const r = await runEngine(ctx, {
		tool: p.tool,
		input: p.source,
		params: p.params,
		excerpt: w,
		output: { mode: 'preview', dir: id },
	});
	const out = r.outputs[0];
	if (!out) throw new Error(`${p.tool} produced no preview file`);
	return finishPreview(id, w, a, out.path, notes, ctx);
}

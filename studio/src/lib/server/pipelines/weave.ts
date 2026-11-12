import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { JobResult } from '$lib/jobs';
import { stemOf, type MediaInfo } from '$lib/media';
import { metaFor, type OutputSpec, type Step, type StepOf, type WeavePlan } from '$lib/weave';
import { runEngine } from '../engine.js';
import { runFfmpeg, throwIfAborted } from '../ffmpeg.js';
import type { JobContext } from '../jobs.js';
import { CACHE_DIR, resolveMedia, type MediaRef } from '../paths.js';
import { probeCached } from '../probe.js';
import {
	compileAnalysis,
	compileWeave,
	parseLoudness,
	parseSilence,
	type Analysis,
	type AnalysisPass,
	type Compiled,
	type Pending,
	type SilenceAnalysis,
} from '../weave.js';
import { displayCommand, encodeFile, encodeTo, graphArgs, renderPath } from './common.js';

export interface WeaveParams {
	source: MediaRef;
	steps: Step[];
	output: OutputSpec;
}

/** "trim-jumpcut-loudnorm", or "copy" for an empty weave (a straight transcode). */
function weaveTag(steps: Step[]): string {
	const ops = steps.filter((s) => s.on).map((s) => s.op);
	if (ops.length === 0) return 'copy';
	const head = ops.slice(0, 3).join('-');
	return ops.length > 3 ? `${head}-plus${ops.length - 3}` : head;
}

/**
 * Dry run: compile with placeholders for anything that needs measuring and
 * hand back the exact command, the passes it will take and how long the
 * result should be. Nothing touches the disk.
 */
export async function planWeave(params: WeaveParams): Promise<WeavePlan> {
	const path = await resolveMedia(params.source);
	const info = await probeCached(path);
	const c = compileWeave({ path, info, steps: params.steps, output: params.output, analyses: new Map(), mode: 'plan' });
	const argv = [...c.inputArgs, '-/filter_complex', '<graph>', ...c.outputArgs, `out.${c.ext}`];
	return {
		command: displayCommand(argv, c.graph, `out.${c.ext}`),
		passes: [...c.passes, 'Render (one decode, one encode)'],
		estimatedDurationSec: c.duration,
		output: {
			hasVideo: c.output.hasVideo,
			hasAudio: c.output.hasAudio,
			width: c.output.hasVideo ? c.output.width : null,
			height: c.output.hasVideo ? c.output.height : null,
			fps: c.output.hasVideo ? c.output.fps : null,
			ext: c.ext,
		},
		warnings: c.warnings,
	};
}

async function runAnalysisPass(
	path: string,
	info: MediaInfo,
	params: WeaveParams,
	analyses: Map<number, Analysis>,
	pending: Pending,
	ctx: JobContext,
): Promise<Analysis> {
	const pass = compileAnalysis(
		{ path, info, steps: params.steps, output: params.output, analyses, mode: 'render' },
		pending.index,
		pending.kind,
	);
	if (pending.kind === 'speech') {
		const step = params.steps.filter((s) => s.on)[pending.index];
		if (step.op !== 'jumpcut') throw new Error('speech analysis on a non-jumpcut step');
		return speechPass(pass, step, ctx);
	}
	const g = await graphArgs(pass.graph);
	const argv = [...pass.inputArgs, ...g.args, '-map', '[aout]', '-f', 'null', '-'];
	ctx.command(displayCommand(argv, pass.graph, '-'));
	let measured = 0;
	try {
		const stderr = await runFfmpeg(argv, {
			signal: ctx.signal,
			loglevel: 'info',
			forwardStderr: false,
			expectedDuration: pass.duration,
			onProgress: (p) => {
				measured = p.outTime;
				ctx.progress(p);
			},
		});
		if (pending.kind === 'silence') {
			const a = parseSilence(stderr, pass.duration ?? measured);
			const total = a.regions.reduce((s, [x, y]) => s + (y - x), 0);
			ctx.log(`Found ${a.regions.length} silences (${total.toFixed(1)}s) in ${a.duration.toFixed(1)}s.`);
			return a;
		}
		const a = parseLoudness(stderr);
		ctx.log(
			`Measured ${a.inputI.toFixed(1)} LUFS integrated, ${a.inputTp.toFixed(1)} dBTP peak, LRA ${a.inputLra.toFixed(1)}.`,
		);
		return a;
	} finally {
		await g.cleanup();
	}
}

/** Speech spans → the silences between them, so the jump cut can reuse keepSpans. */
export function speechToSilence(speech: [number, number][], duration: number): SilenceAnalysis {
	const regions: [number, number][] = [];
	let cursor = 0;
	for (const [a, b] of speech) {
		if (a - cursor > 0.01) regions.push([cursor, a]);
		cursor = Math.max(cursor, b);
	}
	if (duration - cursor > 0.01) regions.push([cursor, duration]);
	return { kind: 'silence', regions, duration };
}

/**
 * Speech-aware jump cut: render the audio *as it is at that step* to a WAV
 * in the cache, ask the engine's Silero VAD where people are talking, and
 * treat everything else as silence. Unlike a level threshold this cuts the
 * gaps between words even under music or hum.
 */
async function speechPass(pass: AnalysisPass, step: StepOf<'jumpcut'>, ctx: JobContext): Promise<SilenceAnalysis> {
	const name = `tmp/${randomUUID()}.wav`;
	const wav = join(CACHE_DIR, name);
	await mkdir(dirname(wav), { recursive: true });
	const g = await graphArgs(pass.graph);
	try {
		const argv = [...pass.inputArgs, ...g.args, '-map', '[aout]', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le'];
		await encodeFile(wav, argv, ctx, { graph: pass.graph, expectedDuration: pass.duration });
		const r = await runEngine(ctx, {
			tool: 'vad',
			input: { kind: 'cache', name },
			params: { threshold: step.vadThreshold, min_silence_ms: step.minSilenceMs, min_speech_ms: 150 },
			output: { mode: 'data' },
		});
		const data = r.data as { speech: [number, number][]; duration: number };
		const a = speechToSilence(data.speech, pass.duration ?? data.duration);
		ctx.log(`Speech in ${data.speech.length} spans; ${a.regions.length} gaps to cut.`);
		return a;
	} finally {
		await g.cleanup();
		await rm(wav, { force: true });
	}
}

/**
 * Compile until nothing is pending: whenever a step needs measuring, run
 * that analysis pass and compile again.
 */
export async function compileResolved(path: string, info: MediaInfo, params: WeaveParams, ctx: JobContext): Promise<Compiled> {
	const enabled = params.steps.filter((s) => s.on);
	const analyses = new Map<number, Analysis>();
	const totalPasses = enabled.filter((s) => metaFor(s.op).analysis).length;
	let pass = 0;
	for (;;) {
		throwIfAborted(ctx.signal);
		const c = compileWeave({ path, info, steps: params.steps, output: params.output, analyses, mode: 'render' });
		if (!c.pending) return c;
		pass++;
		ctx.phase(`analyse ${pass}/${totalPasses}`);
		analyses.set(c.pending.index, await runAnalysisPass(path, info, params, analyses, c.pending, ctx));
	}
}

/** The render job: resolve analyses, then one decode and one encode. */
export async function runWeave(params: WeaveParams, ctx: JobContext): Promise<JobResult> {
	const path = await resolveMedia(params.source);
	const info = await probeCached(path);
	const enabled = params.steps.filter((s) => s.on);
	ctx.log(`Source: ${params.source.bin}/${params.source.kind}/${params.source.name}`);
	ctx.log(`Weave: ${enabled.map((s, i) => `${i + 1}. ${metaFor(s.op).label}`).join('  ') || '(no steps — transcode only)'}`);

	const c = await compileResolved(path, info, params, ctx);
	for (const w of c.warnings) ctx.log(`Note: ${w}`);
	ctx.phase('render');
	const out = await renderPath(params.source.bin, stemOf(params.source.name), weaveTag(params.steps), c.ext);
	const g = await graphArgs(c.graph);
	try {
		const argv = [...c.inputArgs, ...g.args, ...c.outputArgs];
		const output = await encodeTo(out, argv, ctx, { graph: c.graph, expectedDuration: c.duration });
		ctx.log(`Done: ${output.name}`);
		const stats: Record<string, number | string> = {};
		if (info.duration && output.durationSec) stats.inputSec = info.duration;
		return { outputs: [output], stats };
	} finally {
		await g.cleanup();
	}
}

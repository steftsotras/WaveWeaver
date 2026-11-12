import type { JobResult } from '$lib/jobs';
import { stemOf, type MediaInfo } from '$lib/media';
import { isVideoFormat, type Aspect, type OutputFormat, type Quality } from '$lib/weave';
import { throwIfAborted } from '../ffmpeg.js';
import { encoderArgs, even } from '../encode.js';
import type { JobContext } from '../jobs.js';
import { resolveMedia, type MediaRef } from '../paths.js';
import { probeCached } from '../probe.js';
import { encodeTo, graphArgs, renderPath } from './common.js';

export const TRANSITIONS = ['fade', 'dissolve', 'wipeleft', 'slideleft', 'circleopen', 'pixelize'] as const;
export type Transition = (typeof TRANSITIONS)[number];

export interface StitchParams {
	sources: MediaRef[];
	/** Seconds of overlap between clips; 0 = hard cuts. */
	crossfade: number;
	transition: Transition;
	canvas: 'auto' | Aspect;
	fit: 'pad' | 'crop';
	format: OutputFormat;
	quality: Quality;
}

/** Stitch canvases are full HD: these are finished pieces, not previews. */
const STITCH_CANVAS: Record<Aspect, { w: number; h: number }> = {
	'16:9': { w: 1920, h: 1080 },
	'9:16': { w: 1080, h: 1920 },
	'1:1': { w: 1080, h: 1080 },
	'4:5': { w: 1080, h: 1350 },
	'4:3': { w: 1440, h: 1080 },
	'21:9': { w: 2520, h: 1080 },
};

const FPS = 30;

interface Clip {
	ref: MediaRef;
	path: string;
	info: MediaInfo;
	duration: number;
}

export interface StitchPlan {
	duration: number;
	width: number | null;
	height: number | null;
	graph: string;
	inputArgs: string[];
	outputArgs: string[];
	ext: string;
}

/**
 * Concatenate clips into one. Every clip is conformed to one canvas, 30 fps
 * and 48 kHz stereo first, because concat and xfade both insist their inputs
 * match. Clips missing a stream get a stand-in (black frames / silence) of
 * the right length, so you can freely mix audio files into a video edit.
 */
async function buildStitch(params: StitchParams): Promise<StitchPlan> {
	if (params.sources.length < 2) throw new Error('Pick at least two clips to stitch.');
	const clips: Clip[] = [];
	for (const ref of params.sources) {
		const path = await resolveMedia(ref);
		const info = await probeCached(path);
		if (!info.duration) throw new Error(`${ref.name} doesn't report a duration; can't stitch it.`);
		clips.push({ ref, path, info, duration: info.duration });
	}

	const X = params.crossfade;
	if (X > 0) {
		const tooShort = clips.find((c) => c.duration <= X * 2);
		if (tooShort) throw new Error(`${tooShort.ref.name} is shorter than two crossfades (${(X * 2).toFixed(1)}s).`);
	}

	const videoOut = isVideoFormat(params.format);
	if (params.format === 'gif') throw new Error('Stitch renders to MP4/WebM or audio. Make a GIF from the result on the Desk.');
	const anyVideo = clips.some((c) => c.info.video);
	if (videoOut && !anyVideo) throw new Error('None of these clips have video. Pick an audio format.');

	let W = 0;
	let H = 0;
	if (videoOut) {
		if (params.canvas === 'auto') {
			const first = clips.find((c) => c.info.video)!.info.video!;
			W = even(first.width);
			H = even(first.height);
		} else {
			({ w: W, h: H } = STITCH_CANVAS[params.canvas]);
		}
	}

	const inputArgs: string[] = [];
	const statements: string[] = [];
	clips.forEach((c, i) => {
		inputArgs.push('-i', c.path);
		const D = c.duration.toFixed(3);
		if (videoOut) {
			const fit =
				params.fit === 'crop'
					? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
					: `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;
			statements.push(
				c.info.video
					? `[${i}:v]${fit},setsar=1,fps=${FPS},format=yuv420p,trim=duration=${D},setpts=PTS-STARTPTS,settb=AVTB[v${i}]`
					: `color=c=black:s=${W}x${H}:r=${FPS}:d=${D},format=yuv420p,setsar=1,settb=AVTB[v${i}]`,
			);
		}
		// apad + atrim pins every clip's audio to exactly the clip's length,
		// so audio never drifts against video across many joins.
		statements.push(
			c.info.audio
				? `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${D},asetpts=PTS-STARTPTS[a${i}]`
				: `anullsrc=r=48000:cl=stereo,atrim=duration=${D},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`,
		);
	});

	const n = clips.length;
	if (X <= 0) {
		const pads = clips.map((_, i) => (videoOut ? `[v${i}][a${i}]` : `[a${i}]`)).join('');
		statements.push(`${pads}concat=n=${n}:v=${videoOut ? 1 : 0}:a=1${videoOut ? '[vout]' : ''}[aout]`);
	} else {
		// xfade offsets are absolute: clip k starts fading in X seconds before
		// the end of everything merged so far.
		let merged = clips[0].duration;
		let vPrev = 'v0';
		let aPrev = 'a0';
		for (let k = 1; k < n; k++) {
			const last = k === n - 1;
			const vOut = last ? 'vout' : `vx${k}`;
			const aOut = last ? 'aout' : `ax${k}`;
			if (videoOut) {
				statements.push(
					`[${vPrev}][v${k}]xfade=transition=${params.transition}:duration=${X.toFixed(3)}:offset=${(merged - X).toFixed(3)}[${vOut}]`,
				);
			}
			statements.push(`[${aPrev}][a${k}]acrossfade=d=${X.toFixed(3)}:c1=tri:c2=tri[${aOut}]`);
			merged = merged + clips[k].duration - X;
			vPrev = vOut;
			aPrev = aOut;
		}
	}

	const duration = clips.reduce((s, c) => s + c.duration, 0) - (n - 1) * Math.max(0, X);
	const outputArgs = [
		...(videoOut ? ['-map', '[vout]'] : []),
		'-map',
		'[aout]',
		...encoderArgs(params.format, params.quality, { video: videoOut, audio: true }),
	];
	return {
		duration,
		width: videoOut ? W : null,
		height: videoOut ? H : null,
		graph: statements.join(';\n'),
		inputArgs,
		outputArgs,
		ext: params.format,
	};
}

export async function planStitch(params: StitchParams) {
	const p = await buildStitch(params);
	return { duration: p.duration, width: p.width, height: p.height };
}

export async function runStitch(params: StitchParams, ctx: JobContext): Promise<JobResult> {
	const p = await buildStitch(params);
	throwIfAborted(ctx.signal);
	ctx.log(`Stitching ${params.sources.length} clips → ${p.duration.toFixed(1)}s`);
	ctx.phase('render');
	const first = params.sources[0];
	const out = await renderPath(first.bin, stemOf(first.name), `stitch${params.sources.length}`, p.ext);
	const g = await graphArgs(p.graph);
	try {
		const output = await encodeTo(out, [...p.inputArgs, ...g.args, ...p.outputArgs], ctx, {
			graph: p.graph,
			expectedDuration: p.duration,
		});
		ctx.log(`Done: ${output.name}`);
		return { outputs: [output] };
	} finally {
		await g.cleanup();
	}
}

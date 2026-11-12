import type { MediaInfo } from '$lib/media';
import {
	isVideoFormat,
	metaFor,
	type Aspect,
	type OutputSpec,
	type Step,
	type StepOf,
} from '$lib/weave';
import { atempoChain } from './ffmpeg.js';
import { CANVAS, encoderArgs, even } from './encode.js';

/**
 * The Weave compiler: an ordered list of steps → one ffmpeg invocation.
 *
 * Video and audio each get a linear filter chain. Most steps append a filter
 * to one or both chains; a few (blur-pad reframe, GIF palettes, the audio
 * visualiser) need split/overlay, so the chain can also take labelled
 * fragments. The compiler tracks stream state (duration, size, fps) as it
 * goes, which is what lets later steps use real numbers — a fade-out knows
 * where the end is *after* a speed-up and a jump cut.
 *
 * Two steps can't be compiled blind:
 *   - jumpcut needs to know where the silences are
 *   - loudnorm needs measured loudness for an accurate (linear) second pass
 * Both are measured on the signal *as it is at that point in the chain*, by
 * running the prefix of the graph into an analysis filter. compile() reports
 * the first unresolved one as `pending`; the job runs that pass, stores the
 * result, and compiles again until nothing is pending.
 */

export interface SilenceAnalysis {
	kind: 'silence';
	/** [start, end] of each silent region, on the timeline at that step. */
	regions: [number, number][];
	duration: number;
}

export interface LoudnessAnalysis {
	kind: 'loudness';
	inputI: number;
	inputTp: number;
	inputLra: number;
	inputThresh: number;
	targetOffset: number;
}

export type Analysis = SilenceAnalysis | LoudnessAnalysis;

interface StreamState {
	hasVideo: boolean;
	hasAudio: boolean;
	/** Null once a pending analysis makes it unknowable (plan mode only). */
	duration: number | null;
	width: number;
	height: number;
	fps: number;
}

/** Sample rate every audio chain is normalised to on entry. */
const SR = 48000;

/**
 * A linear filter chain that can also splice in labelled sub-graphs.
 * `emit = false` turns it into a no-op, used when an analysis pass only
 * needs the audio: the compiler still tracks video state, but no video
 * filters are generated (and no video is decoded).
 */
class Chain {
	private statements: string[] = [];
	private pending: string[] = [];
	private label: string;
	private static counter = 0;

	constructor(
		private readonly prefix: 'v' | 'a',
		input: string,
		readonly emit = true,
	) {
		this.label = input;
	}

	add(...filters: string[]): void {
		if (this.emit) this.pending.push(...filters);
	}

	fresh(): string {
		return `${this.prefix}${++Chain.counter}`;
	}

	/** Splice a fragment: receives the current label, returns its statements and output label. */
	fragment(fn: (input: string) => { statements: string[]; output: string }): void {
		if (!this.emit) return;
		const input = this.flush();
		const r = fn(input);
		this.statements.push(...r.statements);
		this.label = r.output;
	}

	private flush(): string {
		if (this.pending.length === 0) return this.label;
		const out = this.fresh();
		this.statements.push(`[${this.label}]${this.pending.join(',')}[${out}]`);
		this.pending = [];
		this.label = out;
		return out;
	}

	finish(output: string): string[] {
		const filters = this.pending.length ? this.pending : [this.prefix === 'v' ? 'null' : 'anull'];
		return [...this.statements, `[${this.label}]${filters.join(',')}[${output}]`];
	}
}

export interface CompileInput {
	path: string;
	info: MediaInfo;
	steps: Step[];
	output: OutputSpec;
	analyses: Map<number, Analysis>;
	/**
	 * plan:   never stops; unresolved analyses become placeholders, so the UI
	 *         can show a readable command before anything runs.
	 * render: stops at the first unresolved analysis and reports it.
	 */
	mode: 'plan' | 'render';
}

export interface Pending {
	index: number;
	/** speech = Silero VAD in the engine; its spans are stored as a SilenceAnalysis. */
	kind: 'silence' | 'loudness' | 'speech';
}

interface Built {
	inputArgs: string[];
	v: Chain;
	a: Chain;
	state: StreamState;
	pending: Pending | null;
	warnings: string[];
	passes: string[];
}

export interface Compiled {
	inputArgs: string[];
	graph: string;
	outputArgs: string[];
	ext: string;
	duration: number | null;
	output: StreamState;
	pending: Pending | null;
	warnings: string[];
	passes: string[];
}

const ASPECT_RATIO: Record<Aspect, number> = {
	'16:9': 16 / 9,
	'9:16': 9 / 16,
	'1:1': 1,
	'4:5': 4 / 5,
	'4:3': 4 / 3,
	'21:9': 21 / 9,
};

/** Frame rates whose frame length is a whole number of 48 kHz samples. */
const ALIGNABLE_FPS = [24, 25, 30, 48, 50, 60, 120];

function f3(n: number): string {
	return n.toFixed(3);
}

/** dB → the linear amplitude most ffmpeg dynamics filters take. */
function lin(db: number): string {
	return Math.pow(10, db / 20).toFixed(6);
}

function stepName(i: number, s: Step): string {
	return `step ${i + 1} (${metaFor(s.op).label})`;
}

/**
 * Turn silence regions into the spans to keep. Each silence is shrunk by
 * `pad` on both sides so words keep their natural attack and tail, and spans
 * are snapped to the frame grid so audio and video cut on identical samples.
 */
export function keepSpans(
	analysis: SilenceAnalysis,
	padSec: number,
	grid: number | null,
): [number, number][] {
	const D = analysis.duration;
	const snap = (t: number) => (grid ? Math.round(t * grid) / grid : t);
	const spans: [number, number][] = [];
	let cursor = 0;
	for (const [s, e] of analysis.regions) {
		const cutStart = s <= 0.01 ? 0 : s + padSec;
		const cutEnd = e >= D - 0.01 ? D : e - padSec;
		if (cutEnd - cutStart < 0.05) continue;
		if (cutStart > cursor) spans.push([cursor, cutStart]);
		cursor = Math.max(cursor, cutEnd);
	}
	if (D - cursor > 0.02) spans.push([cursor, D]);
	return spans
		.map(([a, b]) => [snap(a), snap(b)] as [number, number])
		.filter(([a, b]) => b - a >= (grid ? 1 / grid : 0.02));
}

function trimBounds(s: StepOf<'trim'>, state: StreamState): { start: number; len: number | null } {
	const D = state.duration;
	if (D != null && s.start >= D) throw new Error(`Trim starts at ${f3(s.start)}s but the clip is only ${f3(D)}s`);
	let end = s.end;
	if (D != null && (end == null || end > D)) end = D;
	return { start: s.start, len: end == null ? null : end - s.start };
}

/**
 * Walk steps[0..until) and build both chains. Shared by full compiles and
 * analysis passes so both see exactly the same timeline.
 */
function build(input: CompileInput, until: number, audioOnly: boolean): Built {
	const { info, steps, analyses, mode } = input;
	if (!info.video && !info.audio) throw new Error('Source has no audio or video streams');

	const warnings: string[] = [];
	const passes: string[] = [];
	const state: StreamState = {
		hasVideo: Boolean(info.video),
		hasAudio: Boolean(info.audio),
		duration: info.duration,
		width: info.video?.width ?? 0,
		height: info.video?.height ?? 0,
		fps: Math.min(120, Math.max(1, Math.round(info.video?.fps ?? 30))),
	};

	const v = new Chain('v', '0:v', !audioOnly && state.hasVideo);
	const a = new Chain('a', '0:a', state.hasAudio);
	a.add(`aresample=${SR}`);

	// A trim at the very top becomes input seeking (-ss/-t before -i): ffmpeg
	// jumps straight there instead of decoding from zero. When transcoding
	// this is frame-accurate. Only safe as the first step — a trim after a
	// speed change or fade means something different on that timeline.
	const inputArgs: string[] = [];
	let from = 0;
	if (steps[0]?.op === 'trim' && until > 0) {
		const t = trimBounds(steps[0], state);
		inputArgs.push('-ss', f3(t.start));
		if (t.len != null) inputArgs.push('-t', f3(t.len));
		state.duration = t.len ?? (state.duration != null ? state.duration - t.start : null);
		from = 1;
	}
	if (audioOnly) inputArgs.push('-vn');
	inputArgs.push('-i', input.path);

	let pending: Pending | null = null;

	for (let i = from; i < until; i++) {
		const s = steps[i];
		const meta = metaFor(s.op);
		if (meta.needs === 'audio' && !state.hasAudio) {
			warnings.push(`Skipped ${stepName(i, s)}: there's no audio at that point.`);
			continue;
		}
		if (meta.needs === 'video' && !state.hasVideo) {
			warnings.push(`Skipped ${stepName(i, s)}: there's no video at that point.`);
			continue;
		}
		const D = state.duration;

		switch (s.op) {
			case 'trim': {
				const t = trimBounds(s, state);
				const end = t.len != null ? `:end=${f3(t.start + t.len)}` : '';
				v.add(`trim=start=${f3(t.start)}${end}`, 'setpts=PTS-STARTPTS');
				a.add(`atrim=start=${f3(t.start)}${end}`, 'asetpts=PTS-STARTPTS');
				state.duration = t.len ?? (D != null ? D - t.start : null);
				break;
			}
			case 'speed': {
				if (s.factor === 1) break;
				// Re-impose the frame rate afterwards: without it a 2x speed-up
				// doubles the frame rate (and the file size) instead of
				// dropping frames.
				v.add(`setpts=PTS/${s.factor.toFixed(4)}`, `fps=${state.fps}`);
				a.add(atempoChain(s.factor));
				if (D != null) state.duration = D / s.factor;
				break;
			}
			case 'reverse': {
				if (state.hasVideo && D != null && D > 20) {
					warnings.push(
						`Reverse buffers every decoded frame in RAM — ${Math.round(D)}s of video may need gigabytes. Trim first.`,
					);
				}
				v.add('reverse');
				a.add('areverse');
				break;
			}
			case 'jumpcut': {
				const an = analyses.get(i);
				if (!an || an.kind !== 'silence') {
					if (mode === 'render') {
						pending = { index: i, kind: s.detector === 'speech' ? 'speech' : 'silence' };
						return { inputArgs, v, a, state, pending, warnings, passes };
					}
					passes.push(
						s.detector === 'speech'
							? `Find speech for ${stepName(i, s)} (Silero VAD in the engine)`
							: `Measure silences for ${stepName(i, s)} (silencedetect, audio only)`,
					);
					v.add(`select='‹spans from silencedetect›'`, 'setpts=N/FRAME_RATE/TB');
					a.add(`aselect='‹spans from silencedetect›'`, 'asetpts=N/SR/TB');
					state.duration = null;
					break;
				}
				// With video, cut on the frame grid and repackage audio into
				// frame-sized chunks so select and aselect see identical
				// timestamps: no drift, however many cuts. Odd rates (29.97)
				// are conformed to the nearest alignable rate first.
				const grid = state.hasVideo
					? ALIGNABLE_FPS.reduce((best, f) => (Math.abs(f - state.fps) < Math.abs(best - state.fps) ? f : best))
					: null;
				const spans = keepSpans(an, s.padMs / 1000, grid);
				if (spans.length === 0) throw new Error(`${stepName(i, s)} would cut everything — lower the threshold.`);
				const half = grid ? 0.5 / grid : 0;
				const expr = spans.map(([x, y]) => `between(t,${(x - half).toFixed(4)},${(y - half).toFixed(4)})`).join('+');
				if (grid) {
					v.add(`fps=${grid}`, `select='${expr}'`, 'setpts=N/FRAME_RATE/TB');
					a.add(`asetnsamples=n=${SR / grid}:p=0`, `aselect='${expr}'`, 'asetpts=N/SR/TB');
					state.fps = grid;
				} else {
					a.add('asetnsamples=n=480:p=0', `aselect='${expr}'`, 'asetpts=N/SR/TB');
				}
				const kept = spans.reduce((sum, [x, y]) => sum + (y - x), 0);
				warnings.push(
					`${stepName(i, s)}: ${spans.length} spans kept, ${f3(an.duration - kept)}s of silence removed.`,
				);
				state.duration = kept;
				break;
			}
			case 'volume':
				if (s.db !== 0) a.add(`volume=${s.db.toFixed(1)}dB`);
				break;
			case 'loudnorm': {
				const an = analyses.get(i);
				const target = `I=${s.lufs}:TP=${s.truePeak}:LRA=11`;
				if (!an || an.kind !== 'loudness') {
					if (mode === 'render') {
						pending = { index: i, kind: 'loudness' };
						return { inputArgs, v, a, state, pending, warnings, passes };
					}
					passes.push(`Measure loudness for ${stepName(i, s)} (loudnorm, audio only)`);
					a.add(`loudnorm=${target}:measured_I=‹…›:linear=true`, `aresample=${SR}`);
					break;
				}
				if (!Number.isFinite(an.inputI)) {
					warnings.push(`Skipped ${stepName(i, s)}: the audio is silent.`);
					break;
				}
				// Second pass of the classic two-pass loudnorm: feeding the
				// measurements back lets it apply one linear gain instead of
				// pumping dynamically. loudnorm upsamples to 192k internally,
				// so resample back down.
				a.add(
					`loudnorm=${target}:measured_I=${an.inputI}:measured_TP=${an.inputTp}` +
						`:measured_LRA=${an.inputLra}:measured_thresh=${an.inputThresh}` +
						`:offset=${an.targetOffset}:linear=true:print_format=none`,
					`aresample=${SR}`,
				);
				break;
			}
			case 'fade': {
				let fin = s.inSec;
				let fout = s.outSec;
				if (D != null && fin + fout > D) {
					const k = D / (fin + fout);
					fin *= k;
					fout *= k;
					warnings.push(`${stepName(i, s)}: fades were longer than the clip and were shortened.`);
				}
				if (D == null && fout > 0 && mode === 'render') {
					throw new Error(`${stepName(i, s)}: the source doesn't report its duration, so there's no end to fade out at.`);
				}
				const outAt = D != null ? f3(D - fout) : `‹end−${fout}›`;
				if (fin > 0) {
					v.add(`fade=t=in:st=0:d=${f3(fin)}`);
					a.add(`afade=t=in:st=0:d=${f3(fin)}`);
				}
				if (fout > 0) {
					v.add(`fade=t=out:st=${outAt}:d=${f3(fout)}`);
					a.add(`afade=t=out:st=${outAt}:d=${f3(fout)}`);
				}
				break;
			}
			case 'eq': {
				// Same RBJ biquads the on-screen curve is drawn from (eqResponseDb).
				for (const b of s.bands) {
					if (!b.on) continue;
					const f = Math.round(b.f);
					const q = b.q.toFixed(3);
					const g = b.g.toFixed(1);
					if (b.type === 'highpass') a.add(`highpass=f=${f}:p=2:t=q:w=${q}`);
					else if (b.type === 'lowpass') a.add(`lowpass=f=${f}:p=2:t=q:w=${q}`);
					else if (b.type === 'lowshelf') a.add(`lowshelf=f=${f}:g=${g}:t=q:w=${q}`);
					else if (b.type === 'highshelf') a.add(`highshelf=f=${f}:g=${g}:t=q:w=${q}`);
					else a.add(`equalizer=f=${f}:t=q:w=${q}:g=${g}`);
				}
				break;
			}
			case 'compressor':
				a.add(
					`acompressor=threshold=${lin(s.thresholdDb)}:ratio=${s.ratio.toFixed(2)}:attack=${s.attackMs.toFixed(1)}` +
						`:release=${Math.round(s.releaseMs)}:makeup=${lin(s.makeupDb)}:knee=2.828`,
				);
				break;
			case 'limiter':
				// level=0: don't auto-normalise up to the ceiling. latency=1:
				// remove the lookahead delay so sound stays in sync with picture.
				a.add(`alimiter=limit=${lin(s.ceilingDb)}:attack=5:release=${Math.round(s.releaseMs)}:level=0:latency=1`);
				break;
			case 'gate':
				a.add(
					`agate=threshold=${lin(s.thresholdDb)}:range=${lin(s.rangeDb)}:ratio=8` +
						`:attack=${s.attackMs.toFixed(1)}:release=${Math.round(s.releaseMs)}`,
				);
				break;
			case 'deesser':
				a.add(`deesser=i=${s.amount.toFixed(2)}:m=${(0.3 + s.amount * 0.6).toFixed(2)}:f=0.5:s=o`);
				break;
			case 'dehum':
				// A narrow notch on the fundamental and each harmonic: hum is a
				// stack of pure tones, so cutting exactly there leaves voices alone.
				for (let k = 1; k <= s.harmonics; k++) a.add(`bandreject=f=${s.freq * k}:t=q:w=12`);
				break;
			case 'declick':
				if (s.clicks) a.add('adeclick');
				if (s.clipping) a.add('adeclip');
				if (s.clicks || s.clipping) {
					warnings.push(`${stepName(i, s)} runs at roughly realtime — a long file takes a while.`);
				}
				break;
			case 'stereo': {
				a.add('aformat=channel_layouts=stereo');
				const pans: Record<string, string> = {
					mono: 'pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1',
					swap: 'pan=stereo|c0=c1|c1=c0',
					left: 'pan=stereo|c0=c0|c1=c0',
					right: 'pan=stereo|c0=c1|c1=c1',
				};
				if (s.mode !== 'keep') a.add(pans[s.mode]);
				if (Math.abs(s.width - 1) > 0.01 && s.mode !== 'mono') a.add(`extrastereo=m=${s.width.toFixed(2)}`);
				if (Math.abs(s.balance) > 0.01) a.add(`stereotools=balance_out=${s.balance.toFixed(2)}`);
				break;
			}
			case 'denoise': {
				const nr = Math.round(6 + s.amount * 30);
				a.add('highpass=f=80', `afftdn=nr=${nr}:nf=-45:tn=1`);
				break;
			}
			case 'pitch': {
				if (s.semitones === 0) break;
				// Resample-trick pitch shift: play faster/slower via a fake
				// sample rate, then atempo the duration back.
				const rate = Math.round(SR * Math.pow(2, s.semitones / 12));
				a.add(`asetrate=${rate}`, `aresample=${SR}`, atempoChain(SR / rate));
				break;
			}
			case 'mute':
				state.hasAudio = false;
				break;
			case 'reframe': {
				const target = ASPECT_RATIO[s.aspect];
				const W = state.width;
				const H = state.height;
				const wider = W / H > target;
				if (s.fit === 'crop') {
					const cw = wider ? even(H * target) : even(W);
					const ch = wider ? even(H) : even(W / target);
					v.add(`crop=${cw}:${ch}`);
					state.width = cw;
					state.height = ch;
				} else {
					// The canvas keeps the source's long edge, the way phone
					// apps do it: 1280×720 → 9:16 is a 720×1280 canvas with
					// the frame shrunk to fit its width — not a 1280×2276
					// monster that keeps every source pixel.
					const L = Math.max(W, H);
					const pw = target >= 1 ? even(L) : even(L * target);
					const ph = target >= 1 ? even(L / target) : even(L);
					const fit = `scale=${pw}:${ph}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
					if (s.fit === 'pad') {
						v.add(fit, `pad=${pw}:${ph}:(ow-iw)/2:(oh-ih)/2:color=black`, 'setsar=1');
					} else {
						// The "vertical video" look: the frame centred on a
						// blurred, darkened, zoomed copy of itself. The blur is
						// done at quarter size — 16x fewer pixels, same look.
						v.fragment((inp) => {
							const bgIn = v.fresh();
							const fgIn = v.fresh();
							const fg = v.fresh();
							const bg = v.fresh();
							const out = v.fresh();
							return {
								statements: [
									`[${inp}]split=2[${bgIn}][${fgIn}]`,
									`[${bgIn}]scale=${even(pw / 4)}:${even(ph / 4)}:force_original_aspect_ratio=increase,` +
										`crop=${even(pw / 4)}:${even(ph / 4)},gblur=sigma=12,eq=brightness=-0.08,` +
										`scale=${pw}:${ph},setsar=1[${bg}]`,
									`[${fgIn}]${fit},setsar=1[${fg}]`,
									`[${bg}][${fg}]overlay=(W-w)/2:(H-h)/2[${out}]`,
								],
								output: out,
							};
						});
					}
					state.width = pw;
					state.height = ph;
				}
				break;
			}
			case 'scale': {
				if (s.height > state.height) {
					warnings.push(`${stepName(i, s)} upscales ${state.height}p → ${s.height}p; it won't add detail.`);
				}
				const w = even((state.width * s.height) / state.height);
				v.add(`scale=${w}:${s.height}:flags=lanczos`, 'setsar=1');
				state.width = w;
				state.height = s.height;
				break;
			}
			case 'rotate': {
				if (s.turns === 2) v.add('hflip', 'vflip');
				else v.add(`transpose=${s.turns === 1 ? 'clock' : 'cclock'}`);
				if (s.turns !== 2) [state.width, state.height] = [state.height, state.width];
				break;
			}
			case 'flip':
				v.add(s.axis === 'h' ? 'hflip' : 'vflip');
				break;
			case 'fps':
				v.add(`fps=${s.fps}`);
				state.fps = Math.round(s.fps);
				break;
			case 'color':
				v.add(
					`eq=brightness=${s.brightness.toFixed(2)}:contrast=${s.contrast.toFixed(2)}:saturation=${s.saturation.toFixed(2)}`,
				);
				break;
		}
	}

	return { inputArgs, v, a, state, pending, warnings, passes };
}

/** Full compile, including the output stage and encoder flags. */
export function compileWeave(input: CompileInput): Compiled {
	const steps = input.steps.filter((s) => s.on);
	const b = build({ ...input, steps }, steps.length, false);
	const { output } = input;
	const state = { ...b.state };
	const ext = output.format;
	const blank = { inputArgs: b.inputArgs, graph: '', outputArgs: [], ext, duration: null, output: state };
	if (b.pending) {
		return { ...blank, pending: b.pending, warnings: b.warnings, passes: b.passes };
	}

	const warnings = [...b.warnings];
	const statements: string[] = [];
	const outputArgs: string[] = [];
	let mapV = false;
	let mapA = false;

	if (isVideoFormat(output.format)) {
		if (state.hasVideo) {
			if (output.format === 'gif') {
				// GIFs: cap at 15 fps / 640px and build an optimal palette in
				// the same graph (split → palettegen → paletteuse) instead of
				// the usual two separate ffmpeg runs.
				const fps = Math.min(state.fps, 15);
				b.v.add(`fps=${fps}`);
				if (state.width > 640) {
					const h = even((state.height * 640) / state.width);
					b.v.add(`scale=640:${h}:flags=lanczos`);
					state.width = 640;
					state.height = h;
				}
				state.fps = fps;
				b.v.fragment((inp) => {
					const g1 = b.v.fresh();
					const g2 = b.v.fresh();
					const pal = b.v.fresh();
					const out = b.v.fresh();
					return {
						statements: [
							`[${inp}]split=2[${g1}][${g2}]`,
							`[${g1}]palettegen=stats_mode=diff[${pal}]`,
							`[${g2}][${pal}]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[${out}]`,
						],
						output: out,
					};
				});
				if (state.duration != null && state.duration > 30) {
					warnings.push(`A ${Math.round(state.duration)}s GIF will be huge. Trim it or use MP4.`);
				}
				if (state.hasAudio) warnings.push('GIFs have no sound; the audio is dropped.');
				state.hasAudio = false;
			} else {
				if (state.width % 2 || state.height % 2) {
					const w = state.width + (state.width % 2);
					const h = state.height + (state.height % 2);
					b.v.add(`pad=${w}:${h}`);
					state.width = w;
					state.height = h;
				}
				b.v.add('format=yuv420p');
			}
			statements.push(...b.v.finish('vout'));
			mapV = true;
			if (state.hasAudio) {
				statements.push(...b.a.finish('aout'));
				mapA = true;
			}
		} else if (state.hasAudio && output.format !== 'gif') {
			// Audio in, video out: draw something. This is how a podcast clip
			// becomes something you can post.
			const { w, h } = CANVAS[output.canvas];
			const pre = b.a.finish('apre');
			statements.push(...pre);
			if (output.visual === 'black') {
				statements.push('[apre]anull[aout]', `color=c=black:s=${w}x${h}:r=30,format=yuv420p[vout]`);
				outputArgs.push('-shortest');
			} else {
				const vis =
					output.visual === 'waves'
						? `showwaves=s=${w}x${h}:mode=cline:rate=30:colors=0xFF4F00:scale=sqrt:draw=full`
						: `showspectrum=s=${w}x${h}:mode=combined:slide=scroll:color=fire:scale=cbrt:legend=0,fps=30`;
				statements.push('[apre]asplit=2[aout][avis]', `[avis]${vis},format=yuv420p[vout]`);
			}
			state.hasVideo = true;
			state.width = w;
			state.height = h;
			state.fps = 30;
			mapV = true;
			mapA = true;
		} else {
			throw new Error(`Nothing to put in a ${output.format.toUpperCase()}: the result has no video or audio.`);
		}
	} else {
		if (!state.hasAudio) throw new Error(`Nothing to put in a ${output.format.toUpperCase()}: there's no audio.`);
		statements.push(...b.a.finish('aout'));
		mapA = true;
		state.hasVideo = false;
	}

	if (mapV) outputArgs.push('-map', '[vout]');
	if (mapA) outputArgs.push('-map', '[aout]');
	outputArgs.push(...encoderArgs(output.format, output.quality, { video: mapV && output.format !== 'gif', audio: mapA }));

	return {
		inputArgs: b.inputArgs,
		graph: statements.join(';\n'),
		outputArgs,
		ext,
		duration: state.duration,
		output: state,
		pending: null,
		warnings,
		passes: b.passes,
	};
}

export interface AnalysisPass {
	inputArgs: string[];
	graph: string;
	duration: number | null;
}

/**
 * The graph for measuring step `index`: everything before it, audio only,
 * ending in the analysis filter. Video is never decoded (-vn on the input),
 * which makes these passes 10–50x faster than a render.
 */
export function compileAnalysis(input: CompileInput, index: number, kind: Pending['kind']): AnalysisPass {
	const steps = input.steps.filter((s) => s.on);
	const b = build({ ...input, steps, mode: 'render' }, index, true);
	if (b.pending) throw new Error('Analysis prefix has an unresolved analysis (compile order bug)');
	const s = steps[index];
	if (kind === 'speech' && s.op === 'jumpcut') {
		// No filter: the job renders this prefix to a WAV and hands it to the
		// engine's VAD.
	} else if (kind === 'silence' && s.op === 'jumpcut') {
		b.a.add(`silencedetect=noise=${s.thresholdDb}dB:d=${(s.minSilenceMs / 1000).toFixed(3)}`);
	} else if (kind === 'loudness' && s.op === 'loudnorm') {
		b.a.add(`loudnorm=I=${s.lufs}:TP=${s.truePeak}:LRA=11:print_format=json`);
	} else {
		throw new Error(`Step ${index + 1} has no ${kind} analysis`);
	}
	return { inputArgs: b.inputArgs, graph: b.a.finish('aout').join(';\n'), duration: b.state.duration };
}

/** Parse silencedetect's stderr. A trailing silence with no end runs to EOF. */
export function parseSilence(stderr: string, duration: number): SilenceAnalysis {
	const regions: [number, number][] = [];
	let open: number | null = null;
	for (const line of stderr.split(/\r?\n/)) {
		const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
		if (start) {
			open = Math.max(0, parseFloat(start[1]));
			continue;
		}
		const end = /silence_end:\s*([\d.]+)/.exec(line);
		if (end && open != null) {
			regions.push([open, parseFloat(end[1])]);
			open = null;
		}
	}
	if (open != null) regions.push([open, duration]);
	return { kind: 'silence', regions, duration };
}

/** loudnorm prints a JSON block at the end of stderr in measure mode. */
export function parseLoudness(stderr: string): LoudnessAnalysis {
	const blocks = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g);
	if (!blocks) throw new Error('loudnorm printed no measurements');
	const j = JSON.parse(blocks[blocks.length - 1]) as Record<string, string>;
	const n = (k: string) => {
		const x = parseFloat(j[k]);
		return Number.isFinite(x) ? x : Number.NEGATIVE_INFINITY;
	};
	return {
		kind: 'loudness',
		inputI: n('input_i'),
		inputTp: n('input_tp'),
		inputLra: Number.isFinite(n('input_lra')) ? n('input_lra') : 0,
		inputThresh: n('input_thresh'),
		targetOffset: Number.isFinite(n('target_offset')) ? n('target_offset') : 0,
	};
}

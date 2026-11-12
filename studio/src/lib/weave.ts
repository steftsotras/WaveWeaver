/**
 * The Weave vocabulary, shared by the Desk UI and the server compiler.
 *
 * A weave is an ordered list of steps applied to one source, compiled into a
 * single ffmpeg filtergraph: one decode, one encode, no matter how many
 * steps. (The old WaveWeaver re-encoded the whole file once per step.)
 */

export type Aspect = '16:9' | '9:16' | '1:1' | '4:5' | '4:3' | '21:9';
export const ASPECTS: Aspect[] = ['16:9', '9:16', '1:1', '4:5', '4:3', '21:9'];

export type EqBandType = 'highpass' | 'lowshelf' | 'peak' | 'highshelf' | 'lowpass';

export interface EqBand {
	type: EqBandType;
	on: boolean;
	/** Hz */
	f: number;
	/** dB (shelves and peaks) */
	g: number;
	q: number;
}

export function defaultEqBands(): EqBand[] {
	return [
		{ type: 'highpass', on: true, f: 80, g: 0, q: 0.707 },
		{ type: 'lowshelf', on: false, f: 120, g: 2, q: 0.707 },
		{ type: 'peak', on: false, f: 300, g: -2, q: 1 },
		{ type: 'peak', on: false, f: 3500, g: 2, q: 1 },
		{ type: 'highshelf', on: false, f: 10000, g: 1.5, q: 0.707 },
		{ type: 'lowpass', on: false, f: 18000, g: 0, q: 0.707 },
	];
}

export type StereoMode = 'keep' | 'mono' | 'swap' | 'left' | 'right';

export type StepBody =
	| { op: 'trim'; start: number; end: number | null }
	| { op: 'speed'; factor: number }
	| { op: 'reverse' }
	| {
			op: 'jumpcut';
			/** level: silencedetect threshold. speech: Silero VAD in the engine — ignores music and hum. */
			detector: 'level' | 'speech';
			thresholdDb: number;
			minSilenceMs: number;
			padMs: number;
			vadThreshold: number;
	  }
	| { op: 'eq'; bands: EqBand[] }
	| { op: 'compressor'; thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; makeupDb: number }
	| { op: 'limiter'; ceilingDb: number; releaseMs: number }
	| { op: 'gate'; thresholdDb: number; rangeDb: number; attackMs: number; releaseMs: number }
	| { op: 'deesser'; amount: number }
	| { op: 'dehum'; freq: 50 | 60; harmonics: number }
	| { op: 'declick'; clicks: boolean; clipping: boolean }
	| { op: 'stereo'; mode: StereoMode; width: number; balance: number }
	| { op: 'volume'; db: number }
	| { op: 'loudnorm'; lufs: number; truePeak: number }
	| { op: 'fade'; inSec: number; outSec: number }
	| { op: 'denoise'; amount: number }
	| { op: 'pitch'; semitones: number }
	| { op: 'mute' }
	| { op: 'reframe'; aspect: Aspect; fit: 'crop' | 'pad' | 'blur' }
	| { op: 'scale'; height: number }
	| { op: 'rotate'; turns: 1 | 2 | 3 }
	| { op: 'flip'; axis: 'h' | 'v' }
	| { op: 'fps'; fps: number }
	| { op: 'color'; brightness: number; contrast: number; saturation: number };

export type StepOp = StepBody['op'];

/** `id` is a client-side key for list rendering; `on` lets you bypass a step. */
export type Step = { id: string; on: boolean } & StepBody;

export type StepOf<O extends StepOp> = Extract<Step, { op: O }>;

export type StepGroup = 'time' | 'sound' | 'repair' | 'picture';

export interface StepMeta {
	op: StepOp;
	label: string;
	group: StepGroup;
	/** Which stream the step works on; used to grey out tools that can't apply. */
	needs: 'audio' | 'video' | 'any';
	blurb: string;
	/** Needs a measuring pass before the render. */
	analysis?: 'silence' | 'loudness' | 'speech';
	defaults: () => StepBody;
}

export const STEP_CATALOG: StepMeta[] = [
	{
		op: 'trim',
		label: 'Trim',
		group: 'time',
		needs: 'any',
		blurb: 'Keep only the part between in and out. Drag on the waveform to set it.',
		defaults: () => ({ op: 'trim', start: 0, end: null }),
	},
	{
		op: 'jumpcut',
		label: 'Jump cut',
		group: 'time',
		needs: 'audio',
		analysis: 'silence',
		blurb: 'Find every pause and cut it out — video and audio together, frame-aligned.',
		defaults: () => ({ op: 'jumpcut', detector: 'level', thresholdDb: -35, minSilenceMs: 600, padMs: 120, vadThreshold: 0.5 }),
	},
	{
		op: 'speed',
		label: 'Speed',
		group: 'time',
		needs: 'any',
		blurb: 'Faster or slower without chipmunk voices (pitch is preserved).',
		defaults: () => ({ op: 'speed', factor: 1.25 }),
	},
	{
		op: 'reverse',
		label: 'Reverse',
		group: 'time',
		needs: 'any',
		blurb: 'Play it backwards. Holds the whole clip in memory — keep it short.',
		defaults: () => ({ op: 'reverse' }),
	},
	{
		op: 'fade',
		label: 'Fade',
		group: 'time',
		needs: 'any',
		blurb: 'Fade in from black/silence and out to it.',
		defaults: () => ({ op: 'fade', inSec: 0.5, outSec: 1 }),
	},
	{
		op: 'loudnorm',
		label: 'Loudness',
		group: 'sound',
		needs: 'audio',
		analysis: 'loudness',
		blurb: 'Two-pass EBU R128 normalisation to a target LUFS. -14 for streaming, -16 podcasts, -23 broadcast.',
		defaults: () => ({ op: 'loudnorm', lufs: -14, truePeak: -1 }),
	},
	{
		op: 'volume',
		label: 'Volume',
		group: 'sound',
		needs: 'audio',
		blurb: 'Plain gain in decibels. +6 dB is roughly twice as loud.',
		defaults: () => ({ op: 'volume', db: 3 }),
	},
	{
		op: 'eq',
		label: 'EQ',
		group: 'sound',
		needs: 'audio',
		blurb: 'Six-band parametric EQ: low cut, low shelf, two bells, high shelf, high cut. Drag the dots.',
		defaults: () => ({ op: 'eq', bands: defaultEqBands() }),
	},
	{
		op: 'compressor',
		label: 'Compressor',
		group: 'sound',
		needs: 'audio',
		blurb: 'Evens out loud and quiet parts. Ratio is how hard; threshold is where it starts.',
		defaults: () => ({ op: 'compressor', thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 150, makeupDb: 3 }),
	},
	{
		op: 'limiter',
		label: 'Limiter',
		group: 'sound',
		needs: 'audio',
		blurb: 'A brickwall ceiling: nothing gets louder than this. Last in a mastering chain.',
		defaults: () => ({ op: 'limiter', ceilingDb: -1, releaseMs: 50 }),
	},
	{
		op: 'gate',
		label: 'Gate',
		group: 'sound',
		needs: 'audio',
		blurb: 'Turns the room down between words. Range is how far down.',
		defaults: () => ({ op: 'gate', thresholdDb: -45, rangeDb: -18, attackMs: 5, releaseMs: 200 }),
	},
	{
		op: 'stereo',
		label: 'Stereo',
		group: 'sound',
		needs: 'audio',
		blurb: 'Fold to mono, swap or pick a side, widen, rebalance.',
		defaults: () => ({ op: 'stereo', mode: 'keep', width: 1, balance: 0 }),
	},
	{
		op: 'denoise',
		label: 'Denoise',
		group: 'repair',
		needs: 'audio',
		blurb: 'FFT noise reduction plus an 80 Hz rumble filter. For learned-profile or neural cleanup, use the Lab.',
		defaults: () => ({ op: 'denoise', amount: 0.5 }),
	},
	{
		op: 'dehum',
		label: 'De-hum',
		group: 'repair',
		needs: 'audio',
		blurb: 'Notches out mains hum and its harmonics. 50 Hz in Europe, 60 Hz in the Americas.',
		defaults: () => ({ op: 'dehum', freq: 50, harmonics: 4 }),
	},
	{
		op: 'deesser',
		label: 'De-ess',
		group: 'repair',
		needs: 'audio',
		blurb: 'Tames harsh S and T sounds.',
		defaults: () => ({ op: 'deesser', amount: 0.5 }),
	},
	{
		op: 'declick',
		label: 'De-click',
		group: 'repair',
		needs: 'audio',
		blurb: 'Repairs clicks and pops, and reconstructs clipped peaks. Slow (about realtime).',
		defaults: () => ({ op: 'declick', clicks: true, clipping: false }),
	},
	{
		op: 'pitch',
		label: 'Pitch',
		group: 'sound',
		needs: 'audio',
		blurb: 'Shift pitch in semitones without changing duration.',
		defaults: () => ({ op: 'pitch', semitones: -3 }),
	},
	{
		op: 'mute',
		label: 'Mute',
		group: 'sound',
		needs: 'audio',
		blurb: 'Drop the audio track entirely.',
		defaults: () => ({ op: 'mute' }),
	},
	{
		op: 'reframe',
		label: 'Reframe',
		group: 'picture',
		needs: 'video',
		blurb: 'Change aspect ratio: crop to fill, pad with bars, or pad with a blurred copy.',
		defaults: () => ({ op: 'reframe', aspect: '9:16', fit: 'blur' }),
	},
	{
		op: 'scale',
		label: 'Resize',
		group: 'picture',
		needs: 'video',
		blurb: 'Scale to a standard height; width follows the aspect ratio.',
		defaults: () => ({ op: 'scale', height: 720 }),
	},
	{
		op: 'color',
		label: 'Color',
		group: 'picture',
		needs: 'video',
		blurb: 'Brightness, contrast and saturation.',
		defaults: () => ({ op: 'color', brightness: 0, contrast: 1.1, saturation: 1.2 }),
	},
	{
		op: 'rotate',
		label: 'Rotate',
		group: 'picture',
		needs: 'video',
		blurb: 'Quarter turns, clockwise.',
		defaults: () => ({ op: 'rotate', turns: 1 }),
	},
	{
		op: 'flip',
		label: 'Flip',
		group: 'picture',
		needs: 'video',
		blurb: 'Mirror horizontally or vertically.',
		defaults: () => ({ op: 'flip', axis: 'h' }),
	},
	{
		op: 'fps',
		label: 'Frame rate',
		group: 'picture',
		needs: 'video',
		blurb: 'Resample to a fixed frame rate.',
		defaults: () => ({ op: 'fps', fps: 30 }),
	},
];

export const STEP_GROUPS: { group: StepGroup; label: string }[] = [
	{ group: 'time', label: 'Time' },
	{ group: 'sound', label: 'Sound' },
	{ group: 'repair', label: 'Repair' },
	{ group: 'picture', label: 'Picture' },
];

/* --------------------------------------------------------------------------
 * EQ response — RBJ "Audio EQ Cookbook" biquads, the same formulas ffmpeg's
 * highpass/lowshelf/equalizer/highshelf/lowpass filters implement, so the
 * curve on screen is the curve you get.
 * -------------------------------------------------------------------------- */

function biquad(b: EqBand, sr: number): [number, number, number, number, number, number] {
	const w0 = (2 * Math.PI * Math.min(b.f, sr / 2 - 1)) / sr;
	const cos = Math.cos(w0);
	const sin = Math.sin(w0);
	const alpha = sin / (2 * b.q);
	const A = Math.pow(10, b.g / 40);
	switch (b.type) {
		case 'highpass':
			return [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
		case 'lowpass':
			return [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
		case 'peak':
			return [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
		case 'lowshelf': {
			const s = 2 * Math.sqrt(A) * alpha;
			return [
				A * (A + 1 - (A - 1) * cos + s),
				2 * A * (A - 1 - (A + 1) * cos),
				A * (A + 1 - (A - 1) * cos - s),
				A + 1 + (A - 1) * cos + s,
				-2 * (A - 1 + (A + 1) * cos),
				A + 1 + (A - 1) * cos - s,
			];
		}
		case 'highshelf': {
			const s = 2 * Math.sqrt(A) * alpha;
			return [
				A * (A + 1 + (A - 1) * cos + s),
				-2 * A * (A - 1 + (A + 1) * cos),
				A * (A + 1 + (A - 1) * cos - s),
				A + 1 - (A - 1) * cos + s,
				2 * (A - 1 - (A + 1) * cos),
				A + 1 - (A - 1) * cos - s,
			];
		}
	}
}

/** Combined magnitude response (dB) of the enabled bands at each frequency. */
export function eqResponseDb(bands: EqBand[], freqs: number[], sr = 48000): number[] {
	const coeffs = bands.filter((b) => b.on).map((b) => biquad(b, sr));
	return freqs.map((f) => {
		const w = (2 * Math.PI * f) / sr;
		let db = 0;
		for (const [b0, b1, b2, a0, a1, a2] of coeffs) {
			// |H(e^jw)| for one biquad.
			const nr = b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w);
			const ni = -(b1 * Math.sin(w) + b2 * Math.sin(2 * w));
			const dr = a0 + a1 * Math.cos(w) + a2 * Math.cos(2 * w);
			const di = -(a1 * Math.sin(w) + a2 * Math.sin(2 * w));
			db += 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
		}
		return db;
	});
}

export function metaFor(op: StepOp): StepMeta {
	return STEP_CATALOG.find((m) => m.op === op)!;
}

let seq = 0;
export function newStep(op: StepOp): Step {
	seq++;
	return { id: `s${Date.now().toString(36)}${seq}`, on: true, ...metaFor(op).defaults() } as Step;
}

export const SCALE_HEIGHTS = [2160, 1440, 1080, 720, 540, 480, 360];
export const FPS_CHOICES = [12, 15, 24, 25, 30, 50, 60];

/* --------------------------------------------------------------------------
 * Output
 * -------------------------------------------------------------------------- */

export type VideoFormat = 'mp4' | 'webm' | 'gif';
export type AudioFormat = 'mp3' | 'wav' | 'flac' | 'ogg' | 'opus' | 'm4a';
export type OutputFormat = VideoFormat | AudioFormat;

export const VIDEO_FORMATS: VideoFormat[] = ['mp4', 'webm', 'gif'];
export const AUDIO_FORMATS: AudioFormat[] = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus'];

export function isVideoFormat(f: OutputFormat): f is VideoFormat {
	return (VIDEO_FORMATS as string[]).includes(f);
}

export type Quality = 'draft' | 'standard' | 'high';
export const QUALITIES: Quality[] = ['draft', 'standard', 'high'];

/** What to draw when an audio-only source is rendered to a video format. */
export type Visual = 'waves' | 'spectrum' | 'black';
export const VISUALS: Visual[] = ['waves', 'spectrum', 'black'];

export interface OutputSpec {
	format: OutputFormat;
	quality: Quality;
	visual: Visual;
	canvas: Aspect;
}

export function defaultOutput(hasVideo: boolean): OutputSpec {
	return { format: hasVideo ? 'mp4' : 'mp3', quality: 'standard', visual: 'waves', canvas: '16:9' };
}

/* --------------------------------------------------------------------------
 * Plan (dry run) response
 * -------------------------------------------------------------------------- */

export interface WeavePlan {
	command: string;
	passes: string[];
	estimatedDurationSec: number | null;
	output: {
		hasVideo: boolean;
		hasAudio: boolean;
		width: number | null;
		height: number | null;
		fps: number | null;
		ext: string;
	};
	warnings: string[];
}

/* --------------------------------------------------------------------------
 * Validation: the server never trusts a step it didn't clamp itself.
 * -------------------------------------------------------------------------- */

function num(v: unknown, min: number, max: number, fallback: number): number {
	const n = typeof v === 'number' ? v : Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

function pick<T extends string | number>(v: unknown, allowed: readonly T[], fallback: T): T {
	return allowed.includes(v as T) ? (v as T) : fallback;
}

export function sanitizeStep(raw: unknown): Step | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const id = typeof r.id === 'string' ? r.id.slice(0, 40) : 'step';
	const on = r.on !== false;
	const base = { id, on };
	switch (r.op) {
		case 'trim': {
			const start = num(r.start, 0, 1e6, 0);
			const end = r.end == null || r.end === '' ? null : num(r.end, 0, 1e6, 0);
			return { ...base, op: 'trim', start, end: end != null && end <= start ? null : end };
		}
		case 'speed':
			return { ...base, op: 'speed', factor: num(r.factor, 0.25, 4, 1) };
		case 'reverse':
			return { ...base, op: 'reverse' };
		case 'jumpcut':
			return {
				...base,
				op: 'jumpcut',
				detector: pick(r.detector, ['level', 'speech'] as const, 'level'),
				thresholdDb: num(r.thresholdDb, -80, -10, -35),
				minSilenceMs: num(r.minSilenceMs, 100, 10000, 600),
				padMs: num(r.padMs, 0, 1000, 120),
				vadThreshold: num(r.vadThreshold, 0.1, 0.9, 0.5),
			};
		case 'eq': {
			const defaults = defaultEqBands();
			const raw = Array.isArray(r.bands) ? r.bands : [];
			const bands = defaults.map((d, i) => {
				const b = (raw[i] ?? {}) as Record<string, unknown>;
				return {
					type: d.type,
					on: b.on === undefined ? d.on : Boolean(b.on),
					f: num(b.f, 20, 20000, d.f),
					g: num(b.g, -24, 24, d.g),
					q: num(b.q, 0.1, 18, d.q),
				};
			});
			return { ...base, op: 'eq', bands };
		}
		case 'compressor':
			return {
				...base,
				op: 'compressor',
				thresholdDb: num(r.thresholdDb, -60, 0, -18),
				ratio: num(r.ratio, 1, 20, 3),
				attackMs: num(r.attackMs, 0.1, 500, 10),
				releaseMs: num(r.releaseMs, 5, 3000, 150),
				makeupDb: num(r.makeupDb, 0, 24, 0),
			};
		case 'limiter':
			return { ...base, op: 'limiter', ceilingDb: num(r.ceilingDb, -24, 0, -1), releaseMs: num(r.releaseMs, 1, 1000, 50) };
		case 'gate':
			return {
				...base,
				op: 'gate',
				thresholdDb: num(r.thresholdDb, -80, -10, -45),
				rangeDb: num(r.rangeDb, -80, 0, -18),
				attackMs: num(r.attackMs, 0.1, 200, 5),
				releaseMs: num(r.releaseMs, 5, 3000, 200),
			};
		case 'deesser':
			return { ...base, op: 'deesser', amount: num(r.amount, 0, 1, 0.5) };
		case 'dehum':
			return { ...base, op: 'dehum', freq: pick(r.freq, [50, 60] as const, 50), harmonics: Math.round(num(r.harmonics, 1, 8, 4)) };
		case 'declick':
			return { ...base, op: 'declick', clicks: r.clicks !== false, clipping: Boolean(r.clipping) };
		case 'stereo':
			return {
				...base,
				op: 'stereo',
				mode: pick(r.mode, ['keep', 'mono', 'swap', 'left', 'right'] as const, 'keep'),
				width: num(r.width, 0, 2.5, 1),
				balance: num(r.balance, -1, 1, 0),
			};
		case 'volume':
			return { ...base, op: 'volume', db: num(r.db, -40, 40, 0) };
		case 'loudnorm':
			return { ...base, op: 'loudnorm', lufs: num(r.lufs, -40, -5, -14), truePeak: num(r.truePeak, -9, 0, -1) };
		case 'fade':
			return { ...base, op: 'fade', inSec: num(r.inSec, 0, 60, 0), outSec: num(r.outSec, 0, 60, 0) };
		case 'denoise':
			return { ...base, op: 'denoise', amount: num(r.amount, 0, 1, 0.5) };
		case 'pitch':
			return { ...base, op: 'pitch', semitones: Math.round(num(r.semitones, -12, 12, 0)) };
		case 'mute':
			return { ...base, op: 'mute' };
		case 'reframe':
			return {
				...base,
				op: 'reframe',
				aspect: pick(r.aspect, ASPECTS, '9:16'),
				fit: pick(r.fit, ['crop', 'pad', 'blur'] as const, 'blur'),
			};
		case 'scale':
			return { ...base, op: 'scale', height: Math.round(num(r.height, 64, 4320, 720) / 2) * 2 };
		case 'rotate':
			return { ...base, op: 'rotate', turns: pick(r.turns, [1, 2, 3] as const, 1) };
		case 'flip':
			return { ...base, op: 'flip', axis: pick(r.axis, ['h', 'v'] as const, 'h') };
		case 'fps':
			return { ...base, op: 'fps', fps: num(r.fps, 1, 120, 30) };
		case 'color':
			return {
				...base,
				op: 'color',
				brightness: num(r.brightness, -0.5, 0.5, 0),
				contrast: num(r.contrast, 0.3, 2.5, 1),
				saturation: num(r.saturation, 0, 3, 1),
			};
		default:
			return null;
	}
}

export function sanitizeSteps(raw: unknown): Step[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.slice(0, 40)
		.map(sanitizeStep)
		.filter((s): s is Step => s !== null);
}

export function sanitizeOutput(raw: unknown, hasVideo: boolean): OutputSpec {
	const d = defaultOutput(hasVideo);
	if (!raw || typeof raw !== 'object') return d;
	const r = raw as Record<string, unknown>;
	return {
		format: pick(r.format, [...VIDEO_FORMATS, ...AUDIO_FORMATS] as OutputFormat[], d.format),
		quality: pick(r.quality, QUALITIES, d.quality),
		visual: pick(r.visual, VISUALS, d.visual),
		canvas: pick(r.canvas, ASPECTS, d.canvas),
	};
}

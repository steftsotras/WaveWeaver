/**
 * Presets are plain weave step lists. Applying one inserts ordinary steps
 * you can see and tweak — no black boxes. Built-ins live here; your own
 * recipes are JSON files in media/presets/.
 */
import { defaultEqBands, metaFor, newStep, type EqBand, type OutputSpec, type Step, type StepBody } from './weave';

export type PresetGroup = 'mastering' | 'voice' | 'repair' | 'creative' | 'mine';

export interface Preset {
	id: string;
	name: string;
	group: PresetGroup;
	description: string;
	/** Loudness target, shown as a tag ("−16 LUFS"). */
	target?: string;
	steps: StepBody[];
	output?: OutputSpec;
	builtin?: boolean;
}

export const PRESET_GROUPS: { group: PresetGroup; label: string }[] = [
	{ group: 'mastering', label: 'Mastering' },
	{ group: 'voice', label: 'Voice' },
	{ group: 'repair', label: 'Repair' },
	{ group: 'creative', label: 'Creative' },
	{ group: 'mine', label: 'Mine' },
];

type BandPatch = Partial<Omit<EqBand, 'type'>>;

/** EQ step from per-slot patches: [lowcut, lowshelf, bell, bell, highshelf, highcut]. */
function eq(...patches: (BandPatch | null)[]): StepBody {
	const bands = defaultEqBands().map((b, i) => {
		const p = patches[i];
		return p ? { ...b, on: true, ...p } : { ...b, on: false };
	});
	return { op: 'eq', bands };
}

const comp = (thresholdDb: number, ratio: number, attackMs: number, releaseMs: number, makeupDb: number): StepBody => ({
	op: 'compressor',
	thresholdDb,
	ratio,
	attackMs,
	releaseMs,
	makeupDb,
});
const limit = (ceilingDb: number, releaseMs = 50): StepBody => ({ op: 'limiter', ceilingDb, releaseMs });
const loud = (lufs: number, truePeak: number): StepBody => ({ op: 'loudnorm', lufs, truePeak });

export const BUILTIN_PRESETS: Preset[] = [
	{
		id: 'podcast-voice',
		name: 'Podcast voice',
		group: 'voice',
		target: '−16 LUFS',
		description: 'Rumble cut, de-mud at 300 Hz, presence at 3.5 kHz, de-ess, 3:1 glue, limiter, −16 LUFS (Apple Podcasts / Spotify spoken word).',
		steps: [eq({ f: 80 }, null, { f: 300, g: -2.5, q: 1 }, { f: 3500, g: 2.5, q: 1 }, { f: 10000, g: 1.5 }), { op: 'deesser', amount: 0.4 }, comp(-20, 3, 10, 120, 3), limit(-1.5), loud(-16, -1.5)],
	},
	{
		id: 'youtube-voiceover',
		name: 'YouTube voiceover',
		group: 'voice',
		target: '−14 LUFS',
		description: 'Podcast voice, pushed to −14 LUFS so it sits level with music on YouTube and social.',
		steps: [eq({ f: 90 }, null, { f: 300, g: -2, q: 1 }, { f: 4000, g: 3, q: 0.9 }, { f: 11000, g: 2 }), { op: 'deesser', amount: 0.45 }, comp(-22, 3.5, 8, 120, 4), limit(-1), loud(-14, -1)],
	},
	{
		id: 'audiobook-acx',
		name: 'Audiobook (ACX)',
		group: 'voice',
		target: '−20 LUFS',
		description: 'Meets Audible/ACX: RMS around −20 dB, peaks under −3 dB, a quiet noise floor between words.',
		steps: [eq({ f: 80 }, null, { f: 250, g: -2, q: 1 }, { f: 3000, g: 1.5, q: 1 }, null), { op: 'gate', thresholdDb: -50, rangeDb: -12, attackMs: 5, releaseMs: 250 }, { op: 'deesser', amount: 0.3 }, comp(-22, 2.5, 15, 150, 2), limit(-3.5), loud(-20, -3.5)],
	},
	{
		id: 'streaming-music',
		name: 'Streaming master',
		group: 'mastering',
		target: '−14 LUFS',
		description: 'Gentle music master for Spotify / Apple Music / YouTube: sub cut, a touch of low and air, 2:1 glue, −14 LUFS, −1 dBTP.',
		steps: [eq({ f: 30 }, { f: 100, g: 1 }, null, null, { f: 12000, g: 1.5 }), comp(-16, 2, 30, 200, 1), limit(-1), loud(-14, -1)],
	},
	{
		id: 'broadcast-r128',
		name: 'Broadcast (EBU R128)',
		group: 'mastering',
		target: '−23 LUFS',
		description: 'European TV/radio delivery: −23 LUFS integrated, true peak under −2 dBTP, light compression.',
		steps: [eq({ f: 40 }, null, null, null, null), comp(-24, 2, 20, 200, 1), limit(-2), loud(-23, -2)],
	},
	{
		id: 'loud-club',
		name: 'Loud & punchy',
		group: 'mastering',
		target: '−9 LUFS',
		description: 'Club / DJ-promo loudness. Heavy compression and a hot limiter — expect less dynamics.',
		steps: [eq({ f: 28 }, { f: 80, g: 2 }, null, null, { f: 10000, g: 1 }), comp(-14, 4, 5, 80, 3), limit(-0.3, 30), loud(-9, -0.5)],
	},
	{
		id: 'clean-dialogue',
		name: 'Clean up dialogue',
		group: 'repair',
		description: 'Rumble cut, 50 Hz hum notches, FFT denoise, de-ess and a soft gate. No loudness change — chain a voice preset after it.',
		steps: [eq({ f: 80 }, null, null, null, null), { op: 'dehum', freq: 50, harmonics: 4 }, { op: 'denoise', amount: 0.5 }, { op: 'deesser', amount: 0.4 }, { op: 'gate', thresholdDb: -45, rangeDb: -15, attackMs: 5, releaseMs: 200 }],
	},
	{
		id: 'warm-lofi',
		name: 'Warm lo-fi',
		group: 'creative',
		target: '−14 LUFS',
		description: 'Rolled-off top, boosted lows, squashed — a cassette-ish warmth.',
		steps: [eq({ f: 120 }, { f: 200, g: 3 }, null, null, { f: 6000, g: -4 }, { f: 9000 }), comp(-18, 3, 20, 200, 2), loud(-14, -1)],
	},
	{
		id: 'phone-call',
		name: 'Phone call',
		group: 'creative',
		description: 'Band-limited 400–3400 Hz with a nasal bump and hard compression.',
		steps: [eq({ f: 400 }, null, { f: 1500, g: 4, q: 0.7 }, null, null, { f: 3400 }), comp(-25, 6, 3, 60, 6)],
	},
];

export function presetSteps(p: Preset): Step[] {
	// JSON, not structuredClone: presets often arrive as Svelte $state proxies,
	// which structuredClone refuses.
	return p.steps.map((body) => ({ ...newStep(body.op), ...JSON.parse(JSON.stringify(body)), on: true }) as Step);
}

/** "HPF → EQ → De-ess → Compressor → Limiter → Loudness" */
export function chainSummary(p: Preset): string {
	return p.steps.map((s) => metaFor(s.op).label).join(' → ');
}

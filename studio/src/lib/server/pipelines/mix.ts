import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobResult } from '$lib/jobs';
import { stemOf, type MediaInfo } from '$lib/media';
import type { MixSpec, MixTrack } from '$lib/mix';
import { listPresets } from '../presets.js';
import { encoderArgs } from '../encode.js';
import type { JobContext } from '../jobs.js';
import { CACHE_DIR, resolveMedia } from '../paths.js';
import { probeCached } from '../probe.js';
import { describeOutput, encodeFile, graphArgs, renderPath } from './common.js';
import { clampWindow, finishPreview, PREVIEW_DIR, type PreviewWindow } from './preview.js';
import { compileResolved } from './weave.js';
import { isVideoFormat, type OutputSpec, type Step } from '$lib/weave';

/**
 * Mixing in one ffmpeg graph:
 *
 *   each track → 48k stereo → fades → gain → pan → delayed to its offset
 *   voice tracks → [voice]      music tracks → [bed]      fx → [fx]
 *   [bed] ducked by a sidechain compressor keyed from [voice]
 *   [voice] + [bed] + [fx] → amix (no auto-normalising: your gains stand)
 *
 * Mastering is a second step: the mix is written to a lossless WAV and
 * run through the chosen preset as an ordinary weave — so two-pass
 * loudness measures the finished mix, not its parts.
 */

interface Loaded {
	track: MixTrack;
	path: string;
	info: MediaInfo;
}

function db(x: number): string {
	return Math.pow(10, x / 20).toFixed(6);
}

export function mixDuration(tracks: Loaded[]): number {
	return Math.max(0, ...tracks.map((t) => t.track.offset + (t.info.duration ?? 0)));
}

async function load(spec: MixSpec): Promise<Loaded[]> {
	const anySolo = spec.tracks.some((t) => t.solo);
	const live = spec.tracks.filter((t) => (anySolo ? t.solo : !t.mute));
	if (!live.length) throw new Error('Every track is muted.');
	const out: Loaded[] = [];
	for (const track of live) {
		const path = await resolveMedia(track.ref);
		const info = await probeCached(path);
		if (!info.audio) throw new Error(`${track.ref.name} has no audio.`);
		out.push({ track, path, info });
	}
	return out;
}

/**
 * The mix graph. `dry` skips ducking (for the "before" side of a preview:
 * the plain sum of your tracks at your gains).
 */
function buildGraph(tracks: Loaded[], spec: MixSpec, opts: { dry: boolean; window?: PreviewWindow }): string {
	const parts: string[] = [];
	const groups: Record<'voice' | 'music' | 'fx', string[]> = { voice: [], music: [], fx: [] };
	tracks.forEach(({ track: t, info }, i) => {
		const D = info.duration ?? 0;
		const chain = [`aresample=48000`, 'aformat=sample_fmts=fltp:channel_layouts=stereo'];
		if (t.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${t.fadeIn.toFixed(3)}`);
		if (t.fadeOut > 0 && D) chain.push(`afade=t=out:st=${Math.max(0, D - t.fadeOut).toFixed(3)}:d=${t.fadeOut.toFixed(3)}`);
		if (t.gainDb) chain.push(`volume=${t.gainDb.toFixed(1)}dB`);
		if (Math.abs(t.pan) > 0.01) {
			const l = t.pan > 0 ? 1 - t.pan : 1;
			const r = t.pan < 0 ? 1 + t.pan : 1;
			chain.push(`pan=stereo|c0=${l.toFixed(3)}*c0|c1=${r.toFixed(3)}*c1`);
		}
		if (t.offset > 0) {
			const ms = Math.round(t.offset * 1000);
			chain.push(`adelay=${ms}|${ms}`);
		}
		parts.push(`[${i}:a]${chain.join(',')}[t${i}]`);
		groups[t.role].push(`t${i}`);
	});

	const sum = (labels: string[], out: string) => {
		if (labels.length === 1) parts.push(`[${labels[0]}]anull[${out}]`);
		else parts.push(`${labels.map((l) => `[${l}]`).join('')}amix=inputs=${labels.length}:duration=longest:normalize=0[${out}]`);
	};

	const finals: string[] = [];
	const duck = spec.duck.on && !opts.dry && groups.voice.length && groups.music.length;
	if (groups.voice.length) sum(groups.voice, duck ? 'voice0' : 'voice');
	if (groups.music.length) sum(groups.music, duck ? 'bed0' : 'bed');
	if (groups.fx.length) sum(groups.fx, 'fx');
	if (duck) {
		// Sidechain: the voice keys a compressor on the music. Threshold sits
		// low so any speech triggers it; the ratio is chosen so the bed drops
		// by roughly `depthDb` under typical speech level.
		const ratio = Math.min(20, Math.max(2, Math.abs(spec.duck.depthDb) / 2));
		// sidechaincompress stops when its key stream ends; pad the key with
		// silence so music that outlasts the voice plays out in full.
		parts.push('[voice0]asplit=2[voice][key0]', '[key0]apad[key]');
		parts.push(
			`[bed0][key]sidechaincompress=threshold=0.02:ratio=${ratio.toFixed(1)}` +
				`:attack=${spec.duck.attackMs}:release=${spec.duck.releaseMs}:makeup=1[bed]`,
		);
	}
	if (groups.voice.length) finals.push('voice');
	if (groups.music.length) finals.push('bed');
	if (groups.fx.length) finals.push('fx');
	const trim = opts.window
		? `,atrim=start=${opts.window.start.toFixed(3)}:duration=${opts.window.duration.toFixed(3)},asetpts=PTS-STARTPTS`
		: '';
	if (finals.length === 1) parts.push(`[${finals[0]}]anull${trim}[mix]`);
	else parts.push(`${finals.map((l) => `[${l}]`).join('')}amix=inputs=${finals.length}:duration=longest:normalize=0${trim}[mix]`);
	return parts.join(';\n');
}

async function renderMixWav(tracks: Loaded[], spec: MixSpec, out: string, ctx: JobContext, opts: { dry: boolean; window?: PreviewWindow }) {
	const graph = buildGraph(tracks, spec, opts);
	const g = await graphArgs(graph);
	try {
		const inputs = tracks.flatMap((t) => ['-vn', '-i', t.path]);
		const expected = opts.window?.duration ?? mixDuration(tracks);
		await encodeFile(out, [...inputs, ...g.args, '-map', '[mix]', '-c:a', 'pcm_s24le'], ctx, { graph, expectedDuration: expected });
	} finally {
		await g.cleanup();
	}
}

async function masterSteps(spec: MixSpec): Promise<Step[]> {
	if (!spec.master) return [];
	const p = (await listPresets()).find((x) => x.id === spec.master);
	if (!p) throw new Error(`No preset ${spec.master}`);
	return p.steps.map((s, i) => ({ ...s, id: `m${i}`, on: true }) as Step);
}

/** Weave the mixed WAV through the master chain into the requested format (+ picture). */
async function finish(
	wav: string,
	tracks: Loaded[],
	spec: MixSpec,
	out: string,
	ctx: JobContext,
	opts: { quality: 'draft' | 'standard'; window?: PreviewWindow },
): Promise<void> {
	const steps = await masterSteps(spec);
	const info = await probeCached(wav);
	const format = spec.format;
	const video = spec.videoFrom ? tracks.find((t) => t.track.id === spec.videoFrom && t.info.video) : null;
	const audioFormat = isVideoFormat(format as OutputSpec['format']) ? 'wav' : format;
	const output: OutputSpec = { format: audioFormat as OutputSpec['format'], quality: opts.quality, visual: 'waves', canvas: '16:9' };
	const c = await compileResolved(wav, info, { source: { bin: '', kind: 'sources', name: '' }, steps, output }, ctx);
	const g = await graphArgs(c.graph);
	try {
		if (format !== 'mp4') {
			await encodeFile(out, [...c.inputArgs, ...g.args, ...c.outputArgs], ctx, { graph: c.graph, expectedDuration: c.duration });
			return;
		}
		// MP4: the mastered audio plus a picture — the chosen video track
		// (placed at its offset), or an accent waveform if none.
		const D = c.duration ?? mixDuration(tracks);
		let videoInput: string[] = [];
		let vgraph: string;
		if (video) {
			const off = opts.window ? Math.max(0, video.track.offset - opts.window.start) : video.track.offset;
			const seek = opts.window ? Math.max(0, opts.window.start - video.track.offset) : 0;
			videoInput = [...(seek ? ['-ss', seek.toFixed(3)] : []), '-i', video.path];
			vgraph = `[1:v]tpad=start_duration=${off.toFixed(3)}:stop_mode=clone:stop_duration=${D.toFixed(3)},trim=duration=${D.toFixed(3)},format=yuv420p[vout]`;
		} else {
			vgraph = `[aout]asplit=2[aout2][vis];[vis]showwaves=s=1280x720:mode=cline:rate=30:colors=0xFF4F00:scale=sqrt,format=yuv420p[vout]`;
		}
		const full = video ? `${c.graph};\n${vgraph}` : `${c.graph};\n${vgraph}`;
		const g2 = await graphArgs(full);
		try {
			await encodeFile(
				out,
				[...c.inputArgs, ...videoInput, ...g2.args, '-map', '[vout]', '-map', video ? '[aout]' : '[aout2]', ...encoderArgs('mp4', opts.quality, { video: true, audio: true })],
				ctx,
				{ graph: full, expectedDuration: D },
			);
		} finally {
			await g2.cleanup();
		}
	} finally {
		await g.cleanup();
	}
}

export async function runMix(spec: MixSpec, ctx: JobContext): Promise<JobResult> {
	const tracks = await load(spec);
	const D = mixDuration(tracks);
	ctx.log(`${tracks.length} tracks, ${D.toFixed(1)}s${spec.duck.on ? ', music ducks under voice' : ''}${spec.master ? `, mastered with ${spec.master}` : ''}`);
	const dir = join(CACHE_DIR, 'tmp', randomUUID());
	await mkdir(dir, { recursive: true });
	try {
		ctx.phase('mix');
		const wav = join(dir, 'mix.wav');
		await renderMixWav(tracks, spec, wav, ctx, { dry: false });
		ctx.phase(spec.master ? 'master' : 'encode');
		const first = tracks[0].track.ref;
		const out = await renderPath(first.bin, stemOf(first.name), `mix${tracks.length}`, spec.format);
		await finish(wav, tracks, spec, out, ctx, { quality: 'standard' });
		return { outputs: [await describeOutput(out)] };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** A: the plain sum of your tracks at your gains. B: ducked and mastered, as it will render. */
export async function runMixPreview(id: string, spec: MixSpec, window: PreviewWindow, ctx: JobContext): Promise<JobResult> {
	const tracks = await load(spec);
	const w = clampWindow(window, mixDuration(tracks));
	const dir = join(PREVIEW_DIR, id);
	await mkdir(dir, { recursive: true });
	ctx.phase('dry sum');
	const a = join(dir, 'a.wav');
	await renderMixWav(tracks, spec, a, ctx, { dry: true, window: w });
	ctx.phase('mix');
	const wet = join(dir, 'wet.wav');
	await renderMixWav(tracks, spec, wet, ctx, { dry: false, window: w });
	ctx.phase(spec.master ? 'master' : 'encode');
	const b = join(dir, 'b.wav');
	await finish(wet, tracks, { ...spec, format: 'wav', videoFrom: null }, b, ctx, { quality: 'draft', window: w });
	await rm(wet, { force: true });
	const notes = spec.master ? ['Mastering loudness is measured on this window; the full render measures the whole mix.'] : [];
	return finishPreview(id, w, a, b, notes, ctx);
}

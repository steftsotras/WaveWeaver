import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	DEFAULT_REFLOW,
	ISO639_2,
	languageName,
	reflow,
	rewrap,
	segmentsToCues,
	shiftCues,
	toSrt,
	type CaptionTrack,
	type Cue,
	type Word,
} from '$lib/captions';
import type { JobResult } from '$lib/jobs';
import { stemOf, type MediaInfo } from '$lib/media';
import { loadTrack, saveTrack } from '../captions.js';
import { encoderArgs } from '../encode.js';
import { runEngine } from '../engine.js';
import type { JobContext } from '../jobs.js';
import { CACHE_DIR, resolveMedia, type MediaRef } from '../paths.js';
import { probeCached } from '../probe.js';
import { describeOutput, encodeFile, encodeTo, graphArgs, renderPath } from './common.js';
import { clampWindow, finishPreview, PREVIEW_DIR, renderOriginal, type PreviewWindow } from './preview.js';

/* --------------------------------------------------------------------------
 * Transcribe
 * -------------------------------------------------------------------------- */

export interface TranscribeParams {
	source: MediaRef;
	model: string;
	language: string;
	task: 'transcribe' | 'translate';
	vad: boolean;
	prompt: string;
	/** Present = preview: transcribe just this window and don't save. */
	window?: PreviewWindow;
}

export async function runTranscribe(p: TranscribeParams, ctx: JobContext): Promise<JobResult> {
	const r = await runEngine(ctx, {
		tool: 'transcribe',
		input: p.source,
		params: { model: p.model, language: p.language, task: p.task, vad: p.vad, prompt: p.prompt },
		...(p.window ? { excerpt: p.window } : {}),
		output: { mode: 'data' },
	});
	const data = r.data as {
		language: string;
		model: string;
		device: string;
		task: string;
		segments: { start: number; end: number; text: string; words: Word[] }[];
	};
	const cues = reflow(segmentsToCues(data.segments), DEFAULT_REFLOW);
	ctx.log(`${data.segments.length} Whisper segments → ${cues.length} subtitle cues (${languageName(data.language)}).`);
	if (p.window) return { outputs: [], data: { preview: true, language: data.language, cues } };

	const track: CaptionTrack = {
		version: 1,
		lang: data.language,
		source: p.source,
		origin: { kind: 'whisper', model: data.model, device: data.device, task: data.task },
		updatedAt: Date.now(),
		cues,
	};
	await saveTrack(track);
	ctx.log(`Saved ${p.source.name}.${track.lang}.srt`);
	return { outputs: [], data: { lang: track.lang, cues: cues.length } };
}

/* --------------------------------------------------------------------------
 * Translate
 * -------------------------------------------------------------------------- */

export interface TranslateParams {
	source: MediaRef;
	from: string;
	to: string;
	provider: string;
}

/**
 * A translated track keeps every cue's id and timing; only the words
 * change. That's what makes bilingual editing and multi-language exports
 * line up exactly.
 */
export async function runTranslate(p: TranslateParams, ctx: JobContext): Promise<JobResult> {
	const original = await loadTrack(p.source, p.from);
	ctx.log(`Translating ${original.cues.length} cues ${languageName(p.from)} → ${languageName(p.to)}`);
	const r = await runEngine(ctx, {
		tool: 'translate',
		payload: { source: p.from, cues: original.cues.map((c) => ({ id: c.id, text: c.text.replace(/\n/g, ' ') })) },
		params: { source: p.from, target: p.to, provider: p.provider },
		output: { mode: 'data' },
	});
	const data = r.data as { cues: { id: string; text: string }[]; provider: string };
	const byId = new Map(data.cues.map((c) => [c.id, c.text]));
	const cues: Cue[] = rewrap(
		original.cues.map((c) => ({ id: c.id, start: c.start, end: c.end, text: byId.get(c.id) ?? c.text, speaker: c.speaker ?? null, note: c.note ?? null })),
		DEFAULT_REFLOW,
	);
	await saveTrack({
		version: 1,
		lang: p.to,
		source: p.source,
		origin: { kind: 'translation', from: p.from, provider: data.provider },
		updatedAt: Date.now(),
		cues,
	});
	ctx.log(`Saved ${p.source.name}.${p.to}.srt (${data.provider})`);
	return { outputs: [], data: { lang: p.to, cues: cues.length } };
}

/* --------------------------------------------------------------------------
 * Subtitled renders: burned in, or as switchable tracks
 * -------------------------------------------------------------------------- */

export interface SubtitleStyle {
	size: 's' | 'm' | 'l';
	position: 'bottom' | 'top';
	box: boolean;
	color: 'white' | 'yellow' | 'accent';
}

export interface SubtitleParams {
	source: MediaRef;
	mode: 'burn' | 'soft';
	langs: string[];
	style: SubtitleStyle;
	speakers: boolean;
	container: 'mp4' | 'mkv';
	window?: PreviewWindow;
}

const ASS_COLOR: Record<SubtitleStyle['color'], string> = {
	white: '&H00FFFFFF',
	yellow: '&H0000FFFF',
	accent: '&H00004FFF', // #FF4F00 in ASS's &HAABBGGRR
};

function assTime(t: number): string {
	const cs = Math.max(0, Math.round(t * 100));
	const h = Math.floor(cs / 360000);
	const m = Math.floor((cs % 360000) / 6000);
	const s = Math.floor((cs % 6000) / 100);
	return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/**
 * ASS rather than SRT for burning in: it carries the style (size relative
 * to the frame, box or outline, position), so the result looks the same on
 * a 720p clip and a 4K one.
 */
export function buildAss(cues: Cue[], w: number, h: number, style: SubtitleStyle, speakers: boolean): string {
	const fs = Math.round(h * { s: 0.045, m: 0.058, l: 0.075 }[style.size]);
	const margin = Math.round(h * 0.06);
	const border = style.box ? `3,${Math.round(fs * 0.22)},0` : `1,${Math.max(2, Math.round(fs / 14))},${Math.max(1, Math.round(fs / 28))}`;
	const outline = style.box ? '&H99000000' : '&H00000000';
	const text = (c: Cue) =>
		(speakers && c.speaker ? `${c.speaker}: ${c.text}` : c.text).replace(/[{}]/g, '').replace(/\\/g, '＼').replace(/\n/g, '\\N');
	return [
		'[Script Info]',
		'ScriptType: v4.00+',
		`PlayResX: ${w}`,
		`PlayResY: ${h}`,
		'WrapStyle: 0',
		'ScaledBorderAndShadow: yes',
		'',
		'[V4+ Styles]',
		'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
		`Style: Default,Arial,${fs},${ASS_COLOR[style.color]},&H000000FF,${outline},&H80000000,-1,0,0,0,100,100,0,0,${border},${style.position === 'top' ? 8 : 2},${margin},${margin},${margin},1`,
		'',
		'[Events]',
		'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
		...cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${text(c)}`),
		'',
	].join('\n');
}

async function burn(
	path: string,
	info: MediaInfo,
	track: CaptionTrack,
	p: SubtitleParams,
	out: string,
	ctx: JobContext,
	window?: PreviewWindow,
): Promise<void> {
	const W = info.video?.width ?? 1280;
	const H = info.video?.height ?? 720;
	// Input seeking resets timestamps to 0, so a preview's subtitles shift with it.
	const cues = window
		? shiftCues(track.cues.filter((c) => c.end > window.start && c.start < window.start + window.duration), -window.start)
		: track.cues;
	const dir = join(CACHE_DIR, 'subs', randomUUID());
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'subs.ass'), buildAss(cues, W, H, p.style, p.speakers));
	// No picture? Draw an accent waveform under the words — a captioned audiogram.
	const graph = info.video
		? '[0:v]subtitles=subs.ass,format=yuv420p[vout]'
		: `[0:a]asplit=2[aout][vis];[vis]showwaves=s=${W}x${H}:mode=cline:rate=30:colors=0xFF4F00:scale=sqrt,format=yuv420p,subtitles=subs.ass[vout]`;
	const g = await graphArgs(graph);
	try {
		const seek = window ? ['-ss', window.start.toFixed(3), '-t', window.duration.toFixed(3)] : [];
		const argv = [
			...seek,
			'-i',
			path,
			...g.args,
			'-map',
			'[vout]',
			...(info.video ? (info.audio ? ['-map', '0:a:0'] : []) : ['-map', '[aout]']),
			...encoderArgs('mp4', window ? 'draft' : 'standard', { video: true, audio: Boolean(info.audio) }),
		];
		await encodeFile(out, argv, ctx, { graph, expectedDuration: window?.duration ?? info.duration, cwd: dir });
	} finally {
		await g.cleanup();
		await rm(dir, { recursive: true, force: true });
	}
}

export async function runSubtitle(p: SubtitleParams, ctx: JobContext): Promise<JobResult> {
	const path = await resolveMedia(p.source);
	const info = await probeCached(path);
	const tracks = await Promise.all(p.langs.map((l) => loadTrack(p.source, l)));
	if (!tracks.length) throw new Error('Pick at least one caption track.');

	if (p.mode === 'burn') {
		ctx.phase('burn in');
		const out = await renderPath(p.source.bin, stemOf(p.source.name), `subs-${tracks[0].lang}`, 'mp4');
		await burn(path, info, tracks[0], p, out, ctx);
		return { outputs: [await describeOutput(out)] };
	}

	// Soft subtitles: the picture and sound are stream-copied; each track is
	// a switchable subtitle stream with its language tagged.
	if (!info.video) throw new Error('Soft subtitles need a video. For audio, burn them into an audiogram instead.');
	ctx.phase('mux');
	const dir = join(CACHE_DIR, 'subs', randomUUID());
	await mkdir(dir, { recursive: true });
	try {
		const inputs: string[] = ['-i', path];
		const maps: string[] = ['-map', '0:v:0', ...(info.audio ? ['-map', '0:a:0'] : [])];
		const meta: string[] = [];
		for (let i = 0; i < tracks.length; i++) {
			const t = tracks[i];
			const srt = join(dir, `${t.lang}.srt`);
			await writeFile(srt, toSrt(t.cues, p.speakers));
			inputs.push('-i', srt);
			maps.push('-map', `${i + 1}:0`);
			meta.push(`-metadata:s:s:${i}`, `language=${ISO639_2[t.lang] ?? t.lang}`, `-metadata:s:s:${i}`, `title=${languageName(t.lang)}`);
		}
		const out = await renderPath(p.source.bin, stemOf(p.source.name), `subs-${tracks.map((t) => t.lang).join('-')}`, p.container);
		const sub = p.container === 'mp4' ? 'mov_text' : 'srt';
		const output = await encodeTo(
			out,
			[...inputs, ...maps, '-c:v', 'copy', '-c:a', 'copy', '-c:s', sub, ...meta, '-disposition:s:0', 'default'],
			ctx,
			{ graph: null, expectedDuration: info.duration },
		);
		return { outputs: [output] };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Burn-in preview: the excerpt without and with subtitles, side by side. */
export async function runSubtitlePreview(id: string, p: SubtitleParams, ctx: JobContext): Promise<JobResult> {
	const path = await resolveMedia(p.source);
	const info = await probeCached(path);
	const w = clampWindow(p.window ?? { start: 0, duration: 10 }, info.duration);
	const track = await loadTrack(p.source, p.langs[0]);
	const dir = join(PREVIEW_DIR, id);
	await mkdir(dir, { recursive: true });
	ctx.phase('original');
	const a = await renderOriginal(path, info, w, true, dir, ctx);
	ctx.phase('burn in');
	const b = join(dir, 'b.mp4');
	await burn(path, info, track, p, b, ctx, w);
	return finishPreview(id, w, a, b, [], ctx);
}

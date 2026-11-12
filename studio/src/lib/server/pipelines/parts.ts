import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobOutput, JobResult } from '$lib/jobs';
import { extOf, stemOf, VIDEO_EXTS, type MediaInfo } from '$lib/media';
import { joinedLength, joinedTimeline, kept, toChapterList, type ExportOptions, type Part } from '$lib/parts';
import type { OutputFormat } from '$lib/weave';
import { encoderArgs } from '../encode.js';
import { runFfmpeg, throwIfAborted } from '../ffmpeg.js';
import type { JobContext } from '../jobs.js';
import { CACHE_DIR, resolveMedia, type MediaRef } from '../paths.js';
import { probeCached } from '../probe.js';
import { timestampSuffix } from '../text.js';
import { parseLoudness, type LoudnessAnalysis } from '../weave.js';
import { encodeFile, encodeTo, graphArgs, renderPath } from './common.js';
import { finishPreview, PREVIEW_DIR, renderOriginal } from './preview.js';

export interface PartsParams {
	source: MediaRef;
	parts: Part[];
	export: ExportOptions;
	/** Preview: render a short stretch starting at this part instead of everything. */
	preview?: { fromPart: string | null; seconds: number };
}

const MAX_JOIN_INPUTS = 150;

/** "same" → the source's own format, as an output format the encoders know. */
function resolveFormat(fmt: ExportOptions['format'], name: string, info: MediaInfo): OutputFormat {
	if (fmt !== 'same') {
		if (fmt === 'mp4' && !info.video) throw new Error('MP4 needs a video source; pick an audio format.');
		return fmt;
	}
	const ext = extOf(name).slice(1);
	if (info.video && VIDEO_EXTS.has(`.${ext}`)) return ext === 'webm' ? 'webm' : 'mp4';
	if (ext === 'aac') return 'm4a';
	return (['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus'].includes(ext) ? ext : 'mp3') as OutputFormat;
}

function tagArgs(tags: ExportOptions['tags'], extra: Record<string, string>): string[] {
	const all: Record<string, string> = { artist: tags.artist, album: tags.album, date: tags.year, genre: tags.genre, ...extra };
	return Object.entries(all).flatMap(([k, v]) => (v ? ['-metadata', `${k}=${v}`] : []));
}

/** Loudness of [start, start+len] as loudnorm's first pass sees it. */
async function measure(path: string, start: number, len: number, lufs: number, ctx: JobContext): Promise<LoudnessAnalysis> {
	const stderr = await runFfmpeg(
		['-ss', start.toFixed(3), '-t', len.toFixed(3), '-vn', '-i', path, '-af', `aresample=48000,loudnorm=I=${lufs}:TP=-1:LRA=11:print_format=json`, '-f', 'null', '-'],
		{ loglevel: 'info', forwardStderr: false, signal: ctx.signal },
	);
	return parseLoudness(stderr);
}

function loudnormLinear(a: LoudnessAnalysis, lufs: number): string {
	if (!Number.isFinite(a.inputI)) return 'anull';
	return (
		`loudnorm=I=${lufs}:TP=-1:LRA=11:measured_I=${a.inputI}:measured_TP=${a.inputTp}` +
		`:measured_LRA=${a.inputLra}:measured_thresh=${a.inputThresh}:offset=${a.targetOffset}:linear=true:print_format=none,aresample=48000`
	);
}

function fades(len: number, fadeMs: number, kind: 'a' | 'v'): string[] {
	const f = Math.min(fadeMs / 1000, len / 3);
	if (f <= 0.005) return [];
	const name = kind === 'a' ? 'afade' : 'fade';
	return [`${name}=t=in:st=0:d=${f.toFixed(3)}`, `${name}=t=out:st=${(len - f).toFixed(3)}:d=${f.toFixed(3)}`];
}

/* --------------------------------------------------------------------------
 * Separate files: one per kept part, numbered and tagged.
 * -------------------------------------------------------------------------- */

async function exportSeparate(p: PartsParams, path: string, info: MediaInfo, list: Part[], ctx: JobContext, previewOut?: string): Promise<JobOutput[]> {
	const e = p.export;
	const format = resolveFormat(e.format, p.source.name, info);
	const video = info.video != null && (format === 'mp4' || format === 'webm');
	const stamp = timestampSuffix();
	const width = String(list.length).length < 2 ? 2 : String(list.length).length;
	const total = list.reduce((s, x) => s + (x.end - x.start), 0);
	const outputs: JobOutput[] = [];
	let done = 0;

	for (let i = 0; i < list.length; i++) {
		throwIfAborted(ctx.signal);
		const part = list[i];
		const len = part.end - part.start;
		const af = ['aresample=48000', ...fades(len, e.fadeMs, 'a')];
		if (e.normalize !== 'none') {
			ctx.phase(`measure ${i + 1}/${list.length}`);
			af.push(loudnormLinear(await measure(path, part.start, len, e.lufs, ctx), e.lufs));
		}
		const vf = video ? [...fades(len, Math.max(e.fadeMs, 0), 'v'), 'format=yuv420p'] : [];
		const n = String(i + 1).padStart(width, '0');
		const argv = [
			'-ss', part.start.toFixed(3), '-t', len.toFixed(3), '-i', path,
			...(video ? ['-map', '0:v:0', '-map', '0:a:0', '-vf', vf.join(',')] : ['-vn', '-map', '0:a:0']),
			'-af', af.join(','),
			'-map_metadata', '-1',
			...tagArgs(e.tags, { title: part.name, track: `${i + 1}/${list.length}`, album: e.tags.album || stemOf(p.source.name) }),
			...(format === 'mp3' ? ['-id3v2_version', '3'] : []),
			...encoderArgs(format, e.quality, { video, audio: true }),
		];
		const sub: JobContext = {
			...ctx,
			progress: (pr) => ctx.progress({ ratio: Math.min(1, (done + (pr.ratio ?? 0) * len) / total), speed: pr.speed }),
		};
		ctx.phase(`part ${i + 1}/${list.length}`);
		if (previewOut) {
			await encodeFile(previewOut, argv, sub, { graph: null, expectedDuration: len });
		} else {
			const out = await renderPath(p.source.bin, stemOf(p.source.name), `${n}-${part.name}`, format, stamp);
			outputs.push(await encodeTo(out, argv, sub, { graph: null, expectedDuration: len }));
			ctx.log(`[${i + 1}/${list.length}] ${part.name} · ${len.toFixed(1)}s`);
		}
		done += len;
	}
	return outputs;
}

/* --------------------------------------------------------------------------
 * One file: kept parts in order, everything else taken out.
 * -------------------------------------------------------------------------- */

interface Joined {
	inputs: string[];
	graph: string;
	maps: string[];
	duration: number;
	video: boolean;
}

/**
 * Each part is its own input (`-ss/-t` before `-i`), so ffmpeg only ever
 * decodes the parts — an hour-long source with 40 minutes kept decodes 40
 * minutes. Gaps are generated silence (and held frames for video); crossfades
 * overlap neighbours with acrossfade.
 */
function buildJoin(path: string, info: MediaInfo, list: Part[], e: ExportOptions, format: OutputFormat, perPart: (string | null)[], tail: string): Joined {
	if (list.length > MAX_JOIN_INPUTS) {
		throw new Error(`${list.length} parts is more than one pass can join (${MAX_JOIN_INPUTS}). Raise "pause longer than", or export separate files.`);
	}
	const video = info.video != null && (format === 'mp4' || format === 'webm');
	const xf = video ? 0 : e.crossfadeMs / 1000;
	const gap = xf > 0 ? 0 : e.gapMs / 1000;
	const W = info.video?.width ?? 0;
	const H = info.video?.height ?? 0;
	const fps = Math.round(info.video?.fps ?? 30);
	const inputs: string[] = [];
	const parts: string[] = [];
	const segs: string[] = [];

	list.forEach((p, i) => {
		const len = p.end - p.start;
		inputs.push('-ss', p.start.toFixed(3), '-t', len.toFixed(3), ...(video ? [] : ['-vn']), '-i', path);
		const af = ['aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo', 'asetpts=PTS-STARTPTS', ...fades(len, e.fadeMs, 'a')];
		if (perPart[i]) af.push(perPart[i]!);
		parts.push(`[${i}:a]${af.join(',')}[a${i}]`);
		if (video) {
			// A gap holds the part's last frame instead of cutting to black.
			const pad = gap > 0 && i < list.length - 1 ? `,tpad=stop_mode=clone:stop_duration=${gap.toFixed(3)}` : '';
			parts.push(`[${i}:v]setpts=PTS-STARTPTS,fps=${fps},scale=${W}:${H},setsar=1${[...fades(len, e.fadeMs, 'v')].map((f) => `,${f}`).join('')}${pad},format=yuv420p[v${i}]`);
		}
	});

	if (xf > 0) {
		let prev = 'a0';
		for (let i = 1; i < list.length; i++) {
			const out = i === list.length - 1 ? 'xall' : `x${i}`;
			parts.push(`[${prev}][a${i}]acrossfade=d=${xf.toFixed(3)}:c1=tri:c2=tri[${out}]`);
			prev = out;
		}
		if (list.length === 1) parts.push('[a0]anull[xall]');
		parts.push(`[xall]anull${tail}[aout]`);
	} else {
		list.forEach((_, i) => {
			if (video) segs.push(`[v${i}]`);
			// A gap is silence padded onto the end of every part but the last.
			if (gap > 0 && i < list.length - 1) {
				parts.push(`[a${i}]apad=pad_dur=${gap.toFixed(3)}[ag${i}]`);
				segs.push(`[ag${i}]`);
			} else segs.push(`[a${i}]`);
		});
		parts.push(`${segs.join('')}concat=n=${list.length}:v=${video ? 1 : 0}:a=1${video ? '[vout]' : ''}[acat]`);
		parts.push(`[acat]anull${tail}[aout]`);
	}

	const duration = joinedLength(list, xf > 0 ? 0 : e.gapMs, xf * 1000);
	return { inputs, graph: parts.join(';\n'), maps: [...(video ? ['-map', '[vout]'] : []), '-map', '[aout]'], duration, video };
}

async function exportJoined(p: PartsParams, path: string, info: MediaInfo, list: Part[], ctx: JobContext, previewOut?: string): Promise<JobOutput | null> {
	const e = p.export;
	const format = resolveFormat(e.format, p.source.name, info);

	// Per-part loudness, measured on each part as it stands.
	const perPart: (string | null)[] = list.map(() => null);
	if (e.normalize === 'each') {
		for (let i = 0; i < list.length; i++) {
			ctx.phase(`measure ${i + 1}/${list.length}`);
			perPart[i] = loudnormLinear(await measure(path, list[i].start, list[i].end - list[i].start, e.lufs, ctx), e.lufs);
		}
	}

	// Whole-file loudness: run the join once audio-only into the meter, then
	// render with the measured, linear correction on the end.
	let tail = '';
	if (e.normalize === 'all') {
		ctx.phase('measure');
		const probe = buildJoin(path, info, list, { ...e }, 'wav', perPart, `,loudnorm=I=${e.lufs}:TP=-1:LRA=11:print_format=json`);
		const g = await graphArgs(probe.graph);
		try {
			const stderr = await runFfmpeg([...probe.inputs, ...g.args, '-map', '[aout]', '-f', 'null', '-'], {
				loglevel: 'info',
				forwardStderr: false,
				signal: ctx.signal,
				expectedDuration: probe.duration,
				onProgress: ctx.progress,
			});
			tail = `,${loudnormLinear(parseLoudness(stderr), e.lufs)}`;
		} finally {
			await g.cleanup();
		}
	}

	const j = buildJoin(path, info, list, e, format, perPart, tail);
	const dir = join(CACHE_DIR, 'tmp', randomUUID());
	await mkdir(dir, { recursive: true });
	const g = await graphArgs(j.graph);
	try {
		const meta: string[] = [];
		if (e.chapters && !previewOut && list.length > 1 && format !== 'wav') {
			// ffmetadata: one chapter per part at its place in the joined file.
			const tl = joinedTimeline(list, e.crossfadeMs > 0 && !j.video ? 0 : e.gapMs, j.video ? 0 : e.crossfadeMs);
			const lines = [';FFMETADATA1'];
			tl.forEach(({ part, at }, i) => {
				const end = i + 1 < tl.length ? tl[i + 1].at : j.duration;
				lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(at * 1000)}`, `END=${Math.round(end * 1000)}`, `title=${part.name.replace(/[=;#\\\n]/g, ' ')}`);
			});
			const metaFile = join(dir, 'chapters.txt');
			await writeFile(metaFile, lines.join('\n'));
			meta.push('-i', metaFile, '-map_chapters', String(list.length));
		}
		const argv = [
			...j.inputs,
			...meta,
			...g.args,
			...j.maps,
			// Take metadata from the chapter file when there is one (that's
			// where the chapter titles live — "-1" would drop them), never
			// from the source: its title/track tags describe the whole show.
			'-map_metadata', meta.length ? String(list.length) : '-1',
			...tagArgs(e.tags, { title: e.tags.album || stemOf(p.source.name) }),
			...(format === 'mp3' ? ['-id3v2_version', '3'] : []),
			...encoderArgs(format, previewOut ? 'draft' : e.quality, { video: j.video, audio: true }),
		];
		ctx.phase(`join ${list.length} parts`);
		if (previewOut) {
			await encodeFile(previewOut, argv, ctx, { graph: j.graph, expectedDuration: j.duration });
			return null;
		}
		const out = await renderPath(p.source.bin, stemOf(p.source.name), `joined-${list.length}-parts`, format);
		// `return await`, not `return`: the finally below deletes the filter
		// script, and must wait until ffmpeg has finished with it.
		return await encodeTo(out, argv, ctx, { graph: j.graph, expectedDuration: j.duration });
	} finally {
		await g.cleanup();
		await rm(dir, { recursive: true, force: true });
	}
}

export async function runPartsExport(p: PartsParams, ctx: JobContext): Promise<JobResult> {
	const path = await resolveMedia(p.source);
	const info = await probeCached(path);
	const list = kept(p.parts);
	if (!list.length) throw new Error('Every part is excluded — include at least one.');
	const keptSec = list.reduce((s, x) => s + (x.end - x.start), 0);
	ctx.log(`${list.length} of ${p.parts.length} parts, ${keptSec.toFixed(1)}s of ${(info.duration ?? 0).toFixed(1)}s kept → ${p.export.as === 'joined' ? 'one file' : `${list.length} files`}`);

	if (p.export.as === 'separate') {
		const outputs = await exportSeparate(p, path, info, list, ctx);
		return { outputs, stats: { parts: outputs.length } };
	}
	const out = await exportJoined(p, path, info, list, ctx);
	const chapters = toChapterList(list, p.export.gapMs, p.export.crossfadeMs);
	ctx.log(`Chapters:\n${chapters}`);
	return { outputs: out ? [out] : [], data: { chapters } };
}

/**
 * Preview. Joined: the stretch from the chosen part onward (about
 * `seconds` of output), against the same stretch of the original with its
 * pauses still in. Separate: that one part as it will be exported, against
 * the raw part.
 */
export async function runPartsPreview(id: string, p: PartsParams, ctx: JobContext): Promise<JobResult> {
	const path = await resolveMedia(p.source);
	const info = await probeCached(path);
	const all = kept(p.parts);
	if (!all.length) throw new Error('Every part is excluded — include at least one.');
	let from = all.findIndex((x) => x.id === p.preview?.fromPart);
	if (from < 0) from = 0;
	const seconds = p.preview?.seconds ?? 30;

	let list: Part[];
	if (p.export.as === 'separate' || all.length === 1) {
		const part = all[from];
		list = [{ ...part, end: Math.min(part.end, part.start + Math.max(seconds, 5)) }];
	} else {
		// What a joined export changes is the joins, so preview one: the end
		// of this part running into the start of the next kept one, against
		// the original with whatever lay between still in it.
		const i = Math.min(from, all.length - 2);
		const side = Math.min(15, seconds / 2);
		const [a, b] = [all[i], all[i + 1]];
		list = [
			{ ...a, start: Math.max(a.start, a.end - side) },
			{ ...b, end: Math.min(b.end, b.start + side) },
		];
	}

	const dir = join(PREVIEW_DIR, id);
	await mkdir(dir, { recursive: true });
	const format = resolveFormat(p.export.format, p.source.name, info);
	const video = info.video != null && (format === 'mp4' || format === 'webm');
	const window = { start: list[0].start, duration: list[list.length - 1].end - list[0].start };
	ctx.phase('original');
	const a = await renderOriginal(path, info, window, video, dir, ctx);
	const b = join(dir, video ? 'b.mp4' : 'b.wav');
	const previewExport: ExportOptions = { ...p.export, format: video ? 'mp4' : 'wav', chapters: false };
	if (p.export.as === 'separate') {
		await exportSeparate({ ...p, export: previewExport }, path, info, list, ctx, b);
	} else {
		await exportJoined({ ...p, export: previewExport }, path, info, list, ctx, b);
	}
	const removed = window.duration - list.reduce((s, x) => s + (x.end - x.start), 0);
	const notes =
		p.export.as === 'joined' && list.length > 1
			? [`The join from ${list[0].name} into ${list[1].name}: ${removed.toFixed(1)}s taken out between them.`]
			: [`${list[0].name}, as it will be exported.`];
	return finishPreview(id, window, a, b, notes, ctx);
}

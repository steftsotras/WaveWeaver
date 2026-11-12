import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaInfo } from '$lib/media';
import {
	DEFAULT_DETECT,
	DEFAULT_EXPORT,
	partId,
	partName,
	type DetectOptions,
	type ExportOptions,
	type Part,
	type PartsDoc,
} from '$lib/parts';
import { engineFetch } from './engine.js';
import { runFfmpeg } from './ffmpeg.js';
import { getBin, isSafeFileName, type MediaRef } from './paths.js';
import { parseSilence } from './weave.js';

/* --------------------------------------------------------------------------
 * Storage: media/<bin>/parts/<file>.json (renders under parts/renders/).
 * -------------------------------------------------------------------------- */

async function docPath(ref: MediaRef): Promise<string> {
	if (!isSafeFileName(ref.name)) throw new Error('Invalid file name');
	const bin = await getBin(ref.bin);
	return join(bin.dir, 'parts', ...(ref.kind === 'renders' ? ['renders'] : []), `${ref.name}.json`);
}

export async function loadParts(ref: MediaRef): Promise<PartsDoc | null> {
	const raw = await readFile(await docPath(ref), 'utf8').catch(() => null);
	if (!raw) return null;
	const doc = JSON.parse(raw) as PartsDoc;
	return { ...doc, detect: { ...DEFAULT_DETECT, ...doc.detect }, export: { ...DEFAULT_EXPORT, ...doc.export, tags: { ...DEFAULT_EXPORT.tags, ...doc.export?.tags } } };
}

export async function saveParts(ref: MediaRef, doc: PartsDoc): Promise<void> {
	const file = await docPath(ref);
	await mkdir(join(file, '..'), { recursive: true });
	doc.updatedAt = Date.now();
	await writeFile(`${file}.tmp`, JSON.stringify(doc, null, '\t'));
	await rename(`${file}.tmp`, file);
}

/* --------------------------------------------------------------------------
 * Pause maps. Scanning an hour of audio takes seconds, so each scan is done
 * once at a fine resolution and cached; "pause longer than", padding and
 * minimum part length are then applied instantly on top.
 * -------------------------------------------------------------------------- */

const MIN_SCAN_PAUSE = 0.25;
const pauseCache = new Map<string, [number, number][]>();

async function sig(path: string): Promise<string> {
	const st = await stat(path);
	return `${path}|${st.size}|${st.mtimeMs}`;
}

async function levelPauses(path: string, D: number, thresholdDb: number, signal?: AbortSignal): Promise<[number, number][]> {
	const key = `${await sig(path)}|level|${thresholdDb}`;
	const hit = pauseCache.get(key);
	if (hit) return hit;
	const stderr = await runFfmpeg(['-vn', '-i', path, '-af', `silencedetect=noise=${thresholdDb}dB:d=${MIN_SCAN_PAUSE}`, '-f', 'null', '-'], {
		loglevel: 'info',
		forwardStderr: false,
		signal,
	});
	const regions = parseSilence(stderr, D).regions;
	pauseCache.set(key, regions);
	return regions;
}

async function speechPauses(ref: MediaRef, path: string, D: number, threshold: number): Promise<[number, number][]> {
	const key = `${await sig(path)}|speech|${threshold}`;
	const hit = pauseCache.get(key);
	if (hit) return hit;
	const { id } = await engineFetch<{ id: string }>('/jobs', {
		method: 'POST',
		body: JSON.stringify({ tool: 'vad', input: ref, params: { threshold, min_silence_ms: MIN_SCAN_PAUSE * 1000, min_speech_ms: 150 } }),
	});
	for (;;) {
		const job = await engineFetch<{ status: string; error: string | null; result: { data: { speech: [number, number][] } } | null }>(`/jobs/${id}`);
		if (job.status === 'done') {
			const regions: [number, number][] = [];
			let cursor = 0;
			for (const [a, b] of job.result!.data.speech) {
				if (a > cursor) regions.push([cursor, a]);
				cursor = Math.max(cursor, b);
			}
			if (cursor < D) regions.push([cursor, D]);
			pauseCache.set(key, regions);
			return regions;
		}
		if (job.status !== 'queued' && job.status !== 'running') throw new Error(job.error ?? 'Speech detection failed');
		await new Promise((r) => setTimeout(r, 300));
	}
}

export interface Detection {
	parts: Part[];
	pauses: [number, number][];
	duration: number;
}

/**
 * Propose parts. For silence/speech the parts are the *sound* between
 * pauses — the pauses themselves are left out, apart from `padMs` of room
 * tone at each edge. Parts shorter than `minPartSec` come back excluded
 * (or merged into a neighbour), never silently deleted.
 */
export async function detectParts(ref: MediaRef, path: string, info: MediaInfo, o: DetectOptions, signal?: AbortSignal): Promise<Detection> {
	const D = info.duration ?? 0;
	if (!D) throw new Error("This file doesn't report its duration.");

	if (o.mode === 'manual') return { parts: [{ id: partId(), start: 0, end: D, name: partName(0), on: true }], pauses: [], duration: D };

	if (o.mode === 'every' || o.mode === 'count') {
		const step = o.mode === 'every' ? o.everySec : D / o.count;
		let cuts: number[] = [];
		for (let t = step; t < D - 1; t += step) cuts.push(t);
		let pauses: [number, number][] = [];
		if (o.snapToPauses && info.audio) {
			// Move each cut to the middle of the nearest pause within reach,
			// so a 10-minute chunk never ends mid-word.
			pauses = (await levelPauses(path, D, o.thresholdDb, signal)).filter(([a, b]) => b - a >= 0.3);
			// Prefer a real pause a little further away over a breath right
			// at the mark: score = pause length, discounted by distance.
			const reach = Math.min(step * 0.15, 90);
			cuts = cuts.map((c) => {
				let best = c;
				let bestScore = 0;
				for (const [a, b] of pauses) {
					const d = Math.abs((a + b) / 2 - c);
					if (d >= reach) continue;
					const score = Math.min(b - a, 5) * (1 - (0.6 * d) / reach);
					if (score > bestScore) {
						best = (a + b) / 2;
						bestScore = score;
					}
				}
				return best;
			});
		}
		const bounds = [0, ...cuts, D];
		const parts = bounds.slice(1).map((end, i) => ({ id: partId(), start: bounds[i], end, name: partName(i), on: true }));
		return { parts, pauses, duration: D };
	}

	if (!info.audio) throw new Error('Pause detection needs an audio track.');
	const all = o.mode === 'speech' ? await speechPauses(ref, path, D, o.vadThreshold) : await levelPauses(path, D, o.thresholdDb, signal);
	// Containers often run on past the end of their audio (a video track a
	// second longer, a padded last frame). Nothing past that point is sound.
	const end = Math.min(D, info.audio.duration ?? D);
	const pauses = all.filter(([a, b]) => b - a >= o.minPauseSec || a <= 0.01 || b >= end - 0.01);
	const pad = o.padMs / 1000;

	// Sound = everything between qualifying pauses, grown by the padding.
	const spans: [number, number][] = [];
	let cursor = 0;
	for (const [a, b] of pauses) {
		if (a > cursor) spans.push([cursor, Math.min(a, end)]);
		cursor = Math.max(cursor, b);
	}
	if (cursor < end) spans.push([cursor, end]);
	const padded: [number, number][] = [];
	for (const [a, b] of spans) {
		if (b <= a) continue;
		const s = Math.max(0, a - pad);
		const e = Math.min(end, b + pad);
		const last = padded[padded.length - 1];
		if (last && s <= last[1]) last[1] = Math.max(last[1], e);
		else padded.push([s, e]);
	}

	let parts: Part[] = padded.filter(([a, b]) => b - a > 0.05).map(([start, end], i) => ({ id: partId(), start, end, name: partName(i), on: true }));

	if (o.shortParts === 'merge') {
		// Fold each short part into whichever neighbour is closer in time.
		let changed = true;
		while (changed && parts.length > 1) {
			changed = false;
			const i = parts.findIndex((p) => p.end - p.start < o.minPartSec);
			if (i === -1) break;
			const prevGap = i > 0 ? parts[i].start - parts[i - 1].end : Infinity;
			const nextGap = i < parts.length - 1 ? parts[i + 1].start - parts[i].end : Infinity;
			const j = prevGap <= nextGap ? i - 1 : i + 1;
			const [a, b] = j < i ? [j, i] : [i, j];
			parts.splice(a, 2, { ...parts[a], end: parts[b].end });
			changed = true;
		}
	} else {
		for (const p of parts) if (p.end - p.start < o.minPartSec) p.on = false;
	}
	parts = parts.map((p, i) => ({ ...p, name: partName(i) }));
	return { parts, pauses, duration: D };
}

/* --------------------------------------------------------------------------
 * "Auto" threshold: where is the noise floor, where is the programme?
 * -------------------------------------------------------------------------- */

const levelCache = new Map<string, { floorDb: number; programDb: number; suggestedDb: number }>();

/**
 * Measures 100 ms windows across the whole file. The quiet end is read from
 * *peak* levels (10th percentile): silencedetect calls a stretch silent only
 * if every sample stays under the threshold, and noise peaks sit ~10 dB above
 * its average — a threshold set from the average floor never fires on a
 * noisy room. The busy end is the 70th percentile of *average* (RMS) level,
 * i.e. the programme. The threshold sits a quarter of the way between, and
 * always a few dB clear of the noise peaks.
 */
export async function suggestThreshold(path: string, signal?: AbortSignal) {
	const key = await sig(path);
	const hit = levelCache.get(key);
	if (hit) return hit;
	const stderr = await runFfmpeg(
		[
			'-vn', '-i', path,
			'-af', 'aresample=16000,asetnsamples=n=1600:p=0,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level+RMS_level,ametadata=print',
			'-f', 'null', '-',
		],
		{ loglevel: 'info', forwardStderr: false, signal },
	);
	const grab = (name: string) => {
		const out: number[] = [];
		for (const m of stderr.matchAll(new RegExp(`${name}=(-?[\\d.]+|-inf)`, 'g'))) {
			const v = m[1] === '-inf' ? -120 : parseFloat(m[1]);
			if (Number.isFinite(v)) out.push(Math.max(-120, v));
		}
		return out.sort((a, b) => a - b);
	};
	const peaks = grab('Overall.Peak_level');
	const rms = grab('Overall.RMS_level');
	if (peaks.length < 10 || rms.length < 10) throw new Error('Not enough audio to measure.');
	const pct = (list: number[], p: number) => list[Math.min(list.length - 1, Math.floor(list.length * p))];
	const floorDb = Math.round(pct(peaks, 0.1));
	const programDb = Math.round(pct(rms, 0.7));
	const between = floorDb + Math.max(3, (programDb - floorDb) * 0.25);
	const suggestedDb = Math.round(Math.min(-20, Math.max(-70, between)));
	const result = { floorDb, programDb, suggestedDb };
	levelCache.set(key, result);
	return result;
}

export type { ExportOptions };

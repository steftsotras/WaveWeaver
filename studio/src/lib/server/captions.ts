import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidLang, toSrt, type CaptionTrack, type TrackSummary } from '$lib/captions';
import { getBin, isSafeFileName, type MediaRef } from './paths.js';

/**
 * Caption tracks live next to the media, as files you can find and use
 * outside WaveWeaver:
 *
 *   media/<bin>/captions/interview.mp4.en.json   ← the editable track
 *   media/<bin>/captions/interview.mp4.en.srt    ← always up to date
 *   media/<bin>/captions/renders/…               ← tracks for renders
 */
async function dirFor(ref: MediaRef): Promise<string> {
	if (!isSafeFileName(ref.name)) throw new Error('Invalid file name');
	const bin = await getBin(ref.bin);
	return ref.kind === 'renders' ? join(bin.dir, 'captions', 'renders') : join(bin.dir, 'captions');
}

function fileFor(dir: string, ref: MediaRef, lang: string, ext: string): string {
	if (!isValidLang(lang)) throw new Error(`Invalid language code: ${lang}`);
	return join(dir, `${ref.name}.${lang}.${ext}`);
}

export async function listTracks(ref: MediaRef): Promise<TrackSummary[]> {
	const dir = await dirFor(ref);
	const prefix = `${ref.name}.`;
	const out: TrackSummary[] = [];
	for (const f of await readdir(dir).catch(() => [] as string[])) {
		if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
		const lang = f.slice(prefix.length, -5);
		if (!isValidLang(lang)) continue;
		try {
			const t = JSON.parse(await readFile(join(dir, f), 'utf8')) as CaptionTrack;
			out.push({ lang, cues: t.cues.length, origin: t.origin, updatedAt: t.updatedAt });
		} catch {
			// skip unreadable files
		}
	}
	return out.sort((a, b) => a.updatedAt - b.updatedAt);
}

export async function loadTrack(ref: MediaRef, lang: string): Promise<CaptionTrack> {
	const file = fileFor(await dirFor(ref), ref, lang, 'json');
	const raw = await readFile(file, 'utf8').catch(() => null);
	if (!raw) throw new Error(`No ${lang} captions for ${ref.name}`);
	return JSON.parse(raw) as CaptionTrack;
}

/** Write the JSON (atomically) and refresh the sibling .srt. */
export async function saveTrack(track: CaptionTrack): Promise<void> {
	const dir = await dirFor(track.source);
	await mkdir(dir, { recursive: true });
	track.updatedAt = Date.now();
	track.cues.sort((a, b) => a.start - b.start);
	const json = fileFor(dir, track.source, track.lang, 'json');
	await writeFile(`${json}.tmp`, JSON.stringify(track));
	await rename(`${json}.tmp`, json);
	await writeFile(fileFor(dir, track.source, track.lang, 'srt'), toSrt(track.cues));
}

export async function deleteTrack(ref: MediaRef, lang: string): Promise<void> {
	const dir = await dirFor(ref);
	await rm(fileFor(dir, ref, lang, 'json'), { force: true });
	await rm(fileFor(dir, ref, lang, 'srt'), { force: true });
}

/** How many tracks each file has, for the picker. */
export async function trackCounts(refs: MediaRef[]): Promise<Record<string, string[]>> {
	const out: Record<string, string[]> = {};
	for (const r of refs) {
		const t = await listTracks(r).catch(() => []);
		if (t.length) out[`${r.bin}/${r.kind}/${r.name}`] = t.map((x) => x.lang);
	}
	return out;
}

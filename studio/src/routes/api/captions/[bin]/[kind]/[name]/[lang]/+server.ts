import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isValidLang, toSrt, toTxt, toVtt, type CaptionTrack, type Cue } from '$lib/captions';
import { MEDIA_KINDS, stemOf, type MediaKind } from '$lib/media';
import { deleteTrack, loadTrack, saveTrack } from '$lib/server/captions';
import type { MediaRef } from '$lib/server/paths';

function refOf(params: { bin: string; kind: string; name: string; lang: string }): MediaRef {
	if (!MEDIA_KINDS.includes(params.kind as MediaKind)) throw error(400, 'Bad kind');
	if (!isValidLang(params.lang)) throw error(400, 'Bad language code');
	return { bin: params.bin, kind: params.kind as MediaKind, name: params.name };
}

/**
 * The track as JSON, or `?format=srt|vtt|txt` as a download.
 * `&speakers` prefixes speaker names in SRT/VTT.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const ref = refOf(params);
	let track: CaptionTrack;
	try {
		track = await loadTrack(ref, params.lang);
	} catch (err) {
		throw error(404, err instanceof Error ? err.message : 'Not found');
	}
	const format = url.searchParams.get('format');
	if (!format) return json(track);
	const speakers = url.searchParams.has('speakers');
	const body = format === 'srt' ? toSrt(track.cues, speakers) : format === 'vtt' ? toVtt(track.cues, speakers) : format === 'txt' ? toTxt(track.cues) : null;
	if (body == null) throw error(400, 'format is srt, vtt or txt');
	const filename = `${stemOf(ref.name)}.${params.lang}.${format}`;
	return new Response(body, {
		headers: {
			'Content-Type': format === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8',
			'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
		},
	});
};

function cleanCue(raw: unknown, i: number): Cue | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const start = Number(r.start);
	const end = Number(r.end);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
	const words = Array.isArray(r.words)
		? (r.words as Record<string, unknown>[])
				.map((w) => ({ w: String(w.w ?? ''), s: Number(w.s), e: Number(w.e), ...(w.p != null ? { p: Number(w.p) } : {}) }))
				.filter((w) => w.w && Number.isFinite(w.s) && Number.isFinite(w.e))
		: undefined;
	return {
		id: typeof r.id === 'string' ? r.id.slice(0, 40) : `c${i}`,
		start: Math.max(0, start),
		end,
		text: String(r.text ?? '').slice(0, 2000),
		speaker: typeof r.speaker === 'string' && r.speaker.trim() ? r.speaker.trim().slice(0, 60) : null,
		note: typeof r.note === 'string' && r.note.trim() ? r.note.slice(0, 2000) : null,
		...(words?.length ? { words } : {}),
	};
}

/** Save edits from the caption editor (or an imported SRT). */
export const PUT: RequestHandler = async ({ params, request }) => {
	const ref = refOf(params);
	const body = (await request.json().catch(() => null)) as { cues?: unknown[]; origin?: CaptionTrack['origin'] } | null;
	if (!body || !Array.isArray(body.cues)) throw error(400, 'cues[] required');
	if (body.cues.length > 20000) throw error(400, 'Too many cues');
	const cues = body.cues.map(cleanCue).filter((c): c is Cue => c !== null);
	let origin: CaptionTrack['origin'] = { kind: 'manual' };
	try {
		origin = (await loadTrack(ref, params.lang)).origin;
	} catch {
		if (body.origin?.kind === 'import') origin = { kind: 'import', file: String(body.origin.file ?? '').slice(0, 200) };
	}
	await saveTrack({ version: 1, lang: params.lang, source: ref, origin, updatedAt: Date.now(), cues });
	return json({ ok: true, cues: cues.length });
};

export const DELETE: RequestHandler = async ({ params }) => {
	await deleteTrack(refOf(params), params.lang);
	return json({ ok: true });
};

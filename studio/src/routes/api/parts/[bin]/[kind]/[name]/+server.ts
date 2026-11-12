import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { MEDIA_KINDS, stemOf, type MediaKind } from '$lib/media';
import { toAudacityLabels, toChapterList, toCsv, toCueSheet, type PartsDoc } from '$lib/parts';
import { loadParts, saveParts } from '$lib/server/parts';
import type { MediaRef } from '$lib/server/paths';
import { sanitizeParts, sanitizeDetect, sanitizeExport } from '$lib/server/requests';

function refOf(params: { bin: string; kind: string; name: string }): MediaRef {
	if (!MEDIA_KINDS.includes(params.kind as MediaKind)) throw error(400, 'Bad kind');
	return { bin: params.bin, kind: params.kind as MediaKind, name: params.name };
}

const FORMATS: Record<string, { ext: string; type: string; make: (d: PartsDoc, name: string) => string }> = {
	csv: { ext: 'csv', type: 'text/csv', make: (d) => toCsv(d.parts) },
	labels: { ext: 'labels.txt', type: 'text/plain', make: (d) => toAudacityLabels(d.parts) },
	cue: { ext: 'cue', type: 'text/plain', make: (d, name) => toCueSheet(name, d.parts, d.export.tags) },
	chapters: { ext: 'chapters.txt', type: 'text/plain', make: (d) => toChapterList(d.parts, d.export.gapMs, d.export.crossfadeMs) },
};

/** The saved part list, or `?format=csv|labels|cue|chapters` as a download. */
export const GET: RequestHandler = async ({ params, url }) => {
	const ref = refOf(params);
	const doc = await loadParts(ref).catch(() => null);
	const format = url.searchParams.get('format');
	if (!format) return json({ doc });
	if (!doc) throw error(404, 'No parts yet');
	const f = FORMATS[format];
	if (!f) throw error(400, 'format is csv, labels, cue or chapters');
	return new Response(f.make(doc, ref.name), {
		headers: {
			'Content-Type': `${f.type}; charset=utf-8`,
			'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${stemOf(ref.name)}.${f.ext}`)}`,
		},
	});
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const ref = refOf(params);
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) throw error(400, 'Invalid JSON');
	const doc: PartsDoc = {
		version: 1,
		parts: sanitizeParts(body.parts),
		detect: sanitizeDetect(body.detect),
		export: sanitizeExport(body.export),
		updatedAt: Date.now(),
	};
	try {
		await saveParts(ref, doc);
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : 'Could not save');
	}
	return json({ ok: true, parts: doc.parts.length });
};

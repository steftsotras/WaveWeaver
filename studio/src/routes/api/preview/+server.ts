import { error, json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from './$types';
import { enqueue } from '$lib/server/jobs';
import { runPreview } from '$lib/server/pipelines/preview';
import { BadRequest, parseMix, parseParts, parsePreview, parseSubtitle, parseWindowPublic } from '$lib/server/requests';
import { runPartsPreview } from '$lib/server/pipelines/parts';
import { runMixPreview } from '$lib/server/pipelines/mix';
import { runSubtitlePreview } from '$lib/server/pipelines/captions';

/**
 * Start a preview. Body = a weave or tool job body plus
 * `window: { start, duration }` on the source's timeline. Returns `{ id }`
 * of a job in the preview lane; its result carries `preview` (A/B files and
 * loudness for both).
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) throw error(400, 'Invalid JSON body');
	try {
		if (body.kind === 'parts') {
			const params = await parseParts(body);
			const previewId = randomUUID();
			const label = `Preview · ${params.source.name} · ${params.export.as === 'joined' ? 'joined parts' : 'one part'}`;
			const job = enqueue('preview', label, params, (ctx) => runPartsPreview(previewId, params, ctx), { lane: 'preview' });
			return json({ id: job.id });
		}
		if (body.kind === 'mix') {
			const spec = await parseMix(body);
			const window = parseWindowPublic(body.window);
			const previewId = randomUUID();
			const job = enqueue('preview', `Preview · mix of ${spec.tracks.length}`, spec, (ctx) => runMixPreview(previewId, spec, window, ctx), { lane: 'preview' });
			return json({ id: job.id });
		}
		if (body.kind === 'subtitle') {
			const params = parseSubtitle({ ...body, mode: 'burn' });
			const previewId = randomUUID();
			const label = `Preview · ${params.source.name} · burn in ${params.langs[0]}`;
			const job = enqueue('preview', label, params, (ctx) => runSubtitlePreview(previewId, params, ctx), { lane: 'preview' });
			return json({ id: job.id });
		}
		const params = await parsePreview(body);
		const previewId = randomUUID();
		const what = params.kind === 'weave' ? 'weave' : params.tool;
		const label = `Preview · ${params.source.name} · ${what} · ${params.window.start.toFixed(1)}s+${params.window.duration.toFixed(0)}s`;
		const job = enqueue('preview', label, params, (ctx) => runPreview(previewId, params, ctx), { lane: 'preview' });
		return json({ id: job.id });
	} catch (err) {
		if (err instanceof BadRequest) throw error(400, err.message);
		throw err;
	}
};

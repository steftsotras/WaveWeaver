import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { BadRequest, parseStitch, parseWeave } from '$lib/server/requests';
import { planStitch } from '$lib/server/pipelines/stitch';
import { planWeave } from '$lib/server/pipelines/weave';

/**
 * Dry runs. Same body as POST /api/jobs, but nothing renders: you get the
 * exact command, the passes, the expected duration and any warnings back.
 * The Desk calls this on every edit, so it has to stay cheap — weave plans
 * never run ffmpeg at all.
 *
 * Compile errors (e.g. "trim starts after the end") come back as 200 with
 * `{ error }`: they're a property of the recipe, not a broken request.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== 'object') throw error(400, 'Invalid JSON body');
	try {
		switch (body.kind) {
			case 'weave':
				return json({ plan: await planWeave(await parseWeave(body)) });
			case 'stitch':
				return json({ plan: await planStitch(await parseStitch(body)) });
			default:
				throw error(400, `Nothing to plan for kind: ${String(body.kind)}`);
		}
	} catch (err) {
		if (err instanceof BadRequest) throw error(400, err.message);
		if (err instanceof Error && !('status' in err)) return json({ error: err.message });
		throw err;
	}
};

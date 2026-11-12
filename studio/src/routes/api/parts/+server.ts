import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { EngineError } from '$lib/server/engine';
import { detectParts, suggestThreshold } from '$lib/server/parts';
import { resolveMedia } from '$lib/server/paths';
import { probeCached } from '$lib/server/probe';
import { BadRequest, parseRef, sanitizeDetect } from '$lib/server/requests';

/**
 * `{ action: 'detect', source, detect }` → proposed parts and the pauses found.
 * `{ action: 'level', source }` → noise floor, programme level and a
 * suggested pause threshold (the "Auto" button).
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) throw error(400, 'Invalid JSON');
	try {
		const ref = parseRef(body.source);
		const path = await resolveMedia(ref);
		const info = await probeCached(path);
		if (body.action === 'level') return json(await suggestThreshold(path, request.signal));
		const started = Date.now();
		const result = await detectParts(ref, path, info, sanitizeDetect(body.detect), request.signal);
		return json({ ...result, ms: Date.now() - started });
	} catch (err) {
		if (err instanceof EngineError) throw error(err.status, err.message);
		if (err instanceof BadRequest) throw error(400, err.message);
		if (err instanceof Error && !('status' in err)) throw error(422, err.message);
		throw err;
	}
};

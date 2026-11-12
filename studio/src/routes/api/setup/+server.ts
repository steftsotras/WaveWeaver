import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setupStatus, startInstall } from '$lib/server/setup';

/** What's installed on this machine, and the install in progress. */
export const GET: RequestHandler = async () => json(await setupStatus());

/** `{ components: ["ffmpeg", ...] }` → one install job, run in dependency order. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const ids: unknown = body?.components;
	if (!Array.isArray(ids)) throw error(400, 'Expected { components: [...] }');
	try {
		return json({ id: startInstall(ids) });
	} catch (err) {
		throw error(409, err instanceof Error ? err.message : 'Install failed');
	}
};

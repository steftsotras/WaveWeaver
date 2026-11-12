import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { engineStatus } from '$lib/server/engine';

/** Engine status and tool catalogue. `?rescan` re-imports plugins (after a pip install). */
export const GET: RequestHandler = async ({ url }) => {
	return json(await engineStatus(url.searchParams.has('rescan')));
};

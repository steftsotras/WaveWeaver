import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { downloads } from '$lib/server/downloads';

/** One row with yt-dlp's log for its latest run. */
export const GET: RequestHandler = async ({ params }) => {
	await downloads.ready;
	const detail = downloads.detail(params.id);
	if (!detail) throw error(404, 'No such download');
	return json(detail);
};

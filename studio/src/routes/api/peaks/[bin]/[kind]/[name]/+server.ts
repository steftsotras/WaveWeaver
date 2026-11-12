import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { peaksFor, peaksRange } from '$lib/server/cache';
import { pathFromParams } from '$lib/server/http';

/** Whole-file peaks, or `?start=&end=` for a zoomed-in range. */
export const GET: RequestHandler = async ({ params, url }) => {
	const { path } = await pathFromParams(params);
	const start = Number(url.searchParams.get('start'));
	const end = Number(url.searchParams.get('end'));
	try {
		if (url.searchParams.has('start') && Number.isFinite(start) && Number.isFinite(end) && end > start) {
			return json(await peaksRange(path, Math.max(0, start), end), { headers: { 'Cache-Control': 'private, max-age=3600' } });
		}
		return json(await peaksFor(path), { headers: { 'Cache-Control': 'private, max-age=86400' } });
	} catch (err) {
		throw error(404, err instanceof Error ? err.message : 'No peaks');
	}
};

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { thumbnailFor } from '$lib/server/cache';
import { pathFromParams, serveFile } from '$lib/server/http';

export const GET: RequestHandler = async ({ params, request }) => {
	const { path } = await pathFromParams(params);
	const thumb = await thumbnailFor(path).catch(() => null);
	if (!thumb) throw error(404, 'No thumbnail (audio-only or unreadable)');
	return serveFile(thumb, request, { cache: 'private, max-age=86400' });
};

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { downloads } from '$lib/server/downloads';
import { serveFile } from '$lib/server/http';

/**
 * A file a download produced, by position — how the page links to caption
 * files and thumbnails, which live outside sources/. `?download` saves it.
 */
export const GET: RequestHandler = async ({ params, request, url }) => {
	await downloads.ready;
	const file = downloads.filePath(params.id, Number(params.n));
	if (!file) throw error(404, 'No such file');
	return serveFile(file.path, request, { download: url.searchParams.has('download') ? file.name : undefined });
};

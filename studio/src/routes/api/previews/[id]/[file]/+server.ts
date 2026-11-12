import { error, json } from '@sveltejs/kit';
import { join } from 'node:path';
import type { RequestHandler } from './$types';
import { peaksFor } from '$lib/server/cache';
import { serveFile } from '$lib/server/http';
import { PREVIEW_DIR } from '$lib/server/pipelines/preview';

/** Preview files: a.* (before) and b.* (after). `?peaks` returns waveform peaks instead. */
export const GET: RequestHandler = async ({ params, request, url }) => {
	if (!/^[A-Za-z0-9-]{1,64}$/.test(params.id) || !/^[ab]\.[a-z0-9]{2,5}$/.test(params.file)) {
		throw error(400, 'Bad preview path');
	}
	const path = join(PREVIEW_DIR, params.id, params.file);
	if (url.searchParams.has('peaks')) {
		try {
			return json(await peaksFor(path));
		} catch {
			throw error(404, 'No audio');
		}
	}
	return serveFile(path, request, { cache: 'no-store' });
};

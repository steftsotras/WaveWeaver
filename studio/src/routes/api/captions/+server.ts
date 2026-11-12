import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { MEDIA_KINDS, type MediaKind } from '$lib/media';
import { listTracks } from '$lib/server/captions';

/** `GET /api/captions?bin&kind&name` → the caption tracks a file has. */
export const GET: RequestHandler = async ({ url }) => {
	const bin = url.searchParams.get('bin') ?? '';
	const kind = (url.searchParams.get('kind') ?? 'sources') as MediaKind;
	const name = url.searchParams.get('name') ?? '';
	if (!MEDIA_KINDS.includes(kind)) throw error(400, 'Bad kind');
	try {
		return json({ tracks: await listTracks({ bin, kind, name }) });
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : 'Bad reference');
	}
};

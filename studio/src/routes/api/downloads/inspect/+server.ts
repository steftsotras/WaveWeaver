import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { downloads, httpError, parseDownloadOptions } from '$lib/server/downloads';

/**
 * Read a link without downloading: `{ url, options }` → the video's formats
 * (and which your options pick), captions and chapters, or a playlist's
 * entries. With `select: true`, only re-run the format choice against the
 * last inspect of that link — fast enough to follow the form as you change it.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const url = String(body?.url ?? '').trim();
	if (!url) throw error(400, 'Paste a link first.');
	try {
		await downloads.ready;
		const options = parseDownloadOptions(body?.options, downloads.getSettings());
		if (body?.select) return json({ selected: await downloads.select(url, options) });
		const password = typeof body?.password === 'string' && body.password ? body.password : null;
		return json({ info: await downloads.inspect(url, options, password) });
	} catch (err) {
		httpError(err);
	}
};

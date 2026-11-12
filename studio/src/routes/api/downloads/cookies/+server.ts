import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { downloads, httpError } from '$lib/server/downloads';

/**
 * A cookies.txt (Netscape format) for private, age-restricted and "confirm
 * you're not a bot" videos. Stored in the app's data folder and handed to
 * yt-dlp for every download. PUT the file's text; DELETE removes it.
 */
export const PUT: RequestHandler = async ({ request }) => {
	const text = await request.text();
	if (!text.trim()) throw error(400, 'Empty file');
	if (text.length > 5_000_000) throw error(413, 'That’s too big for a cookies file');
	try {
		await downloads.setCookies(text);
		return json({ ok: true });
	} catch (err) {
		httpError(err);
	}
};

export const DELETE: RequestHandler = async () => {
	await downloads.setCookies(null);
	return json({ ok: true });
};

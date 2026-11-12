import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { downloads, httpError, parseDownloadOptions } from '$lib/server/downloads';

/** Everything the Downloads page shows. `?summary` is just the active count (the nav badge). */
export const GET: RequestHandler = async ({ url }) => {
	await downloads.ready;
	if (url.searchParams.has('summary')) return json({ active: downloads.activeCount() });
	return json(downloads.snapshot());
};

/**
 * Add links. Body: `{ urls: string[], options, password?, feedTitle? }`
 * (`feedTitle`: entries picked from a playlist, which keep its bin). Resolves once
 * every link has been read (a channel can take a minute); rows appear on
 * the event stream as they're created.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) throw error(400, 'Invalid JSON body');
	const urls = (Array.isArray(body.urls) ? body.urls : [body.url]).map((u) => String(u ?? '').trim()).filter(Boolean);
	if (!urls.length) throw error(400, 'Paste a link first.');
	if (urls.length > 2000) throw error(400, 'Up to 2000 links at a time.');
	try {
		await downloads.ready;
		const options = parseDownloadOptions(body.options, downloads.getSettings());
		const password = typeof body.password === 'string' && body.password ? body.password : null;
		const feedTitle = typeof body.feedTitle === 'string' && body.feedTitle.trim() ? body.feedTitle.trim() : null;
		return json(await downloads.add(urls, options, password, feedTitle));
	} catch (err) {
		httpError(err);
	}
};

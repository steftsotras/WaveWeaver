import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { downloads, httpError, parseDownloadOptions } from '$lib/server/downloads';

/**
 * Subscribe to a channel or playlist: `{ url, options, intervalMinutes,
 * titleFilter, skipMembersOnly }`. What's there now counts as seen; every
 * check after that queues what's new, with these options.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const url = String(body?.url ?? '').trim();
	if (!url) throw error(400, 'Paste a channel or playlist link first.');
	try {
		await downloads.ready;
		const options = parseDownloadOptions(body?.options, downloads.getSettings());
		const sub = await downloads.subscribe(url, options, {
			intervalMinutes: Number(body?.intervalMinutes) || 60,
			titleFilter: String(body?.titleFilter ?? '').trim(),
			skipMembersOnly: body?.skipMembersOnly === true,
		});
		return json(sub, { status: 201 });
	} catch (err) {
		httpError(err);
	}
};

/** `{ id, enabled?, intervalMinutes?, titleFilter?, skipMembersOnly?, name? }` */
export const PATCH: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body?.id) throw error(400, 'Missing id');
	try {
		await downloads.ready;
		const { id, ...patch } = body;
		return json(downloads.updateSubscription(String(id), patch));
	} catch (err) {
		httpError(err);
	}
};

/** `{ ids }` — queued and finished downloads stay. */
export const DELETE: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
	await downloads.ready;
	downloads.removeSubscriptions(Array.isArray(body?.ids) ? body.ids.map(String) : []);
	return json({ ok: true });
};

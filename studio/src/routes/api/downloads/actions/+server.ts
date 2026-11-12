import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { downloads, httpError } from '$lib/server/downloads';

/**
 * `{ action, ids }` for rows:
 *   start · pause · cancel · stop (finish a live recording) · retry ·
 *   remove (finished rows; `deleteFiles` too, if the setting allows)
 * and `{ action: 'cancel-add' }` to stop expanding the playlist being added,
 * `{ action: 'check', ids }` to check subscriptions now.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { action?: string; ids?: unknown; deleteFiles?: boolean } | null;
	if (!body?.action) throw error(400, 'Missing action');
	const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
	try {
		await downloads.ready;
		switch (body.action) {
			case 'start':
				downloads.start(ids);
				break;
			case 'pause':
				downloads.pause(ids);
				break;
			case 'cancel':
				downloads.cancel(ids);
				break;
			case 'stop':
				downloads.stopRecording(ids);
				break;
			case 'retry':
				await downloads.retry(ids);
				break;
			case 'remove':
				await downloads.remove(ids, body.deleteFiles === true);
				break;
			case 'cancel-add':
				downloads.cancelAdd();
				break;
			case 'check':
				downloads.checkNow(ids);
				break;
			default:
				throw error(400, `Unknown action: ${body.action}`);
		}
		return json({ ok: true });
	} catch (err) {
		httpError(err);
	}
};

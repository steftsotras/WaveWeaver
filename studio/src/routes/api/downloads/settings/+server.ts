import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { DownloadSettings } from '$lib/downloads';
import { downloads, httpError } from '$lib/server/downloads';

export const GET: RequestHandler = async () => {
	await downloads.ready;
	return json(downloads.getSettings());
};

/** Partial update; unknown keys are ignored. */
export const PUT: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Partial<DownloadSettings> | null;
	if (!body || typeof body !== 'object') throw error(400, 'Invalid JSON body');
	const allowed: (keyof DownloadSettings)[] = [
		'concurrency',
		'defaultBin',
		'template',
		'playlistTemplate',
		'channelTemplate',
		'chapterTemplate',
		'rateLimit',
		'clearAfterHours',
		'deleteFiles',
		'cookiesFromBrowser',
		'ytdlOptions',
		'presets',
		'subscriptionScan',
	];
	const patch: Partial<DownloadSettings> = {};
	for (const key of allowed) if (key in body) (patch as Record<string, unknown>)[key] = body[key];
	for (const key of ['ytdlOptions', 'presets'] as const) {
		const v = patch[key];
		if (v !== undefined && (typeof v !== 'object' || v === null || Array.isArray(v))) throw error(400, `${key} must be a JSON object`);
	}
	try {
		return json(await downloads.updateSettings(patch));
	} catch (err) {
		httpError(err);
	}
};

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { downloads, httpError } from '$lib/server/downloads';
import { ytdlpStatus } from '$lib/server/ytdlp';

/** Which yt-dlp is installed (`?fresh` asks it again), and the last update's pip output. */
export const GET: RequestHandler = async ({ url }) => {
	const status = await ytdlpStatus(url.searchParams.has('fresh'));
	return json({ status, log: downloads.getUpdateLog() });
};

/** Install or upgrade yt-dlp (with yt-dlp-ejs and curl_cffi) in the backend venv. */
export const POST: RequestHandler = async () => {
	try {
		return json(await downloads.updateYtdlp());
	} catch (err) {
		httpError(err);
	}
};

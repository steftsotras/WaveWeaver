import type { PageServerLoad } from './$types';
import { ffmpegVersion } from '$lib/server/ffmpeg';
import { listMedia } from '$lib/server/library';
import { ensureDefaultBin, MEDIA_ROOT } from '$lib/server/paths';

export const load: PageServerLoad = async () => {
	await ensureDefaultBin();
	const [{ bins, files }, ffmpeg] = await Promise.all([listMedia({ kinds: ['sources'] }), ffmpegVersion()]);
	files.sort((a, b) => a.name.localeCompare(b.name));
	return { bins, files, ffmpeg, mediaRoot: MEDIA_ROOT };
};

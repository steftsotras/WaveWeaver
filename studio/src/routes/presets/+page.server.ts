import type { PageServerLoad } from './$types';
import { listMedia } from '$lib/server/library';
import { listPresets } from '$lib/server/presets';

export const load: PageServerLoad = async () => {
	const [{ files }, presets] = await Promise.all([listMedia(), listPresets()]);
	return { presets, files: files.filter((f) => f.type !== 'image' && f.info?.audio && f.info.duration) };
};

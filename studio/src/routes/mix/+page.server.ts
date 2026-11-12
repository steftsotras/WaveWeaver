import type { PageServerLoad } from './$types';
import { listMedia } from '$lib/server/library';
import { listPresets } from '$lib/server/presets';

export const load: PageServerLoad = async () => {
	const [{ bins, files }, presets] = await Promise.all([listMedia(), listPresets()]);
	return {
		bins,
		files: files.filter((f) => f.type !== 'image' && f.info?.audio && f.info.duration),
		presets: presets.filter((p) => p.group === 'mastering' || p.group === 'voice' || p.group === 'mine'),
	};
};

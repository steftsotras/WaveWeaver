import type { PageServerLoad } from './$types';
import { listMedia } from '$lib/server/library';

export const load: PageServerLoad = async () => {
	const { bins, files } = await listMedia();
	files.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'sources' ? -1 : 1));
	return { bins, files: files.filter((f) => f.type !== 'image' && f.info?.duration) };
};

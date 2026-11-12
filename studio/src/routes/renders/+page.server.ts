import type { PageServerLoad } from './$types';
import { listMedia } from '$lib/server/library';

export const load: PageServerLoad = async () => {
	const { bins, files } = await listMedia({ kinds: ['renders'] });
	files.sort((a, b) => b.modified - a.modified);
	return { bins, files };
};

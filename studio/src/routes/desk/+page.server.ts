import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listMedia } from '$lib/server/library';
import { ensureDefaultBin } from '$lib/server/paths';

export const load: PageServerLoad = async ({ url }) => {
	await ensureDefaultBin();
	const { bins, files } = await listMedia();
	files.sort((a, b) => (a.kind === b.kind ? b.modified - a.modified : a.kind === 'sources' ? -1 : 1));

	const bin = url.searchParams.get('bin');
	const kind = url.searchParams.get('kind') ?? 'sources';
	const name = url.searchParams.get('file');
	let source = null;
	if (bin && name) {
		source = files.find((f) => f.bin === bin && f.kind === kind && f.name === name) ?? null;
		if (!source) throw error(404, `${bin}/${kind}/${name} isn't in the library (deleted or renamed?)`);
		if (source.type === 'image') throw error(400, 'Stills can’t go on the Desk');
	}
	return { bins, files: files.filter((f) => f.type !== 'image'), source };
};

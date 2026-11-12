import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listTracks, trackCounts } from '$lib/server/captions';
import { listMedia } from '$lib/server/library';

export const load: PageServerLoad = async ({ url }) => {
	const { bins, files } = await listMedia();
	const media = files.filter((f) => f.type !== 'image' && f.info?.audio);
	media.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'sources' ? -1 : 1));

	const bin = url.searchParams.get('bin');
	const kind = url.searchParams.get('kind') ?? 'sources';
	const name = url.searchParams.get('file');
	let source = null;
	let tracks: Awaited<ReturnType<typeof listTracks>> = [];
	if (bin && name) {
		source = media.find((f) => f.bin === bin && f.kind === kind && f.name === name) ?? null;
		if (!source) throw error(404, `${bin}/${kind}/${name} isn't in the library, or has no audio`);
		tracks = await listTracks(source);
	}
	return { bins, files: media, source, tracks, counts: source ? {} : await trackCounts(media) };
};

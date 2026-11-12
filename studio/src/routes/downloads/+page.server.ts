import type { PageServerLoad } from './$types';
import type { DownloadEvent } from '$lib/downloads';
import { downloads } from '$lib/server/downloads';
import { ensureDefaultBin, listBins, MEDIA_ROOT } from '$lib/server/paths';

export const load: PageServerLoad = async ({ url }) => {
	await ensureDefaultBin();
	await downloads.ready;
	const bins = (await listBins()).map((b) => b.name);
	return {
		bins,
		snapshot: downloads.snapshot() as Extract<DownloadEvent, { type: 'snapshot' }>,
		// /downloads?url=… — what the bookmarklet opens.
		prefill: url.searchParams.get('url') ?? '',
		mediaRoot: MEDIA_ROOT,
	};
};

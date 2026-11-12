import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { downloads } from '$lib/server/downloads';
import { listJobs } from '$lib/server/jobs';
import { binContents, createBin, deleteBin, ensureDefaultBin, isValidBinName, listBins } from '$lib/server/paths';

/** Every bin, or with `?contents=<bin>` what deleting that bin would remove. */
export const GET: RequestHandler = async ({ url }) => {
	const name = url.searchParams.get('contents');
	if (name !== null) {
		try {
			return json(await binContents(name));
		} catch (err) {
			throw error(404, err instanceof Error ? err.message : 'No such bin');
		}
	}
	await ensureDefaultBin();
	return json({ bins: (await listBins()).map((b) => b.name) });
};

export const POST: RequestHandler = async ({ request }) => {
	const { name } = (await request.json().catch(() => ({}))) as { name?: string };
	const trimmed = (name ?? '').trim();
	if (!isValidBinName(trimmed)) {
		throw error(400, 'Bin names are 1–64 letters, digits, spaces, dots, dashes or underscores.');
	}
	const bin = await createBin(trimmed);
	return json({ name: bin.name }, { status: 201 });
};

/**
 * Delete a bin — its folder and everything in it: sources, renders,
 * captions, part lists. Body: `{ name }`. Refused while a render or a
 * download is still writing into it.
 */
export const DELETE: RequestHandler = async ({ request }) => {
	const { name } = (await request.json().catch(() => ({}))) as { name?: string };
	const bin = String(name ?? '').trim();
	if (!isValidBinName(bin)) throw error(400, 'Not a valid bin name');

	const pending = downloads.activeInBin(bin);
	if (pending) throw error(409, `${pending} ${pending === 1 ? 'download is' : 'downloads are'} still headed for “${bin}”. Cancel or finish them first.`);
	// Job params carry the files they read and write as { bin, kind, name }.
	const busy = listJobs().filter((j) => (j.status === 'running' || j.status === 'queued') && JSON.stringify(j.params).includes(`"bin":${JSON.stringify(bin)}`));
	if (busy.length) throw error(409, `${busy.length} ${busy.length === 1 ? 'job is' : 'jobs are'} still working on “${bin}” (see Jobs).`);

	try {
		await deleteBin(bin);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// Windows won't delete a file something still has open (a player, Explorer's preview).
		throw error(/EBUSY|EPERM/.test(msg) ? 423 : 404, /EBUSY|EPERM/.test(msg) ? `A file in “${bin}” is still open somewhere. Close it and try again.` : msg);
	}
	await ensureDefaultBin();
	return json({ deleted: bin });
};

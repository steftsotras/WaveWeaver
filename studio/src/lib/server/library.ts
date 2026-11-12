import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { mediaTypeOf, MEDIA_KINDS, type MediaFile, type MediaKind } from '$lib/media';
import { kindDir, listBins, type Bin } from './paths.js';
import { mapLimit, probeCached } from './probe.js';

/**
 * Walk one folder of one bin and describe every media file in it. Probe
 * failures don't hide the file — a half-uploaded or corrupt file still shows
 * up (with info: null) so you can see it and delete it.
 */
async function listKind(bin: Bin, kind: MediaKind): Promise<MediaFile[]> {
	const dir = kindDir(bin, kind);
	let names: string[] = [];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const candidates = names.filter((n) => !n.startsWith('.') && mediaTypeOf(n) !== null);
	const files = await mapLimit(candidates, 6, async (name): Promise<MediaFile | null> => {
		const abs = join(dir, name);
		const st = await stat(abs).catch(() => null);
		if (!st?.isFile()) return null;
		const type = mediaTypeOf(name)!;
		const info = type === 'image' && !name.endsWith('.gif') ? null : await probeCached(abs).catch(() => null);
		return { bin: bin.name, kind, name, type, sizeBytes: st.size, modified: st.mtimeMs, info };
	});
	return files.filter((f): f is MediaFile => f !== null);
}

export async function listMedia(opts: { kinds?: MediaKind[]; bins?: string[] } = {}): Promise<{
	bins: string[];
	files: MediaFile[];
}> {
	const kinds = opts.kinds ?? [...MEDIA_KINDS];
	let bins = await listBins();
	if (opts.bins?.length) bins = bins.filter((b) => opts.bins!.includes(b.name));
	const files: MediaFile[] = [];
	for (const bin of bins) {
		for (const kind of kinds) files.push(...(await listKind(bin, kind)));
	}
	return { bins: bins.map((b) => b.name), files };
}

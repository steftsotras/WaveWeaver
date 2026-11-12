import { error, json } from '@sveltejs/kit';
import { createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RequestHandler } from './$types';
import { extOf, isUploadable, stemOf } from '$lib/media';
import { DEFAULT_BIN, createBin, getBin, sanitizeFileName } from '$lib/server/paths';
import { probeCached } from '$lib/server/probe';

/**
 * `PUT /api/upload?bin=<bin>&name=<file name>` with the raw file as the body.
 *
 * A raw PUT instead of multipart so the body streams straight to disk:
 * `request.formData()` would buffer a 4 GB video in memory first. Bytes land
 * in a hidden `.upload-*` file and are renamed into place only when complete,
 * so a dropped connection never leaves half a video in your library.
 */
export const PUT: RequestHandler = async ({ request, url }) => {
	const binName = url.searchParams.get('bin') || DEFAULT_BIN;
	const rawName = url.searchParams.get('name') ?? '';
	if (!rawName) throw error(400, 'name is required');
	if (!isUploadable(rawName)) throw error(415, `Unsupported file type: ${extOf(rawName) || '(none)'}`);
	// SvelteKit hands us a null body when the request has no Content-Type.
	if (!request.body) throw error(400, 'Empty body (is the Content-Type header set?)');

	let bin;
	try {
		bin = binName === DEFAULT_BIN ? await createBin(DEFAULT_BIN) : await getBin(binName);
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : 'Bad bin');
	}

	// Never overwrite: "clip.mp4" → "clip (2).mp4" → "clip (3).mp4" …
	const clean = sanitizeFileName(rawName);
	let name = clean;
	for (let n = 2; await stat(join(bin.sourcesDir, name)).catch(() => null); n++) {
		name = `${stemOf(clean)} (${n})${extOf(clean)}`;
	}

	const dest = join(bin.sourcesDir, name);
	const part = join(bin.sourcesDir, `.upload-${Date.now()}-${name}`);
	try {
		await pipeline(Readable.fromWeb(request.body as import('node:stream/web').ReadableStream), createWriteStream(part));
		await rename(part, dest);
	} catch (err) {
		await rm(part, { force: true });
		throw error(500, `Upload failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	const info = await probeCached(dest).catch(() => null);
	if (!info || (!info.audio && !info.video)) {
		await rm(dest, { force: true });
		throw error(415, `${name} isn't a media file ffmpeg can read.`);
	}
	return json({ ref: { bin: bin.name, kind: 'sources', name }, info }, { status: 201 });
};

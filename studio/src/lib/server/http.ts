import { error } from '@sveltejs/kit';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { MEDIA_KINDS, type MediaKind } from '$lib/media';
import { resolveMedia, type MediaRef } from './paths.js';

/** `[bin]/[kind]/[name]` route params → absolute path, or a 4xx. */
export async function pathFromParams(params: { bin: string; kind: string; name: string }): Promise<{
	ref: MediaRef;
	path: string;
}> {
	if (!MEDIA_KINDS.includes(params.kind as MediaKind)) throw error(404, 'Unknown media kind');
	const ref: MediaRef = { bin: params.bin, kind: params.kind as MediaKind, name: params.name };
	try {
		return { ref, path: await resolveMedia(ref) };
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : 'Bad media reference');
	}
}

const CONTENT_TYPES: Record<string, string> = {
	'.mp4': 'video/mp4',
	'.m4v': 'video/mp4',
	'.webm': 'video/webm',
	'.mkv': 'video/x-matroska',
	'.mov': 'video/quicktime',
	'.avi': 'video/x-msvideo',
	'.mp3': 'audio/mpeg',
	'.m4a': 'audio/mp4',
	'.aac': 'audio/aac',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.opus': 'audio/ogg',
	'.flac': 'audio/flac',
	'.gif': 'image/gif',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.json': 'application/json',
};

export function contentTypeFor(path: string): string {
	const i = path.lastIndexOf('.');
	return CONTENT_TYPES[path.slice(i).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Serve a file with `Range` support so <video>/<audio> can seek without
 * re-downloading — essential for scrubbing a 2 GB source on the Desk.
 */
export async function serveFile(
	path: string,
	request: Request,
	opts: { download?: string; cache?: string } = {},
): Promise<Response> {
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) throw error(404, 'Not found');
	const total = info.size;
	const headers: Record<string, string> = {
		'Content-Type': contentTypeFor(path),
		'Accept-Ranges': 'bytes',
		'Cache-Control': opts.cache ?? 'private, max-age=3600',
		'Last-Modified': info.mtime.toUTCString(),
	};
	if (opts.download) {
		headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(opts.download)}`;
	}

	const range = request.headers.get('range');
	const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
	if (match && total > 0) {
		const [, startStr, endStr] = match;
		const start = startStr === '' ? Math.max(0, total - parseInt(endStr, 10)) : parseInt(startStr, 10);
		const end = endStr === '' || startStr === '' ? total - 1 : Math.min(parseInt(endStr, 10), total - 1);
		if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
			return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
		}
		const body = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream;
		return new Response(body, {
			status: 206,
			headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${total}` },
		});
	}

	const body = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
	return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(total) } });
}

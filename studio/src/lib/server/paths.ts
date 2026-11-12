import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, delimiter, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { MEDIA_KINDS, type MediaKind } from '$lib/media';

/**
 * Root of all bins. Lives inside this app at ./media by default.
 * Each direct subfolder is a bin — the editing term for a folder of footage.
 * A bin has two folders: what you brought in, and what WaveWeaver made.
 *
 *   media/                          <- MEDIA_ROOT
 *     inbox/                        <- a bin
 *       sources/   *.mp4 *.mp3 ...  <- originals (uploads land here)
 *       renders/   *.mp4 *.gif ...  <- everything WaveWeaver writes
 *     podcast/
 *       ...
 *     .cache/                       <- thumbs, peaks, filter scripts
 *
 * Override the root with WAVEWEAVER_MEDIA_DIR=/abs/path.
 */
export const MEDIA_ROOT = resolve(process.env.WAVEWEAVER_MEDIA_DIR ?? join(process.cwd(), 'media'));

/**
 * What the app installs for itself: Python, the venv, a private ffmpeg. The
 * desktop app points this at %LOCALAPPDATA%\WaveWeaver, so nothing here sits
 * inside the install folder, where an app update would replace it.
 */
export const DATA_DIR = resolve(process.env.WAVEWEAVER_DATA_DIR ?? join(MEDIA_ROOT, '.app'));
export const TOOLS_DIR = join(DATA_DIR, 'tools');

/**
 * ffmpeg and ffprobe are started by bare name from the studio, the engine and
 * yt-dlp alike, so one PATH entry covers them all. It goes first: a copy the
 * user installed through Setup beats whatever else is on the machine.
 */
export const FFMPEG_DIR = join(TOOLS_DIR, 'ffmpeg');
process.env.PATH = `${FFMPEG_DIR}${delimiter}${process.env.PATH ?? ''}`;

/** Derived artefacts only. Safe to delete at any time; everything regenerates. */
export const CACHE_DIR = join(MEDIA_ROOT, '.cache');

export const DEFAULT_BIN = 'inbox';

export interface Bin {
	name: string;
	dir: string;
	sourcesDir: string;
	rendersDir: string;
}

function binPaths(name: string): Bin {
	const dir = join(MEDIA_ROOT, name);
	return {
		name,
		dir,
		sourcesDir: join(dir, 'sources'),
		rendersDir: join(dir, 'renders'),
	};
}

/**
 * Bin names become folder names, so keep them boring: letters, digits,
 * spaces, dot, dash, underscore. No leading dot (hidden / .cache) and no
 * trailing dot or space (Windows silently strips those).
 */
const BIN_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,62}[\p{L}\p{N}_-]$|^[\p{L}\p{N}]$/u;

export function isValidBinName(name: string): boolean {
	return BIN_NAME.test(name);
}

/**
 * Every bin is a subdir of MEDIA_ROOT with a sources/ child. Folders without
 * one are ignored so stray junk under media/ never shows up in the UI.
 */
export async function listBins(): Promise<Bin[]> {
	let entries: string[] = [];
	try {
		entries = await readdir(MEDIA_ROOT);
	} catch {
		return [];
	}
	const bins: Bin[] = [];
	for (const name of entries) {
		if (name.startsWith('.')) continue;
		const b = binPaths(name);
		const info = await stat(b.sourcesDir).catch(() => null);
		if (info?.isDirectory()) bins.push(b);
	}
	bins.sort((a, b) => a.name.localeCompare(b.name));
	return bins;
}

/** First run: make sure there is somewhere to drop files. */
export async function ensureDefaultBin(): Promise<void> {
	const bins = await listBins();
	if (bins.length > 0) return;
	await createBin(DEFAULT_BIN);
}

export async function createBin(name: string): Promise<Bin> {
	if (!isValidBinName(name)) throw new Error(`Invalid bin name: ${name}`);
	const b = binPaths(name);
	await mkdir(b.sourcesDir, { recursive: true });
	await mkdir(b.rendersDir, { recursive: true });
	return b;
}

export async function getBin(name: string): Promise<Bin> {
	if (!isValidBinName(name)) throw new Error(`Invalid bin name: ${name}`);
	const b = binPaths(name);
	const info = await stat(b.sourcesDir).catch(() => null);
	if (!info?.isDirectory()) throw new Error(`Unknown bin: ${name}`);
	return b;
}

export interface BinContents {
	sources: number;
	renders: number;
	/** Captions, part lists, download extras — anything outside sources/ and renders/. */
	other: number;
	bytes: number;
}

/** What deleting a bin would take with it: files per folder, and their size. */
export async function binContents(name: string): Promise<BinContents> {
	const bin = await getBin(name);
	const out: BinContents = { sources: 0, renders: 0, other: 0, bytes: 0 };
	const walk = async (dir: string, key: 'sources' | 'renders' | 'other') => {
		for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
			const abs = join(dir, e.name);
			if (e.isDirectory()) await walk(abs, key);
			else if (e.isFile()) {
				out[key]++;
				out.bytes += (await stat(abs).catch(() => null))?.size ?? 0;
			}
		}
	};
	await walk(bin.sourcesDir, 'sources');
	await walk(bin.rendersDir, 'renders');
	for (const e of await readdir(bin.dir, { withFileTypes: true })) {
		if (e.name === 'sources' || e.name === 'renders') continue;
		const abs = join(bin.dir, e.name);
		if (e.isDirectory()) await walk(abs, 'other');
		else if (e.isFile()) {
			out.other++;
			out.bytes += (await stat(abs).catch(() => null))?.size ?? 0;
		}
	}
	return out;
}

/** Remove a bin's folder and everything in it. There's no undo. */
export async function deleteBin(name: string): Promise<void> {
	const bin = await getBin(name);
	if (!isInside(MEDIA_ROOT, bin.dir)) throw new Error('That bin is outside the media folder');
	await rm(bin.dir, { recursive: true, force: true, maxRetries: 3 });
}

export function kindDir(bin: Bin, kind: MediaKind): string {
	return kind === 'sources' ? bin.sourcesDir : bin.rendersDir;
}

/**
 * True when `target` resolves to somewhere inside `root`. Uses
 * path.relative rather than string prefixes so `media-evil/` can't pass for
 * `media/`, and checks isAbsolute because on Windows a path on another drive
 * comes back absolute instead of starting with `..`.
 */
export function isInside(root: string, target: string): boolean {
	const rel = relative(resolve(root), resolve(target));
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** A file name the client may send us: no separators, no leading dot. */
export function isSafeFileName(name: string): boolean {
	return (
		name.length > 0 &&
		name.length <= 200 &&
		!name.startsWith('.') &&
		!/[\\/\0]/.test(name) &&
		basename(name) === name
	);
}

export interface MediaRef {
	bin: string;
	kind: MediaKind;
	name: string;
}

/**
 * Turn a (bin, kind, name) triple from the client into an absolute path,
 * refusing anything that would escape the bin. Doesn't check existence.
 */
export async function resolveMedia(ref: MediaRef): Promise<string> {
	if (!MEDIA_KINDS.includes(ref.kind)) throw new Error(`Unknown media kind: ${ref.kind}`);
	if (!isSafeFileName(ref.name)) throw new Error(`Invalid file name: ${ref.name}`);
	const bin = await getBin(ref.bin);
	const dir = kindDir(bin, ref.kind);
	const abs = resolve(dir, ref.name);
	if (!isInside(dir, abs)) throw new Error('Path escapes bin');
	return abs;
}

/** Inverse of resolveMedia, for turning job outputs back into URLs. */
export function refForPath(abs: string): MediaRef | null {
	if (!isInside(MEDIA_ROOT, abs)) return null;
	// Split on either separator: relative() returns backslashes on Windows.
	const parts = relative(MEDIA_ROOT, abs).split(/[\\/]/);
	if (parts.length !== 3) return null;
	const [bin, kind, name] = parts;
	if (!MEDIA_KINDS.includes(kind as MediaKind)) return null;
	return { bin, kind: kind as MediaKind, name };
}

/**
 * Normalise an uploaded file name into something every filesystem accepts.
 * Keeps it human — WaveWeaver never renames your footage to a UUID.
 */
export function sanitizeFileName(raw: string): string {
	const ext = extname(raw).toLowerCase();
	const stem = basename(raw, extname(raw))
		.normalize('NFKC')
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
		.replace(/\s+/g, ' ')
		.replace(/-{2,}/g, '-')
		.replace(/^[.\s-]+|[.\s-]+$/g, '')
		.slice(0, 120);
	return `${stem || 'untitled'}${ext}`;
}

export { basename, extname };

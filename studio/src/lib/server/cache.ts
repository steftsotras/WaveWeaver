import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { CACHE_DIR } from './paths.js';
import { runFfmpeg } from './ffmpeg.js';
import { probeCached } from './probe.js';

/**
 * Derived artefacts (thumbnails, waveform peaks) live in media/.cache, named
 * by a hash of path + size + mtime. Replacing a file changes its signature,
 * so stale entries are simply never read again. Delete the folder whenever.
 */
async function cacheKey(path: string): Promise<string> {
	const st = await stat(path);
	return createHash('sha1').update(`${path}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20);
}

async function cachePath(sub: string, key: string, ext: string): Promise<string> {
	const dir = join(CACHE_DIR, sub);
	await mkdir(dir, { recursive: true });
	return join(dir, `${key}${ext}`);
}

/**
 * Collapse concurrent requests for the same artefact into one ffmpeg run,
 * and cap how many run at once — the Renders grid can ask for dozens of
 * waveforms on first paint.
 */
const inflight = new Map<string, Promise<string>>();
const MAX_DERIVE = 3;
let deriving = 0;
const waiting: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
	if (deriving >= MAX_DERIVE) await new Promise<void>((r) => waiting.push(r));
	deriving++;
	try {
		return await fn();
	} finally {
		deriving--;
		waiting.shift()?.();
	}
}

function once(key: string, make: () => Promise<string>): Promise<string> {
	let p = inflight.get(key);
	if (!p) {
		p = slot(make).finally(() => inflight.delete(key));
		inflight.set(key, p);
	}
	return p;
}

/**
 * A 480px-wide JPEG poster frame from 10% into the video — far enough in to
 * skip black leaders and title cards, early enough to be representative.
 */
export async function thumbnailFor(path: string): Promise<string> {
	const key = await cacheKey(path);
	const out = await cachePath('thumbs', key, '.jpg');
	if (await stat(out).catch(() => null)) return out;
	return once(out, async () => {
		const info = await probeCached(path);
		if (!info.video) throw new Error('No video stream');
		const at = info.duration ? Math.min(info.duration * 0.1, 30) : 0;
		const tmp = `${out}.tmp.jpg`;
		await runFfmpeg([
			'-ss',
			at.toFixed(3),
			'-i',
			path,
			'-frames:v',
			'1',
			'-vf',
			'scale=480:-2',
			'-q:v',
			'4',
			tmp,
		]);
		await rename(tmp, out);
		return out;
	});
}

export interface Peaks {
	duration: number;
	/** Seconds of audio represented by each column. */
	secondsPerPeak: number;
	/** Absolute peak per column, 0–1, rounded to 3 decimals. */
	peaks: number[];
}

const PEAK_COLUMNS = 2000;

/**
 * Waveform peaks for the editor. ffmpeg decodes to mono 16-bit PCM at a low
 * sample rate and pipes it to us; we keep one max-abs value per column.
 * Constant memory regardless of file length — a 2-hour podcast streams
 * through in a few seconds and costs a 2000-number JSON file.
 */
export async function peaksFor(path: string): Promise<Peaks> {
	const key = await cacheKey(path);
	const out = await cachePath('peaks', key, '.json');
	const cached = await readFile(out, 'utf8').catch(() => null);
	if (cached) return JSON.parse(cached) as Peaks;

	const file = await once(out, async () => {
		const info = await probeCached(path);
		if (!info.audio) throw new Error('No audio stream');
		const duration = info.duration ?? 0;
		// Long files don't need 8kHz to draw 2000 columns.
		const rate = duration > 1200 ? 2000 : 8000;
		const perPeak = Math.max(1, Math.ceil((duration * rate) / PEAK_COLUMNS));
		const peaks: number[] = [];

		await new Promise<void>((resolve, reject) => {
			const p = spawn(
				'ffmpeg',
				['-hide_banner', '-nostdin', '-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'],
				{ windowsHide: true },
			);
			let max = 0;
			let count = 0;
			let carry: Buffer | null = null;
			p.stdout.on('data', (chunk: Buffer) => {
				const buf: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
				const usable = buf.length - (buf.length % 2);
				carry = usable < buf.length ? buf.subarray(usable) : null;
				for (let i = 0; i < usable; i += 2) {
					const v = Math.abs(buf.readInt16LE(i));
					if (v > max) max = v;
					if (++count === perPeak) {
						peaks.push(Math.round((max / 32768) * 1000) / 1000);
						max = 0;
						count = 0;
					}
				}
			});
			let err = '';
			p.stderr.on('data', (d: Buffer) => (err += d.toString()));
			p.on('error', reject);
			p.on('close', (code) => {
				if (count > 0) peaks.push(Math.round((max / 32768) * 1000) / 1000);
				if (code === 0) resolve();
				else reject(new Error(`peaks failed: ${err.slice(-300)}`));
			});
		});

		const result: Peaks = { duration, secondsPerPeak: perPeak / rate, peaks };
		await writeFile(out, JSON.stringify(result));
		return out;
	});
	return JSON.parse(await readFile(file, 'utf8')) as Peaks;
}

/**
 * Peaks for just [start, end] — what the waveform needs when you zoom into a
 * long file. Decoded with input seeking, so a 10-second window of a 2-hour
 * recording costs 10 seconds of decoding. Kept in a small in-memory LRU.
 */
const rangeCache = new Map<string, Peaks & { start: number }>();

export async function peaksRange(path: string, start: number, end: number): Promise<Peaks & { start: number }> {
	const key = `${await cacheKey(path)}:${start.toFixed(2)}:${end.toFixed(2)}`;
	const hit = rangeCache.get(key);
	if (hit) {
		rangeCache.delete(key);
		rangeCache.set(key, hit);
		return hit;
	}
	const len = Math.max(0.05, end - start);
	const rate = len > 1200 ? 2000 : 8000;
	const perPeak = Math.max(1, Math.ceil((len * rate) / PEAK_COLUMNS));
	const peaks: number[] = [];
	await slot(
		() =>
			new Promise<void>((resolve, reject) => {
				const p = spawn(
					'ffmpeg',
					['-hide_banner', '-nostdin', '-v', 'error', '-ss', start.toFixed(3), '-t', len.toFixed(3), '-i', path, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'],
					{ windowsHide: true },
				);
				let max = 0;
				let count = 0;
				let carry: Buffer | null = null;
				p.stdout.on('data', (chunk: Buffer) => {
					const buf: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
					const usable = buf.length - (buf.length % 2);
					carry = usable < buf.length ? buf.subarray(usable) : null;
					for (let i = 0; i < usable; i += 2) {
						const v = Math.abs(buf.readInt16LE(i));
						if (v > max) max = v;
						if (++count === perPeak) {
							peaks.push(Math.round((max / 32768) * 1000) / 1000);
							max = 0;
							count = 0;
						}
					}
				});
				p.on('error', reject);
				p.on('close', (code) => {
					if (count > 0) peaks.push(Math.round((max / 32768) * 1000) / 1000);
					code === 0 ? resolve() : reject(new Error('range peaks failed'));
				});
			}),
	);
	const result = { start, duration: len, secondsPerPeak: perPeak / rate, peaks };
	rangeCache.set(key, result);
	if (rangeCache.size > 60) rangeCache.delete(rangeCache.keys().next().value!);
	return result;
}

/** Scratch file for long filtergraphs (Windows caps argv at ~32K chars). */
export async function scriptPath(name: string): Promise<string> {
	return cachePath('scripts', name, '.txt');
}

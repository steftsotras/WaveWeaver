import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { JobOutput } from '$lib/jobs';
import { scriptPath } from '../cache.js';
import { formatCommand, runFfmpeg } from '../ffmpeg.js';
import type { JobContext } from '../jobs.js';
import { getBin, refForPath } from '../paths.js';
import { probeCached } from '../probe.js';
import { shortStem, slugify, timestampSuffix } from '../text.js';

/**
 * Names handed out but not yet on disk. Two queued jobs with the same source
 * and recipe can finish in the same second; without this, the second rename
 * would silently replace the first render.
 */
const reserved = new Set<string>();

/**
 * `<stem>-<tag>-<YYYYMMDD-hhmmss>.<ext>` in the bin's renders/ folder.
 * Human-readable on purpose: you should be able to find a render in
 * Explorer/Finder without opening WaveWeaver. Never reuses a name.
 */
export async function renderPath(
	binName: string,
	stem: string,
	tag: string,
	ext: string,
	stamp = timestampSuffix(),
): Promise<string> {
	const bin = await getBin(binName);
	await mkdir(bin.rendersDir, { recursive: true });
	const base = `${shortStem(stem)}-${slugify(tag) || 'render'}-${stamp}`;
	for (let n = 1; ; n++) {
		const path = join(bin.rendersDir, `${base}${n > 1 ? `-${n}` : ''}.${ext}`);
		if (reserved.has(path) || (await stat(path).catch(() => null))) continue;
		reserved.add(path);
		// Long enough to outlive any render; the file exists by then anyway.
		setTimeout(() => reserved.delete(path), 6 * 3600_000).unref();
		return path;
	}
}

/**
 * Write a filtergraph to a script file and return the argv fragment that
 * loads it. Jump cuts can produce graphs far longer than Windows' ~32K
 * command-line limit, so graphs never go on the command line.
 * (`-/filter_complex <file>` is the ffmpeg 7+ spelling of the old
 * `-filter_complex_script`.)
 */
export async function graphArgs(graph: string): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
	const file = await scriptPath(randomUUID());
	await writeFile(file, graph);
	return { args: ['-/filter_complex', file], cleanup: () => rm(file, { force: true }) };
}

/**
 * A readable, copy-pasteable version of the command: real input names
 * instead of absolute paths, and the graph inline instead of a temp file.
 */
export function displayCommand(argv: string[], graph: string | null, outPath: string): string {
	const shown: string[] = ['ffmpeg'];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '-/filter_complex' && graph != null) {
			shown.push('-filter_complex', graph.replace(/;\n/g, '; '));
			i++;
		} else if (argv[i - 1] === '-i' || a === outPath) {
			shown.push(basename(a).replace(/^\.part-/, ''));
		} else {
			shown.push(a);
		}
	}
	return formatCommand(shown);
}

/**
 * Run an encode into a hidden `.part-` file next to the destination and only
 * rename it into place on success, so a cancelled or failed render never
 * leaves a truncated file in renders/.
 */
export async function encodeTo(
	outPath: string,
	argv: string[],
	ctx: JobContext,
	opts: { graph: string | null; expectedDuration: number | null },
): Promise<JobOutput> {
	await encodeFile(outPath, argv, ctx, opts);
	return describeOutput(outPath);
}

/** encodeTo without the library bookkeeping — for previews and scratch files. */
export async function encodeFile(
	outPath: string,
	argv: string[],
	ctx: JobContext,
	opts: { graph: string | null; expectedDuration: number | null; cwd?: string },
): Promise<void> {
	const part = join(dirname(outPath), `.part-${basename(outPath)}`);
	const finalArgv = [...argv, part];
	ctx.command(displayCommand(finalArgv, opts.graph, part));
	try {
		await runFfmpeg(finalArgv, {
			onLog: ctx.log,
			signal: ctx.signal,
			expectedDuration: opts.expectedDuration,
			onProgress: ctx.progress,
			cwd: opts.cwd,
		});
		await rename(part, outPath);
	} catch (err) {
		await rm(part, { force: true });
		throw err;
	}
}

export async function describeOutput(path: string): Promise<JobOutput> {
	const ref = refForPath(path);
	if (!ref) throw new Error(`Output landed outside the media root: ${path}`);
	const st = await stat(path);
	const info = await probeCached(path).catch(() => null);
	return { ...ref, durationSec: info?.duration ?? null, sizeBytes: st.size };
}

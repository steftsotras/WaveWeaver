import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { isActive } from '$lib/jobs';
import type { ComponentId, SetupComponent, SetupStatus } from '$lib/setup';
import { ENGINE_DIR, MODELS_DIR, pythonPath, stopEngine, VENV_DIR, engineStatus } from './engine.js';
import { CancelledError, ffmpegVersion, forgetFfmpegVersion, runCapture } from './ffmpeg.js';
import { enqueue, getJob, type JobContext } from './jobs.js';
import { DATA_DIR, FFMPEG_DIR, isInside, MEDIA_ROOT, TOOLS_DIR } from './paths.js';
import { installYtdlp, killTree, ytdlpStatus } from './ytdlp.js';

/**
 * Installs everything the app doesn't ship with. Each install is one ordinary
 * job, so it gets progress, a log and Cancel from the same place as a render.
 *
 * uv is here only to fetch a private Python the user needn't know about.
 * After that it's pip inside the venv, the same as the Downloads page's
 * Update button and the engine README.
 */

const PYTHON_VERSION = '3.11';
const UV_DIR = join(TOOLS_DIR, 'uv');
const UV_EXE = join(UV_DIR, 'uv.exe');

/**
 * Exact builds, with their hashes held here rather than fetched: a checksum
 * from the same release as the file can't catch a tampered release. To
 * upgrade, change the version and hash together. BtbN keeps the last build of
 * each month for two years and removes daily builds after 14 days, so pin a
 * month-end one.
 */
const UV_VERSION = '0.13.5';
const UV_ZIP = 'uv-x86_64-pc-windows-msvc.zip';
const UV_SHA256 = 'a38b8d1902b7cfbc76b423ba1bb456f623f42064cdc72628b6075b89afd1019a';
const UV_RELEASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
const FFMPEG_BUILD = 'autobuild-2026-10-31-12-59';
const FFMPEG_ZIP = 'ffmpeg-N-128227-g4811625b5f-win64-gpl.zip';
const FFMPEG_SHA256 = '3a5cdb3b83dd1b62b29d946d3655a14d787e5e81d947ad68202a1a400095d2f8';
const FFMPEG_RELEASE = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BUILD}`;

const WHISPER_TURBO = 'models--mobiuslabsgmbh--faster-whisper-large-v3-turbo';
const WHISPER_SMALL = 'models--Systran--faster-whisper-small';

/** The order a batch installs in: each may need the ones before it. */
const ORDER: ComponentId[] = ['ffmpeg', 'python', 'ytdlp', 'engine', 'gpu', 'whisper-turbo', 'whisper-small', 'nllb'];

function sitePackages(): string | null {
	const win = join(VENV_DIR, 'Lib', 'site-packages');
	if (existsSync(win)) return win;
	const lib = join(VENV_DIR, 'lib');
	const py = existsSync(lib) ? readdirSync(lib).find((d) => d.startsWith('python')) : undefined;
	return py ? join(lib, py, 'site-packages') : null;
}

function installed(...pkg: string[]): boolean {
	const dir = sitePackages();
	return !!dir && existsSync(join(dir, ...pkg));
}

function whisperReady(repoDir: string): boolean {
	const snapshots = join(MODELS_DIR, 'whisper', repoDir, 'snapshots');
	if (!existsSync(snapshots)) return false;
	return readdirSync(snapshots).some((rev) => existsSync(join(snapshots, rev, 'model.bin')));
}

let nvidia: Promise<boolean> | null = null;

/** Is there an NVIDIA card with a working driver? nvidia-smi comes with the driver. */
function hasNvidia(): Promise<boolean> {
	nvidia ??= runCapture('nvidia-smi', ['-L'])
		.then(({ code }) => code === 0)
		.catch(() => false);
	return nvidia;
}

async function pythonVersion(py: string | null): Promise<string | null> {
	if (!py) return null;
	const { stdout } = await runCapture(py, ['--version']).catch(() => ({ stdout: '' }));
	return stdout.trim() || null;
}

/** A Python environment Setup didn't make, such as a dev checkout's .venv. Setup must never rebuild it. */
const sharedVenv = () => !isInside(DATA_DIR, VENV_DIR);

let installJob: string | null = null;

export async function setupStatus(): Promise<SetupStatus> {
	const py = pythonPath();
	const [ffmpeg, gpu, python, ytdlp] = await Promise.all([ffmpegVersion(), hasNvidia(), pythonVersion(py), py ? ytdlpStatus() : null]);
	const canFetchTools = process.platform === 'win32';
	const manual = canFetchTools ? null : 'Automatic install is Windows only for now. Install this with your package manager.';

	const components: SetupComponent[] = [
		{
			id: 'ffmpeg',
			label: 'ffmpeg',
			blurb: 'Does all editing, mixing and rendering. Nothing works without it.',
			size: '200 MB',
			group: 'runtime',
			ready: !!ffmpeg,
			detail: ffmpeg,
			recommended: true,
			unavailable: manual,
			needs: null,
			updatable: false,
		},
		{
			id: 'python',
			label: 'Python',
			blurb: 'A private copy for yt-dlp and the engine. Your own Python installs are left alone.',
			size: '40 MB',
			group: 'runtime',
			ready: !!py,
			detail: python && sharedVenv() ? `${python}, shared with ${VENV_DIR}` : python,
			recommended: true,
			unavailable: manual,
			needs: null,
			updatable: false,
		},
		{
			id: 'ytdlp',
			label: 'yt-dlp',
			blurb: 'Runs the Downloads page.',
			size: '50 MB',
			group: 'runtime',
			ready: !!ytdlp?.ready,
			detail: ytdlp?.ytdlp ?? null,
			recommended: true,
			unavailable: null,
			needs: 'python',
			updatable: true,
		},
		{
			id: 'engine',
			label: 'Engine tools',
			blurb: 'Speech, translation, noise reduction, reference mastering, effects and VST3 hosting.',
			size: '500 MB',
			group: 'runtime',
			ready: installed('faster_whisper') && installed('pedalboard'),
			detail: null,
			recommended: true,
			unavailable: null,
			needs: 'python',
			updatable: false,
		},
		{
			id: 'gpu',
			label: 'NVIDIA GPU support',
			blurb: 'Makes Whisper and offline translation 10–30× faster.',
			size: '2 GB',
			group: 'runtime',
			ready: installed('nvidia', 'cublas') && installed('nvidia', 'cudnn'),
			detail: null,
			recommended: gpu,
			unavailable: gpu ? null : 'No NVIDIA GPU found. Everything runs on the CPU instead.',
			needs: 'engine',
			updatable: false,
		},
		{
			id: 'whisper-turbo',
			label: 'Whisper large-v3-turbo',
			blurb: 'Transcription on a GPU. Accurate and fast with a card, slow without one.',
			size: '1.6 GB',
			group: 'model',
			ready: whisperReady(WHISPER_TURBO),
			detail: null,
			recommended: gpu,
			unavailable: null,
			needs: 'engine',
			updatable: false,
		},
		{
			id: 'whisper-small',
			label: 'Whisper small',
			blurb: 'Transcription on a CPU.',
			size: '480 MB',
			group: 'model',
			ready: whisperReady(WHISPER_SMALL),
			detail: null,
			recommended: !gpu,
			unavailable: null,
			needs: 'engine',
			updatable: false,
		},
		{
			id: 'nllb',
			label: 'NLLB-200 translation',
			blurb: 'Offline caption translation, 200 languages. Licensed CC-BY-NC 4.0: non-commercial use only.',
			size: '1.4 GB',
			group: 'model',
			ready: existsSync(join(MODELS_DIR, 'nllb-200-1.3B', 'model.bin')),
			detail: null,
			recommended: false,
			unavailable: null,
			needs: 'engine',
			updatable: false,
		},
	];

	const job = installJob ? getJob(installJob) : undefined;
	return {
		components,
		jobId: job && isActive(job.status) ? job.id : null,
		mediaRoot: MEDIA_ROOT,
		modelsDir: MODELS_DIR,
		dataDir: DATA_DIR,
	};
}

/** Run a command, forwarding output line by line; `\r` counts, since progress bars redraw with it. */
function run(
	ctx: JobContext,
	cmd: string,
	args: string[],
	opts: { env?: Record<string, string>; onLine?: (line: string) => void } = {},
): Promise<void> {
	ctx.command([cmd, ...args].join(' '));
	const onLine = opts.onLine ?? ctx.log;
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd: ENGINE_DIR,
			windowsHide: true,
			env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...opts.env },
		});
		const recent: string[] = [];
		const forward = (buf: Buffer) => {
			for (const raw of buf.toString('utf8').split(/[\r\n]+/)) {
				const line = raw.trim();
				if (!line) continue;
				recent.push(line);
				if (recent.length > 8) recent.shift();
				onLine(line);
			}
		};
		child.stdout.on('data', forward);
		child.stderr.on('data', forward);
		const onAbort = () => killTree(child);
		ctx.signal.addEventListener('abort', onAbort, { once: true });
		child.on('error', (err) => {
			ctx.signal.removeEventListener('abort', onAbort);
			reject(err);
		});
		child.on('close', (code) => {
			ctx.signal.removeEventListener('abort', onAbort);
			if (ctx.signal.aborted) reject(new CancelledError());
			else if (code === 0) resolve();
			else reject(new Error(`${recent.at(-1) ?? 'Install failed'} (exit ${code})`));
		});
	});
}

/** Save a URL to disk, reporting progress. Returns the file's SHA-256. */
async function download(ctx: JobContext, url: string, dest: string): Promise<string> {
	ctx.log(`Downloading ${url}`);
	const res = await fetch(url, { signal: ctx.signal });
	if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
	const total = Number(res.headers.get('content-length')) || 0;
	const hash = createHash('sha256');
	const out = createWriteStream(dest);
	let got = 0;
	try {
		for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
			hash.update(chunk);
			got += chunk.length;
			if (!out.write(chunk)) await once(out, 'drain');
			ctx.progress({ ratio: total ? got / total : null, speed: null });
		}
	} finally {
		out.end();
		await finished(out).catch(() => {});
	}
	return hash.digest('hex');
}

/** Download a zip and refuse it unless it is exactly the build this app was tested with. */
async function verifiedDownload(ctx: JobContext, url: string, name: string, expected: string, dest: string) {
	const actual = await download(ctx, url, dest);
	if (actual !== expected) throw new Error(`${name} failed its checksum, so it wasn't installed. Try again.`);
	ctx.log(`Checksum OK: ${name}`);
}

/** Windows' own tar reads zips. Named in full: a Git Bash tar earlier on PATH doesn't. */
function unzip(ctx: JobContext, zip: string, dir: string): Promise<void> {
	const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
	return run(ctx, tar, ['-xf', zip, '-C', dir]);
}

async function installFfmpeg(ctx: JobContext) {
	const tmp = join(TOOLS_DIR, '.ffmpeg-tmp');
	await rm(tmp, { recursive: true, force: true });
	await mkdir(tmp, { recursive: true });
	try {
		const zip = join(tmp, FFMPEG_ZIP);
		await verifiedDownload(ctx, `${FFMPEG_RELEASE}/${FFMPEG_ZIP}`, FFMPEG_ZIP, FFMPEG_SHA256, zip);
		ctx.phase('unpack ffmpeg');
		await unzip(ctx, zip, tmp);
		const root = (await readdir(tmp, { withFileTypes: true })).find((e) => e.isDirectory());
		if (!root) throw new Error('The ffmpeg archive was empty');
		await mkdir(FFMPEG_DIR, { recursive: true });
		for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) await copyFile(join(tmp, root.name, 'bin', exe), join(FFMPEG_DIR, exe));
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
	forgetFfmpegVersion();
}

async function installPython(ctx: JobContext) {
	// `uv venv --clear` would wipe it.
	if (sharedVenv() && pythonPath()) throw new Error(`Python is shared with ${VENV_DIR}, so Setup leaves it alone.`);
	if (!existsSync(UV_EXE)) {
		await mkdir(UV_DIR, { recursive: true });
		const zip = join(UV_DIR, UV_ZIP);
		await verifiedDownload(ctx, `${UV_RELEASE}/${UV_ZIP}`, UV_ZIP, UV_SHA256, zip);
		await unzip(ctx, zip, UV_DIR);
		await rm(zip, { force: true });
	}
	ctx.phase('install Python');
	ctx.progress({ ratio: null, speed: null });
	await mkdir(join(VENV_DIR, '..'), { recursive: true });
	await run(ctx, UV_EXE, ['venv', VENV_DIR, '--python', PYTHON_VERSION, '--python-preference', 'only-managed', '--seed', '--clear'], {
		env: { UV_PYTHON_INSTALL_DIR: join(TOOLS_DIR, 'python'), UV_CACHE_DIR: join(TOOLS_DIR, 'uv-cache') },
	});
}

function pip(ctx: JobContext, args: string[]): Promise<void> {
	const py = pythonPath();
	if (!py) throw new Error('Install Python first.');
	// A running engine would keep its DLLs locked against the upgrade.
	stopEngine();
	return run(ctx, py, ['-m', 'pip', 'install', '--disable-pip-version-check', '--progress-bar', 'off', ...args]);
}

/**
 * Exact versions, each checked against its hash, wheels only: an sdist would
 * run its own build code and fetch build tools that no lock file covers.
 * Regenerate the locks as engine/README.md describes.
 */
const pipLocked = (ctx: JobContext, lock: string) =>
	pip(ctx, ['--require-hashes', '--only-binary', ':all:', '-r', join(ENGINE_DIR, 'engine', lock)]);

/** tqdm's redrawn bars become the job's progress; everything else goes in the log. */
function modelDownload(ctx: JobContext, what: string): Promise<void> {
	const py = pythonPath();
	if (!py) throw new Error('Install Python first.');
	return run(ctx, py, ['-m', 'engine.download', what], {
		env: { WAVEWEAVER_MODELS_DIR: MODELS_DIR, HF_HUB_DISABLE_SYMLINKS_WARNING: '1' },
		onLine: (line) => {
			const bar = /(\d+)%\|/.exec(line);
			if (bar) ctx.progress({ ratio: Number(bar[1]) / 100, speed: null });
			else ctx.log(line);
		},
	});
}

const INSTALLERS: Record<ComponentId, (ctx: JobContext) => Promise<void>> = {
	ffmpeg: installFfmpeg,
	python: installPython,
	ytdlp: async (ctx) => {
		await installYtdlp(ctx.log);
		await ytdlpStatus(true);
	},
	engine: (ctx) => pipLocked(ctx, 'requirements.lock'),
	gpu: async (ctx) => {
		await pipLocked(ctx, 'requirements-gpu.lock');
		// The engine remembers the GPU probe's answer. It may have been "CPU" for want of these.
		await rm(join(MODELS_DIR, 'device.json'), { force: true });
	},
	'whisper-turbo': (ctx) => modelDownload(ctx, 'whisper'),
	'whisper-small': (ctx) => modelDownload(ctx, 'whisper-small'),
	nllb: (ctx) => modelDownload(ctx, 'nllb'),
};

const isComponent = (id: unknown): id is ComponentId => ORDER.includes(id as ComponentId);

/** Queue the components, in dependency order, as one job. Returns its id. */
export function startInstall(ids: unknown[]): string {
	const job = installJob ? getJob(installJob) : undefined;
	if (job && isActive(job.status)) throw new Error('An install is already running.');
	const todo = ORDER.filter((id) => ids.includes(id));
	if (todo.length === 0 || !ids.every(isComponent)) throw new Error('Nothing to install.');
	const label = todo.length === 1 ? `Install ${todo[0]}` : `Install ${todo.length} components`;
	const { id } = enqueue('setup', label, { components: todo }, async (ctx) => {
		for (const name of todo) {
			ctx.phase(`install ${name}`);
			ctx.progress({ ratio: null, speed: null });
			await INSTALLERS[name](ctx);
			ctx.log(`${name} ready.`);
		}
		if (todo.includes('engine') || todo.includes('gpu')) await engineStatus(true);
		return { outputs: [] };
	});
	installJob = id;
	return id;
}

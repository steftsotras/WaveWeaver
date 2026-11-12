import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EngineStatus, EngineTool } from '$lib/engine';
import { CancelledError } from './ffmpeg.js';
import type { JobContext } from './jobs.js';
import { MEDIA_ROOT } from './paths.js';

/**
 * Bridge to the Python engine (../engine, at the repository root).
 *
 * The studio starts it on demand: the first time a page needs a tool and
 * nothing answers on the engine port, the studio launches the backend's
 * venv python with `-m engine` and pipes its output into this console. One
 * `npm run dev` runs everything. Set WAVEWEAVER_ENGINE_AUTOSTART=0 to manage
 * the engine yourself (another machine, a GPU box, a debugger).
 */
const ENGINE_URL = (process.env.WAVEWEAVER_ENGINE_URL ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
/**
 * Proves a request came from this studio. The engine has no sign-in and its
 * port is open to everything on the machine. It lives in the environment, so
 * a dev reload keeps the token the running engine was started with.
 */
const ENGINE_TOKEN = (process.env.WAVEWEAVER_ENGINE_TOKEN ||= randomBytes(32).toString('hex'));
const AUTH = { 'X-WaveWeaver-Token': ENGINE_TOKEN };

export const ENGINE_DIR = resolve(process.env.WAVEWEAVER_ENGINE_DIR ?? join(process.cwd(), '..'));

/** In the desktop app the engine's code ships read-only and the venv lives in the data folder. */
export const VENV_DIR = resolve(process.env.WAVEWEAVER_VENV ?? join(ENGINE_DIR, '.venv'));

/** Where the model weights go, as the engine resolves it (engine/config.py). */
export const MODELS_DIR = resolve(process.env.WAVEWEAVER_MODELS_DIR ?? join(ENGINE_DIR, 'models'));

export class EngineError extends Error {
	constructor(
		message: string,
		readonly status = 502,
	) {
		super(message);
	}
}

async function ping(): Promise<{ version: string; device: string } | null> {
	try {
		const res = await fetch(`${ENGINE_URL}/health`, { headers: AUTH, signal: AbortSignal.timeout(1500) });
		return res.ok ? await res.json() : null;
	} catch {
		return null;
	}
}

let child: ChildProcess | null = null;
let starting: Promise<boolean> | null = null;

/** The venv's python — the engine's, and the one yt-dlp is installed in. */
export function pythonPath(): string | null {
	const candidates = [join(VENV_DIR, 'Scripts', 'python.exe'), join(VENV_DIR, 'bin', 'python')];
	return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Stop the engine we started, along with the interpreter its venv launcher
 * runs. It comes back on demand. Installing packages needs this on Windows:
 * a running engine holds its DLLs open.
 */
export function stopEngine() {
	if (!child?.pid) return;
	if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
	else child.kill();
	child = null;
	statusCache = null;
}

export async function ensureEngine(): Promise<boolean> {
	if (await ping()) return true;
	if (process.env.WAVEWEAVER_ENGINE_AUTOSTART === '0') return false;
	starting ??= (async () => {
		const py = pythonPath();
		if (!py) return false;
		console.log(`[engine] starting ${py} -m engine (cwd ${ENGINE_DIR})`);
		child = spawn(py, ['-m', 'engine'], {
			cwd: ENGINE_DIR,
			env: { ...process.env, WAVEWEAVER_MEDIA_DIR: MEDIA_ROOT, PYTHONUNBUFFERED: '1' },
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});
		const forward = (buf: Buffer) => {
			for (const line of buf.toString('utf8').split(/\r?\n/)) if (line.trim()) console.log(`[engine] ${line}`);
		};
		child.stdout?.on('data', forward);
		child.stderr?.on('data', forward);
		child.on('exit', (code) => {
			console.log(`[engine] exited (${code})`);
			child = null;
		});
		process.once('exit', stopEngine);
		for (let i = 0; i < 80; i++) {
			if (await ping()) return true;
			if (!child) return false;
			await new Promise((r) => setTimeout(r, 250));
		}
		return false;
	})().finally(() => {
		starting = null;
	});
	return starting;
}

export async function engineFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
	if (!(await ensureEngine())) {
		throw new EngineError(
			`The engine isn't running at ${ENGINE_URL}. Install the engine tools from Setup.`,
			503,
		);
	}
	const res = await fetch(`${ENGINE_URL}${path}`, {
		...init,
		headers: { 'Content-Type': 'application/json', ...AUTH, ...(init.headers ?? {}) },
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new EngineError(typeof body.detail === 'string' ? body.detail : `Engine error ${res.status}`, res.status);
	return body as T;
}

let statusCache: { at: number; value: EngineStatus } | null = null;

export async function engineStatus(fresh = false): Promise<EngineStatus> {
	if (!fresh && statusCache && Date.now() - statusCache.at < 4000) return statusCache.value;
	let value: EngineStatus;
	try {
		const [health, { tools }] = await Promise.all([
			engineFetch<{ version: string; device: string }>('/health'),
			engineFetch<{ tools: EngineTool[] }>(fresh ? '/tools/rescan' : '/tools', fresh ? { method: 'POST' } : {}),
		]);
		value = { online: true, version: health.version, device: health.device, tools };
	} catch (err) {
		value = { online: false, error: err instanceof Error ? err.message : String(err), tools: [] };
	}
	statusCache = { at: Date.now(), value };
	return value;
}

export interface EngineOutput {
	path: string;
	ref: { bin?: string; kind: string; name: string };
	sizeBytes: number;
}

export interface EngineResult {
	outputs: EngineOutput[];
	data?: unknown;
}

interface EngineJobView {
	status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
	progress: { phase: string; ratio: number | null };
	logs: string[];
	logTotal: number;
	result: EngineResult | null;
	error: string | null;
}

/**
 * Run an engine job as part of a studio job: mirror its progress and log
 * lines into the studio's job, and cancel it if the studio job is cancelled.
 * To the UI it's just another job.
 */
export async function runEngine(ctx: JobContext, body: Record<string, unknown>): Promise<EngineResult> {
	const { id } = await engineFetch<{ id: string }>('/jobs', { method: 'POST', body: JSON.stringify(body) });
	let seen = 0;
	let phase = '';
	const cancel = () => {
		fetch(`${ENGINE_URL}/jobs/${id}`, { method: 'DELETE', headers: AUTH }).catch(() => {});
	};
	ctx.signal.addEventListener('abort', cancel, { once: true });
	try {
		for (;;) {
			const job = await engineFetch<EngineJobView>(`/jobs/${id}?since=${seen}`);
			for (const line of job.logs) ctx.log(line);
			seen = job.logTotal;
			if (job.progress.phase !== phase) {
				phase = job.progress.phase;
				ctx.phase(phase);
			}
			ctx.progress({ ratio: job.progress.ratio, speed: null });
			if (job.status === 'done') return job.result ?? { outputs: [] };
			if (job.status === 'cancelled') throw new CancelledError();
			if (job.status === 'error') throw new Error(job.error ?? 'Engine job failed');
			if (ctx.signal.aborted) throw new CancelledError();
			await new Promise((r) => setTimeout(r, 400));
		}
	} finally {
		ctx.signal.removeEventListener('abort', cancel);
	}
}

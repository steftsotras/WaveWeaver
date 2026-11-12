import { spawn } from 'node:child_process';

export type LogFn = (line: string) => void;

export interface FfmpegProgress {
	/** Seconds of output written so far. */
	outTime: number;
	/** outTime / expected duration, clamped to [0, 1]. Null if unknown. */
	ratio: number | null;
	/** Encoding speed as a multiple of realtime ("3.2x" → 3.2). */
	speed: number | null;
}

/**
 * Thrown when a running ffmpeg (or pipeline) is cancelled via its AbortSignal.
 * The job runner recognises this to mark the job cancelled rather than failed.
 */
export class CancelledError extends Error {
	constructor() {
		super('Cancelled');
		this.name = 'CancelledError';
	}
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new CancelledError();
}

export interface RunFfmpegOptions {
	onLog?: LogFn;
	signal?: AbortSignal;
	/**
	 * How long the output should be, in seconds. Lets us turn ffmpeg's
	 * out_time into a real percentage instead of a spinner.
	 */
	expectedDuration?: number | null;
	onProgress?: (p: FfmpegProgress) => void;
	/**
	 * Renders run at `error` so the log stays readable. Analysis passes need
	 * `info`, because that's the level silencedetect / loudnorm print at.
	 */
	loglevel?: 'error' | 'warning' | 'info';
	/** Forward stderr lines to onLog. Off for analysis passes (too chatty). */
	forwardStderr?: boolean;
	/**
	 * Working directory. The subtitles filter takes a file *name* inside the
	 * filtergraph, where a Windows path (C:\…) needs layers of escaping; run
	 * ffmpeg next to the subtitle file and pass a bare name instead.
	 */
	cwd?: string;
}

function killHard(p: ReturnType<typeof spawn>) {
	try {
		p.kill('SIGTERM');
	} catch {
		// child may already be gone
	}
	// SIGTERM gives ffmpeg a chance to close the output cleanly; it usually
	// exits in <100ms. SIGKILL as a follow-up in case it ignores it. (On
	// Windows both map to TerminateProcess, which is fine.)
	setTimeout(() => {
		try {
			p.kill('SIGKILL');
		} catch {
			// ignore
		}
	}, 500).unref();
}

/**
 * Run ffmpeg and resolve with its full stderr once it exits 0.
 *
 * Progress comes from `-progress pipe:1`, which makes ffmpeg write
 * machine-readable key=value blocks to stdout every ~500ms. That's far more
 * reliable than scraping the human "time=… speed=…" status line off stderr.
 *
 * Non-zero exits reject with the tail of stderr. If the AbortSignal fires,
 * the child is killed and the promise rejects with CancelledError.
 */
export function runFfmpeg(args: string[], opts: RunFfmpegOptions = {}): Promise<string> {
	const {
		onLog = () => {},
		signal,
		expectedDuration = null,
		onProgress,
		loglevel = 'error',
		forwardStderr = true,
		cwd,
	} = opts;
	if (signal?.aborted) return Promise.reject(new CancelledError());

	const fullArgs = [
		'-hide_banner',
		'-nostdin',
		'-loglevel',
		loglevel,
		'-y',
		'-progress',
		'pipe:1',
		'-nostats',
		...args,
	];

	return new Promise((resolvePromise, rejectPromise) => {
		const p = spawn('ffmpeg', fullArgs, { windowsHide: true, cwd });
		let stderr = '';
		let stdoutBuf = '';
		let cancelled = false;
		let outTime = 0;
		let speed: number | null = null;

		const onAbort = () => {
			cancelled = true;
			killHard(p);
		};
		signal?.addEventListener('abort', onAbort, { once: true });

		p.stdout.on('data', (chunk: Buffer) => {
			stdoutBuf += chunk.toString('utf8');
			const lines = stdoutBuf.split(/\r?\n/);
			stdoutBuf = lines.pop() ?? '';
			for (const line of lines) {
				const eq = line.indexOf('=');
				if (eq === -1) continue;
				const key = line.slice(0, eq);
				const value = line.slice(eq + 1).trim();
				if (key === 'out_time_us') {
					const us = Number(value);
					if (Number.isFinite(us) && us >= 0) outTime = us / 1e6;
				} else if (key === 'speed') {
					const x = parseFloat(value);
					speed = Number.isFinite(x) ? x : null;
				} else if (key === 'progress') {
					// One complete block received; publish it.
					const ratio =
						expectedDuration && expectedDuration > 0
							? Math.min(1, Math.max(0, outTime / expectedDuration))
							: null;
					onProgress?.({ outTime, ratio: value === 'end' ? 1 : ratio, speed });
				}
			}
		});

		p.stderr.on('data', (chunk: Buffer) => {
			const text = chunk.toString('utf8');
			stderr += text;
			if (!forwardStderr) return;
			for (const line of text.split(/\r?\n/)) {
				if (line.trim().length > 0) onLog(line);
			}
		});

		p.on('error', (err: NodeJS.ErrnoException) => {
			signal?.removeEventListener('abort', onAbort);
			if (err.code === 'ENOENT') {
				rejectPromise(new Error('ffmpeg not found on PATH. Install it and restart WaveWeaver.'));
			} else {
				rejectPromise(err);
			}
		});

		p.on('close', (code) => {
			signal?.removeEventListener('abort', onAbort);
			if (cancelled) {
				rejectPromise(new CancelledError());
				return;
			}
			if (code === 0) resolvePromise(stderr);
			else rejectPromise(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(-800)}`));
		});
	});
}

/**
 * Spawn any tool and collect its output. Used for ffprobe and quick
 * one-shots where we don't need progress.
 */
export function runCapture(
	cmd: string,
	args: string[],
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
	if (signal?.aborted) return Promise.reject(new CancelledError());
	return new Promise((res, rej) => {
		const p = spawn(cmd, args, { windowsHide: true });
		let stdout = '';
		let stderr = '';
		let cancelled = false;
		const onAbort = () => {
			cancelled = true;
			killHard(p);
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		p.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
		p.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
		p.on('error', (err) => {
			signal?.removeEventListener('abort', onAbort);
			rej(err);
		});
		p.on('close', (code) => {
			signal?.removeEventListener('abort', onAbort);
			if (cancelled) return rej(new CancelledError());
			res({ stdout, stderr, code: code ?? 0 });
		});
	});
}

/**
 * ffmpeg's `atempo` filter only accepts 0.5–2.0 per stage. Chain stages to
 * reach any target speed ratio.
 */
export function atempoChain(speed: number): string {
	const stages: number[] = [];
	let remaining = speed;
	while (remaining > 2.0) {
		stages.push(2.0);
		remaining /= 2.0;
	}
	while (remaining < 0.5) {
		stages.push(0.5);
		remaining /= 0.5;
	}
	stages.push(remaining);
	return stages.map((s) => `atempo=${s.toFixed(6)}`).join(',');
}

/**
 * Render an argv as a shell-pasteable command for display. Quoting is
 * POSIX-style; good enough to read and to paste into Git Bash / zsh.
 * Filtergraphs are full of single quotes (select='…'), so prefer double
 * quotes whenever nothing inside would be expanded by the shell.
 */
export function formatCommand(argv: string[]): string {
	return argv
		.map((a) => {
			if (/^[\w@%+=:,./-]+$/.test(a)) return a;
			if (!/["$`\\!]/.test(a)) return `"${a}"`;
			return `'${a.replace(/'/g, `'\\''`)}'`;
		})
		.join(' ');
}

let cachedVersion: Promise<string | null> | null = null;

/** Ask again next time: ffmpeg was just installed. */
export function forgetFfmpegVersion() {
	cachedVersion = null;
}

/** First line of `ffmpeg -version`, or null if ffmpeg isn't installed. */
export function ffmpegVersion(): Promise<string | null> {
	cachedVersion ??= runCapture('ffmpeg', ['-hide_banner', '-version'])
		.then(({ stdout, code }) => {
			if (code !== 0) return null;
			const first = stdout.split(/\r?\n/)[0] ?? '';
			return first.replace(/^ffmpeg version\s+/, '').split(' Copyright')[0] || first;
		})
		.catch(() => {
			cachedVersion = null;
			return null;
		});
	return cachedVersion;
}

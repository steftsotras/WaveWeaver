import { randomUUID } from 'node:crypto';
import type { JobKind, JobProgress, JobResult, JobStatus, JobView } from '$lib/jobs';
import { CancelledError, type FfmpegProgress } from './ffmpeg.js';

export interface JobContext {
	log: (line: string) => void;
	/** Name the current phase ("analyse 1/2", "render") and reset progress. */
	phase: (name: string) => void;
	/** Feed ffmpeg progress straight in. */
	progress: (p: Pick<FfmpegProgress, 'ratio' | 'speed'>) => void;
	/** Record the exact ffmpeg command, so the UI can show and copy it. */
	command: (cmd: string) => void;
	signal: AbortSignal;
}

type Work = (ctx: JobContext) => Promise<JobResult>;

interface Job extends JobView {
	work: Work;
	lane: Lane;
}

/**
 * Module-scope Map is fine for a single-user local studio. Jobs live for the
 * process lifetime; restart clears them (outputs are on disk).
 */
const jobs = new Map<string, Job>();
const controllers = new Map<string, AbortController>();

/**
 * Two lanes. Renders: two at once keeps a laptop responsive and still
 * overlaps one job's analysis pass with another's encode (x264 already uses
 * every core; more parallelism just makes everything slower together).
 * Previews get their own lane so a 20-second excerpt never waits behind a
 * two-hour render — previewing is how you decide what to render.
 */
type Lane = 'main' | 'preview';
const lanes: Record<Lane, { max: number; queue: string[]; running: number }> = {
	main: { max: Math.max(1, Number(process.env.WAVEWEAVER_CONCURRENCY) || 2), queue: [], running: 0 },
	preview: { max: 2, queue: [], running: 0 },
};

/** Cap logs per job so long runs don't balloon memory. */
const MAX_LOG_LINES = 4000;

function addLog(job: Job, line: string) {
	job.logs.push(line);
	if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
}

function view(job: Job): JobView {
	const { work: _work, lane: _lane, ...rest } = job;
	return rest;
}

export function getJob(id: string): JobView | undefined {
	const job = jobs.get(id);
	return job ? view(job) : undefined;
}

export function listJobs(): JobView[] {
	return [...jobs.values()].map(view).sort((a, b) => b.createdAt - a.createdAt);
}

export function activeJobCount(): number {
	let n = 0;
	for (const j of jobs.values()) if (j.status === 'running' || j.status === 'queued') n++;
	return n;
}

/**
 * Ask a job to stop. Queued jobs are simply dropped; running jobs get their
 * AbortSignal fired, which kills the ffmpeg child. Returns false if the job
 * doesn't exist or already finished.
 */
export function cancelJob(id: string): boolean {
	const job = jobs.get(id);
	if (!job) return false;
	if (job.status === 'queued') {
		const q = lanes[job.lane].queue;
		const i = q.indexOf(id);
		if (i !== -1) q.splice(i, 1);
		job.status = 'cancelled';
		job.finishedAt = Date.now();
		addLog(job, 'Cancelled before it started.');
		return true;
	}
	if (job.status !== 'running') return false;
	const ctrl = controllers.get(id);
	if (!ctrl) return false;
	addLog(job, 'Cancel requested.');
	ctrl.abort();
	return true;
}

/** Forget finished jobs (the outputs stay on disk). */
export function clearFinished(): number {
	let n = 0;
	for (const [id, job] of jobs) {
		if (job.status !== 'running' && job.status !== 'queued') {
			jobs.delete(id);
			n++;
		}
	}
	return n;
}

function pump() {
	for (const lane of Object.values(lanes)) {
		while (lane.running < lane.max && lane.queue.length > 0) {
			const id = lane.queue.shift()!;
			const job = jobs.get(id);
			if (job && job.status === 'queued') start(job);
		}
	}
}

function start(job: Job) {
	lanes[job.lane].running++;
	const controller = new AbortController();
	controllers.set(job.id, controller);
	job.status = 'running';
	job.startedAt = Date.now();

	const ctx: JobContext = {
		log: (line) => addLog(job, line),
		phase: (name) => {
			job.progress = { phase: name, ratio: 0, speed: null, phaseStartedAt: Date.now() };
		},
		progress: (p) => {
			job.progress = { ...job.progress, ratio: p.ratio, speed: p.speed };
		},
		command: (cmd) => {
			job.commands.push(cmd);
			addLog(job, `$ ${cmd}`);
		},
		signal: controller.signal,
	};

	job
		.work(ctx)
		.then((result) => {
			job.result = result;
			job.status = 'done';
			job.progress = { ...job.progress, ratio: 1 };
		})
		.catch((err) => {
			if (err instanceof CancelledError || controller.signal.aborted) {
				job.status = 'cancelled';
				addLog(job, 'Cancelled.');
			} else {
				const msg = err instanceof Error ? err.message : String(err);
				job.error = msg;
				job.status = 'error';
				addLog(job, `ERROR: ${msg}`);
			}
		})
		.finally(() => {
			job.finishedAt = Date.now();
			controllers.delete(job.id);
			lanes[job.lane].running--;
			pump();
		});
}

/**
 * Register a job and queue it. `label` is what the Jobs page shows;
 * `params` is echoed back verbatim so the UI can show what was asked for.
 */
export function enqueue(
	kind: JobKind,
	label: string,
	params: unknown,
	work: Work,
	opts: { lane?: Lane } = {},
): JobView {
	const progress: JobProgress = { phase: 'queued', ratio: null, speed: null, phaseStartedAt: null };
	const job: Job = {
		id: randomUUID(),
		kind,
		label,
		status: 'queued' satisfies JobStatus,
		params,
		logs: [],
		commands: [],
		progress,
		createdAt: Date.now(),
		startedAt: null,
		finishedAt: null,
		error: null,
		result: null,
		work,
		lane: opts.lane ?? 'main',
	};
	jobs.set(job.id, job);
	lanes[job.lane].queue.push(job.id);
	pump();
	return view(job);
}

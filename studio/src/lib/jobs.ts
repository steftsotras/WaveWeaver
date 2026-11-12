/**
 * Job shapes shared between the server registry and the UI that polls it.
 */
import type { MediaKind } from './media';

export type JobKind =
	| 'weave'
	| 'stitch'
	| 'parts'
	| 'snapshot'
	| 'tool'
	| 'preview'
	| 'transcribe'
	| 'translate'
	| 'subtitle'
	| 'mix'
	| 'setup';

export interface Loudness {
	lufs: number | null;
	truePeak: number | null;
	lra: number | null;
}

/** One side of an A/B preview: the untouched excerpt (a) or the processed one (b). */
export interface PreviewSide {
	url: string;
	type: 'audio' | 'video' | 'image';
	duration: number | null;
	loudness: Loudness | null;
}

export interface PreviewResult {
	id: string;
	window: { start: number; duration: number };
	a: PreviewSide;
	b: PreviewSide;
	/** "changed" when B is a different length (speed, jump cut) — A/B by position is then approximate. */
	timing: 'same' | 'changed';
	notes: string[];
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface JobProgress {
	phase: string;
	/** 0–1, or null while the total is unknown. */
	ratio: number | null;
	/** Multiple of realtime, from ffmpeg. */
	speed: number | null;
	phaseStartedAt: number | null;
}

export interface JobOutput {
	bin: string;
	kind: MediaKind;
	name: string;
	durationSec: number | null;
	sizeBytes: number;
}

export interface JobResult {
	outputs: JobOutput[];
	/** Free-form numbers worth showing (e.g. "removed": 12.4 seconds). */
	stats?: Record<string, number | string>;
	preview?: PreviewResult;
	/** Tool-specific payload (a transcript preview, translated cues …). */
	data?: unknown;
}

export interface JobView {
	id: string;
	kind: JobKind;
	label: string;
	status: JobStatus;
	params: unknown;
	logs: string[];
	commands: string[];
	progress: JobProgress;
	createdAt: number;
	startedAt: number | null;
	finishedAt: number | null;
	error: string | null;
	result: JobResult | null;
}

export function isActive(status: JobStatus): boolean {
	return status === 'queued' || status === 'running';
}

export function elapsed(start: number | null, end: number | null, now = Date.now()): string {
	if (!start) return '—';
	const s = Math.max(0, Math.floor(((end ?? now) - start) / 1000));
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Parts: a long recording as a list of segments you keep or drop.
 *
 * Detection proposes the parts (the sound between pauses, chunks of N
 * minutes, …); you adjust them — drag edges, split, merge, rename, include
 * or exclude — and export either one file per part or a single file with
 * everything you dropped taken out. Nothing is rendered until you export;
 * the list is saved next to the media as JSON.
 */
import { formatTimecode } from './media';
import type { Quality } from './weave';

export interface Part {
	id: string;
	start: number;
	end: number;
	name: string;
	/** Included in the export. Short parts arrive excluded so you can review them. */
	on: boolean;
}

export type DetectMode = 'silence' | 'speech' | 'every' | 'count' | 'manual';

export interface DetectOptions {
	mode: DetectMode;
	/** silence: anything quieter than this is a pause. */
	thresholdDb: number;
	/** A pause must last at least this long to separate two parts. */
	minPauseSec: number;
	/** Room tone kept at each edge of a part, so words and notes aren't clipped. */
	padMs: number;
	/** Parts shorter than this are excluded (or merged into a neighbour). */
	minPartSec: number;
	shortParts: 'exclude' | 'merge';
	everySec: number;
	count: number;
	/** every/count: move each cut to the nearest pause so nothing is cut mid-word. */
	snapToPauses: boolean;
	vadThreshold: number;
}

export const DEFAULT_DETECT: DetectOptions = {
	mode: 'silence',
	thresholdDb: -40,
	minPauseSec: 2,
	padMs: 300,
	minPartSec: 15,
	shortParts: 'exclude',
	everySec: 600,
	count: 4,
	snapToPauses: true,
	vadThreshold: 0.5,
};

export type PartsFormat = 'same' | 'mp3' | 'm4a' | 'wav' | 'flac' | 'ogg' | 'opus' | 'mp4';

export interface ExportOptions {
	as: 'separate' | 'joined';
	format: PartsFormat;
	quality: Quality;
	/** Fade at every part edge. Even 20 ms removes clicks at cut points. */
	fadeMs: number;
	/** joined: silence placed between parts (0 = parts butt together). */
	gapMs: number;
	/** joined, audio only: parts overlap and crossfade by this much. */
	crossfadeMs: number;
	/** each: every part to the target · all: the whole joined file to the target. */
	normalize: 'none' | 'each' | 'all';
	lufs: number;
	/** joined: a chapter marker per part (MP3/M4A/MP4 players show them). */
	chapters: boolean;
	tags: { artist: string; album: string; year: string; genre: string };
}

export const DEFAULT_EXPORT: ExportOptions = {
	as: 'joined',
	format: 'same',
	quality: 'high',
	fadeMs: 30,
	gapMs: 600,
	crossfadeMs: 0,
	normalize: 'none',
	lufs: -16,
	chapters: true,
	tags: { artist: '', album: '', year: '', genre: '' },
};

export interface PartsDoc {
	version: 1;
	parts: Part[];
	detect: DetectOptions;
	export: ExportOptions;
	updatedAt: number;
}

let n = 0;
export function partId(): string {
	return `p${Date.now().toString(36)}${(++n).toString(36)}`;
}

export function partName(i: number): string {
	return `Part ${String(i + 1).padStart(2, '0')}`;
}

export const kept = (parts: Part[]) => parts.filter((p) => p.on).sort((a, b) => a.start - b.start);
export const lengthOf = (parts: Part[]) => parts.reduce((s, p) => s + (p.end - p.start), 0);

/** Where each kept part lands in the joined file. */
export function joinedTimeline(parts: Part[], gapMs: number, crossfadeMs: number): { part: Part; at: number }[] {
	const out: { part: Part; at: number }[] = [];
	let t = 0;
	for (const p of kept(parts)) {
		out.push({ part: p, at: t });
		t += p.end - p.start + (crossfadeMs > 0 ? -crossfadeMs / 1000 : gapMs / 1000);
	}
	return out;
}

export function joinedLength(parts: Part[], gapMs: number, crossfadeMs: number): number {
	const k = kept(parts);
	if (!k.length) return 0;
	const between = crossfadeMs > 0 ? -crossfadeMs / 1000 : gapMs / 1000;
	return lengthOf(k) + between * (k.length - 1);
}

/* --------------------------------------------------------------------------
 * Cue lists — the part list in formats other tools read.
 * -------------------------------------------------------------------------- */

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(parts: Part[]): string {
	const rows = parts.map((p, i) =>
		[i + 1, csvCell(p.name), p.start.toFixed(3), p.end.toFixed(3), (p.end - p.start).toFixed(3), p.on ? 'yes' : 'no'].join(','),
	);
	return ['#,name,start,end,duration,included', ...rows].join('\n');
}

/** Audacity: File → Import → Labels. Tab-separated start, end, label. */
export function toAudacityLabels(parts: Part[]): string {
	return kept(parts)
		.map((p) => `${p.start.toFixed(6)}\t${p.end.toFixed(6)}\t${p.name}`)
		.join('\n');
}

/** A CUE sheet for the original file: DJ software, burners and players split by it. */
export function toCueSheet(fileName: string, parts: Part[], tags: ExportOptions['tags']): string {
	const msf = (t: number) => {
		const frames = Math.round(t * 75);
		const m = Math.floor(frames / (75 * 60));
		const s = Math.floor((frames / 75) % 60);
		const f = frames % 75;
		return [m, s, f].map((x) => String(x).padStart(2, '0')).join(':');
	};
	const type = /\.mp3$/i.test(fileName) ? 'MP3' : 'WAVE';
	const lines = [
		...(tags.artist ? [`PERFORMER "${tags.artist}"`] : []),
		...(tags.album ? [`TITLE "${tags.album}"`] : []),
		`FILE "${fileName}" ${type}`,
	];
	kept(parts).forEach((p, i) => {
		lines.push(`  TRACK ${String(i + 1).padStart(2, '0')} AUDIO`, `    TITLE "${p.name.replace(/"/g, "'")}"`);
		if (tags.artist) lines.push(`    PERFORMER "${tags.artist}"`);
		lines.push(`    INDEX 01 ${msf(p.start)}`);
	});
	return lines.join('\n');
}

/** "0:00 Intro" lines for a YouTube description — positions in the joined file. */
export function toChapterList(parts: Part[], gapMs: number, crossfadeMs: number): string {
	return joinedTimeline(parts, gapMs, crossfadeMs)
		.map(({ part, at }) => {
			const t = Math.max(0, Math.round(at));
			const h = Math.floor(t / 3600);
			const m = Math.floor((t % 3600) / 60);
			const s = String(t % 60).padStart(2, '0');
			return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${s} ${part.name}`;
		})
		.join('\n');
}

export function describePart(p: Part): string {
	return `${formatTimecode(p.start)} → ${formatTimecode(p.end)}`;
}

/**
 * Captions: the data model, subtitle line-breaking, and SRT/VTT/TXT in and
 * out. Shared by the editor (which reflows live) and the server (which
 * writes files and burns subtitles in).
 *
 * One track per language per media file, stored as JSON beside an .srt in
 * the bin's captions/ folder. Cues keep Whisper's word timings so they can
 * be re-flowed into proper subtitles at any time without losing sync.
 */

export interface Word {
	w: string;
	s: number;
	e: number;
	p?: number;
}

export interface Cue {
	id: string;
	start: number;
	end: number;
	text: string;
	/** Who's speaking — prefixed on export if you ask for it. */
	speaker?: string | null;
	/** Your annotation. Never burned in; exported in the TXT transcript and VTT NOTEs. */
	note?: string | null;
	words?: Word[];
}

export type TrackOrigin =
	| { kind: 'whisper'; model: string; device: string; task: string }
	| { kind: 'translation'; from: string; provider: string }
	| { kind: 'import'; file: string }
	| { kind: 'manual' };

export interface CaptionTrack {
	version: 1;
	lang: string;
	source: { bin: string; kind: 'sources' | 'renders'; name: string };
	origin: TrackOrigin;
	updatedAt: number;
	cues: Cue[];
}

export interface TrackSummary {
	lang: string;
	cues: number;
	origin: TrackOrigin;
	updatedAt: number;
}

export const LANGUAGES: [string, string][] = [
	['en', 'English'], ['el', 'Greek'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
	['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['tr', 'Turkish'], ['ru', 'Russian'], ['uk', 'Ukrainian'],
	['ar', 'Arabic'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'],
	['sv', 'Swedish'], ['ro', 'Romanian'], ['bg', 'Bulgarian'], ['cs', 'Czech'], ['hu', 'Hungarian'], ['fi', 'Finnish'],
];

export function languageName(code: string): string {
	return LANGUAGES.find(([c]) => c === code)?.[1] ?? code;
}

/** ISO 639-2/B codes for container metadata (mp4/mkv subtitle tracks). */
export const ISO639_2: Record<string, string> = {
	en: 'eng', el: 'gre', es: 'spa', fr: 'fre', de: 'ger', it: 'ita', pt: 'por', nl: 'dut', pl: 'pol', tr: 'tur',
	ru: 'rus', uk: 'ukr', ar: 'ara', he: 'heb', hi: 'hin', ja: 'jpn', ko: 'kor', zh: 'chi', sv: 'swe', ro: 'rum',
	bg: 'bul', cs: 'cze', hu: 'hun', fi: 'fin',
};

export const isValidLang = (s: string) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(s);

let n = 0;
export function cueId(): string {
	n++;
	return `c${Date.now().toString(36)}${n.toString(36)}`;
}

/* --------------------------------------------------------------------------
 * Line breaking ("reflow")
 *
 * Whisper segments are sentences, sometimes 20 seconds long. Subtitles have
 * rules: two lines, ~42 characters each, at most ~6 seconds, break at
 * punctuation and at pauses, never flash shorter than ~0.8 s. Word timings
 * let us rebuild cues to those rules exactly.
 * -------------------------------------------------------------------------- */

export interface ReflowOptions {
	maxChars: number;
	maxLines: number;
	maxDuration: number;
	minDuration: number;
}

export const DEFAULT_REFLOW: ReflowOptions = { maxChars: 42, maxLines: 2, maxDuration: 6, minDuration: 0.8 };

/** Words of a cue — real timings when we have them, otherwise spread by length. */
function wordsOf(c: Cue): Word[] {
	if (c.words?.length) return c.words.map((w) => ({ ...w, w: w.w.trim() })).filter((w) => w.w);
	const parts = c.text.split(/\s+/).filter(Boolean);
	const total = parts.reduce((s, p) => s + p.length + 1, 0) || 1;
	let t = c.start;
	return parts.map((p) => {
		const d = ((p.length + 1) / total) * (c.end - c.start);
		const w = { w: p, s: t, e: t + d };
		t += d;
		return w;
	});
}

/** Split one line of text into ≤ maxLines lines, breaking near the middle. */
export function wrapLines(text: string, maxChars: number, maxLines = 2): string {
	const flat = text.replace(/\s*\n\s*/g, ' ').trim();
	if (flat.length <= maxChars || maxLines < 2) return flat;
	const words = flat.split(' ');
	let best = -1;
	let bestScore = Infinity;
	let len = 0;
	for (let i = 0; i < words.length - 1; i++) {
		len += words[i].length + (i ? 1 : 0);
		const rest = flat.length - len - 1;
		// Balanced lines, a little bonus for breaking after punctuation.
		const score = Math.abs(len - rest) - (/[,.;:!?]$/.test(words[i]) ? 6 : 0) + (Math.max(len, rest) > maxChars ? 100 : 0);
		if (score < bestScore) {
			bestScore = score;
			best = i;
		}
	}
	return `${words.slice(0, best + 1).join(' ')}\n${words.slice(best + 1).join(' ')}`;
}

export function reflow(cues: Cue[], opts: ReflowOptions = DEFAULT_REFLOW): Cue[] {
	const words = cues.flatMap((c) => wordsOf(c).map((w) => ({ ...w, speaker: c.speaker ?? null })));
	const budget = opts.maxChars * opts.maxLines;
	const out: Cue[] = [];
	let cur: typeof words = [];
	const text = (ws: typeof words) => ws.map((w) => w.w).join(' ');
	const flush = () => {
		if (!cur.length) return;
		out.push({
			id: cueId(),
			start: cur[0].s,
			end: cur[cur.length - 1].e,
			text: wrapLines(text(cur), opts.maxChars, opts.maxLines),
			speaker: cur[0].speaker,
			words: cur.map(({ w, s, e, p }) => ({ w, s, e, ...(p != null ? { p } : {}) })),
		});
		cur = [];
	};
	for (const w of words) {
		if (cur.length) {
			const last = cur[cur.length - 1];
			const tooLong = text([...cur, w]).length > budget || w.e - cur[0].s > opts.maxDuration;
			const pause = w.s - last.e > 0.7;
			const newSpeaker = w.speaker !== cur[0].speaker;
			if (tooLong && !pause && !newSpeaker) {
				// Full: break at the last comma/semicolon in the second half so
				// the clause moves on together — not one orphaned word.
				let k = -1;
				for (let j = cur.length - 2; j >= Math.floor(cur.length / 2); j--) {
					if (/[,;:]$/.test(cur[j].w)) {
						k = j;
						break;
					}
				}
				if (k >= 0) {
					const tail = cur.slice(k + 1);
					cur = cur.slice(0, k + 1);
					flush();
					cur = tail;
				} else flush();
			} else if (tooLong || pause || newSpeaker) flush();
		}
		cur.push(w);
		// End a cue at a sentence end once it has some substance.
		if (/[.!?…。！？]["')\]]*$/.test(w.w) && text(cur).length > budget * 0.35) flush();
	}
	flush();
	// Hold short cues on screen a little longer, without overlapping the next.
	for (let i = 0; i < out.length; i++) {
		const c = out[i];
		const next = out[i + 1]?.start ?? Infinity;
		if (c.end - c.start < opts.minDuration) c.end = Math.min(c.start + opts.minDuration, next - 0.04);
	}
	return out;
}

/** Re-wrap lines only — for tracks without word timings (translations, imports). */
export function rewrap(cues: Cue[], opts: ReflowOptions = DEFAULT_REFLOW): Cue[] {
	return cues.map((c) => ({ ...c, text: wrapLines(c.text, opts.maxChars, opts.maxLines) }));
}

export function shiftCues(cues: Cue[], seconds: number): Cue[] {
	return cues.map((c) => ({
		...c,
		start: Math.max(0, c.start + seconds),
		end: Math.max(0, c.end + seconds),
		words: c.words?.map((w) => ({ ...w, s: Math.max(0, w.s + seconds), e: Math.max(0, w.e + seconds) })),
	}));
}

/* --------------------------------------------------------------------------
 * Formats
 * -------------------------------------------------------------------------- */

function stamp(t: number, sep: ',' | '.'): string {
	const ms = Math.max(0, Math.round(t * 1000));
	const h = Math.floor(ms / 3600000);
	const m = Math.floor((ms % 3600000) / 60000);
	const s = Math.floor((ms % 60000) / 1000);
	const pad = (x: number, w = 2) => String(x).padStart(w, '0');
	return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

function display(c: Cue, speakers: boolean): string {
	return speakers && c.speaker ? `${c.speaker}: ${c.text}` : c.text;
}

export function toSrt(cues: Cue[], speakers = false): string {
	return cues
		.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${display(c, speakers)}\n`)
		.join('\n');
}

export function toVtt(cues: Cue[], speakers = false): string {
	const body = cues
		.map((c) => {
			const note = c.note ? `NOTE ${c.note.replace(/-->/g, '→')}\n\n` : '';
			const text = speakers && c.speaker ? `<v ${c.speaker}>${c.text}` : c.text;
			return `${note}${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${text}\n`;
		})
		.join('\n');
	return `WEBVTT\n\n${body}`;
}

/** A readable transcript with timestamps, speakers and notes. */
export function toTxt(cues: Cue[]): string {
	return cues
		.map((c) => {
			const m = Math.floor(c.start / 60);
			const s = Math.floor(c.start % 60);
			const who = c.speaker ? `${c.speaker}: ` : '';
			const note = c.note ? `\n    ✎ ${c.note}` : '';
			return `[${m}:${String(s).padStart(2, '0')}] ${who}${c.text.replace(/\n/g, ' ')}${note}`;
		})
		.join('\n');
}

function parseStamp(s: string): number {
	const m = /(?:(\d+):)?(\d+):(\d+)[,.](\d+)/.exec(s.trim());
	if (!m) return NaN;
	return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0').slice(0, 3)) / 1000;
}

/**
 * Parse SRT or WebVTT. Tolerant of BOMs, CRLF, cue settings, missing
 * indexes — and of a missing blank line between cues: every timing line
 * starts a cue, and a blank line ends its text.
 */
export function parseSubtitles(text: string): Cue[] {
	const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
	const cues: Cue[] = [];
	let cur: { start: number; end: number; body: string[]; closed: boolean } | null = null;
	const flush = () => {
		if (!cur) return;
		let body = cur.body.join('\n');
		let speaker: string | null = null;
		const v = /^<v\s+([^>]+)>/.exec(body);
		if (v) {
			speaker = v[1].trim();
			body = body.slice(v[0].length);
		}
		const clean = body.replace(/<[^>]+>/g, '').trim();
		if (clean) cues.push({ id: cueId(), start: cur.start, end: cur.end, text: clean, speaker });
		cur = null;
	};
	for (const line of lines) {
		if (line.includes('-->')) {
			// A bare number just before a timing line is the next cue's index.
			if (cur && !cur.closed && /^\d+$/.test(cur.body[cur.body.length - 1]?.trim() ?? '')) cur.body.pop();
			flush();
			const [a, b] = line.split('-->');
			const start = parseStamp(a);
			const end = parseStamp(b.trim().split(/\s+/)[0]);
			if (Number.isFinite(start) && Number.isFinite(end)) cur = { start, end, body: [], closed: false };
			continue;
		}
		if (!cur || cur.closed) continue;
		if (line.trim() === '') cur.closed = true;
		else cur.body.push(line);
	}
	flush();
	return cues;
}

/**
 * YouTube's json3 captions. Auto captions carry a start offset per word
 * (`tOffsetMs`), so they come in as words and are reflowed into proper
 * subtitles — the same path Whisper output takes. Manual captions are
 * events of finished text and are kept cue for cue.
 */
export function parseJson3(text: string): Cue[] {
	type Seg = { utf8?: string; tOffsetMs?: number };
	type Ev = { tStartMs?: number; dDurationMs?: number; segs?: Seg[] };
	const events = ((JSON.parse(text) as { events?: Ev[] }).events ?? []).filter((e) => Array.isArray(e.segs));
	const timedWords = events.some((e) => e.segs!.some((s) => s.tOffsetMs != null));
	if (!timedWords) {
		return events
			.map((e) => ({
				id: cueId(),
				start: (e.tStartMs ?? 0) / 1000,
				end: ((e.tStartMs ?? 0) + (e.dDurationMs ?? 0)) / 1000,
				text: e.segs!.map((s) => s.utf8 ?? '').join('').trim(),
			}))
			.filter((c) => c.text && c.end > c.start);
	}
	const words: Word[] = [];
	for (const e of events) {
		const base = e.tStartMs ?? 0;
		const segs = e.segs!.filter((s) => (s.utf8 ?? '').trim());
		segs.forEach((s, i) => {
			const start = base + (s.tOffsetMs ?? 0);
			const next = i + 1 < segs.length ? base + (segs[i + 1].tOffsetMs ?? 0) : base + (e.dDurationMs ?? 0);
			for (const w of s.utf8!.trim().split(/\s+/)) words.push({ w, s: start / 1000, e: Math.max(start, next) / 1000 });
		});
	}
	words.sort((a, b) => a.s - b.s);
	// An event's last word runs to the end of the event, often seconds past
	// the speech; never past the next word, never longer than ~1.2 s.
	for (let i = 0; i < words.length; i++) {
		const next = words[i + 1]?.s ?? Infinity;
		words[i].e = Math.min(words[i].e, next, words[i].s + 1.2);
		if (words[i].e <= words[i].s) words[i].e = words[i].s + 0.05;
	}
	if (!words.length) return [];
	return reflow([{ id: cueId(), start: words[0].s, end: words[words.length - 1].e, text: '', words }]);
}

/**
 * Auto captions exported as WebVTT "roll up": each cue repeats the line
 * before it and adds a few words. Keep only what's new in each cue.
 */
export function dedupeRolling(cues: Cue[]): Cue[] {
	const out: Cue[] = [];
	let previous: string[] = [];
	for (const c of cues) {
		const lines = c.text.split('\n').map((l) => l.trim()).filter(Boolean);
		const fresh = lines.filter((l) => !previous.includes(l));
		previous = lines;
		if (!fresh.length || c.end - c.start < 0.05) continue;
		out.push({ ...c, text: fresh.join('\n') });
	}
	return out;
}

/** Whisper segments (from the engine) → cues with word timings. */
export function segmentsToCues(segments: { start: number; end: number; text: string; words?: Word[] }[]): Cue[] {
	return segments.map((s) => ({ id: cueId(), start: s.start, end: s.end, text: s.text.trim(), words: s.words }));
}

/** The cue on screen at time t (binary search; cues are sorted). */
export function cueAt(cues: Cue[], t: number): number {
	let lo = 0;
	let hi = cues.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (cues[mid].end <= t) lo = mid + 1;
		else if (cues[mid].start > t) hi = mid - 1;
		else return mid;
	}
	return -1;
}

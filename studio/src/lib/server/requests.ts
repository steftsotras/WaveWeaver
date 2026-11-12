import { MEDIA_KINDS, type MediaKind } from '$lib/media';
import {
	ASPECTS,
	AUDIO_FORMATS,
	QUALITIES,
	sanitizeOutput,
	sanitizeSteps,
	VIDEO_FORMATS,
	type Aspect,
	type OutputFormat,
	type Quality,
} from '$lib/weave';
import type { MediaRef } from './paths.js';
import { resolveMedia } from './paths.js';
import { probeCached } from './probe.js';
import type { SnapshotParams } from './pipelines/snapshot.js';
import type { PartsParams } from './pipelines/parts.js';
import { TRANSITIONS, type StitchParams, type Transition } from './pipelines/stitch.js';
import type { WeaveParams } from './pipelines/weave.js';
import type { PreviewParams } from './pipelines/preview.js';
import type { ToolParams } from './pipelines/tool.js';
import type { SubtitleParams, TranscribeParams, TranslateParams } from './pipelines/captions.js';
import { isValidLang } from '$lib/captions';
import type { MixSpec, MixTrack } from '$lib/mix';
import { DEFAULT_DETECT, DEFAULT_EXPORT, type DetectOptions, type ExportOptions, type Part } from '$lib/parts';

/**
 * Request-body parsing for every job kind. Everything from the client is
 * treated as untrusted: unknown fields are dropped, numbers are clamped and
 * enums fall back to defaults. Bad references throw, which the routes turn
 * into 400s.
 */

export class BadRequest extends Error {}

type Body = Record<string, unknown>;

function clamp(v: unknown, min: number, max: number, fallback: number): number {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function oneOf<T>(v: unknown, allowed: readonly T[], fallback: T): T {
	return allowed.includes(v as T) ? (v as T) : fallback;
}

export function parseRef(v: unknown): MediaRef {
	if (!v || typeof v !== 'object') throw new BadRequest('Missing media reference');
	const r = v as Body;
	if (typeof r.bin !== 'string' || typeof r.name !== 'string') throw new BadRequest('Media reference needs bin and name');
	const kind = oneOf<MediaKind>(r.kind, MEDIA_KINDS, 'sources');
	return { bin: r.bin, kind, name: r.name };
}

async function hasVideo(ref: MediaRef): Promise<boolean> {
	try {
		return Boolean((await probeCached(await resolveMedia(ref))).video);
	} catch (err) {
		throw new BadRequest(err instanceof Error ? err.message : String(err));
	}
}

export async function parseWeave(body: Body, source = parseRef(body.source)): Promise<WeaveParams> {
	return { source, steps: sanitizeSteps(body.steps), output: sanitizeOutput(body.output, await hasVideo(source)) };
}

const ALL_FORMATS = [...VIDEO_FORMATS, ...AUDIO_FORMATS] as OutputFormat[];

export async function parseStitch(body: Body): Promise<StitchParams> {
	if (!Array.isArray(body.sources)) throw new BadRequest('sources must be a list');
	const sources = body.sources.slice(0, 60).map(parseRef);
	for (const s of sources) await hasVideo(s);
	return {
		sources,
		crossfade: clamp(body.crossfade, 0, 5, 0),
		transition: oneOf<Transition>(body.transition, TRANSITIONS, 'fade'),
		canvas: oneOf<'auto' | Aspect>(body.canvas, ['auto', ...ASPECTS], 'auto'),
		fit: oneOf(body.fit, ['pad', 'crop'] as const, 'pad'),
		format: oneOf(body.format, ALL_FORMATS, 'mp4'),
		quality: oneOf<Quality>(body.quality, QUALITIES, 'standard'),
	};
}

export async function parseSnapshot(body: Body): Promise<SnapshotParams> {
	const source = parseRef(body.source);
	if (!(await hasVideo(source))) throw new BadRequest('Snapshots need a video source');
	return {
		source,
		mode: oneOf(body.mode, ['frame', 'sheet'] as const, 'frame'),
		at: clamp(body.at, 0, 1e6, 0),
		cols: Math.round(clamp(body.cols, 1, 12, 5)),
		rows: Math.round(clamp(body.rows, 1, 12, 4)),
	};
}

/** Engine params are validated by the engine itself; here we only bound the size. */
function engineParams(v: unknown): Record<string, unknown> {
	if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
	const json = JSON.stringify(v);
	if (json.length > 20000) throw new BadRequest('Tool parameters too large');
	return JSON.parse(json);
}

function parseWindow(v: unknown): { start: number; duration: number } {
	const w = (v ?? {}) as Body;
	return { start: clamp(w.start, 0, 1e6, 0), duration: clamp(w.duration, 0.5, 90, 20) };
}

export async function parseTool(body: Body): Promise<ToolParams> {
	const source = parseRef(body.source);
	await hasVideo(source);
	if (typeof body.tool !== 'string' || !/^[\w-]{1,40}$/.test(body.tool)) throw new BadRequest('tool is required');
	const format = typeof body.format === 'string' && /^(same|wav|flac|mp3|m4a|ogg|opus|mp4|mov|mkv|webm)$/.test(body.format) ? body.format : 'same';
	return { source, tool: body.tool, params: engineParams(body.params), format };
}

export async function parsePreview(body: Body): Promise<PreviewParams> {
	const window = parseWindow(body.window);
	if (body.kind === 'weave') return { kind: 'weave', window, ...(await parseWeave(body)) };
	if (body.kind === 'tool') {
		const t = await parseTool(body);
		return { kind: 'tool', window, source: t.source, tool: t.tool, params: t.params };
	}
	throw new BadRequest(`Nothing to preview for kind: ${String(body.kind)}`);
}

export function parseTranscribe(body: Body): TranscribeParams {
	return {
		source: parseRef(body.source),
		model: oneOf(body.model, ['auto', 'tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'large-v3'] as const, 'auto'),
		language: typeof body.language === 'string' && (body.language === 'auto' || isValidLang(body.language)) ? body.language : 'auto',
		task: oneOf(body.task, ['transcribe', 'translate'] as const, 'transcribe'),
		vad: body.vad !== false,
		prompt: typeof body.prompt === 'string' ? body.prompt.slice(0, 500) : '',
		window: body.window ? parseWindow(body.window) : undefined,
	};
}

export function parseTranslate(body: Body): TranslateParams {
	const from = String(body.from ?? '');
	const to = String(body.to ?? '');
	if (!isValidLang(from) || !isValidLang(to)) throw new BadRequest('from and to must be language codes');
	if (from === to) throw new BadRequest('Pick a different target language');
	return { source: parseRef(body.source), from, to, provider: oneOf(body.provider, ['auto', 'claude', 'nllb'] as const, 'auto') };
}

export function parseSubtitle(body: Body): SubtitleParams {
	const langs = (Array.isArray(body.langs) ? body.langs : []).map(String).filter(isValidLang).slice(0, 12);
	if (!langs.length) throw new BadRequest('Pick at least one caption track');
	const st = (body.style ?? {}) as Body;
	return {
		source: parseRef(body.source),
		mode: oneOf(body.mode, ['burn', 'soft'] as const, 'burn'),
		langs,
		style: {
			size: oneOf(st.size, ['s', 'm', 'l'] as const, 'm'),
			position: oneOf(st.position, ['bottom', 'top'] as const, 'bottom'),
			box: st.box !== false,
			color: oneOf(st.color, ['white', 'yellow', 'accent'] as const, 'white'),
		},
		speakers: Boolean(body.speakers),
		container: oneOf(body.container, ['mp4', 'mkv'] as const, 'mp4'),
		window: body.window ? parseWindow(body.window) : undefined,
	};
}

export async function parseMix(body: Body): Promise<MixSpec> {
	if (!Array.isArray(body.tracks) || !body.tracks.length) throw new BadRequest('Add at least one track');
	const tracks: MixTrack[] = [];
	for (const raw of body.tracks.slice(0, 24)) {
		const t = (raw ?? {}) as Body;
		const ref = parseRef(t.ref);
		await hasVideo(ref);
		tracks.push({
			id: typeof t.id === 'string' ? t.id.slice(0, 40) : `t${tracks.length}`,
			ref,
			role: oneOf(t.role, ['voice', 'music', 'fx'] as const, 'voice'),
			gainDb: clamp(t.gainDb, -40, 20, 0),
			pan: clamp(t.pan, -1, 1, 0),
			offset: clamp(t.offset, 0, 36000, 0),
			fadeIn: clamp(t.fadeIn, 0, 60, 0),
			fadeOut: clamp(t.fadeOut, 0, 60, 0),
			mute: Boolean(t.mute),
			solo: Boolean(t.solo),
		});
	}
	const d = (body.duck ?? {}) as Body;
	return {
		tracks,
		duck: {
			on: d.on !== false,
			depthDb: clamp(d.depthDb, -40, -1, -12),
			attackMs: clamp(d.attackMs, 1, 2000, 40),
			releaseMs: clamp(d.releaseMs, 10, 5000, 600),
		},
		master: typeof body.master === 'string' && /^[\w-]{1,80}$/.test(body.master) ? body.master : null,
		format: oneOf(body.format, ['mp3', 'wav', 'flac', 'm4a', 'mp4'] as const, 'mp3'),
		videoFrom: typeof body.videoFrom === 'string' ? body.videoFrom : null,
	};
}

export function parseWindowPublic(v: unknown) {
	return parseWindow(v);
}

export function sanitizeParts(v: unknown): Part[] {
	if (!Array.isArray(v)) return [];
	return v
		.slice(0, 2000)
		.map((raw, i) => {
			const r = (raw ?? {}) as Body;
			const start = clamp(r.start, 0, 1e6, 0);
			const end = clamp(r.end, 0, 1e6, 0);
			return {
				id: typeof r.id === 'string' ? r.id.slice(0, 40) : `p${i}`,
				start,
				end,
				name: (typeof r.name === 'string' && r.name.trim() ? r.name.trim() : `Part ${i + 1}`).slice(0, 120),
				on: r.on !== false,
			};
		})
		.filter((x) => x.end - x.start > 0.05)
		.sort((a, b) => a.start - b.start);
}

export function sanitizeDetect(v: unknown): DetectOptions {
	const r = (v ?? {}) as Body;
	const d = DEFAULT_DETECT;
	return {
		mode: oneOf(r.mode, ['silence', 'speech', 'every', 'count', 'manual'] as const, d.mode),
		thresholdDb: Math.round(clamp(r.thresholdDb, -80, -10, d.thresholdDb)),
		minPauseSec: clamp(r.minPauseSec, 0.25, 120, d.minPauseSec),
		padMs: clamp(r.padMs, 0, 5000, d.padMs),
		minPartSec: clamp(r.minPartSec, 0, 3600, d.minPartSec),
		shortParts: oneOf(r.shortParts, ['exclude', 'merge'] as const, d.shortParts),
		everySec: clamp(r.everySec, 5, 36000, d.everySec),
		count: Math.round(clamp(r.count, 2, 500, d.count)),
		snapToPauses: r.snapToPauses !== false,
		vadThreshold: clamp(r.vadThreshold, 0.1, 0.9, d.vadThreshold),
	};
}

export function sanitizeExport(v: unknown): ExportOptions {
	const r = (v ?? {}) as Body;
	const d = DEFAULT_EXPORT;
	const t = (r.tags ?? {}) as Body;
	const tag = (x: unknown) => (typeof x === 'string' ? x.replace(/[\r\n]/g, ' ').slice(0, 120) : '');
	return {
		as: oneOf(r.as, ['separate', 'joined'] as const, d.as),
		format: oneOf(r.format, ['same', 'mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'mp4'] as const, d.format),
		quality: oneOf<Quality>(r.quality, QUALITIES, d.quality),
		fadeMs: clamp(r.fadeMs, 0, 5000, d.fadeMs),
		gapMs: clamp(r.gapMs, 0, 10000, d.gapMs),
		crossfadeMs: clamp(r.crossfadeMs, 0, 10000, d.crossfadeMs),
		normalize: oneOf(r.normalize, ['none', 'each', 'all'] as const, d.normalize),
		lufs: clamp(r.lufs, -30, -8, d.lufs),
		chapters: r.chapters !== false,
		tags: { artist: tag(t.artist), album: tag(t.album), year: tag(t.year), genre: tag(t.genre) },
	};
}

export async function parseParts(body: Body): Promise<PartsParams> {
	const source = parseRef(body.source);
	await hasVideo(source);
	const parts = sanitizeParts(body.parts);
	if (!parts.length) throw new BadRequest('No parts');
	const pv = body.preview as Body | undefined;
	return {
		source,
		parts,
		export: sanitizeExport(body.export),
		preview: pv ? { fromPart: typeof pv.fromPart === 'string' ? pv.fromPart : null, seconds: clamp(pv.seconds, 5, 90, 30) } : undefined,
	};
}

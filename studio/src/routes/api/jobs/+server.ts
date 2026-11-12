import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { activeJobCount, clearFinished, enqueue, listJobs } from '$lib/server/jobs';
import { downloads } from '$lib/server/downloads';
import {
	BadRequest,
	parseRef,
	parseSnapshot,
	parseStitch,
	parseSubtitle,
	parseTool,
	parseTranscribe,
	parseTranslate,
	parseWeave,
	parseMix,
	parseParts,
} from '$lib/server/requests';
import { runMix } from '$lib/server/pipelines/mix';
import { runSubtitle, runTranscribe, runTranslate } from '$lib/server/pipelines/captions';
import { languageName } from '$lib/captions';
import { EngineError } from '$lib/server/engine';
import { runTool } from '$lib/server/pipelines/tool';
import { runSnapshot } from '$lib/server/pipelines/snapshot';
import { runPartsExport } from '$lib/server/pipelines/parts';
import { runStitch } from '$lib/server/pipelines/stitch';
import { runWeave } from '$lib/server/pipelines/weave';
import { metaFor } from '$lib/weave';

/**
 * `?summary` returns just the active counts — jobs, and downloads running
 * or waiting for a slot (the nav badges poll this).
 * Otherwise every job, minus logs — fetch /api/jobs/[id] for those.
 */
export const GET: RequestHandler = async ({ url }) => {
	if (url.searchParams.has('summary')) return json({ active: activeJobCount(), downloads: downloads.activeCount() });
	return json({ jobs: listJobs().map((j) => ({ ...j, logs: [], commands: [] })) });
};

/** Clear finished jobs from the list. Files on disk are untouched. */
export const DELETE: RequestHandler = async () => {
	return json({ cleared: clearFinished() });
};

/**
 * Start a job. Body: `{ kind, ...params }`. Returns `{ id }`, or `{ ids }`
 * for a batch weave (`sources: [...]` instead of `source`), which queues one
 * job per file so a whole bin can go through the same recipe.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== 'object') throw error(400, 'Invalid JSON body');

	try {
		switch (body.kind) {
			case 'weave': {
				const sources = Array.isArray(body.sources) ? body.sources.slice(0, 500).map(parseRef) : [parseRef(body.source)];
				const ids: string[] = [];
				for (const source of sources) {
					const params = await parseWeave(body, source);
					const ops = params.steps.filter((s) => s.on).map((s) => metaFor(s.op).label);
					const label = `${source.name} · ${ops.join(' → ') || 'transcode'} → ${params.output.format}`;
					ids.push(enqueue('weave', label, params, (ctx) => runWeave(params, ctx)).id);
				}
				return json(Array.isArray(body.sources) ? { ids } : { id: ids[0] });
			}
			case 'stitch': {
				const params = await parseStitch(body);
				const label = `${params.sources.length} clips${params.crossfade > 0 ? ` · ${params.transition} ${params.crossfade}s` : ''} → ${params.format}`;
				return json({ id: enqueue('stitch', label, params, (ctx) => runStitch(params, ctx)).id });
			}
			case 'parts': {
				const params = await parseParts(body);
				const n = params.parts.filter((x) => x.on).length;
				const label = `${params.source.name} · ${params.export.as === 'joined' ? `join ${n} parts` : `${n} part files`}`;
				return json({ id: enqueue('parts', label, params, (ctx) => runPartsExport(params, ctx)).id });
			}
			case 'tool': {
				const params = await parseTool(body);
				const label = `${params.source.name} · ${params.tool}`;
				return json({ id: enqueue('tool', label, params, (ctx) => runTool(params, ctx)).id });
			}
			case 'transcribe': {
				const params = parseTranscribe(body);
				const label = `${params.source.name} · transcribe${params.window ? ' · preview' : ''}`;
				return json({ id: enqueue('transcribe', label, params, (ctx) => runTranscribe(params, ctx), params.window ? { lane: 'preview' } : {}).id });
			}
			case 'translate': {
				const params = parseTranslate(body);
				const label = `${params.source.name} · ${languageName(params.from)} → ${languageName(params.to)}`;
				return json({ id: enqueue('translate', label, params, (ctx) => runTranslate(params, ctx)).id });
			}
			case 'subtitle': {
				const params = parseSubtitle(body);
				const label = `${params.source.name} · ${params.mode === 'burn' ? 'burn in' : 'subtitle tracks'} ${params.langs.join(', ')}`;
				return json({ id: enqueue('subtitle', label, params, (ctx) => runSubtitle(params, ctx)).id });
			}
			case 'mix': {
				const params = await parseMix(body);
				const label = `Mix · ${params.tracks.length} tracks → ${params.format}${params.master ? ` · ${params.master}` : ''}`;
				return json({ id: enqueue('mix', label, params, (ctx) => runMix(params, ctx)).id });
			}
			case 'snapshot': {
				const params = await parseSnapshot(body);
				const label = `${params.source.name} · ${params.mode === 'frame' ? `frame @ ${params.at.toFixed(1)}s` : `${params.cols}×${params.rows} sheet`}`;
				return json({ id: enqueue('snapshot', label, params, (ctx) => runSnapshot(params, ctx)).id });
			}
			default:
				throw error(400, `Unknown job kind: ${String(body.kind)}`);
		}
	} catch (err) {
		if (err instanceof EngineError) throw error(err.status, err.message);
		if (err instanceof BadRequest || (err instanceof Error && /^(Invalid|Unknown|Path)/.test(err.message))) {
			throw error(400, err.message);
		}
		throw err;
	}
};

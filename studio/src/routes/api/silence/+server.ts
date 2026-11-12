import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runFfmpeg } from '$lib/server/ffmpeg';
import { resolveMedia } from '$lib/server/paths';
import { probeCached } from '$lib/server/probe';
import { BadRequest, parseRef } from '$lib/server/requests';
import { parseSilence } from '$lib/server/weave';
import { EngineError, engineFetch } from '$lib/server/engine';
import { speechToSilence } from '$lib/server/pipelines/weave';

/**
 * Silences in a source, on its own timeline. Powers the jump-cut preview:
 * the Desk paints these onto the waveform so you can tune the threshold
 * before committing to a render. Audio-only decode, so it's quick.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) throw error(400, 'Invalid JSON body');
	let path: string;
	try {
		path = await resolveMedia(parseRef(body.source));
	} catch (err) {
		throw error(400, err instanceof BadRequest || err instanceof Error ? err.message : 'Bad source');
	}
	const info = await probeCached(path);
	if (!info.audio) throw error(400, 'No audio track');
	const db = Math.min(-10, Math.max(-80, Number(body.thresholdDb) || -35));
	const min = Math.min(10000, Math.max(100, Number(body.minSilenceMs) || 600));
	const D = info.duration ?? 0;
	if (body.detector === 'speech') {
		// Speech-aware: ask the engine's Silero VAD where people talk; the
		// gaps between are the silences.
		const threshold = Math.min(0.9, Math.max(0.1, Number(body.vadThreshold) || 0.5));
		try {
			const { id } = await engineFetch<{ id: string }>('/jobs', {
				method: 'POST',
				body: JSON.stringify({ tool: 'vad', input: parseRef(body.source), params: { threshold, min_silence_ms: min, min_speech_ms: 150 } }),
			});
			for (;;) {
				const job = await engineFetch<{ status: string; error: string | null; result: { data: { speech: [number, number][] } } | null }>(`/jobs/${id}`);
				if (job.status === 'done') return json(speechToSilence(job.result!.data.speech, D));
				if (job.status === 'error' || job.status === 'cancelled') throw error(500, job.error ?? 'VAD failed');
				await new Promise((r) => setTimeout(r, 250));
			}
		} catch (err) {
			if (err instanceof EngineError) throw error(err.status, err.message);
			throw err;
		}
	}
	const stderr = await runFfmpeg(['-vn', '-i', path, '-af', `silencedetect=noise=${db}dB:d=${(min / 1000).toFixed(3)}`, '-f', 'null', '-'], {
		loglevel: 'info',
		forwardStderr: false,
	});
	return json(parseSilence(stderr, D));
};

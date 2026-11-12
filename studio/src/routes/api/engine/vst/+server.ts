import { error, json } from '@sveltejs/kit';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RequestHandler } from './$types';
import { EngineError, engineFetch } from '$lib/server/engine';
import { MEDIA_ROOT } from '$lib/server/paths';

const STATE_DIR = join(MEDIA_ROOT, 'presets', 'vst');

/** Installed VST3 plugins (scanned by the engine) and the settings you've saved for them. */
export const GET: RequestHandler = async () => {
	try {
		const { plugins } = await engineFetch<{ plugins: { path: string; name: string }[] }>('/vst/plugins');
		const states: { id: string; plugin: string; name: string }[] = [];
		for (const dir of await readdir(STATE_DIR).catch(() => [] as string[])) {
			for (const f of await readdir(join(STATE_DIR, dir)).catch(() => [] as string[])) {
				if (f.endsWith('.state')) states.push({ id: `${dir}/${f.slice(0, -6)}`, plugin: dir, name: f.slice(0, -6) });
			}
		}
		return json({ plugins, states });
	} catch (err) {
		if (err instanceof EngineError) throw error(err.status, err.message);
		throw err;
	}
};

/**
 * Open a plugin's own window on this computer. Blocks until you close it,
 * then saves its settings under `saveAs` — the VST3 tool renders with them.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { plugin?: string; state?: string; saveAs?: string };
	if (!body.plugin || !body.saveAs) throw error(400, 'plugin and saveAs are required');
	try {
		return json(
			await engineFetch('/vst/editor', {
				method: 'POST',
				body: JSON.stringify({ plugin: body.plugin, state: body.state || null, save_as: body.saveAs }),
			}),
		);
	} catch (err) {
		if (err instanceof EngineError) throw error(err.status, err.message);
		throw err;
	}
};

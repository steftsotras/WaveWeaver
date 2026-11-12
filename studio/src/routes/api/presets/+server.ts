import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deletePreset, listPresets, savePreset } from '$lib/server/presets';

export const GET: RequestHandler = async () => json({ presets: await listPresets() });

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body.name !== 'string' || !body.name.trim()) throw error(400, 'name is required');
	try {
		return json({ preset: await savePreset(body.name, String(body.description ?? ''), body.steps, body.output) }, { status: 201 });
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : 'Could not save');
	}
};

export const DELETE: RequestHandler = async ({ url }) => {
	try {
		await deletePreset(url.searchParams.get('id') ?? '');
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : 'Bad id');
	}
	return json({ ok: true });
};

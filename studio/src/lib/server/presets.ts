import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BUILTIN_PRESETS, type Preset } from '$lib/presets';
import { sanitizeOutput, sanitizeSteps } from '$lib/weave';
import { MEDIA_ROOT } from './paths.js';
import { slugify } from './text.js';

/**
 * Your own recipes: one JSON file each in media/presets/. Plain files, so
 * they're easy to back up, share, or edit by hand.
 */
export const PRESET_DIR = join(MEDIA_ROOT, 'presets');

export async function listPresets(): Promise<Preset[]> {
	const mine: Preset[] = [];
	for (const f of await readdir(PRESET_DIR).catch(() => [] as string[])) {
		if (!f.endsWith('.json')) continue;
		try {
			const raw = JSON.parse(await readFile(join(PRESET_DIR, f), 'utf8'));
			mine.push({
				id: f.slice(0, -5),
				name: String(raw.name ?? f.slice(0, -5)),
				group: 'mine',
				description: String(raw.description ?? ''),
				steps: sanitizeSteps(raw.steps),
				output: raw.output ? sanitizeOutput(raw.output, true) : undefined,
			});
		} catch {
			// a hand-edited file with a typo shouldn't hide the others
		}
	}
	mine.sort((a, b) => a.name.localeCompare(b.name));
	return [...BUILTIN_PRESETS.map((p) => ({ ...p, builtin: true })), ...mine];
}

export async function savePreset(name: string, description: string, steps: unknown, output: unknown): Promise<Preset> {
	const id = slugify(name) || 'recipe';
	if (BUILTIN_PRESETS.some((p) => p.id === id)) throw new Error('That name belongs to a built-in preset.');
	const preset: Preset = {
		id,
		name: name.trim().slice(0, 80),
		group: 'mine',
		description: description.trim().slice(0, 400),
		steps: sanitizeSteps(steps),
		output: output ? sanitizeOutput(output, true) : undefined,
	};
	if (!preset.steps.length) throw new Error('A recipe needs at least one step.');
	await mkdir(PRESET_DIR, { recursive: true });
	await writeFile(join(PRESET_DIR, `${id}.json`), JSON.stringify(preset, null, '\t'));
	return preset;
}

export async function deletePreset(id: string): Promise<void> {
	if (!/^[\w-]{1,80}$/.test(id)) throw new Error('Bad preset id');
	await rm(join(PRESET_DIR, `${id}.json`), { force: true });
}

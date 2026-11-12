/**
 * Shapes of the Python engine's tool catalogue, as the studio sees them.
 * The engine describes its own forms; the studio renders them generically,
 * so a new plugin needs no studio code.
 */

export type EngineParamKind = 'number' | 'bool' | 'select' | 'text' | 'media' | 'region' | 'vst';

export interface EngineParam {
	key: string;
	label: string;
	kind: EngineParamKind;
	default?: unknown;
	min?: number;
	max?: number;
	step?: number;
	unit?: string;
	options?: { value: string; label: string }[];
	help?: string;
}

export interface EngineTool {
	id: string;
	label: string;
	group: string;
	blurb: string;
	inputs: 'audio' | 'captions';
	output: 'audio' | 'data';
	params: EngineParam[];
	previewable: boolean;
	presets: Record<string, Record<string, unknown>>;
	available: boolean;
	reason: string | null;
	install: string;
	credits: string;
}

export interface EngineStatus {
	online: boolean;
	error?: string;
	version?: string;
	device?: string;
	tools: EngineTool[];
}

export const TOOL_GROUPS: { group: string; label: string }[] = [
	{ group: 'clean', label: 'Clean up' },
	{ group: 'fx', label: 'Effects' },
	{ group: 'master', label: 'Master' },
	{ group: 'speech', label: 'Speech' },
];

export function defaultParams(tool: EngineTool): Record<string, unknown> {
	return Object.fromEntries(tool.params.map((p) => [p.key, p.default ?? null]));
}

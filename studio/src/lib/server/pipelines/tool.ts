import type { JobResult } from '$lib/jobs';
import { runEngine } from '../engine.js';
import type { JobContext } from '../jobs.js';
import type { MediaRef } from '../paths.js';
import { describeOutput } from './common.js';

export interface ToolParams {
	source: MediaRef;
	tool: string;
	params: Record<string, unknown>;
	/** "same" keeps the source's container (a cleaned .mp4 stays an .mp4 with its picture). */
	format: string;
}

/** Run an engine tool over a whole file and register what it wrote. */
export async function runTool(p: ToolParams, ctx: JobContext): Promise<JobResult> {
	ctx.log(`Engine tool ${p.tool} on ${p.source.bin}/${p.source.kind}/${p.source.name}`);
	const r = await runEngine(ctx, {
		tool: p.tool,
		input: p.source,
		params: p.params,
		output: { mode: 'render', format: p.format },
	});
	const outputs = await Promise.all(r.outputs.map((o) => describeOutput(o.path)));
	return { outputs, data: r.data };
}

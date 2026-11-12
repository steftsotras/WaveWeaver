import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cancelJob, getJob } from '$lib/server/jobs';

export const GET: RequestHandler = async ({ params }) => {
	const job = getJob(params.id);
	if (!job) throw error(404, 'Job not found');
	return json({ job });
};

export const DELETE: RequestHandler = async ({ params }) => {
	if (!cancelJob(params.id)) throw error(404, 'Job not found or already finished');
	return json({ ok: true });
};

import type { Handle, ServerInit } from '@sveltejs/kit';
import { downloads } from '$lib/server/downloads';

/**
 * Start the download manager with the server, so queued downloads resume
 * and subscriptions get checked without a page having to be open first.
 */
export const init: ServerInit = async () => {
	await downloads.ready;
};

/**
 * The desktop app sets ORIGIN. It has no sign-in, and any web page the user
 * opens could otherwise reach this port: a matching Host stops DNS rebinding,
 * a matching Origin stops cross-site POSTs. Plain `npm run dev` keeps none of
 * this, since it's only ever a developer's own browser.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const allowed = process.env.ORIGIN;
	if (allowed) {
		const origin = event.request.headers.get('origin');
		const host = event.request.headers.get('host');
		if ((origin && origin !== allowed) || host !== new URL(allowed).host) return new Response('Forbidden', { status: 403 });
	}
	return resolve(event);
};

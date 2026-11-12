import type { RequestHandler } from './$types';
import type { DownloadEvent } from '$lib/downloads';
import { downloads } from '$lib/server/downloads';

/**
 * Server-sent events: a snapshot on connect, then every change as it
 * happens — progress twice a second per running download. EventSource
 * reconnects by itself (after a server restart or a dev reload) and gets a
 * fresh snapshot.
 */
export const GET: RequestHandler = async ({ request }) => {
	await downloads.ready;
	const enc = new TextEncoder();
	let cleanup = () => {};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let open = true;
			const write = (text: string) => {
				if (!open) return;
				try {
					controller.enqueue(enc.encode(text));
				} catch {
					close();
				}
			};
			const send = (e: DownloadEvent) => write(`data: ${JSON.stringify(e)}\n\n`);
			const ping = setInterval(() => write(': ping\n\n'), 15_000);
			const off = downloads.on(send, () => close());
			function close() {
				if (!open) return;
				open = false;
				clearInterval(ping);
				off();
				try {
					controller.close();
				} catch {
					// already closed
				}
			}
			cleanup = close;
			request.signal.addEventListener('abort', close, { once: true });
			write('retry: 1500\n\n');
			send(downloads.snapshot());
		},
		cancel() {
			cleanup();
		},
	});
	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
		},
	});
};

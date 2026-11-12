<script lang="ts">
	import { palette, theme } from '$lib/theme.svelte';
	import { eqResponseDb, type EqBand } from '$lib/weave';

	/**
	 * The EQ as a picture: the combined response on a log-frequency axis,
	 * one dot per enabled band. Drag a dot sideways for frequency, up/down
	 * for gain; scroll on a bell to make it narrower or wider.
	 */
	let { bands = $bindable() }: { bands: EqBand[] } = $props();

	const H = 160;
	const DB = 18;
	const FMIN = 20;
	const FMAX = 20000;
	let canvas = $state<HTMLCanvasElement | null>(null);
	let width = $state(0);

	const xOf = (f: number) => (Math.log10(f / FMIN) / Math.log10(FMAX / FMIN)) * width;
	const fOf = (x: number) => FMIN * Math.pow(FMAX / FMIN, Math.min(1, Math.max(0, x / width)));
	const yOf = (db: number) => H / 2 - (db / DB) * (H / 2 - 8);
	const dbOf = (y: number) => ((H / 2 - y) / (H / 2 - 8)) * DB;

	$effect(() => {
		if (!canvas) return;
		const ro = new ResizeObserver(([e]) => (width = Math.floor(e.contentRect.width)));
		ro.observe(canvas.parentElement!);
		return () => ro.disconnect();
	});

	function nodeY(b: EqBand): number {
		return b.type === 'highpass' || b.type === 'lowpass' ? yOf(0) : yOf(b.g);
	}

	$effect(() => {
		void [JSON.stringify(bands), theme.version];
		if (!canvas || !width) return;
		const dpr = devicePixelRatio || 1;
		canvas.width = width * dpr;
		canvas.height = H * dpr;
		const g = canvas.getContext('2d')!;
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		const { ink, accent, onAccent, fade } = palette(canvas);
		g.clearRect(0, 0, width, H);

		g.strokeStyle = fade(ink, 0.15);
		g.lineWidth = 1;
		g.font = '10px JetBrains Mono, monospace';
		g.fillStyle = fade(ink, 0.5);
		for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
			const x = Math.round(xOf(f)) + 0.5;
			g.beginPath();
			g.moveTo(x, 0);
			g.lineTo(x, H);
			g.stroke();
			g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3, H - 4);
		}
		for (const db of [-12, -6, 6, 12]) {
			const y = Math.round(yOf(db)) + 0.5;
			g.beginPath();
			g.moveTo(0, y);
			g.lineTo(width, y);
			g.stroke();
			g.fillText(`${db > 0 ? '+' : ''}${db}`, 3, y - 3);
		}
		g.strokeStyle = ink;
		g.beginPath();
		g.moveTo(0, yOf(0) + 0.5);
		g.lineTo(width, yOf(0) + 0.5);
		g.stroke();

		const freqs = Array.from({ length: width }, (_, x) => fOf(x));
		const resp = eqResponseDb(bands, freqs);
		g.beginPath();
		resp.forEach((db, x) => (x ? g.lineTo(x, yOf(Math.max(-DB, Math.min(DB, db)))) : g.moveTo(x, yOf(db))));
		g.lineTo(width, H);
		g.lineTo(0, H);
		g.closePath();
		g.fillStyle = fade(accent, 0.18);
		g.fill();
		g.beginPath();
		resp.forEach((db, x) => (x ? g.lineTo(x, yOf(Math.max(-DB, Math.min(DB, db)))) : g.moveTo(x, yOf(db))));
		g.strokeStyle = ink;
		g.lineWidth = 2;
		g.stroke();

		bands.forEach((b, i) => {
			if (!b.on) return;
			const x = xOf(b.f);
			const y = nodeY(b);
			g.fillStyle = i === dragging ? ink : accent;
			g.strokeStyle = ink;
			g.lineWidth = 1.5;
			g.fillRect(x - 6, y - 6, 12, 12);
			g.strokeRect(x - 6, y - 6, 12, 12);
			// The number sits on the accent square, or on the ink one while dragged.
			g.fillStyle = i === dragging ? accent : onAccent;
			g.font = 'bold 9px JetBrains Mono, monospace';
			g.fillText(String(i + 1), x - 3, y + 3);
		});
	});

	let dragging = $state<number | null>(null);

	function local(e: PointerEvent | WheelEvent) {
		const r = canvas!.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	function nearest(x: number, y: number): number | null {
		let best: number | null = null;
		let bestD = 14;
		bands.forEach((b, i) => {
			if (!b.on) return;
			const d = Math.hypot(xOf(b.f) - x, nodeY(b) - y);
			if (d < bestD) {
				bestD = d;
				best = i;
			}
		});
		return best;
	}

	function onDown(e: PointerEvent) {
		const { x, y } = local(e);
		dragging = nearest(x, y);
		if (dragging != null) canvas!.setPointerCapture(e.pointerId);
	}

	function onMove(e: PointerEvent) {
		if (dragging == null) return;
		const { x, y } = local(e);
		const b = bands[dragging];
		b.f = Math.round(Math.min(20000, Math.max(20, fOf(x))));
		if (b.type !== 'highpass' && b.type !== 'lowpass') b.g = Math.round(Math.max(-DB, Math.min(DB, dbOf(y))) * 2) / 2;
	}

	function onWheel(e: WheelEvent) {
		const { x, y } = local(e);
		const i = nearest(x, y);
		if (i == null) return;
		e.preventDefault();
		const b = bands[i];
		b.q = Math.round(Math.min(10, Math.max(0.3, b.q * (e.deltaY > 0 ? 0.9 : 1.1))) * 100) / 100;
	}
</script>

<div class="eq">
	<canvas
		bind:this={canvas}
		style:cursor={dragging != null ? 'grabbing' : 'crosshair'}
		onpointerdown={onDown}
		onpointermove={onMove}
		onpointerup={() => (dragging = null)}
		onwheel={onWheel}
	></canvas>
</div>

<style>
	.eq {
		position: relative;
		block-size: 160px;
		border: 1.5px solid var(--ink);
		touch-action: none;
	}

	canvas {
		position: absolute;
		inset: 0;
		inline-size: 100%;
		block-size: 100%;
	}
</style>

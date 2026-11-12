<script lang="ts" module>
	export interface Region {
		start: number;
		end: number;
		/**
		 * cut:     will be removed (hatched)
		 * outside: not part of the result (washed out)
		 * keep:    a part you're keeping (light accent tint)
		 * drop:    a part you've excluded (hatched, dimmed)
		 * focus:   the part you're working on (outlined)
		 */
		kind: 'cut' | 'outside' | 'keep' | 'drop' | 'focus';
		/** Regions with an id get draggable edges (see onregionedge). */
		id?: string;
		label?: string;
	}
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { formatTimecode } from '$lib/media';
	import { palette, theme, type Palette } from '$lib/theme.svelte';

	interface PeaksData {
		duration: number;
		secondsPerPeak: number;
		peaks: number[];
		start?: number;
	}

	let {
		src,
		duration = 0,
		currentTime = 0,
		selection = $bindable(null),
		regions = [],
		marks = [],
		interactive = true,
		height = 128,
		onseek,
		onregionedge,
		onregionclick,
	}: {
		src: string;
		duration?: number;
		currentTime?: number;
		selection?: { start: number; end: number } | null;
		regions?: Region[];
		marks?: number[];
		interactive?: boolean;
		height?: number;
		onseek?: (t: number) => void;
		/** Dragging the edge of a region with an id. */
		onregionedge?: (id: string, edge: 'start' | 'end', t: number) => void;
		onregionclick?: (id: string) => void;
	} = $props();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let mini = $state<HTMLCanvasElement | null>(null);
	let wrap = $state<HTMLDivElement | null>(null);
	let width = $state(0);
	let data = $state<PeaksData | null>(null);
	let detail = $state<PeaksData | null>(null);
	let failed = $state<string | null>(null);
	let hoverX = $state<number | null>(null);

	const D = $derived(data?.duration || duration || 0);

	/* ------------------------------------------------------------------
	 * View: the visible [start, end]. Ctrl+wheel zooms around the pointer,
	 * Shift+wheel (or a trackpad's sideways swipe) scrolls, the overview
	 * strip below drags. Plain wheel is left alone so the page scrolls.
	 * ---------------------------------------------------------------- */

	let view = $state({ start: 0, end: 0 });
	const span = $derived(Math.max(0.05, view.end - view.start));
	const zoomed = $derived(D > 0 && span < D - 0.01);

	$effect(() => {
		if (D > 0 && (view.end === 0 || view.end > D + 0.01)) view = { start: 0, end: D };
	});

	function setView(start: number, end: number) {
		const minSpan = Math.min(D, 2);
		let len = Math.max(minSpan, Math.min(D, end - start));
		let s = Math.max(0, Math.min(D - len, start));
		view = { start: s, end: s + len };
	}

	function zoomAt(t: number, factor: number) {
		const len = span * factor;
		const ratio = (t - view.start) / span;
		setView(t - ratio * len, t - ratio * len + len);
	}

	export function zoomToSelection() {
		if (selection) setView(selection.start - 0.5, selection.end + 0.5);
	}

	// Follow the playhead when it runs off the visible part (playback,
	// seeking from elsewhere). Scrolling away on purpose doesn't snap back:
	// this only reacts to the playhead moving.
	$effect(() => {
		const t = currentTime;
		untrack(() => {
			if (!zoomed) return;
			if (t > view.end || t < view.start) setView(t - span * 0.1, t - span * 0.1 + span);
		});
	});

	$effect(() => {
		const url = src;
		data = null;
		detail = null;
		failed = null;
		let alive = true;
		fetch(url)
			.then(async (r) => {
				if (!r.ok) throw new Error(r.status === 404 ? 'No audio track' : await r.text());
				return r.json();
			})
			.then((d: PeaksData) => alive && (data = d))
			.catch((e) => alive && (failed = e instanceof Error ? e.message : String(e)));
		return () => {
			alive = false;
		};
	});

	// Zoomed in past the overview's resolution: fetch finer peaks for the
	// visible range (plus a margin), debounced while you scroll.
	let detailTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		const { start, end } = view;
		if (!data || !width) return;
		const columnsInView = (end - start) / data.secondsPerPeak;
		if (columnsInView >= width * 0.8) return;
		if (detail && detail.start! <= start && detail.start! + detail.duration >= end) return;
		if (detailTimer) clearTimeout(detailTimer);
		const margin = (end - start) * 0.5;
		const a = Math.max(0, start - margin);
		const b = Math.min(D, end + margin);
		detailTimer = setTimeout(() => {
			const sep = src.includes('?') ? '&' : '?';
			fetch(`${src}${sep}start=${a.toFixed(2)}&end=${b.toFixed(2)}`)
				.then((r) => (r.ok ? r.json() : null))
				.then((d) => d && (detail = d));
		}, 150);
	});

	$effect(() => {
		if (!wrap) return;
		const ro = new ResizeObserver(([entry]) => (width = Math.floor(entry.contentRect.width)));
		ro.observe(wrap);
		return () => ro.disconnect();
	});

	const xOf = (t: number) => ((t - view.start) / span) * width;
	const tOf = (x: number) => Math.min(D, Math.max(0, view.start + (x / width) * span));

	function peakAt(t0: number, t1: number): number {
		const src = detail && detail.start! <= t0 && detail.start! + detail.duration >= t1 ? detail : data;
		if (!src) return 0;
		const off = src.start ?? 0;
		const spp = src.secondsPerPeak;
		let p = 0;
		const i1 = Math.min(src.peaks.length, Math.ceil((t1 - off) / spp));
		for (let i = Math.max(0, Math.floor((t0 - off) / spp)); i < i1; i++) if (src.peaks[i] > p) p = src.peaks[i];
		return p;
	}

	$effect(() => {
		void [data, detail, width, height, currentTime, selection?.start, selection?.end, regions, marks, hoverX, view, theme.version];
		draw();
	});

	function hatch(ctx: CanvasRenderingContext2D, p: Palette, x0: number, x1: number, alpha: number) {
		ctx.save();
		ctx.beginPath();
		ctx.rect(x0, 0, x1 - x0, height);
		ctx.clip();
		ctx.strokeStyle = p.fade(p.ink, alpha);
		ctx.lineWidth = 1;
		for (let k = x0 - height; k < x1; k += 6) {
			ctx.beginPath();
			ctx.moveTo(k, height);
			ctx.lineTo(k + height, 0);
			ctx.stroke();
		}
		ctx.restore();
	}

	function draw() {
		if (!canvas || width === 0) return;
		const dpr = window.devicePixelRatio || 1;
		canvas.width = width * dpr;
		canvas.height = height * dpr;
		const ctx = canvas.getContext('2d')!;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		const p = palette(canvas);
		const { ink, accent, wash, onAccent, fade } = p;
		const mid = height / 2;
		const visible = (r: Region) => r.end > view.start && r.start < view.end;

		ctx.clearRect(0, 0, width, height);

		for (const r of regions) {
			if (!visible(r)) continue;
			if (r.kind === 'outside') ctx.fillStyle = wash;
			else if (r.kind === 'keep') ctx.fillStyle = fade(accent, 0.13);
			else continue;
			ctx.fillRect(xOf(r.start), 0, xOf(r.end) - xOf(r.start), height);
		}

		if (selection && selection.end > selection.start) {
			ctx.fillStyle = accent;
			ctx.fillRect(xOf(selection.start), 0, xOf(selection.end) - xOf(selection.start), height);
		}

		if (data && D > 0) {
			const dim = (t: number) => regions.some((r) => (r.kind === 'cut' || r.kind === 'drop') && t >= r.start && t < r.end);
			// Over the selection the bars sit on the accent; same dark ink in both themes.
			const selected = (t: number) => !!selection && selection.end > selection.start && t >= selection.start && t < selection.end;
			for (let x = 0; x < width; x++) {
				const t0 = tOf(x);
				const t1 = tOf(x + 1);
				const h = Math.max(1, Math.pow(peakAt(t0, t1), 0.75) * (mid - 3));
				ctx.fillStyle = dim(t0) ? fade(ink, 0.22) : selected(t0) ? onAccent : ink;
				ctx.fillRect(x, mid - h, 1, h * 2);
			}
		} else {
			ctx.fillStyle = ink;
			ctx.fillRect(0, mid, width, 1);
		}

		for (const r of regions) {
			if (!visible(r)) continue;
			const x0 = Math.max(0, xOf(r.start));
			const x1 = Math.min(width, Math.max(x0 + 1, xOf(r.end)));
			if (r.kind === 'cut' || r.kind === 'drop') {
				hatch(ctx, p, x0, x1, r.kind === 'cut' ? 0.55 : 0.3);
				if (r.kind === 'cut') {
					ctx.fillStyle = ink;
					ctx.fillRect(x0, 0, x1 - x0, 3);
					ctx.fillRect(x0, height - 3, x1 - x0, 3);
				}
			}
			if (r.kind === 'focus') {
				ctx.strokeStyle = ink;
				ctx.lineWidth = 3;
				ctx.strokeRect(x0 + 1.5, 1.5, x1 - x0 - 3, height - 3);
			}
			if (r.id && (r.kind === 'keep' || r.kind === 'drop')) {
				// Edges you can grab.
				ctx.fillStyle = ink;
				for (const x of [xOf(r.start), xOf(r.end)]) {
					if (x < -2 || x > width + 2) continue;
					ctx.fillRect(Math.round(x) - 1, 0, 2, height);
				}
			}
			if (r.label && x1 - x0 > 22) {
				ctx.font = '600 10px JetBrains Mono, monospace';
				const w = ctx.measureText(r.label).width + 8;
				ctx.fillStyle = r.kind === 'drop' ? fade(ink, 0.45) : ink;
				ctx.fillRect(x0 + 2, 2, Math.min(w, x1 - x0 - 4), 15);
				ctx.fillStyle = r.kind === 'drop' ? p.bg : accent;
				ctx.fillText(r.label, x0 + 6, 13, x1 - x0 - 10);
			}
		}

		ctx.fillStyle = ink;
		for (const m of marks) {
			if (m < view.start || m > view.end) continue;
			const x = Math.round(xOf(m));
			ctx.fillRect(x - 1, 0, 2, height);
			ctx.fillRect(x - 4, 0, 8, 8);
		}

		if (selection && selection.end > selection.start) {
			for (const t of [selection.start, selection.end]) {
				const x = Math.round(xOf(t));
				ctx.fillRect(x - 1, 0, 2, height);
				ctx.fillRect(x - 5, mid - 10, 10, 20);
			}
		}

		if (hoverX != null) {
			ctx.fillStyle = fade(ink, 0.35);
			ctx.fillRect(hoverX, 0, 1, height);
		}

		if (currentTime >= view.start && currentTime <= view.end) {
			const px = Math.round(xOf(currentTime));
			ctx.fillStyle = ink;
			ctx.fillRect(px - 1, 0, 2, height);
			ctx.fillRect(px - 5, 0, 10, 5);
		}

		drawMini(p);
	}

	/* The overview strip: the whole file, with the visible window boxed. */
	function drawMini({ ink, accent, fade }: Palette) {
		if (!mini || !width || !zoomed || !data) return;
		const h = 22;
		const dpr = window.devicePixelRatio || 1;
		mini.width = width * dpr;
		mini.height = h * dpr;
		const ctx = mini.getContext('2d')!;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, h);
		const per = data.peaks.length / width;
		ctx.fillStyle = fade(ink, 0.45);
		for (let x = 0; x < width; x++) {
			let p = 0;
			for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) p = Math.max(p, data.peaks[i] ?? 0);
			const bh = Math.max(0.5, p * (h / 2 - 1));
			ctx.fillRect(x, h / 2 - bh, 1, bh * 2);
		}
		const x0 = (view.start / D) * width;
		const x1 = (view.end / D) * width;
		ctx.fillStyle = fade(accent, 0.35);
		ctx.fillRect(x0, 0, Math.max(2, x1 - x0), h);
		ctx.strokeStyle = ink;
		ctx.lineWidth = 1.5;
		ctx.strokeRect(x0 + 0.75, 0.75, Math.max(2, x1 - x0) - 1.5, h - 1.5);
		ctx.fillStyle = ink;
		ctx.fillRect((currentTime / D) * width, 0, 1, h);
	}

	/* ------------------------------------------------------------------
	 * Pointer: drag a region edge > drag a selection handle > drag out a
	 * new selection > click to seek (or pick the region under you).
	 * ---------------------------------------------------------------- */

	type Drag =
		| { mode: 'edge'; id: string; edge: 'start' | 'end'; x0: number; moved: boolean }
		| { mode: 'start' | 'end' | 'new'; anchor: number; x0: number; moved: boolean };
	let drag: Drag | null = null;

	function localX(e: PointerEvent | WheelEvent, el: HTMLElement = canvas!): number {
		const rect = el.getBoundingClientRect();
		return Math.min(width, Math.max(0, e.clientX - rect.left));
	}

	function edgeAt(x: number): { id: string; edge: 'start' | 'end' } | null {
		if (!onregionedge) return null;
		let best: { id: string; edge: 'start' | 'end'; d: number } | null = null;
		for (const r of regions) {
			if (!r.id || (r.kind !== 'keep' && r.kind !== 'drop')) continue;
			for (const edge of ['start', 'end'] as const) {
				const d = Math.abs(xOf(r[edge]) - x);
				if (d < 6 && (!best || d < best.d)) best = { id: r.id, edge, d };
			}
		}
		return best;
	}

	function onDown(e: PointerEvent) {
		if (!interactive || !canvas || D === 0) return;
		const x = localX(e);
		canvas.setPointerCapture(e.pointerId);
		const edge = edgeAt(x);
		if (edge) drag = { mode: 'edge', ...edge, x0: x, moved: false };
		else if (selection && Math.abs(x - xOf(selection.start)) < 8) drag = { mode: 'start', anchor: selection.end, x0: x, moved: false };
		else if (selection && Math.abs(x - xOf(selection.end)) < 8) drag = { mode: 'end', anchor: selection.start, x0: x, moved: false };
		else drag = { mode: 'new', anchor: tOf(x), x0: x, moved: false };
	}

	function onMove(e: PointerEvent) {
		if (!canvas) return;
		const x = localX(e);
		hoverX = x;
		canvas.style.cursor = !interactive ? 'default' : drag?.mode === 'edge' || edgeAt(x) ? 'ew-resize' : 'crosshair';
		if (!drag) return;
		if (Math.abs(x - drag.x0) > 3) drag.moved = true;
		if (!drag.moved) return;
		const t = tOf(x);
		if (drag.mode === 'edge') onregionedge?.(drag.id, drag.edge, t);
		else selection = { start: Math.min(t, drag.anchor), end: Math.max(t, drag.anchor) };
	}

	function onUp(e: PointerEvent) {
		if (!drag) return;
		if (!drag.moved) {
			const t = tOf(localX(e));
			const hit = regions.find((r) => r.id && r.kind !== 'focus' && t >= r.start && t < r.end);
			if (hit?.id) onregionclick?.(hit.id);
			onseek?.(t);
		}
		drag = null;
	}

	function onWheel(e: WheelEvent) {
		if (!interactive || D === 0) return;
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault();
			zoomAt(tOf(localX(e)), e.deltaY > 0 ? 1.25 : 0.8);
		} else if (zoomed && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
			e.preventDefault();
			const d = (e.shiftKey ? e.deltaY : e.deltaX) / width;
			setView(view.start + d * span, view.end + d * span);
		}
	}

	// Ctrl+wheel must be cancellable, which needs a non-passive listener.
	$effect(() => {
		if (!canvas) return;
		const c = canvas;
		c.addEventListener('wheel', onWheel, { passive: false });
		return () => c.removeEventListener('wheel', onWheel);
	});

	let miniDrag: { x0: number; start: number } | null = null;
	function miniDown(e: PointerEvent) {
		const x = localX(e, mini!);
		const t = (x / width) * D;
		if (t < view.start || t > view.end) setView(t - span / 2, t + span / 2);
		miniDrag = { x0: x, start: view.start };
		mini!.setPointerCapture(e.pointerId);
	}
	function miniMove(e: PointerEvent) {
		if (!miniDrag) return;
		const dt = ((localX(e, mini!) - miniDrag.x0) / width) * D;
		setView(miniDrag.start + dt, miniDrag.start + dt + span);
	}

	const ticks = $derived.by(() => {
		if (D <= 0 || width === 0) return [];
		const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
		const step = steps.find((s) => span / s <= width / 90) ?? 3600;
		const out: number[] = [];
		for (let t = Math.ceil(view.start / step) * step; t <= view.end; t += step) out.push(t);
		return out;
	});

	const tickLabel = (t: number) => {
		const s = formatTimecode(t);
		return span < 20 ? s : s.replace(/\.0$/, '');
	};
</script>

<div class="wave" bind:this={wrap}>
	<div class="wave__box" style:height="{height}px">
		<canvas bind:this={canvas} onpointerdown={onDown} onpointermove={onMove} onpointerup={onUp} onpointerleave={() => (hoverX = null)}></canvas>
	</div>
	{#if failed}
		<div class="wave__note caps muted">{failed}</div>
	{:else if !data}
		<div class="wave__note caps muted">Reading waveform…</div>
	{/if}
	{#if hoverX != null && interactive && D > 0}
		<div class="wave__hover mono" style:left="{hoverX}px">{formatTimecode(tOf(hoverX))}</div>
	{/if}
	{#if interactive}
		<div class="wave__ruler mono" aria-hidden="true">
			{#each ticks as t (t)}
				<span style:left="{xOf(t)}px">{tickLabel(t)}</span>
			{/each}
		</div>
		{#if zoomed}
			<canvas class="wave__mini" bind:this={mini} onpointerdown={miniDown} onpointermove={miniMove} onpointerup={() => (miniDrag = null)}></canvas>
		{/if}
		<div class="wave__zoom">
			<button type="button" class="btn-ghost btn-icon" onclick={() => zoomAt(currentTime >= view.start && currentTime <= view.end ? currentTime : (view.start + view.end) / 2, 1.6)} disabled={!zoomed} aria-label="Zoom out">−</button>
			<button type="button" class="btn-ghost btn-icon" onclick={() => zoomAt(currentTime >= view.start && currentTime <= view.end ? currentTime : (view.start + view.end) / 2, 0.5)} aria-label="Zoom in">+</button>
			<button type="button" class="btn-ghost btn-icon" onclick={() => setView(0, D)} disabled={!zoomed}>Fit</button>
			<button type="button" class="btn-ghost btn-icon" onclick={zoomToSelection} disabled={!selection}>Sel</button>
			<span class="mono muted">{zoomed ? `${formatTimecode(view.start)} – ${formatTimecode(view.end)}` : 'whole file'} · Ctrl+wheel zoom · Shift+wheel scroll</span>
		</div>
	{/if}
</div>

<style>
	.wave {
		position: relative;
		min-width: 0;
		border-block: 1.5px solid var(--ink);
		user-select: none;
		touch-action: none;
	}

	/* The bitmap is width × devicePixelRatio. Positioned absolutely so that
	 * intrinsic size never feeds back into the layout it was measured from
	 * (on a 3x phone it would otherwise push the column off-screen). */
	.wave__box {
		position: relative;
	}

	.wave__box canvas {
		position: absolute;
		inset: 0;
		inline-size: 100%;
		block-size: 100%;
	}

	.wave__note {
		position: absolute;
		inset: 0 0 auto 0;
		padding: 0.5rem 0.75rem;
		pointer-events: none;
	}

	.wave__hover {
		position: absolute;
		top: 0;
		transform: translateX(-50%);
		background: var(--ink);
		color: var(--bg);
		font-size: 0.7rem;
		padding: 0.1rem 0.35rem;
		pointer-events: none;
		white-space: nowrap;
	}

	.wave__ruler {
		position: relative;
		block-size: 1.4rem;
		border-block-start: 1px solid var(--ink);
		font-size: 0.68rem;
		color: var(--muted);
		overflow: hidden;
	}

	.wave__ruler span {
		position: absolute;
		top: 0.2rem;
		padding-inline-start: 0.25rem;
		border-inline-start: 1px solid var(--ink);
		line-height: 1;
		padding-block-end: 0.3rem;
	}

	.wave__mini {
		display: block;
		inline-size: 100%;
		block-size: 22px;
		border-block-start: 1px solid var(--ink);
		cursor: grab;
	}

	.wave__zoom {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem;
		padding-block: 0.35rem;
		border-block-start: 1px solid var(--ink);
		font-size: 0.68rem;
	}

	.wave__zoom .btn-icon {
		padding: 0.2rem 0.5rem;
	}
</style>

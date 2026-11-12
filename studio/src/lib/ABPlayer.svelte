<script lang="ts">
	import { formatTimecode } from '$lib/media';
	import type { PreviewResult, PreviewSide } from '$lib/jobs';
	import { palette, theme } from '$lib/theme.svelte';

	let { preview }: { preview: PreviewResult } = $props();

	const isAudio = $derived(preview.a.type === 'audio' && preview.b.type === 'audio');

	let side = $state<'a' | 'b'>('b');
	let playing = $state(false);
	let loop = $state(true);
	let position = $state(0);
	let loading = $state(true);
	let failed = $state<string | null>(null);

	/* ------------------------------------------------------------------
	 * Audio: both versions decoded into memory and started on the same
	 * AudioContext clock, each through its own gain. Switching A/B is a
	 * 20 ms crossfade between gains — sample-synchronous, no gap, no
	 * reload. This is how mastering engineers compare.
	 * ---------------------------------------------------------------- */

	let ctx: AudioContext | null = null;
	let buffers = $state<{ a: AudioBuffer; b: AudioBuffer } | null>(null);
	let nodes: { src: AudioBufferSourceNode[]; gains: Record<'a' | 'b', GainNode> } | null = null;
	let startedAt = 0;
	let offset = 0;
	let raf = 0;

	const duration = $derived(buffers ? Math.max(buffers.a.duration, buffers.b.duration) : (preview.b.duration ?? 0));

	$effect(() => {
		if (!isAudio) {
			loading = false;
			return;
		}
		const { a, b } = preview;
		let alive = true;
		loading = true;
		failed = null;
		ctx ??= new AudioContext();
		const decode = async (s: PreviewSide) => ctx!.decodeAudioData(await (await fetch(s.url)).arrayBuffer());
		Promise.all([decode(a), decode(b)])
			.then(([ba, bb]) => {
				if (alive) buffers = { a: ba, b: bb };
			})
			.catch((e) => alive && (failed = e instanceof Error ? e.message : String(e)))
			.finally(() => alive && (loading = false));
		return () => {
			alive = false;
			stop();
			buffers = null;
		};
	});

	function stop() {
		if (nodes) {
			for (const s of nodes.src) {
				try {
					s.stop();
				} catch {
					// already stopped
				}
			}
			nodes = null;
		}
		cancelAnimationFrame(raf);
		playing = false;
	}

	function play(from = position) {
		if (!ctx || !buffers) return;
		stop();
		ctx.resume();
		const gains = { a: ctx.createGain(), b: ctx.createGain() };
		gains.a.gain.value = side === 'a' ? 1 : 0;
		gains.b.gain.value = side === 'b' ? 1 : 0;
		const src = (['a', 'b'] as const).map((k) => {
			const s = ctx!.createBufferSource();
			s.buffer = buffers![k];
			s.loop = loop;
			s.connect(gains[k]).connect(ctx!.destination);
			s.start(0, Math.min(from, buffers![k].duration - 0.01));
			return s;
		});
		src[1].onended = () => {
			if (!loop && nodes?.src === src) {
				stop();
				position = 0;
			}
		};
		nodes = { src, gains };
		startedAt = ctx.currentTime;
		offset = from;
		playing = true;
		const tick = () => {
			if (!ctx || !playing) return;
			const t = offset + ctx.currentTime - startedAt;
			position = loop && duration ? t % duration : Math.min(t, duration);
			raf = requestAnimationFrame(tick);
		};
		tick();
	}

	function choose(next: 'a' | 'b') {
		side = next;
		if (isAudio && nodes && ctx) {
			const t = ctx.currentTime;
			nodes.gains.a.gain.setTargetAtTime(next === 'a' ? 1 : 0, t, 0.006);
			nodes.gains.b.gain.setTargetAtTime(next === 'b' ? 1 : 0, t, 0.006);
		}
		if (!isAudio) syncVideoAudio();
	}

	function toggle() {
		if (isAudio) {
			if (playing) stop();
			else play();
		} else {
			if (playing) vb?.pause();
			else vb?.play();
		}
	}

	function seekTo(t: number) {
		position = Math.max(0, Math.min(duration, t));
		if (isAudio) {
			if (playing) play(position);
		} else if (va && vb) {
			va.currentTime = position;
			vb.currentTime = position;
		}
	}

	/* ------------------------------------------------------------------
	 * Video: two linked players. B is the master clock; A follows it and
	 * is nudged back whenever it drifts more than a frame or two. Only the
	 * chosen side is audible.
	 * ---------------------------------------------------------------- */

	let va = $state<HTMLVideoElement | null>(null);
	let vb = $state<HTMLVideoElement | null>(null);
	let layout = $state<'side' | 'swap'>('side');

	function syncVideoAudio() {
		if (va) va.muted = side !== 'a';
		if (vb) vb.muted = side !== 'b';
	}

	function onVideoTime() {
		if (!vb) return;
		position = vb.currentTime;
		if (va && preview.timing === 'same' && Math.abs(va.currentTime - vb.currentTime) > 0.08) va.currentTime = vb.currentTime;
	}

	$effect(() => {
		if (isAudio || !vb) return;
		const v = vb;
		const onPlay = () => {
			playing = true;
			va?.play().catch(() => {});
		};
		const onPause = () => {
			playing = false;
			va?.pause();
		};
		v.addEventListener('play', onPlay);
		v.addEventListener('pause', onPause);
		syncVideoAudio();
		return () => {
			v.removeEventListener('play', onPlay);
			v.removeEventListener('pause', onPause);
		};
	});

	/* ------------------------------------------------------------------
	 * Twin waveforms, straight from the decoded buffers.
	 * ---------------------------------------------------------------- */

	let canvas = $state<HTMLCanvasElement | null>(null);
	let width = $state(0);

	function peaks(buf: AudioBuffer, cols: number): Float32Array {
		const out = new Float32Array(cols);
		const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
		const per = Math.max(1, Math.floor(buf.length / cols));
		for (let c = 0; c < cols; c++) {
			let m = 0;
			const end = Math.min(buf.length, (c + 1) * per);
			for (let i = c * per; i < end; i += 4) for (const ch of chans) m = Math.max(m, Math.abs(ch[i]));
			out[c] = m;
		}
		return out;
	}

	// Peaks once per buffer/size; the effect below redraws every frame.
	const peaksA = $derived(buffers && width ? peaks(buffers.a, width) : null);
	const peaksB = $derived(buffers && width ? peaks(buffers.b, width) : null);

	$effect(() => {
		void [position, side, theme.version];
		if (!canvas || !buffers || !width || !peaksA || !peaksB) return;
		const dpr = devicePixelRatio || 1;
		const H = 120;
		canvas.width = width * dpr;
		canvas.height = H * dpr;
		const g = canvas.getContext('2d')!;
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		const { ink, accent, onAccent, fade } = palette(canvas);
		g.clearRect(0, 0, width, H);
		const lane = (buf: AudioBuffer, p: Float32Array, y0: number, h: number, active: boolean) => {
			if (active) {
				g.fillStyle = accent;
				g.fillRect(0, y0, width, h);
			}
			const scale = buf.duration / duration;
			// The side you're hearing is filled with the accent; its bars sit on it.
			g.fillStyle = active ? onAccent : fade(ink, 0.35);
			for (let x = 0; x < width * scale; x++) {
				const v = p[Math.min(p.length - 1, Math.floor(x / scale))];
				const h2 = Math.max(0.5, Math.pow(v, 0.75) * (h / 2 - 2));
				g.fillRect(x, y0 + h / 2 - h2, 1, h2 * 2);
			}
		};
		lane(buffers.a, peaksA, 0, H / 2 - 1, side === 'a');
		lane(buffers.b, peaksB, H / 2 + 1, H / 2 - 1, side === 'b');
		g.fillStyle = ink;
		g.fillRect(0, H / 2 - 1, width, 2);
		const px = duration ? (position / duration) * width : 0;
		g.fillRect(px - 1, 0, 2, H);
	});

	$effect(() => {
		if (!canvas) return;
		const ro = new ResizeObserver(([e]) => (width = Math.floor(e.contentRect.width)));
		ro.observe(canvas.parentElement!);
		return () => ro.disconnect();
	});

	function onKey(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
		const k = e.key.toLowerCase();
		if (k === 'a') choose('a');
		else if (k === 'b') choose('b');
		else if (k === 'x') choose(side === 'a' ? 'b' : 'a');
	}

	function fmtLoud(s: PreviewSide): string {
		if (!s.loudness || s.loudness.lufs == null) return '—';
		return `${s.loudness.lufs.toFixed(1)} LUFS · ${s.loudness.truePeak?.toFixed(1) ?? '?'} dBTP`;
	}

	const delta = $derived(
		preview.a.loudness?.lufs != null && preview.b.loudness?.lufs != null ? preview.b.loudness.lufs - preview.a.loudness.lufs : null,
	);
</script>

<svelte:window onkeydown={onKey} />

<div class="ab stack-tight">
	{#if isAudio}
		<div class="ab__wave" role="presentation">
			<canvas
				bind:this={canvas}
				onpointerdown={(e) => {
					const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
					seekTo(((e.clientX - r.left) / r.width) * duration);
				}}
			></canvas>
			<span class="ab__lane tag" style="top: 0.3rem;">A · before</span>
			<span class="ab__lane tag" style="top: calc(50% + 0.3rem);">B · after</span>
			{#if loading}<div class="ab__note caps">Decoding…</div>{/if}
		</div>
	{:else}
		<div class="seg" role="group" aria-label="Layout">
			<button type="button" aria-pressed={layout === 'side'} onclick={() => (layout = 'side')}>Side by side</button>
			<button type="button" aria-pressed={layout === 'swap'} onclick={() => (layout = 'swap')}>Swap in place</button>
		</div>
		<div class="ab__videos" class:is-swap={layout === 'swap'}>
			<figure class:is-hidden={layout === 'swap' && side !== 'a'}>
				{#if preview.a.type === 'video'}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video bind:this={va} class="screen" src={preview.a.url} preload="auto" muted playsinline loop={loop}></video>
				{:else}
					<audio src={preview.a.url}></audio>
				{/if}
				<figcaption class="caps">A · before</figcaption>
			</figure>
			<figure class:is-hidden={layout === 'swap' && side !== 'b'}>
				{#if preview.b.type === 'image'}
					<img class="screen" src={preview.b.url} alt="Processed preview" />
				{:else}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video bind:this={vb} class="screen" src={preview.b.url} preload="auto" playsinline loop={loop} ontimeupdate={onVideoTime}></video>
				{/if}
				<figcaption class="caps">B · after</figcaption>
			</figure>
		</div>
	{/if}

	{#if failed}
		<div class="error"><strong class="caps">Can't play preview</strong><div class="mono">{failed}</div></div>
	{/if}

	<div class="row spread" style="gap: 0.75rem;">
		<div class="row" style="gap: 0.5rem;">
			<button type="button" class="btn-small" onclick={toggle} disabled={isAudio && !buffers}>{playing ? 'Pause' : 'Play'}</button>
			<div class="seg" role="group" aria-label="Listen to">
				<button type="button" aria-pressed={side === 'a'} onclick={() => choose('a')}>A · before</button>
				<button type="button" aria-pressed={side === 'b'} onclick={() => choose('b')}>B · after</button>
			</div>
			<label class="field-check"><input type="checkbox" bind:checked={loop} /> Loop</label>
		</div>
		<span class="mono">{formatTimecode(position)} / {formatTimecode(duration)}</span>
	</div>
	<div class="help"><kbd>A</kbd>/<kbd>B</kbd> pick a side · <kbd>X</kbd> flips — switching is instant and in sync.</div>

	{#if preview.a.loudness || preview.b.loudness}
		<table class="ab__meter">
			<tbody>
				<tr><th>A</th><td class="mono">{fmtLoud(preview.a)}</td></tr>
				<tr>
					<th>B</th>
					<td class="mono">
						{fmtLoud(preview.b)}
						{#if delta != null}
							<span class="tag tag-accent" style="margin-inline-start: 0.5rem;">{delta >= 0 ? '+' : ''}{delta.toFixed(1)} LU</span>
						{/if}
					</td>
				</tr>
			</tbody>
		</table>
	{/if}
	{#if preview.timing === 'changed'}
		<div class="help">B is a different length (it changes timing), so A and B line up by position, not by moment.</div>
	{/if}
	{#each preview.notes as n (n)}
		<div class="help" style="color: var(--ink);"><span class="tag tag-accent">!</span> {n}</div>
	{/each}
</div>

<style>
	.ab__wave {
		position: relative;
		block-size: 120px;
		border: 1.5px solid var(--ink);
		cursor: pointer;
	}

	.ab__wave canvas {
		position: absolute;
		inset: 0;
		inline-size: 100%;
		block-size: 100%;
	}

	.ab__lane {
		position: absolute;
		left: 0.3rem;
		pointer-events: none;
	}

	.ab__note {
		position: absolute;
		inset: auto 0.5rem 0.4rem auto;
	}

	.ab__videos {
		display: grid;
		gap: 0.75rem;
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.ab__videos.is-swap {
		grid-template-columns: minmax(0, 1fr);
	}

	figure {
		margin: 0;
		display: grid;
		gap: 0.3rem;
	}

	figure.is-hidden {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		opacity: 0;
	}

	.ab__meter th {
		inline-size: 2rem;
		border-block-end-width: 1px;
	}

	.ab__meter tr:hover td {
		background: none;
	}
</style>

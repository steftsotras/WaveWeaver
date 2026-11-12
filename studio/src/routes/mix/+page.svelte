<script lang="ts">
	import type { PageData } from './$types';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import JobPanel from '$lib/JobPanel.svelte';
	import PreviewPanel from '$lib/PreviewPanel.svelte';
	import Range from '$lib/Range.svelte';
	import Waveform from '$lib/Waveform.svelte';
	import { formatDuration, formatTimecode, peaksUrl, refKey, type MediaFile } from '$lib/media';
	import { DEFAULT_DUCK, trackId, type Ducking, type MixTrack, type TrackRole } from '$lib/mix';

	let { data }: { data: PageData } = $props();
	const jobId = $derived(page.url.searchParams.get('job'));

	let tracks = $state<MixTrack[]>([]);
	let duck = $state<Ducking>({ ...DEFAULT_DUCK });
	let master = $state<string>('');
	let format = $state<'mp3' | 'wav' | 'flac' | 'm4a' | 'mp4'>('mp3');
	let videoFrom = $state<string>('');

	// The mix in progress survives a reload (browser storage, this viewer only).
	let restored = false;
	$effect(() => {
		if (restored) return;
		restored = true;
		try {
			const s = JSON.parse(localStorage.getItem('ww:mix') ?? 'null');
			if (s?.tracks) {
				const known = new Set(data.files.map(refKey));
				tracks = s.tracks.filter((t: MixTrack) => known.has(refKey(t.ref)));
				duck = s.duck ?? duck;
				master = s.master ?? '';
				format = s.format ?? format;
			}
		} catch {
			// storage unavailable: start empty
		}
	});
	$effect(() => {
		const snap = JSON.stringify({ tracks: $state.snapshot(tracks), duck: $state.snapshot(duck), master, format });
		try {
			localStorage.setItem('ww:mix', snap);
		} catch {
			// ignore
		}
	});

	const fileFor = (t: MixTrack) => data.files.find((f) => refKey(f) === refKey(t.ref));
	const durOf = (t: MixTrack) => fileFor(t)?.info?.duration ?? 0;
	const total = $derived(Math.max(1, ...tracks.map((t) => t.offset + durOf(t))));

	function add(f: MediaFile) {
		const role: TrackRole = tracks.length === 0 ? 'voice' : /music|song|bed|beat/i.test(f.name) ? 'music' : 'voice';
		tracks = [
			...tracks,
			{ id: trackId(), ref: { bin: f.bin, kind: f.kind, name: f.name }, role, gainDb: role === 'music' ? -8 : 0, pan: 0, offset: 0, fadeIn: role === 'music' ? 1 : 0, fadeOut: role === 'music' ? 2 : 0, mute: false, solo: false },
		];
	}

	/* Timeline: drag a clip sideways to move it in time. */
	let lane = $state<HTMLElement | null>(null);
	let drag: { id: string; x0: number; off0: number } | null = null;

	function onDown(e: PointerEvent, t: MixTrack) {
		drag = { id: t.id, x0: e.clientX, off0: t.offset };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function onMove(e: PointerEvent) {
		if (!drag || !lane) return;
		const t = tracks.find((x) => x.id === drag!.id);
		if (!t) return;
		const secPerPx = total / lane.clientWidth;
		t.offset = Math.max(0, Math.round((drag.off0 + (e.clientX - drag.x0) * secPerPx) * 10) / 10);
	}

	let previewStart = $state(0);
	let previewLen = $state(20);
	let previewJob = $state<string | null>(null);
	let submitting = $state(false);

	function body() {
		return {
			tracks: $state.snapshot(tracks),
			duck: $state.snapshot(duck),
			master: master || null,
			format,
			videoFrom: videoFrom || null,
		};
	}

	async function post(url: string, b: Record<string, unknown>) {
		const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
		const json = await res.json().catch(() => ({}));
		if (!res.ok) {
			alert(`Failed: ${json.message ?? res.statusText}`);
			return null;
		}
		return json.id as string;
	}

	async function preview() {
		if (previewJob) fetch(`/api/jobs/${previewJob}`, { method: 'DELETE' }).catch(() => {});
		previewJob = await post('/api/preview', { kind: 'mix', ...body(), window: { start: previewStart, duration: previewLen } });
	}

	async function render() {
		submitting = true;
		try {
			const id = await post('/api/jobs', { kind: 'mix', ...body() });
			if (id) goto(`/mix?job=${id}`, { keepFocus: true, noScroll: true });
		} finally {
			submitting = false;
		}
	}

	let filter = $state('');
	const available = $derived(data.files.filter((f) => !filter || f.name.toLowerCase().includes(filter.toLowerCase())));
	const ticks = $derived.by(() => {
		const step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => total / s <= 10) ?? 600;
		return Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step);
	});
</script>

<section class="hero">
	<h1>Mix</h1>
	<p class="muted">Voice, music and effects on one timeline. Music ducks under the voice automatically; a mastering preset finishes it.</p>
</section>

<section class="split">
	<div class="stack">
		<div class="panel-title">
			<h3>Timeline</h3>
			<span class="caps muted">{tracks.length} tracks · {formatDuration(total)}</span>
		</div>

		{#if tracks.length === 0}
			<div class="logs logs-empty">Add tracks from the list below. Drag them on the timeline to line them up.</div>
		{:else}
			<div class="timeline" bind:this={lane}>
				<div class="ruler mono">
					{#each ticks as t (t)}<span style:left="{(t / total) * 100}%">{formatTimecode(t).replace(/\.0$/, '')}</span>{/each}
				</div>
				{#each tracks as t (t.id)}
					<div class="lane" class:is-muted={t.mute || (tracks.some((x) => x.solo) && !t.solo)}>
						<div
							class="clip role-{t.role}"
							style:left="{(t.offset / total) * 100}%"
							style:width="{(durOf(t) / total) * 100}%"
							role="slider"
							tabindex="0"
							aria-label="{t.ref.name} offset"
							aria-valuenow={t.offset}
							onpointerdown={(e) => onDown(e, t)}
							onpointermove={onMove}
							onpointerup={() => (drag = null)}
							onkeydown={(e) => {
								if (e.key === 'ArrowRight') t.offset = Math.round((t.offset + 0.1) * 10) / 10;
								if (e.key === 'ArrowLeft') t.offset = Math.max(0, Math.round((t.offset - 0.1) * 10) / 10);
							}}
						>
							<Waveform src={peaksUrl(t.ref)} duration={durOf(t)} interactive={false} height={44} />
							<span class="clip__name caps">{t.role} · {t.ref.name}</span>
						</div>
					</div>
				{/each}
			</div>

			{#each tracks as t, i (t.id)}
				<div class="step">
					<div class="step__head">
						<span class="step__index">{String(i + 1).padStart(2, '0')}</span>
						<span class="step__title" style="text-transform: none; letter-spacing: 0;">{t.ref.name}</span>
						<div class="seg">
							{#each ['voice', 'music', 'fx'] as const as r (r)}
								<button type="button" aria-pressed={t.role === r} onclick={() => (t.role = r)}>{r}</button>
							{/each}
						</div>
						<button type="button" class="btn-icon" class:btn-primary={t.solo} class:btn-ghost={!t.solo} onclick={() => (t.solo = !t.solo)} title="Solo">S</button>
						<button type="button" class="btn-icon" class:btn-primary={t.mute} class:btn-ghost={!t.mute} onclick={() => (t.mute = !t.mute)} title="Mute">M</button>
						<button type="button" class="btn-icon" onclick={() => (tracks = tracks.filter((x) => x.id !== t.id))} aria-label="Remove">✕</button>
					</div>
					<div class="step__body">
						<div class="grid-2">
							<Range label="Gain" bind:value={t.gainDb} min={-40} max={12} step={0.5} format={(v) => `${v > 0 ? '+' : ''}${v} dB`} />
							<Range label="Pan" bind:value={t.pan} min={-1} max={1} step={0.05} format={(v) => (v === 0 ? 'centre' : v < 0 ? `L ${Math.round(-v * 100)}` : `R ${Math.round(v * 100)}`)} />
							<Range label="Starts at" bind:value={t.offset} min={0} max={Math.max(60, total)} step={0.1} format={(v) => formatTimecode(v)} />
							<Range label="Fade in" bind:value={t.fadeIn} min={0} max={10} step={0.1} format={(v) => `${v.toFixed(1)} s`} />
							<Range label="Fade out" bind:value={t.fadeOut} min={0} max={10} step={0.1} format={(v) => `${v.toFixed(1)} s`} />
						</div>
					</div>
				</div>
			{/each}
		{/if}

		<div class="stack-tight">
			<h4 class="caps" style="font-size: var(--fs-small);">Ducking</h4>
			<label class="field-check"><input type="checkbox" bind:checked={duck.on} /> Music dips while someone talks</label>
			{#if duck.on}
				<div class="grid-3">
					<Range label="Depth" bind:value={duck.depthDb} min={-30} max={-3} step={1} format={(v) => `${v} dB`} />
					<Range label="Attack" bind:value={duck.attackMs} min={5} max={500} step={5} format={(v) => `${v} ms`} />
					<Range label="Release" bind:value={duck.releaseMs} min={50} max={3000} step={50} format={(v) => `${v} ms`} />
				</div>
				<div class="help">Sidechain compression: the voice tracks key a compressor on the music tracks. FX tracks never duck.</div>
			{/if}
		</div>

		<div class="stack-tight">
			<h4 class="caps" style="font-size: var(--fs-small);">Master &amp; output</h4>
			<select class="input-small" bind:value={master} aria-label="Mastering preset">
				<option value="">No mastering</option>
				{#each data.presets as p (p.id)}<option value={p.id}>{p.name}{p.target ? ` · ${p.target}` : ''}</option>{/each}
			</select>
			<div class="seg">
				{#each ['mp3', 'm4a', 'wav', 'flac', 'mp4'] as const as f (f)}
					<button type="button" aria-pressed={format === f} onclick={() => (format = f)}>{f}</button>
				{/each}
			</div>
			{#if format === 'mp4'}
				<select class="input-small" bind:value={videoFrom} aria-label="Picture from">
					<option value="">Picture: accent waveform</option>
					{#each tracks.filter((t) => fileFor(t)?.info?.video) as t (t.id)}<option value={t.id}>Picture: {t.ref.name}</option>{/each}
				</select>
			{/if}
		</div>

		<div class="stack-tight">
			<Range label="Preview from" bind:value={previewStart} min={0} max={Math.max(0, total - 1)} step={0.5} format={(v) => formatTimecode(v)} />
			<div class="row" style="gap: 0.5rem;">
				<button type="button" class="btn" disabled={!tracks.length} onclick={preview}>Preview {Math.round(previewLen)}s</button>
				<div class="seg">
					{#each [10, 20, 30] as n (n)}<button type="button" aria-pressed={previewLen === n} onclick={() => (previewLen = n)}>{n}s</button>{/each}
				</div>
				<button type="button" class="btn-primary" disabled={!tracks.length || submitting} onclick={render}>Render mix</button>
			</div>
			<div class="help">A is the plain sum of your tracks; B is ducked and mastered, exactly as it will render.</div>
		</div>

		<hr class="rule" />
		<div class="panel-title">
			<h3>Add tracks</h3>
			<input type="search" class="input-small" placeholder="FILTER…" bind:value={filter} style="max-width: 16rem;" />
		</div>
		<div class="table-wrap" style="max-height: 24rem; overflow-y: auto;">
			<table>
				<tbody>
					{#each available as f (refKey(f))}
						<tr>
							<td style="inline-size: 5rem;"><span class="tag" class:tag-accent={f.kind === 'renders'}>{f.kind === 'renders' ? 'render' : f.type}</span></td>
							<td style="word-break: break-word;">{f.bin} / {f.name}</td>
							<td class="num">{formatDuration(f.info?.duration)}</td>
							<td><button type="button" class="btn-small" onclick={() => add(f)}>+ Add</button></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>

	<div class="sticky stack">
		{#if previewJob}
			<PreviewPanel jobId={previewJob} onapply={render} applyLabel="Render the whole mix" onclose={() => (previewJob = null)} />
		{/if}
		<JobPanel {jobId} empty="Build a mix and render it." ondone={() => invalidateAll()} />
	</div>
</section>

<style>
	.timeline {
		position: relative;
		border: 1.5px solid var(--ink);
		padding-block-start: 1.6rem;
		user-select: none;
	}

	.ruler {
		position: absolute;
		inset: 0 0 auto 0;
		block-size: 1.4rem;
		border-block-end: 1px solid var(--ink);
		font-size: 0.68rem;
		color: var(--muted);
	}

	.ruler span {
		position: absolute;
		top: 0.2rem;
		padding-inline-start: 0.2rem;
		border-inline-start: 1px solid var(--ink);
	}

	.lane {
		position: relative;
		block-size: 52px;
		border-block-end: 1px solid color-mix(in oklab, var(--ink) 15%, transparent);
	}

	.lane.is-muted {
		opacity: 0.35;
	}

	.clip {
		position: absolute;
		inset-block: 4px;
		min-inline-size: 6px;
		border: 1.5px solid var(--ink);
		background: var(--bg);
		cursor: grab;
		overflow: hidden;
	}

	.clip:active {
		cursor: grabbing;
	}

	.clip.role-voice {
		background: color-mix(in oklab, var(--accent) 35%, var(--bg));
	}

	.clip.role-fx {
		background: var(--wash);
	}

	.clip :global(.wave) {
		border: 0;
		pointer-events: none;
	}

	.clip__name {
		position: absolute;
		inset: 0 auto auto 0.3rem;
		font-size: 0.6rem;
		background: var(--ink);
		color: var(--bg);
		padding: 0 0.3rem;
		pointer-events: none;
		white-space: nowrap;
	}

	.grid-3 {
		display: grid;
		gap: 1rem;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
	}
</style>

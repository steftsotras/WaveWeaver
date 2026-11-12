<script lang="ts">
	import type { PageData } from './$types';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import JobPanel from '$lib/JobPanel.svelte';
	import Range from '$lib/Range.svelte';
	import { formatDuration, formatResolution, refKey, type MediaFile } from '$lib/media';
	import { ASPECTS, AUDIO_FORMATS, QUALITIES, type Quality } from '$lib/weave';

	let { data }: { data: PageData } = $props();

	const TRANSITIONS = ['fade', 'dissolve', 'wipeleft', 'slideleft', 'circleopen', 'pixelize'];
	const FORMATS = ['mp4', 'webm', ...AUDIO_FORMATS];

	let sequence = $state<MediaFile[]>([]);
	let opts = $state({
		crossfade: 0,
		transition: 'fade',
		canvas: 'auto',
		fit: 'pad' as 'pad' | 'crop',
		format: 'mp4',
		quality: 'standard' as Quality,
	});
	let filter = $state('');
	let activeBin = $state('all');
	let submitting = $state(false);
	const jobId = $derived(page.url.searchParams.get('job'));

	const available = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		return data.files.filter((f) => (activeBin === 'all' || f.bin === activeBin) && (!q || f.name.toLowerCase().includes(q)));
	});

	const total = $derived(
		sequence.reduce((s, f) => s + (f.info?.duration ?? 0), 0) - Math.max(0, sequence.length - 1) * opts.crossfade,
	);

	function move(i: number, dir: -1 | 1) {
		const j = i + dir;
		if (j < 0 || j >= sequence.length) return;
		const next = [...sequence];
		[next[i], next[j]] = [next[j], next[i]];
		sequence = next;
	}

	let plan = $state<{ duration: number; width: number | null; height: number | null } | null>(null);
	let planError = $state<string | null>(null);
	let timer: ReturnType<typeof setTimeout> | null = null;

	function body(): Record<string, unknown> {
		return {
			kind: 'stitch',
			sources: sequence.map((f) => ({ bin: f.bin, kind: f.kind, name: f.name })),
			...$state.snapshot(opts),
		};
	}

	$effect(() => {
		const b = JSON.stringify(body());
		if (sequence.length < 2) {
			plan = null;
			planError = null;
			return;
		}
		if (timer) clearTimeout(timer);
		timer = setTimeout(async () => {
			const res = await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b });
			const json = await res.json().catch(() => ({ error: 'Bad response' }));
			planError = !res.ok || json.error ? (json.error ?? json.message) : null;
			plan = planError ? null : json.plan;
		}, 250);
	});

	async function submit(e: Event) {
		e.preventDefault();
		submitting = true;
		try {
			const res = await fetch('/api/jobs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body()),
			});
			if (!res.ok) {
				alert(`Failed: ${(await res.json().catch(() => ({ message: 'error' }))).message}`);
				return;
			}
			const { id } = await res.json();
			goto(`/stitch?job=${id}`, { keepFocus: true, noScroll: true });
		} finally {
			submitting = false;
		}
	}
</script>

<section class="hero">
	<h1>Stitch</h1>
	<p class="muted">
		Clips in, one file out. Mix video and audio freely — anything missing a picture gets black, anything missing
		sound gets silence.
	</p>
</section>

<section class="split">
	<form class="stack" onsubmit={submit}>
		<div class="panel-title">
			<h3>Sequence</h3>
			<span class="caps muted">{sequence.length} clips · {formatDuration(total)}</span>
		</div>

		{#if sequence.length === 0}
			<div class="logs logs-empty">Add two or more clips from the list below. They play top to bottom.</div>
		{:else}
			<div class="stack-tight">
				{#each sequence as f, i (refKey(f) + i)}
					<div class="step">
						<div class="step__head" style="border: 0;">
							<span class="step__index">{String(i + 1).padStart(2, '0')}</span>
							<span class="step__title" style="text-transform: none; letter-spacing: 0; word-break: break-word;">{f.name}</span>
							<span class="mono muted">{formatDuration(f.info?.duration)}</span>
							<button type="button" class="btn-ghost btn-icon" onclick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
							<button type="button" class="btn-ghost btn-icon" onclick={() => move(i, 1)} disabled={i === sequence.length - 1} aria-label="Move down">↓</button>
							<button type="button" class="btn-icon" onclick={() => (sequence = sequence.filter((_, k) => k !== i))} aria-label="Remove">✕</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}

		<div class="stack-tight">
			<h4 class="caps" style="font-size: var(--fs-small);">Joins</h4>
			<Range
				label="Crossfade"
				bind:value={opts.crossfade}
				min={0}
				max={3}
				step={0.1}
				format={(v) => (v === 0 ? 'hard cut' : `${v.toFixed(1)} s`)}
			/>
			{#if opts.crossfade > 0}
				<div class="seg" role="group" aria-label="Transition">
					{#each TRANSITIONS as t (t)}
						<button type="button" aria-pressed={opts.transition === t} onclick={() => (opts.transition = t)}>{t}</button>
					{/each}
				</div>
			{/if}
		</div>

		<div class="stack-tight">
			<h4 class="caps" style="font-size: var(--fs-small);">Canvas</h4>
			<div class="seg" role="group" aria-label="Canvas">
				{#each ['auto', ...ASPECTS] as a (a)}
					<button type="button" aria-pressed={opts.canvas === a} onclick={() => (opts.canvas = a)}>{a}</button>
				{/each}
			</div>
			<div class="seg" role="group" aria-label="Fit">
				<button type="button" aria-pressed={opts.fit === 'pad'} onclick={() => (opts.fit = 'pad')}>Letterbox</button>
				<button type="button" aria-pressed={opts.fit === 'crop'} onclick={() => (opts.fit = 'crop')}>Crop to fill</button>
			</div>
			<div class="help">Auto uses the first clip's frame size. Everything is conformed to 30 fps, 48 kHz stereo.</div>
		</div>

		<div class="stack-tight">
			<h4 class="caps" style="font-size: var(--fs-small);">Output</h4>
			<div class="seg" role="group" aria-label="Format">
				{#each FORMATS as f (f)}
					<button type="button" aria-pressed={opts.format === f} onclick={() => (opts.format = f)}>{f}</button>
				{/each}
			</div>
			<div class="seg" role="group" aria-label="Quality">
				{#each QUALITIES as q (q)}
					<button type="button" aria-pressed={opts.quality === q} onclick={() => (opts.quality = q)}>{q}</button>
				{/each}
			</div>
		</div>

		{#if planError}
			<div class="error"><strong class="caps">Won't render</strong><div class="mono">{planError}</div></div>
		{:else if plan}
			<div class="stats" style="gap: 1rem 2.5rem;">
				<div>
					<div class="caps muted">Runtime</div>
					<div class="stat__value" style="font-size: var(--fs-3);"><mark>{formatDuration(plan.duration)}</mark></div>
				</div>
				<div>
					<div class="caps muted">Frame</div>
					<div class="stat__value" style="font-size: var(--fs-3);">{plan.width ? `${plan.width}×${plan.height}` : 'audio'}</div>
				</div>
			</div>
		{/if}

		<div>
			<button type="submit" class="btn-primary" disabled={submitting || sequence.length < 2 || Boolean(planError)}>
				{submitting ? 'Starting…' : `Stitch ${sequence.length || ''} clips`}
			</button>
		</div>

		<hr class="rule" />

		<div class="panel-title">
			<h3>Clips</h3>
			<input type="search" placeholder="FILTER..." bind:value={filter} class="input-small" style="max-width: 16rem;" />
		</div>
		<div class="row" style="gap: 0.5rem;">
			{#each ['all', ...data.bins] as b (b)}
				<button type="button" class="btn-small" class:btn-primary={activeBin === b} class:btn-ghost={activeBin !== b} onclick={() => (activeBin = b)}>{b}</button>
			{/each}
		</div>
		<div class="table-wrap" style="max-height: 28rem; overflow-y: auto;">
			<table>
				<tbody>
					{#each available as f (refKey(f))}
						<tr>
							<td style="inline-size: 5rem;"><span class="tag" class:tag-accent={f.kind === 'renders'}>{f.kind === 'renders' ? 'render' : f.type}</span></td>
							<td style="word-break: break-word;">{f.name}</td>
							<td class="num">{formatDuration(f.info?.duration)}</td>
							<td class="num muted">{formatResolution(f.info)}</td>
							<td><button type="button" class="btn-small" onclick={() => (sequence = [...sequence, f])}>+ Add</button></td>
						</tr>
					{:else}
						<tr><td class="help">No clips match.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</form>

	<div class="sticky">
		<JobPanel {jobId} empty="Build a sequence and stitch it." ondone={() => invalidateAll()} />
	</div>
</section>

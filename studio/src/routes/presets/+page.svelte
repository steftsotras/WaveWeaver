<script lang="ts">
	import type { PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import PreviewPanel from '$lib/PreviewPanel.svelte';
	import Range from '$lib/Range.svelte';
	import { deskUrl, formatTimecode, refKey } from '$lib/media';
	import { chainSummary, PRESET_GROUPS, presetSteps, type Preset } from '$lib/presets';
	import { defaultOutput } from '$lib/weave';

	let { data }: { data: PageData } = $props();

	let fileKey = $state('');
	let start = $state(0);
	let previewJob = $state<string | null>(null);
	let previewing = $state<Preset | null>(null);

	$effect(() => {
		if (!fileKey && data.files.length) fileKey = refKey(data.files.find((f) => /interview|voice|podcast/i.test(f.name)) ?? data.files[0]);
	});

	const file = $derived(data.files.find((f) => refKey(f) === fileKey) ?? null);
	const D = $derived(file?.info?.duration ?? 0);

	async function tryPreset(p: Preset) {
		if (!file) return;
		if (previewJob) fetch(`/api/jobs/${previewJob}`, { method: 'DELETE' }).catch(() => {});
		previewing = p;
		const res = await fetch('/api/preview', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				kind: 'weave',
				source: { bin: file.bin, kind: file.kind, name: file.name },
				steps: presetSteps(p),
				// Preview as audio so the A/B is sample-accurate.
				output: { ...defaultOutput(false), format: 'wav' },
				window: { start, duration: Math.min(20, Math.max(1, D - start)) },
			}),
		});
		const json = await res.json();
		if (!res.ok) {
			alert(`Preview failed: ${json.message}`);
			return;
		}
		previewJob = json.id;
	}

	async function remove(p: Preset) {
		if (!confirm(`Delete the recipe "${p.name}"? (media/presets/${p.id}.json)`)) return;
		await fetch(`/api/presets?id=${encodeURIComponent(p.id)}`, { method: 'DELETE' });
		invalidateAll();
	}
</script>

<section class="hero">
	<h1>Presets</h1>
	<p class="muted">
		Mastering and voice chains built from ordinary weave steps — EQ, de-ess, compressor, limiter, two-pass loudness. Try one
		on any file, hear it A/B, then take it to the Desk where every value stays editable.
	</p>
</section>

<section class="split">
	<div class="stack">
		{#each PRESET_GROUPS as g (g.group)}
			{@const list = data.presets.filter((p) => p.group === g.group)}
			{#if list.length}
				<div class="stack-tight">
					<h3>{g.label}</h3>
					<div class="cards">
						{#each list as p (p.id)}
							<article class="card" class:is-on={previewing?.id === p.id}>
								<div class="row spread" style="gap: 0.5rem;">
									<h4>{p.name}</h4>
									{#if p.target}<span class="tag tag-accent">{p.target}</span>{/if}
								</div>
								<p class="help" style="color: var(--ink);">{p.description || 'Your recipe.'}</p>
								<div class="mono muted chain">{chainSummary(p)}</div>
								<div class="row" style="gap: 0.4rem;">
									<button type="button" class="btn-small" disabled={!file} onclick={() => tryPreset(p)}>Try it</button>
									{#if file}
										<a class="btn btn-ghost btn-small" href="{deskUrl(file)}&preset={encodeURIComponent(p.id)}">Use on Desk</a>
									{/if}
									{#if !p.builtin}
										<button type="button" class="btn-ghost btn-small" onclick={() => remove(p)}>Delete</button>
									{/if}
								</div>
							</article>
						{/each}
					</div>
				</div>
			{/if}
		{/each}
		<p class="help">Save your own from the Desk with <strong>Save recipe</strong>. They're JSON files in <code>media/presets/</code>.</p>
	</div>

	<div class="sticky stack">
		<div class="stack-tight">
			<h3>Try on</h3>
			<select class="input-small" bind:value={fileKey} aria-label="File to try presets on">
				{#each data.files as f (refKey(f))}<option value={refKey(f)}>{f.bin} / {f.name}</option>{/each}
			</select>
			<Range label="From" bind:value={start} min={0} max={Math.max(0, D - 1)} step={0.5} format={(v) => formatTimecode(v)} help="20-second window. A is the original, B has the preset." />
		</div>
		{#if previewJob}
			<div class="caps">{previewing?.name}</div>
			<PreviewPanel jobId={previewJob} onclose={() => ((previewJob = null), (previewing = null))} />
		{:else}
			<div class="logs logs-empty">Pick a preset and press Try it.</div>
		{/if}
	</div>
</section>

<style>
	.cards {
		display: grid;
		gap: 1rem;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr));
	}

	.card {
		border: 1.5px solid var(--ink);
		padding: 1rem;
		display: grid;
		gap: 0.6rem;
		align-content: start;
	}

	.card.is-on {
		box-shadow: inset 0 0 0 3px var(--accent);
	}

	.card h4 {
		font-size: 1rem;
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
	}

	.chain {
		font-size: 0.72rem;
	}
</style>

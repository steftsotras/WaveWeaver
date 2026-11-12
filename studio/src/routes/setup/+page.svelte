<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount, untrack } from 'svelte';
	import JobPanel from '$lib/JobPanel.svelte';
	import type { ComponentId, DesktopBridge, SetupComponent, SetupStatus } from '$lib/setup';

	let { data } = $props();

	// Seeded once; after that the page re-reads /api/setup when an install ends.
	let status = $state<SetupStatus>(untrack(() => data.status));
	let jobId = $state<string | null>(untrack(() => data.status.jobId));
	let error = $state<string | null>(null);

	let desktop = $state<DesktopBridge | null>(null);
	let media = $state('');
	let models = $state('');
	let saved = $state({ media: '', models: '' });
	let firstRun = $state(false);
	let saving = $state(false);

	const busy = $derived(status.jobId !== null);
	const foldersChanged = $derived(media !== saved.media || models !== saved.models);
	const runtimes = $derived(status.components.filter((c) => c.group === 'runtime'));
	const weights = $derived(status.components.filter((c) => c.group === 'model'));
	const needed = $derived(status.components.filter((c) => c.recommended && !c.ready && !c.unavailable));

	onMount(async () => {
		desktop = (window as unknown as { waveweaver?: DesktopBridge }).waveweaver ?? null;
		if (!desktop) return;
		const f = await desktop.folders();
		media = f.media;
		models = f.models;
		saved = { media: f.media, models: f.models };
		firstRun = !f.configured;
	});

	async function refresh() {
		const res = await fetch('/api/setup');
		if (res.ok) status = await res.json();
	}

	async function install(ids: ComponentId[]) {
		error = null;
		const res = await fetch('/api/setup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ components: ids }),
		});
		if (!res.ok) {
			error = (await res.json().catch(() => null))?.message ?? 'That install could not start.';
			return;
		}
		jobId = (await res.json()).id;
		await refresh();
	}

	async function choose(which: 'media' | 'models') {
		const picked = await desktop?.chooseFolder(which === 'media' ? media : models);
		if (!picked) return;
		if (which === 'media') media = picked;
		else models = picked;
	}

	async function saveFolders() {
		saving = true;
		error = null;
		// On success the app restarts its server and reloads this page.
		const res = await desktop!.saveFolders({ media: media.trim(), models: models.trim() });
		saving = false;
		if (res.error) error = res.error;
	}

	async function finish() {
		await desktop?.finishSetup();
		await goto('/');
	}

	function blockedBy(c: SetupComponent): SetupComponent | null {
		const need = c.needs ? status.components.find((o) => o.id === c.needs) : null;
		return need && !need.ready ? need : null;
	}
</script>

<svelte:head><title>Setup · WaveWeaver</title></svelte:head>

{#snippet componentRow(c: SetupComponent)}
	{@const blocked = blockedBy(c)}
	<li class="component">
		<span class="pip" class:pip-filled={c.ready} aria-hidden="true"></span>
		<div class="component__text">
			<div class="row component__name">
				<strong>{c.label}</strong>
				<span class="muted">{c.ready ? (c.detail ?? 'Installed') : c.size}</span>
			</div>
			<p class="help">{c.unavailable ?? c.blurb}</p>
		</div>
		{#if !c.unavailable && (!c.ready || c.updatable)}
			<button
				class="btn-small btn-ghost"
				onclick={() => install([c.id])}
				disabled={busy || !!blocked}
				title={blocked ? `Install ${blocked.label} first` : undefined}
			>
				{c.ready ? 'Update' : 'Install'}
			</button>
		{/if}
	</li>
{/snippet}

<section class="hero">
	<h1>Setup</h1>
	<p class="muted">
		WaveWeaver installs what it needs into your own folders. Choose where things live, then fetch only the parts you’ll use.
		You can come back here any time.
	</p>
</section>

{#if error}
	<div class="error"><p>{error}</p></div>
{/if}

<section class="stack">
	<h2>Folders</h2>
	{#if desktop}
		<div class="field">
			<label for="media">Media</label>
			<div class="folder">
				<input id="media" type="text" bind:value={media} spellcheck="false" />
				<button class="btn-small btn-ghost" onclick={() => choose('media')}>Choose…</button>
			</div>
			<p class="help">Your bins: sources, renders and captions. Point this at an existing media folder to pick up where you left off.</p>
		</div>
		<div class="field">
			<label for="models">Models</label>
			<div class="folder">
				<input id="models" type="text" bind:value={models} spellcheck="false" />
				<button class="btn-small btn-ghost" onclick={() => choose('models')}>Choose…</button>
			</div>
			<p class="help">Whisper and translation weights. They take several GB, so a large drive helps.</p>
		</div>
		{#if foldersChanged}
			<div class="row">
				<button class="btn-small" onclick={saveFolders} disabled={saving || busy}>{saving ? 'Saving…' : 'Save folders'}</button>
				<span class="help">Nothing is moved. Files already in the old folders stay there.</span>
			</div>
		{/if}
	{:else}
		<dl class="paths">
			<dt class="caps muted">Media</dt>
			<dd class="mono">{status.mediaRoot}</dd>
			<dt class="caps muted">Models</dt>
			<dd class="mono">{status.modelsDir}</dd>
		</dl>
		<p class="help">Running from a checkout: change these with <code>WAVEWEAVER_MEDIA_DIR</code> and <code>WAVEWEAVER_MODELS_DIR</code>.</p>
	{/if}
</section>

<hr class="rule" />

<section class="stack">
	<div class="row spread">
		<h2>Components</h2>
		{#if needed.length > 0}
			<button onclick={() => install(needed.map((c) => c.id))} disabled={busy}>Install what’s needed ({needed.length})</button>
		{/if}
	</div>
	<ul class="components">
		{#each runtimes as c (c.id)}
			{@render componentRow(c)}
		{/each}
	</ul>
</section>

<hr class="rule" />

<section class="stack">
	<h2>Models</h2>
	<p class="help">Saved to the models folder above.</p>
	<ul class="components">
		{#each weights as c (c.id)}
			{@render componentRow(c)}
		{/each}
	</ul>
</section>

{#if jobId}
	<JobPanel {jobId} title="Install" ondone={refresh} />
{/if}

{#if firstRun}
	<div class="row">
		<button class="btn-primary" onclick={finish} disabled={busy}>Open the Library</button>
		{#if needed.length > 0}<span class="help">You can skip for now, but ffmpeg is needed for anything to render.</span>{/if}
	</div>
{/if}

<style>
	.folder {
		display: flex;
		gap: 0.75rem;
		align-items: stretch;
	}

	.folder input {
		flex: 1;
		min-width: 0;
	}

	.paths {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 0.5rem 1.5rem;
		margin: 0;
	}

	.paths dd {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.components {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 1.25rem;
	}

	.component {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 1rem;
		align-items: start;
	}

	.component > .pip {
		margin-block-start: 0.3rem;
	}

	.component__name {
		gap: 0.25rem 1rem;
	}

	.component__text p {
		margin-block: 0.25rem 0;
	}
</style>

<script lang="ts">
	import type { PageData } from './$types';
	import { goto, invalidateAll } from '$app/navigation';
	import Waveform from '$lib/Waveform.svelte';
	import {
		deskUrl,
		extOf,
		formatBytes,
		formatDuration,
		mediaUrl,
		peaksUrl,
		refKey,
		thumbUrl,
		type MediaFile,
	} from '$lib/media';

	let { data }: { data: PageData } = $props();

	let filter = $state('');
	let activeBin = $state('all');
	let selected = $state<string | null>(null);

	const filtered = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		return data.files.filter(
			(f) => (activeBin === 'all' || f.bin === activeBin) && (!q || f.name.toLowerCase().includes(q)),
		);
	});

	const totalBytes = $derived(data.files.reduce((s, f) => s + f.sizeBytes, 0));

	function when(ms: number): string {
		const d = new Date(ms);
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	}

	async function del(f: MediaFile) {
		if (!confirm(`Delete ${f.bin}/renders/${f.name}?`)) return;
		const res = await fetch(mediaUrl(f), { method: 'DELETE' });
		if (!res.ok) {
			alert('Failed to delete');
			return;
		}
		if (selected === refKey(f)) selected = null;
		invalidateAll();
	}

	async function promote(f: MediaFile) {
		const res = await fetch(mediaUrl(f), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'promote' }),
		});
		if (!res.ok) {
			alert(`Failed: ${(await res.json().catch(() => ({ message: 'error' }))).message}`);
			return;
		}
		invalidateAll();
	}
</script>

<section class="hero">
	<h1>Renders</h1>
	<p class="muted">
		{data.files.length} render{data.files.length === 1 ? '' : 's'} across {data.bins.length} bin{data.bins.length === 1 ? '' : 's'} ·
		{formatBytes(totalBytes)} on disk.
	</p>
</section>

<section class="row spread" style="gap: 1rem;">
	<div class="row" style="gap: 0.75rem;">
		{#each ['all', ...data.bins] as b (b)}
			<button type="button" class="btn-small" class:btn-primary={activeBin === b} class:btn-ghost={activeBin !== b} onclick={() => (activeBin = b)}>{b}</button>
		{/each}
	</div>
	<input type="search" placeholder="FILTER..." bind:value={filter} style="max-width: 28rem;" />
</section>

{#if filtered.length === 0}
	<div class="logs logs-empty">Nothing rendered yet. Open a file on the <a href="/desk" style="color: inherit;">Desk</a>.</div>
{/if}

<section class="clip-grid">
	{#each filtered as f (refKey(f))}
		{@const key = refKey(f)}
		<div class="clip-tile">
			<button type="button" onclick={() => (selected = selected === key ? null : key)} style="all: unset; cursor: pointer; display: grid; gap: 0.75rem;">
				<div class="clip-tile__media" class:is-audio={f.type === 'audio'}>
					{#if f.type === 'video'}
						<video
							src={mediaUrl(f)}
							poster={thumbUrl(f)}
							preload="none"
							muted
							loop
							playsinline
							onmouseenter={(e) => (e.currentTarget as HTMLVideoElement).play().catch(() => {})}
							onmouseleave={(e) => {
								const v = e.currentTarget as HTMLVideoElement;
								v.pause();
								v.currentTime = 0;
							}}
						></video>
					{:else if f.type === 'audio'}
						<Waveform src={peaksUrl(f)} duration={f.info?.duration ?? 0} interactive={false} height={110} />
					{:else}
						<img src={mediaUrl(f)} alt={f.name} loading="lazy" />
					{/if}
					<span class="clip-tile__badge tag" class:tag-accent={f.type !== 'video'}>{extOf(f.name).slice(1)}</span>
				</div>
				<div class="clip-tile__name">
					<span class="tag" style="margin-inline-end: 0.4em;">{f.bin}</span>
					{f.name}
				</div>
				<div class="clip-tile__meta">
					<span>{formatDuration(f.info?.duration)} · {formatBytes(f.sizeBytes)}</span>
					<span>{when(f.modified)}</span>
				</div>
			</button>

			{#if selected === key}
				<div class="stack-tight">
					{#if f.type === 'video'}
						<!-- svelte-ignore a11y_media_has_caption -->
						<video class="screen" controls autoplay src={mediaUrl(f)}></video>
					{:else if f.type === 'audio'}
						<audio class="screen-audio" controls autoplay src={mediaUrl(f)}></audio>
					{/if}
					<div class="row" style="gap: 0.5rem;">
						<a class="btn btn-primary btn-small" href="{mediaUrl(f)}?download">Download</a>
						{#if f.type !== 'image'}
							<button class="btn-small" onclick={() => goto(deskUrl(f))}>Desk</button>
							<button class="btn-ghost btn-small" onclick={() => promote(f)} title="Move into sources/">Promote</button>
						{/if}
						<button class="btn-ghost btn-small" onclick={() => del(f)}>Delete</button>
					</div>
				</div>
			{/if}
		</div>
	{/each}
</section>

<style>
	.is-audio {
		background: var(--bg) !important;
		border: 1.5px solid var(--ink);
		display: grid;
		align-items: center;
	}
</style>

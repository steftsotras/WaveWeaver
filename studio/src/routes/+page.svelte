<script lang="ts">
	import type { PageData } from './$types';
	import { goto, invalidateAll } from '$app/navigation';
	import Dropzone from '$lib/Dropzone.svelte';
	import {
		deskUrl,
		formatBytes,
		formatDuration,
		formatResolution,
		formatRuntime,
		mediaUrl,
		thumbUrl,
		type MediaFile,
	} from '$lib/media';

	let { data }: { data: PageData } = $props();

	let filter = $state('');
	let activeBin = $state<string>('all');
	let only = $state<'all' | 'video' | 'audio'>('all');
	let newBin = $state('');
	let binError = $state<string | null>(null);

	const tabs = $derived(['all', ...data.bins]);
	const uploadBin = $derived(activeBin === 'all' ? (data.bins.includes('inbox') ? 'inbox' : data.bins[0] ?? 'inbox') : activeBin);

	const groups = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		return data.bins
			.filter((b) => activeBin === 'all' || b === activeBin)
			.map((bin) => ({
				bin,
				rows: data.files.filter(
					(f) =>
						f.bin === bin &&
						(only === 'all' || f.type === only) &&
						(!q || f.name.toLowerCase().includes(q)),
				),
			}));
	});

	const totals = $derived.by(() => {
		let runtime = 0;
		let bytes = 0;
		let video = 0;
		for (const f of data.files) {
			runtime += f.info?.duration ?? 0;
			bytes += f.sizeBytes;
			if (f.type === 'video') video++;
		}
		return { runtime, bytes, video, audio: data.files.length - video };
	});

	function codecLine(f: MediaFile): string {
		const parts: string[] = [];
		if (f.info?.video) parts.push(`${f.info.video.codec ?? '?'}${f.info.video.fps ? ` ${f.info.video.fps}fps` : ''}`);
		if (f.info?.audio) parts.push(`${f.info.audio.codec ?? '?'} ${f.info.audio.channels === 1 ? 'mono' : `${f.info.audio.channels}ch`}`);
		return parts.join(' · ') || 'unreadable';
	}

	async function createBin(e: Event) {
		e.preventDefault();
		binError = null;
		const res = await fetch('/api/bins', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: newBin }),
		});
		if (!res.ok) {
			binError = (await res.json().catch(() => ({ message: 'error' }))).message;
			return;
		}
		const { name } = await res.json();
		newBin = '';
		await invalidateAll();
		activeBin = name;
	}

	let deletingBin = $state<string | null>(null);

	/** The whole bin folder goes: say exactly what that means before asking. */
	async function deleteBin(bin: string) {
		const res = await fetch(`/api/bins?contents=${encodeURIComponent(bin)}`);
		if (!res.ok) {
			alert(`Couldn't read ${bin}: ${(await res.json().catch(() => ({ message: 'error' }))).message}`);
			return;
		}
		const c: { sources: number; renders: number; other: number; bytes: number } = await res.json();
		const parts = [
			`${c.sources} ${c.sources === 1 ? 'source' : 'sources'}`,
			`${c.renders} ${c.renders === 1 ? 'render' : 'renders'}`,
			...(c.other ? [`${c.other} other ${c.other === 1 ? 'file' : 'files'} (captions, part lists, extras)`] : []),
		];
		const what = c.sources + c.renders + c.other ? `${parts.join(', ')} — ${formatBytes(c.bytes)}` : 'It’s empty';
		const sep = data.mediaRoot.includes('\\') ? '\\' : '/';
		if (!confirm(`Delete the bin “${bin}” and everything in it?\n\n${what}.\n\nThe folder ${data.mediaRoot}${sep}${bin} is removed. This can't be undone.`)) return;
		deletingBin = bin;
		const del = await fetch('/api/bins', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: bin }) });
		deletingBin = null;
		if (!del.ok) {
			alert(`Couldn't delete ${bin}: ${(await del.json().catch(() => ({ message: 'error' }))).message}`);
			return;
		}
		if (activeBin === bin) activeBin = 'all';
		await invalidateAll();
	}

	async function del(f: MediaFile) {
		if (!confirm(`Delete ${f.bin}/${f.name}?\n\nRenders made from it are kept. This can't be undone.`)) return;
		const res = await fetch(mediaUrl(f), { method: 'DELETE' });
		if (!res.ok) {
			alert(`Failed: ${(await res.json().catch(() => ({ message: 'error' }))).message}`);
			return;
		}
		await invalidateAll();
	}
</script>

<section class="hero">
	<h1>Library</h1>
	<p class="muted">
		Every source file, grouped by bin. Drop footage in, open it on the Desk, weave it into something new.
	</p>
</section>

{#if !data.ffmpeg}
	<div class="error">
		<strong class="caps">ffmpeg not found</strong>
		<p style="margin-block-start: 0.5rem;">
			WaveWeaver drives <code>ffmpeg</code> and <code>ffprobe</code> directly. <a href="/setup">Install them from Setup</a>.
		</p>
	</div>
{/if}

<section class="stats">
	<div>
		<div class="caps muted">Bins</div>
		<div class="stat__value">{data.bins.length}</div>
	</div>
	<div>
		<div class="caps muted">Sources</div>
		<div class="stat__value">{data.files.length}</div>
	</div>
	<div>
		<div class="caps muted">Video / Audio</div>
		<div class="stat__value">{totals.video}<small> / </small>{totals.audio}</div>
	</div>
	<div>
		<div class="caps muted">Runtime</div>
		<div class="stat__value">{formatRuntime(totals.runtime)}</div>
	</div>
	<div>
		<div class="caps muted">On disk</div>
		<div class="stat__value">{formatBytes(totals.bytes)}</div>
	</div>
</section>

<section class="stack">
	<Dropzone bin={uploadBin} onuploaded={() => invalidateAll()} />

	<div class="row spread" style="gap: 1.5rem;">
		<div class="row" style="gap: 0.75rem;">
			{#each tabs as b (b)}
				<button
					type="button"
					class="btn-small"
					class:btn-primary={activeBin === b}
					class:btn-ghost={activeBin !== b}
					onclick={() => (activeBin = b)}
				>
					{b}
				</button>
			{/each}
			<form class="row" style="gap: 0;" onsubmit={createBin}>
				<input
					type="text"
					placeholder="NEW BIN"
					bind:value={newBin}
					class="input-small"
					style="inline-size: 9rem; border-inline-end: 0;"
					aria-label="New bin name"
				/>
				<button type="submit" class="btn-small" disabled={!newBin.trim()}>+</button>
			</form>
		</div>
		<div class="row" style="gap: 1rem;">
			<div class="seg" role="group" aria-label="Filter by type">
				{#each ['all', 'video', 'audio'] as const as t (t)}
					<button type="button" aria-pressed={only === t} onclick={() => (only = t)}>{t}</button>
				{/each}
			</div>
			<input type="search" placeholder="FILTER BY NAME..." bind:value={filter} style="max-width: 22rem;" />
			<button class="btn-small" onclick={() => invalidateAll()}>Refresh</button>
		</div>
	</div>
	{#if binError}<div class="help">✕ {binError}</div>{/if}
</section>

{#each groups as group (group.bin)}
	<section class="stack">
		<div class="row spread">
			<h3>{group.bin}</h3>
			<div class="row" style="gap: 1rem;">
				<span class="caps muted">{group.rows.length} shown</span>
				<button class="btn-small btn-ghost" onclick={() => deleteBin(group.bin)} disabled={deletingBin === group.bin} title="Delete this bin's folder: sources, renders, captions — everything">
					{deletingBin === group.bin ? 'Deleting…' : 'Delete bin'}
				</button>
			</div>
		</div>

		{#if group.rows.length === 0}
			<p class="help">
				Nothing here yet. Drop files above{activeBin === 'all' ? ` (they land in ${uploadBin})` : ''}, or copy them into
				<code>{data.mediaRoot}/{group.bin}/sources</code>.
			</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th style="inline-size: 7rem;"></th>
							<th>Name</th>
							<th>Video</th>
							<th>Audio</th>
							<th class="num">Runtime</th>
							<th class="num">Frame</th>
							<th class="num">Size</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each group.rows as f (f.name)}
							<tr>
								<td>
									<a href={deskUrl(f)} class="thumb" aria-label="Open {f.name} on the Desk">
										{#if f.type === 'video'}
											<img src={thumbUrl(f)} alt="" loading="lazy" />
										{:else}
											<span>{f.name.split('.').pop()}</span>
										{/if}
									</a>
								</td>
								<td style="max-width: 34rem;">
									<div style="font-weight: 600; word-break: break-word;">{f.name}</div>
									<div class="mono muted">{codecLine(f)}</div>
								</td>
								<td><span class="pip" class:pip-filled={Boolean(f.info?.video)}></span></td>
								<td><span class="pip" class:pip-filled={Boolean(f.info?.audio)}></span></td>
								<td class="num">{formatDuration(f.info?.duration)}</td>
								<td class="num">{formatResolution(f.info)}</td>
								<td class="num">{formatBytes(f.sizeBytes)}</td>
								<td>
									<div class="row" style="gap: 0.5rem; justify-content: flex-end; flex-wrap: nowrap;">
										<button class="btn-small" onclick={() => goto(deskUrl(f))}>Desk</button>
										<a class="btn btn-ghost btn-small" href="{mediaUrl(f)}?download" title="Download">↓</a>
										<button class="btn-small btn-ghost" onclick={() => del(f)} title="Delete source">✕</button>
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
{/each}

<style>
	.thumb {
		display: grid;
		place-items: center;
		inline-size: 6rem;
		aspect-ratio: 16 / 9;
		background: var(--screen);
		text-decoration: none;
		overflow: hidden;
	}

	.thumb:hover {
		background: var(--screen);
		outline: 3px solid var(--accent);
	}

	.thumb img {
		inline-size: 100%;
		block-size: 100%;
		object-fit: cover;
		display: block;
	}

	.thumb span {
		color: var(--accent);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		text-transform: uppercase;
	}
</style>

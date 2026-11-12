<script lang="ts">
	import { elapsed, isActive, type JobView } from '$lib/jobs';
	import { deskUrl, formatBytes, formatDuration, mediaTypeOf, mediaUrl } from '$lib/media';
	import CopyButton from './CopyButton.svelte';

	let {
		jobId,
		title = 'Output',
		empty = 'Render something to see it here.',
		ondone,
	}: {
		jobId: string | null;
		title?: string;
		empty?: string;
		ondone?: (job: JobView) => void;
	} = $props();

	let job = $state<JobView | null>(null);
	let cancelling = $state(false);
	let now = $state(Date.now());
	let logEl: HTMLPreElement | null = $state(null);
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let notified = '';

	async function poll(id: string) {
		try {
			const res = await fetch(`/api/jobs/${id}`);
			if (!res.ok) throw new Error(await res.text());
			const data: { job: JobView } = await res.json();
			if (id !== jobId) return;
			job = data.job;
			now = Date.now();
			queueMicrotask(() => {
				if (logEl) logEl.scrollTop = logEl.scrollHeight;
			});
			if (isActive(data.job.status)) {
				pollTimer = setTimeout(() => poll(id), 700);
			} else if (notified !== id) {
				notified = id;
				ondone?.(data.job);
			}
		} catch (err) {
			console.error(err);
			pollTimer = setTimeout(() => poll(id), 2000);
		}
	}

	$effect(() => {
		const id = jobId;
		job = null;
		if (!id) return;
		poll(id);
		return () => {
			if (pollTimer) clearTimeout(pollTimer);
		};
	});

	async function cancel() {
		if (!jobId) return;
		cancelling = true;
		try {
			await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
		} finally {
			cancelling = false;
		}
	}

	const ratio = $derived(job?.progress.ratio ?? null);

	/** Remaining time from how long the current phase has taken so far. */
	const eta = $derived.by(() => {
		if (!job || job.status !== 'running' || !ratio || ratio < 0.02 || !job.progress.phaseStartedAt) return null;
		const spent = (now - job.progress.phaseStartedAt) / 1000;
		return Math.max(0, spent / ratio - spent);
	});

	const first = $derived(job?.result?.outputs[0] ?? null);
	const firstType = $derived(first ? mediaTypeOf(first.name) : null);
</script>

<div class="stack-tight">
	<div class="panel-title">
		<h3>{title}</h3>
		{#if job}
			<div class="row" style="gap: 0.75rem;">
				<span class="tag" class:tag-accent={job.status === 'done'}>{job.status}</span>
				<span class="caps muted">{elapsed(job.startedAt ?? job.createdAt, job.finishedAt, now)}</span>
			</div>
		{/if}
	</div>

	{#if !jobId}
		<div class="logs logs-empty">{empty}</div>
	{:else if !job}
		<div class="logs logs-empty">Loading…</div>
	{:else}
		{#if isActive(job.status)}
			<div class="meter" class:meter-indeterminate={ratio == null}>
				<div class="meter__fill" style:inline-size="{(ratio ?? 0) * 100}%"></div>
				<div class="meter__label">
					<span>{job.progress.phase}</span>
					<span>
						{#if ratio != null}{Math.round(ratio * 100)}%{/if}
						{#if job.progress.speed}&nbsp;· {job.progress.speed.toFixed(1)}×{/if}
						{#if eta != null}&nbsp;· {formatDuration(eta)} left{/if}
					</span>
				</div>
			</div>
			<div>
				<button type="button" class="btn-ghost btn-small" onclick={cancel} disabled={cancelling}>
					{cancelling ? 'Cancelling…' : 'Cancel'}
				</button>
			</div>
		{/if}

		{#if job.status === 'done' && first}
			{#if firstType === 'video'}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video class="screen" controls src={mediaUrl(first)}></video>
			{:else if firstType === 'audio'}
				<audio class="screen-audio" controls src={mediaUrl(first)}></audio>
			{:else if firstType === 'image'}
				<img class="screen" src={mediaUrl(first)} alt={first.name} style="object-fit: contain;" />
			{/if}

			<div class="stats" style="gap: 1rem 2.5rem;">
				<div>
					<div class="caps muted">Files</div>
					<div class="stat__value" style="font-size: var(--fs-3);">{job.result!.outputs.length}</div>
				</div>
				{#if first.durationSec}
					<div>
						<div class="caps muted">Runtime</div>
						<div class="stat__value" style="font-size: var(--fs-3);">
							<mark>{formatDuration(job.result!.outputs.reduce((s, o) => s + (o.durationSec ?? 0), 0))}</mark>
						</div>
					</div>
				{/if}
				<div>
					<div class="caps muted">Size</div>
					<div class="stat__value" style="font-size: var(--fs-3);">
						{formatBytes(job.result!.outputs.reduce((s, o) => s + o.sizeBytes, 0))}
					</div>
				</div>
			</div>

			{#if job.result!.outputs.length === 1}
				<div class="stack-tight">
					<div class="mono truncate" title={first.name}>{first.name}</div>
					<div class="row" style="gap: 0.5rem;">
						<a class="btn btn-primary btn-small" href="{mediaUrl(first)}?download">Download</a>
						{#if firstType !== 'image'}
							<a class="btn btn-small" href={deskUrl(first)}>Open on Desk</a>
						{/if}
						<a class="btn btn-ghost btn-small" href={mediaUrl(first)} target="_blank" rel="noreferrer">Open</a>
					</div>
				</div>
			{:else}
				<div class="table-wrap" style="max-height: 22rem; overflow-y: auto;">
					<table>
						<tbody>
							{#each job.result!.outputs as o (o.name)}
								<tr>
									<td class="mono" style="word-break: break-all;">{o.name}</td>
									<td class="num">{formatDuration(o.durationSec)}</td>
									<td>
										<div class="row" style="gap: 0.4rem; justify-content: flex-end; flex-wrap: nowrap;">
											<a class="btn btn-ghost btn-small" href="{mediaUrl(o)}?download">↓</a>
											<a class="btn btn-small" href={deskUrl(o)}>Desk</a>
										</div>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		{/if}

		{#if job.error}
			<div class="error">
				<strong class="caps">Error</strong>
				<div class="mono">{job.error}</div>
			</div>
		{/if}

		{#if job.commands.length}
			<details>
				<summary class="caps" style="cursor: pointer;">ffmpeg ({job.commands.length})</summary>
				<div class="stack-tight" style="margin-block-start: 0.75rem;">
					{#each job.commands as cmd, i (i)}
						<div style="position: relative;">
							<pre class="cmd">{cmd}</pre>
							<div style="position: absolute; inset: 0.4rem 0.4rem auto auto;">
								<CopyButton text={cmd} />
							</div>
						</div>
					{/each}
				</div>
			</details>
		{/if}

		<details open={job.status !== 'done'}>
			<summary class="caps" style="cursor: pointer;">Logs</summary>
			<pre bind:this={logEl} class="logs" style="margin-block-start: 0.75rem;">{#if job.logs.length === 0}<span class="logs-empty">waiting for output…</span>{:else}{job.logs.join('\n')}{/if}</pre>
		</details>
	{/if}
</div>

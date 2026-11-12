<script lang="ts">
	import ABPlayer from './ABPlayer.svelte';
	import { elapsed, isActive, type JobView } from '$lib/jobs';

	let {
		jobId,
		onapply,
		applyLabel = 'Apply to whole file',
		onclose,
	}: {
		jobId: string;
		onapply?: () => void;
		applyLabel?: string;
		onclose?: () => void;
	} = $props();

	let job = $state<JobView | null>(null);
	let timer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const id = jobId;
		job = null;
		let alive = true;
		const poll = async () => {
			try {
				const res = await fetch(`/api/jobs/${id}`);
				if (!alive) return;
				if (res.ok) job = (await res.json()).job;
				if (!job || isActive(job.status)) timer = setTimeout(poll, 350);
			} catch {
				if (alive) timer = setTimeout(poll, 1000);
			}
		};
		poll();
		return () => {
			alive = false;
			if (timer) clearTimeout(timer);
		};
	});

	async function cancel() {
		await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
	}
</script>

<section class="stack-tight preview">
	<div class="panel-title">
		<h3>Preview</h3>
		<div class="row" style="gap: 0.5rem;">
			{#if job}<span class="caps muted">{elapsed(job.startedAt ?? job.createdAt, job.finishedAt)}</span>{/if}
			{#if onclose}<button type="button" class="btn-ghost btn-icon" onclick={onclose} aria-label="Close preview">✕</button>{/if}
		</div>
	</div>

	{#if !job || isActive(job.status)}
		<div class="meter" class:meter-indeterminate={job?.progress.ratio == null}>
			<div class="meter__fill" style:inline-size="{(job?.progress.ratio ?? 0) * 100}%"></div>
			<div class="meter__label">
				<span>{job?.progress.phase ?? 'starting'}</span>
				<span>{job?.progress.ratio != null ? `${Math.round(job.progress.ratio * 100)}%` : ''}</span>
			</div>
		</div>
		<div><button type="button" class="btn-ghost btn-small" onclick={cancel}>Cancel</button></div>
	{:else if job.status === 'done' && job.result?.preview}
		<ABPlayer preview={job.result.preview} />
		{#if onapply}
			<div class="row" style="gap: 0.5rem;">
				<button type="button" class="btn-primary" onclick={onapply}>{applyLabel}</button>
				<span class="help">Happy with B? Render it for real.</span>
			</div>
		{/if}
	{:else if job.status === 'error'}
		<div class="error"><strong class="caps">Preview failed</strong><div class="mono">{job.error}</div></div>
	{:else}
		<div class="logs logs-empty">Preview {job.status}.</div>
	{/if}
</section>

<style>
	.preview {
		padding-block-end: 1.5rem;
		border-block-end: 1px solid var(--ink);
	}
</style>

<script lang="ts">
	import { onMount } from 'svelte';
	import JobPanel from '$lib/JobPanel.svelte';
	import { elapsed, isActive, type JobView } from '$lib/jobs';

	let jobs = $state<JobView[]>([]);
	let loaded = $state(false);
	let open = $state<string | null>(null);
	let now = $state(Date.now());

	async function refresh() {
		try {
			const res = await fetch('/api/jobs');
			if (res.ok) jobs = (await res.json()).jobs;
		} finally {
			loaded = true;
			now = Date.now();
		}
	}

	onMount(() => {
		let timer: ReturnType<typeof setTimeout>;
		const loop = async () => {
			await refresh();
			timer = setTimeout(loop, jobs.some((j) => isActive(j.status)) ? 1000 : 4000);
		};
		loop();
		return () => clearTimeout(timer);
	});

	async function cancel(id: string) {
		await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
		refresh();
	}

	async function cancelAll() {
		const active = jobs.filter((j) => isActive(j.status));
		if (!active.length || !confirm(`Cancel ${active.length} jobs?`)) return;
		await Promise.all(active.map((j) => fetch(`/api/jobs/${j.id}`, { method: 'DELETE' })));
		refresh();
	}

	async function clear() {
		await fetch('/api/jobs', { method: 'DELETE' });
		refresh();
	}

	const counts = $derived({
		running: jobs.filter((j) => j.status === 'running').length,
		queued: jobs.filter((j) => j.status === 'queued').length,
		done: jobs.filter((j) => j.status === 'done').length,
		failed: jobs.filter((j) => j.status === 'error').length,
	});
</script>

<section class="hero">
	<h1>Jobs</h1>
	<p class="muted">Everything rendering, waiting, or finished since the server started. Outputs stay on disk after a restart; this list doesn't.</p>
</section>

<section class="stats">
	<div><div class="caps muted">Running</div><div class="stat__value">{#if counts.running}<mark>{counts.running}</mark>{:else}0{/if}</div></div>
	<div><div class="caps muted">Queued</div><div class="stat__value">{counts.queued}</div></div>
	<div><div class="caps muted">Done</div><div class="stat__value">{counts.done}</div></div>
	<div><div class="caps muted">Failed</div><div class="stat__value">{counts.failed}</div></div>
</section>

<section class="stack">
	<div class="row" style="gap: 0.75rem;">
		<button class="btn-small btn-ghost" onclick={cancelAll} disabled={!counts.running && !counts.queued}>Cancel all</button>
		<button class="btn-small btn-ghost" onclick={clear}>Clear finished</button>
	</div>

	{#if !loaded}
		<div class="logs logs-empty">Loading…</div>
	{:else if jobs.length === 0}
		<div class="logs logs-empty">No jobs yet. Render something on the <a href="/desk" style="color: inherit;">Desk</a>.</div>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th></th>
						<th>Job</th>
						<th>Kind</th>
						<th>Progress</th>
						<th class="num">Time</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each jobs as j (j.id)}
						<tr>
							<td style="inline-size: 2rem;">
								<span class="pip" class:pip-filled={j.status === 'done' || j.status === 'running'} class:pip-ink={j.status === 'error'}></span>
							</td>
							<td style="word-break: break-word;">
								<div style="font-weight: 600;">{j.label}</div>
								{#if j.error}<div class="mono muted">{j.error.slice(0, 160)}</div>{/if}
							</td>
							<td><span class="tag">{j.kind}</span></td>
							<td class="mono" style="min-inline-size: 10rem;">
								{#if j.status === 'running'}
									{j.progress.phase} · {j.progress.ratio != null ? `${Math.round(j.progress.ratio * 100)}%` : '…'}
								{:else}
									{j.status}
								{/if}
							</td>
							<td class="num">{elapsed(j.startedAt ?? j.createdAt, j.finishedAt, now)}</td>
							<td>
								<div class="row" style="gap: 0.5rem; justify-content: flex-end; flex-wrap: nowrap;">
									{#if isActive(j.status)}
										<button class="btn-small btn-ghost" onclick={() => cancel(j.id)}>Cancel</button>
									{/if}
									<button class="btn-small" onclick={() => (open = open === j.id ? null : j.id)}>{open === j.id ? 'Hide' : 'Open'}</button>
								</div>
							</td>
						</tr>
						{#if open === j.id}
							<tr class="detail">
								<td colspan="6" style="padding-block: 1.5rem;">
									<JobPanel jobId={j.id} title="Job" />
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	tr.detail:hover td {
		background: var(--bg);
	}
</style>

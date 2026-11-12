<script lang="ts">
	import type { PageData } from './$types';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import CopyButton from '$lib/CopyButton.svelte';
	import Dropzone from '$lib/Dropzone.svelte';
	import JobPanel from '$lib/JobPanel.svelte';
	import PartsPanel from '$lib/PartsPanel.svelte';
	import PreviewPanel from '$lib/PreviewPanel.svelte';
	import type { Part } from '$lib/parts';
	import Range from '$lib/Range.svelte';
	import ToolForm from '$lib/ToolForm.svelte';
	import { defaultParams, TOOL_GROUPS, type EngineStatus, type EngineTool } from '$lib/engine';
	import { chainSummary, PRESET_GROUPS, presetSteps, type Preset } from '$lib/presets';
	import StepCard from '$lib/StepCard.svelte';
	import Waveform, { type Region } from '$lib/Waveform.svelte';
	import {
		deskUrl,
		formatBytes,
		formatDuration,
		formatResolution,
		formatTimecode,
		mediaUrl,
		peaksUrl,
		refKey,
		stemOf,
		type MediaFile,
	} from '$lib/media';
	import {
		ASPECTS,
		AUDIO_FORMATS,
		defaultOutput,
		isVideoFormat,
		metaFor,
		newStep,
		QUALITIES,
		STEP_CATALOG,
		STEP_GROUPS,
		VIDEO_FORMATS,
		VISUALS,
		type OutputSpec,
		type Quality,
		type Step,
		type StepOp,
		type WeavePlan,
	} from '$lib/weave';

	let { data }: { data: PageData } = $props();

	const source = $derived(data.source);
	const hasVideo = $derived(Boolean(source?.info?.video));
	const hasAudio = $derived(Boolean(source?.info?.audio));
	const D = $derived(source?.info?.duration ?? 0);
	const jobId = $derived(page.url.searchParams.get('job'));

	let mode = $state<'weave' | 'lab' | 'parts' | 'snapshot'>('weave');
	let steps = $state<Step[]>([]);
	let output = $state<OutputSpec>(defaultOutput(true));
	let currentTime = $state(0);
	let paused = $state(true);
	let selection = $state<{ start: number; end: number } | null>(null);

	/* ----------------------------------------------------------------------
	 * Per-file memory: the weave you were building comes back when you
	 * return to a file. A brand-new file starts from the last weave you
	 * used anywhere, because you usually want the same treatment again.
	 * -------------------------------------------------------------------- */

	function load(key: string): { steps: Step[]; output: OutputSpec } | null {
		try {
			const raw = localStorage.getItem(key);
			return raw ? JSON.parse(raw) : null;
		} catch {
			return null;
		}
	}

	function save(key: string, value: unknown) {
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch {
			// storage blocked or full; the weave just won't be remembered
		}
	}

	let loadedFor = $state<string | null>(null);

	$effect(() => {
		if (!source) return;
		const key = refKey(source);
		if (loadedFor === key) return;
		const saved = load(`ww:weave:${key}`) ?? load('ww:weave:last');
		steps = (saved?.steps ?? []).map((s) => ({ ...s, ...newStep(s.op), ...s }));
		const out = saved?.output ?? defaultOutput(hasVideo);
		if (!hasVideo && isVideoFormat(out.format) && !saved) out.format = 'mp3';
		output = out;
		selection = null;
		silence = null;
		currentTime = 0;
		loadedFor = key;
	});

	$effect(() => {
		if (!source || loadedFor !== refKey(source)) return;
		const snap = { steps: $state.snapshot(steps), output: $state.snapshot(output) };
		save(`ww:weave:${refKey(source)}`, snap);
		save('ww:weave:last', snap);
	});

	/* ----------------------------------------------------------------------
	 * Steps
	 * -------------------------------------------------------------------- */

	function canUse(op: StepOp): boolean {
		const needs = metaFor(op).needs;
		return needs === 'any' || (needs === 'video' ? hasVideo : hasAudio);
	}

	function add(op: StepOp) {
		const s = newStep(op);
		if (s.op === 'trim' && selection) {
			s.start = Math.round(selection.start * 10) / 10;
			s.end = Math.round(selection.end * 10) / 10;
			steps = [s, ...steps];
			return;
		}
		steps = [...steps, s];
	}

	function move(i: number, dir: -1 | 1) {
		const j = i + dir;
		if (j < 0 || j >= steps.length) return;
		const next = [...steps];
		[next[i], next[j]] = [next[j], next[i]];
		steps = next;
	}

	function remove(i: number) {
		steps = steps.filter((_, k) => k !== i);
	}

	/** Make the selection the leading trim, creating it if needed. */
	function trimToSelection() {
		if (!selection) return;
		const start = Math.round(selection.start * 10) / 10;
		const end = Math.round(selection.end * 10) / 10;
		const i = steps.findIndex((s) => s.op === 'trim');
		if (i === -1) {
			const s = newStep('trim');
			if (s.op === 'trim') Object.assign(s, { start, end });
			steps = [s, ...steps];
		} else {
			const t = steps[i];
			if (t.op === 'trim') Object.assign(t, { start, end, on: true });
			if (i !== 0) steps = [t, ...steps.filter((_, k) => k !== i)];
		}
	}

	/* ----------------------------------------------------------------------
	 * Live dry run: every edit recompiles on the server (no ffmpeg run) and
	 * shows the exact command that Render will execute.
	 * -------------------------------------------------------------------- */

	let plan = $state<WeavePlan | null>(null);
	let planError = $state<string | null>(null);
	let planTimer: ReturnType<typeof setTimeout> | null = null;
	let planSeq = 0;

	$effect(() => {
		if (!source || mode !== 'weave') return;
		const body = JSON.stringify({
			kind: 'weave',
			source: { bin: source.bin, kind: source.kind, name: source.name },
			steps: $state.snapshot(steps),
			output: $state.snapshot(output),
		});
		if (planTimer) clearTimeout(planTimer);
		const seq = ++planSeq;
		planTimer = setTimeout(async () => {
			try {
				const res = await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
				const json = await res.json();
				if (seq !== planSeq) return;
				if (!res.ok || json.error) {
					planError = json.error ?? json.message ?? 'Plan failed';
					plan = null;
				} else {
					plan = json.plan;
					planError = null;
				}
			} catch (err) {
				if (seq === planSeq) planError = err instanceof Error ? err.message : String(err);
			}
		}, 200);
	});

	/* ----------------------------------------------------------------------
	 * Jump-cut preview: detect silences on the source and paint the cuts.
	 * Only honest when nothing before the jump cut moves time around.
	 * -------------------------------------------------------------------- */

	let silence = $state<{ stepId: string; regions: [number, number][] } | null>(null);
	let previewing = $state(false);

	function previewableAt(i: number): boolean {
		return steps.slice(0, i).every((s, k) => !s.on || (s.op === 'trim' && k === 0) || !['speed', 'reverse', 'jumpcut', 'trim'].includes(s.op));
	}

	async function previewCuts(step: Step) {
		if (step.op !== 'jumpcut' || !source) return;
		previewing = true;
		try {
			const res = await fetch('/api/silence', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					source: { bin: source.bin, kind: source.kind, name: source.name },
					thresholdDb: step.thresholdDb,
					minSilenceMs: step.minSilenceMs,
					detector: step.detector,
					vadThreshold: step.vadThreshold,
				}),
			});
			if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? 'failed');
			silence = { stepId: step.id, regions: (await res.json()).regions };
		} catch (err) {
			alert(`Preview failed: ${err instanceof Error ? err.message : err}`);
		} finally {
			previewing = false;
		}
	}

	const regions = $derived.by((): Region[] => {
		const out: Region[] = [];
		if (mode === 'parts' && D) {
			// Kept parts tinted, excluded parts and every gap hatched: anything
			// hatched won't be in the export.
			let cursor = 0;
			parts.forEach((p, i) => {
				if (p.start > cursor + 0.01) out.push({ start: cursor, end: p.start, kind: 'drop' });
				out.push({ start: p.start, end: p.end, kind: p.on ? 'keep' : 'drop', id: p.id, label: String(i + 1) });
				cursor = Math.max(cursor, p.end);
			});
			if (parts.length && cursor < D - 0.01) out.push({ start: cursor, end: D, kind: 'drop' });
			const f = parts.find((p) => p.id === focusPart);
			if (f) out.push({ start: f.start, end: f.end, kind: 'focus' });
			return out;
		}
		if (mode !== 'weave' || !D) return out;
		const enabled = steps.filter((s) => s.on);
		const first = enabled[0];
		if (first?.op === 'trim') {
			if (first.start > 0) out.push({ start: 0, end: first.start, kind: 'outside' });
			if (first.end != null && first.end < D) out.push({ start: first.end, end: D, kind: 'outside' });
		}
		if (silence) {
			const i = steps.findIndex((s) => s.id === silence!.stepId);
			const s = steps[i];
			if (s?.op === 'jumpcut' && s.on && previewableAt(i)) {
				const pad = s.padMs / 1000;
				for (const [a, b] of silence.regions) {
					const x = a <= 0.01 ? 0 : a + pad;
					const y = b >= D - 0.01 ? D : b - pad;
					if (y - x > 0.05) out.push({ start: x, end: y, kind: 'cut' });
				}
			}
		}
		return out;
	});

	const previewSummary = $derived.by(() => {
		const cuts = regions.filter((r) => r.kind === 'cut');
		if (!cuts.length) return null;
		const removed = cuts.reduce((s, r) => s + (r.end - r.start), 0);
		return { count: cuts.length, removed, pct: D ? (removed / D) * 100 : 0 };
	});

	/* ----------------------------------------------------------------------
	 * Parts mode: the list lives in PartsPanel; the waveform draws it and
	 * hands edge drags back.
	 * -------------------------------------------------------------------- */

	let parts = $state<Part[]>([]);
	let focusPart = $state<string | null>(null);
	let partsPanel = $state<PartsPanel | null>(null);

	/* ----------------------------------------------------------------------
	 * Snapshot mode
	 * -------------------------------------------------------------------- */

	let sheet = $state({ cols: 5, rows: 4 });

	/* ----------------------------------------------------------------------
	 * Jobs
	 * -------------------------------------------------------------------- */

	let submitting = $state(false);

	async function start(body: Record<string, unknown>) {
		if (!source) return;
		submitting = true;
		try {
			const res = await fetch('/api/jobs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ source: { bin: source.bin, kind: source.kind, name: source.name }, ...body }),
			});
			if (!res.ok) {
				alert(`Failed: ${(await res.json().catch(() => ({ message: 'error' }))).message}`);
				return;
			}
			const json = await res.json();
			if (json.ids) {
				goto('/jobs');
				return;
			}
			const url = new URL(page.url);
			url.searchParams.set('job', json.id);
			goto(url, { replaceState: true, keepFocus: true, noScroll: true });
		} finally {
			submitting = false;
		}
	}

	function render() {
		start({ kind: 'weave', steps: $state.snapshot(steps), output: $state.snapshot(output) });
	}

	/* ----------------------------------------------------------------------
	 * Presets & recipes. Built-in presets (mastering, voice, repair …) are
	 * appended as ordinary steps; your own recipes replace the weave. Both
	 * are files in media/presets/, not browser storage.
	 * -------------------------------------------------------------------- */

	let presets = $state<Preset[]>([]);

	async function loadPresets() {
		const res = await fetch('/api/presets').catch(() => null);
		if (res?.ok) presets = (await res.json()).presets;
	}

	$effect(() => {
		loadPresets();
	});

	function applyPreset(id: string) {
		const p = presets.find((x) => x.id === id);
		if (!p) return;
		if (p.builtin) {
			steps = [...steps, ...presetSteps(p)];
		} else {
			if (steps.length && !confirm(`Replace the current ${steps.length} steps with "${p.name}"?`)) return;
			steps = presetSteps(p);
			if (p.output) output = { ...p.output };
		}
	}

	// /desk?…&preset=podcast-voice (from the Presets page) applies it once.
	let presetApplied = $state<string | null>(null);
	$effect(() => {
		const want = page.url.searchParams.get('preset');
		if (!want || !source || loadedFor !== refKey(source) || !presets.length || presetApplied === want) return;
		presetApplied = want;
		const p = presets.find((x) => x.id === want);
		if (p) steps = [...steps.filter((s) => !p.builtin || s.op === 'trim' || s.op === 'jumpcut'), ...presetSteps(p)];
	});

	async function saveRecipe() {
		const name = prompt('Name this recipe', steps.map((s) => metaFor(s.op).label).join(' + ') || 'Transcode');
		if (!name) return;
		const res = await fetch('/api/presets', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name, steps: $state.snapshot(steps), output: $state.snapshot(output) }),
		});
		if (!res.ok) {
			alert(`Couldn't save: ${(await res.json().catch(() => ({ message: 'error' }))).message}`);
			return;
		}
		await loadPresets();
	}

	/* ----------------------------------------------------------------------
	 * Preview: run the weave (or a Lab tool) on a short window first and
	 * A/B it against the original. The window is your waveform selection,
	 * or N seconds from the playhead.
	 * -------------------------------------------------------------------- */

	let previewLen = $state(20);
	let previewJob = $state<string | null>(null);
	let previewApply = $state<(() => void) | null>(null);

	const previewWindow = $derived(
		selection && selection.end - selection.start >= 0.5
			? { start: selection.start, duration: Math.min(90, selection.end - selection.start) }
			: { start: Math.min(currentTime, Math.max(0, D - 1)), duration: Math.min(previewLen, Math.max(1, D - currentTime)) },
	);

	async function startPreview(body: Record<string, unknown>, apply: () => void) {
		if (!source) return;
		if (previewJob) fetch(`/api/jobs/${previewJob}`, { method: 'DELETE' }).catch(() => {});
		const res = await fetch('/api/preview', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ source: { bin: source.bin, kind: source.kind, name: source.name }, window: previewWindow, ...body }),
		});
		if (!res.ok) {
			alert(`Preview failed: ${(await res.json().catch(() => ({ message: 'error' }))).message}`);
			return;
		}
		previewJob = (await res.json()).id;
		previewApply = apply;
	}

	function previewWeave() {
		startPreview({ kind: 'weave', steps: $state.snapshot(steps), output: $state.snapshot(output) }, render);
	}

	/* ----------------------------------------------------------------------
	 * Lab: tools from the Python engine (learned-profile denoise, VST3,
	 * reference mastering, neural cleanup …). Forms come from the engine.
	 * -------------------------------------------------------------------- */

	let engine = $state<EngineStatus | null>(null);
	let toolId = $state<string | null>(null);
	let toolValues = $state<Record<string, unknown>>({});
	let toolFormat = $state('same');

	async function loadEngine(rescan = false) {
		engine = null;
		const res = await fetch(`/api/engine${rescan ? '?rescan' : ''}`).catch(() => null);
		engine = res?.ok ? await res.json() : { online: false, error: 'Studio server unreachable', tools: [] };
	}

	$effect(() => {
		if (mode === 'lab' && !engine) loadEngine();
	});

	const labTools = $derived((engine?.tools ?? []).filter((t) => t.inputs === 'audio' && t.output === 'audio'));
	const tool = $derived(labTools.find((t) => t.id === toolId) ?? null);

	function pickTool(t: EngineTool) {
		toolId = t.id;
		toolValues = defaultParams(t);
	}

	function applyTool() {
		if (!tool) return;
		start({ kind: 'tool', tool: tool.id, params: $state.snapshot(toolValues), format: toolFormat });
	}

	function previewTool() {
		if (!tool) return;
		startPreview({ kind: 'tool', tool: tool.id, params: $state.snapshot(toolValues) }, applyTool);
	}

	let batchBin = $state('');
	const batchFiles = $derived(data.files.filter((f) => f.kind === 'sources' && f.bin === (batchBin || source?.bin)));

	function batch() {
		if (!batchFiles.length) return;
		if (!confirm(`Queue ${batchFiles.length} renders — this weave applied to every source in "${batchBin || source?.bin}"?`)) return;
		start({
			kind: 'weave',
			sources: batchFiles.map((f) => ({ bin: f.bin, kind: f.kind, name: f.name })),
			steps: $state.snapshot(steps),
			output: $state.snapshot(output),
		});
	}

	/* ----------------------------------------------------------------------
	 * Keyboard: space play/pause, I/O set in/out, Esc clears the selection.
	 * -------------------------------------------------------------------- */

	let mediaEl: HTMLMediaElement | null = $state(null);

	function onKey(e: KeyboardEvent) {
		if (!source) return;
		const t = e.target as HTMLElement;
		if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const k = e.key.toLowerCase();
		// Space already means "press" on a focused button and "play" on native controls.
		if (k === ' ' && ['BUTTON', 'VIDEO', 'AUDIO', 'A'].includes(t.tagName)) return;
		if (k === ' ') {
			e.preventDefault();
			paused = !paused;
		} else if (k === 'i') {
			selection = { start: currentTime, end: Math.max(currentTime + 0.1, selection?.end ?? D) };
		} else if (k === 'o') {
			selection = { start: Math.min(selection?.start ?? 0, currentTime - 0.1), end: currentTime };
			if (selection.start < 0) selection.start = 0;
		} else if (k === 'escape') {
			selection = null;
		} else if (k === 'arrowleft' || k === 'arrowright') {
			e.preventDefault();
			const d = (e.shiftKey ? 5 : 1) * (k === 'arrowleft' ? -1 : 1);
			currentTime = Math.min(D, Math.max(0, currentTime + d));
		}
	}

	async function promote() {
		if (!source) return;
		const res = await fetch(mediaUrl(source), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'promote' }),
		});
		if (!res.ok) {
			alert(`Failed: ${(await res.json().catch(() => ({ message: 'error' }))).message}`);
			return;
		}
		const { ref } = await res.json();
		await goto(deskUrl(ref), { invalidateAll: true });
	}

	function binsFor(files: MediaFile[]) {
		return data.bins.map((bin) => ({ bin, rows: files.filter((f) => f.bin === bin) })).filter((g) => g.rows.length);
	}

	const outputFormats = $derived(hasVideo ? [...VIDEO_FORMATS, ...AUDIO_FORMATS] : [...AUDIO_FORMATS, 'mp4', 'webm']);
</script>

<svelte:window onkeydown={onKey} />

{#if !source}
	<section class="hero">
		<h1>Desk</h1>
		<p class="muted">Pick a file to work on. Every tool here compiles into a single ffmpeg pass.</p>
	</section>

	<section class="stack">
		<Dropzone
			bin={data.bins.includes('inbox') ? 'inbox' : (data.bins[0] ?? 'inbox')}
			onuploaded={(refs) => goto(deskUrl(refs[0]), { invalidateAll: true })}
		/>
	</section>

	{#each binsFor(data.files) as group (group.bin)}
		<section class="stack">
			<h3>{group.bin}</h3>
			<div class="table-wrap">
				<table>
					<tbody>
						{#each group.rows as f (f.kind + f.name)}
							<tr>
								<td style="inline-size: 6rem;"><span class="tag" class:tag-accent={f.kind === 'renders'}>{f.kind === 'renders' ? 'render' : f.type}</span></td>
								<td><a href={deskUrl(f)} style="font-weight: 600; word-break: break-word;">{f.name}</a></td>
								<td class="num">{formatDuration(f.info?.duration)}</td>
								<td class="num">{formatResolution(f.info)}</td>
								<td class="num">{formatBytes(f.sizeBytes)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/each}
{:else}
	<section class="stack-tight">
		<div class="row" style="gap: 0.5rem;">
			<span class="tag">{source.bin}</span>
			<span class="tag" class:tag-accent={source.kind === 'renders'}>{source.kind}</span>
			<a href="/desk" class="caps">Change file</a>
		</div>
		<h2 style="font-size: clamp(1.5rem, 3vw, 2.5rem); word-break: break-word;">{stemOf(source.name)}</h2>
		<div class="row mono muted" style="gap: 0.4rem 1.5rem;">
			<span>{formatDuration(D)}</span>
			{#if source.info?.video}
				<span>{source.info.video.width}×{source.info.video.height} · {source.info.video.fps ?? '?'} fps · {source.info.video.codec}</span>
			{/if}
			{#if source.info?.audio}
				<span>{source.info.audio.codec} · {source.info.audio.sampleRate ? `${source.info.audio.sampleRate / 1000} kHz` : ''} · {source.info.audio.channels === 1 ? 'mono' : `${source.info.audio.channels} ch`}</span>
			{/if}
			<span>{formatBytes(source.sizeBytes)}</span>
			{#if source.kind === 'renders'}
				<button type="button" class="btn-ghost btn-small" onclick={promote} title="Move this render into sources/">Promote to sources</button>
			{/if}
		</div>
	</section>

	<section class="split">
		<div class="stack">
			<div class="stack-tight">
				{#if hasVideo}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video
						class="screen"
						src={mediaUrl(source)}
						preload="metadata"
						controls
						bind:this={mediaEl}
						bind:currentTime
						bind:paused
					></video>
				{:else}
					<audio class="screen-audio" src={mediaUrl(source)} preload="metadata" controls bind:this={mediaEl} bind:currentTime bind:paused></audio>
				{/if}

				{#if hasAudio}
					<Waveform
						src={peaksUrl(source)}
						duration={D}
						{currentTime}
						bind:selection
						{regions}
						onregionedge={(id, edge, t) => partsPanel?.setEdge(id, edge, t)}
						onregionclick={(id) => (focusPart = id)}
						onseek={(t) => (currentTime = t)}
					/>
				{/if}

				<div class="row spread" style="gap: 0.75rem;">
					<div class="mono">
						<span class="tag">{formatTimecode(currentTime)}</span>
						{#if selection}
							<span class="tag tag-accent">
								{formatTimecode(selection.start)} → {formatTimecode(selection.end)} ({formatTimecode(selection.end - selection.start)})
							</span>
						{/if}
					</div>
					<div class="row" style="gap: 0.5rem;">
						{#if selection}
							<button type="button" class="btn-primary btn-small" onclick={trimToSelection}>Trim to selection</button>
							<button type="button" class="btn-ghost btn-small" onclick={() => (selection = null)}>Clear</button>
						{/if}
						<span class="help"><kbd>Space</kbd> play · <kbd>I</kbd>/<kbd>O</kbd> in/out · <kbd>←</kbd><kbd>→</kbd> nudge · drag to select</span>
					</div>
				</div>
				{#if previewSummary}
					<div class="help" style="color: var(--ink);">
						Jump cut preview: <strong>{previewSummary.count}</strong> cuts remove
						<mark>{formatDuration(previewSummary.removed)}</mark> ({previewSummary.pct.toFixed(0)}% of the source).
					</div>
				{/if}
			</div>

			<div class="seg" role="group" aria-label="Desk mode">
				<button type="button" aria-pressed={mode === 'weave'} onclick={() => (mode = 'weave')}>Weave</button>
				<button type="button" aria-pressed={mode === 'lab'} disabled={!hasAudio} onclick={() => (mode = 'lab')}>Lab</button>
				<button type="button" aria-pressed={mode === 'parts'} onclick={() => (mode = 'parts')}>Parts</button>
				<button
					type="button"
					aria-pressed={mode === 'snapshot'}
					disabled={!hasVideo}
					onclick={() => (mode = 'snapshot')}>Snapshot</button
				>
			</div>

			{#if mode === 'weave'}
				<div class="stack">
					<div class="panel-title">
						<h3>Weave</h3>
						<div class="row" style="gap: 0.5rem;">
							{#if presets.length}
								<select
									class="input-small"
									style="inline-size: auto;"
									aria-label="Add a preset"
									onchange={(e) => {
										const sel = e.currentTarget as HTMLSelectElement;
										if (sel.value) applyPreset(sel.value);
										sel.value = '';
									}}
								>
									<option value="">Presets…</option>
									{#each PRESET_GROUPS as g (g.group)}
										{@const list = presets.filter((p) => p.group === g.group)}
										{#if list.length}
											<optgroup label={g.label}>
												{#each list as p (p.id)}<option value={p.id}>{p.name}{p.target ? ` · ${p.target}` : ''}</option>{/each}
											</optgroup>
										{/if}
									{/each}
								</select>
							{/if}
							<button type="button" class="btn-ghost btn-small" onclick={saveRecipe} disabled={!steps.length}>Save recipe</button>
							{#if steps.length}
								<button type="button" class="btn-ghost btn-small" onclick={() => (steps = [])}>Clear</button>
							{/if}
						</div>
					</div>

					<div class="palette">
						{#each STEP_GROUPS as g (g.group)}
							<div class="palette__group">
								<span class="caps muted">{g.label}</span>
								<div class="row" style="gap: 0.4rem;">
									{#each STEP_CATALOG.filter((m) => m.group === g.group) as m (m.op)}
										<button
											type="button"
											class="btn-ghost btn-small"
											disabled={!canUse(m.op)}
											title={canUse(m.op) ? m.blurb : `Needs ${m.needs}`}
											onclick={() => add(m.op)}>+ {m.label}</button
										>
									{/each}
								</div>
							</div>
						{/each}
					</div>

					{#if steps.length === 0}
						<div class="logs logs-empty">
							No steps yet: Render would just transcode to {output.format.toUpperCase()}. Add tools above — they run top to bottom.
						</div>
					{/if}

					{#each steps as step, i (step.id)}
						<StepCard
							bind:step={steps[i]}
							index={i}
							count={steps.length}
							{currentTime}
							{selection}
							duration={D}
							previewing={previewing}
							onremove={() => remove(i)}
							onmove={(dir) => move(i, dir)}
							onpreview={step.op === 'jumpcut' && previewableAt(i) ? () => previewCuts(step) : undefined}
						/>
					{/each}

					<div class="stack-tight">
						<h4 class="caps" style="font-size: var(--fs-small);">Output</h4>
						<div class="seg" role="group" aria-label="Output format">
							{#each outputFormats as f (f)}
								<button type="button" aria-pressed={output.format === f} onclick={() => (output.format = f as OutputSpec['format'])}>{f}</button>
							{/each}
						</div>
						<div class="seg" role="group" aria-label="Quality">
							{#each QUALITIES as q (q)}
								<button type="button" aria-pressed={output.quality === q} onclick={() => (output.quality = q)}>{q}</button>
							{/each}
						</div>
						{#if !hasVideo && isVideoFormat(output.format)}
							<div class="help">Audio → video: WaveWeaver draws the picture.</div>
							<div class="row" style="gap: 0.75rem;">
								<div class="seg" role="group" aria-label="Visual">
									{#each VISUALS as v (v)}
										<button type="button" aria-pressed={output.visual === v} onclick={() => (output.visual = v)}>{v}</button>
									{/each}
								</div>
								<div class="seg" role="group" aria-label="Canvas">
									{#each ASPECTS.slice(0, 4) as a (a)}
										<button type="button" aria-pressed={output.canvas === a} onclick={() => (output.canvas = a)}>{a}</button>
									{/each}
								</div>
							</div>
						{/if}
					</div>

					<div class="stack-tight plan">
						<h4 class="caps" style="font-size: var(--fs-small);">Dry run</h4>
						{#if planError}
							<div class="error"><strong class="caps">Won't render</strong><div class="mono">{planError}</div></div>
						{:else if plan}
							<div class="stats" style="gap: 1rem 2.5rem;">
								<div>
									<div class="caps muted">In</div>
									<div class="stat__value" style="font-size: var(--fs-3);">{formatDuration(D)}</div>
								</div>
								<div>
									<div class="caps muted">Out</div>
									<div class="stat__value" style="font-size: var(--fs-3);">
										<mark>{plan.estimatedDurationSec != null ? formatDuration(plan.estimatedDurationSec) : 'after analysis'}</mark>
									</div>
								</div>
								<div>
									<div class="caps muted">Frame</div>
									<div class="stat__value" style="font-size: var(--fs-3);">
										{plan.output.hasVideo ? `${plan.output.width}×${plan.output.height}` : 'audio'}
									</div>
								</div>
								<div>
									<div class="caps muted">Passes</div>
									<div class="stat__value" style="font-size: var(--fs-3);">{plan.passes.length}</div>
								</div>
							</div>
							<ol class="mono" style="margin: 0; padding-inline-start: 1.25rem;">
								{#each plan.passes as p (p)}<li>{p}</li>{/each}
							</ol>
							{#each plan.warnings as w (w)}
								<div class="help" style="color: var(--ink);"><span class="tag tag-accent">!</span> {w}</div>
							{/each}
							<div style="position: relative;">
								<pre class="cmd">{plan.command}</pre>
								<div style="position: absolute; inset: 0.4rem 0.4rem auto auto;"><CopyButton text={plan.command} /></div>
							</div>
						{:else}
							<div class="logs logs-empty">Compiling…</div>
						{/if}
					</div>

					<div class="stack-tight">
						<div class="row" style="gap: 0.5rem;">
							<button type="button" class="btn" onclick={previewWeave} disabled={Boolean(planError) || !D}>
								Preview {formatTimecode(previewWindow.start)} +{Math.round(previewWindow.duration)}s
							</button>
							{#if !selection}
								<div class="seg" role="group" aria-label="Preview length">
									{#each [10, 20, 30, 60] as n (n)}
										<button type="button" aria-pressed={previewLen === n} onclick={() => (previewLen = n)}>{n}s</button>
									{/each}
								</div>
							{/if}
						</div>
						<div class="help">
							{selection ? 'Previews your selection.' : 'Previews from the playhead — or drag on the waveform to pick the exact stretch.'}
							Try it on a short window and A/B it before committing to the whole file.
						</div>
					</div>

					<div class="row">
						<button type="button" class="btn-primary" onclick={render} disabled={submitting || Boolean(planError)}>
							{submitting ? 'Starting…' : 'Render whole file'}
						</button>
						<div class="row" style="gap: 0;">
							<select bind:value={batchBin} class="input-small" style="inline-size: auto; border-inline-end: 0;" aria-label="Batch bin">
								<option value="">{source.bin}</option>
								{#each data.bins.filter((b) => b !== source.bin) as b (b)}<option value={b}>{b}</option>{/each}
							</select>
							<button type="button" class="btn-ghost btn-small" style="padding-block: 0.6rem;" onclick={batch} disabled={submitting || !batchFiles.length || Boolean(planError)}>
								Weave all {batchFiles.length}
							</button>
						</div>
					</div>
				</div>
			{:else if mode === 'lab'}
				<div class="stack">
					<div class="panel-title">
						<h3>Lab</h3>
						<button type="button" class="btn-ghost btn-small" onclick={() => loadEngine(true)}>Rescan</button>
					</div>
					<p class="help">
						Tools from the Python engine — learned-profile noise reduction, your VST3 plugins, reference mastering, neural
						cleanup. Each one previews on a short window first.
					</p>
					{#if !engine}
						<div class="logs logs-empty">Connecting to the engine…</div>
					{:else if !engine.online}
						<div class="error"><strong class="caps">Engine offline</strong><div class="mono">{engine.error}</div></div>
					{:else}
						<div class="help mono">engine {engine.version} · {engine.device}</div>
						<div class="palette">
							{#each TOOL_GROUPS as g (g.group)}
								{@const list = labTools.filter((t) => t.group === g.group)}
								{#if list.length}
									<div class="palette__group">
										<span class="caps muted">{g.label}</span>
										<div class="row" style="gap: 0.4rem;">
											{#each list as t (t.id)}
												<button
													type="button"
													class="btn-small"
													class:btn-primary={toolId === t.id}
													class:btn-ghost={toolId !== t.id}
													disabled={!t.available}
													title={t.available ? t.blurb : (t.reason ?? '')}
													onclick={() => pickTool(t)}>{t.label}</button
												>
											{/each}
										</div>
									</div>
								{/if}
							{/each}
						</div>
						{#each labTools.filter((t) => !t.available) as t (t.id)}
							<div class="help"><span class="tag tag-ghost">{t.label}</span> {t.reason}</div>
						{/each}
						<div class="help">
							Speech tools (transcribe, translate) live on the
							<a href="/captions?bin={encodeURIComponent(source.bin)}&kind={source.kind}&file={encodeURIComponent(source.name)}">Captions</a> page.
						</div>

						{#if tool}
							<div class="step">
								<div class="step__head">
									<span class="step__index">FX</span>
									<span class="step__title">{tool.label}</span>
								</div>
								<div class="step__body">
									<div class="help">{tool.blurb}</div>
									<ToolForm {tool} bind:values={toolValues} {selection} files={data.files} />
								</div>
							</div>
							<div class="row" style="gap: 0.5rem;">
								<button type="button" class="btn" onclick={previewTool}>
									Preview {formatTimecode(previewWindow.start)} +{Math.round(previewWindow.duration)}s
								</button>
								<button type="button" class="btn-primary" onclick={applyTool} disabled={submitting}>Apply to whole file</button>
								<select bind:value={toolFormat} class="input-small" style="inline-size: auto;" aria-label="Output format">
									<option value="same">Same format{hasVideo ? ' (keeps video)' : ''}</option>
									{#each ['wav', 'flac', 'mp3', 'm4a', 'opus'] as f (f)}<option value={f}>{f}</option>{/each}
								</select>
							</div>
						{/if}
					{/if}
				</div>
			{:else if mode === 'parts'}
				<PartsPanel
					bind:this={partsPanel}
					{source}
					bind:currentTime
					bind:paused
					{selection}
					bind:parts
					bind:focus={focusPart}
					onpreview={startPreview}
					onstart={(b) => start(b)}
				/>
			{:else}
				<div class="stack">
					<h3>Snapshot</h3>
					<div class="stack-tight">
						<h4 class="caps" style="font-size: var(--fs-small);">Frame</h4>
						<p class="help">A full-resolution PNG of the frame under the playhead.</p>
						<div>
							<button type="button" class="btn-primary" disabled={submitting} onclick={() => start({ kind: 'snapshot', mode: 'frame', at: currentTime })}>
								Grab frame @ {formatTimecode(currentTime)}
							</button>
						</div>
					</div>
					<div class="stack-tight">
						<h4 class="caps" style="font-size: var(--fs-small);">Contact sheet</h4>
						<p class="help">{sheet.cols * sheet.rows} evenly spaced frames on one image — see a whole file at a glance.</p>
						<div class="step__body" style="padding: 0;">
							<div class="grid-2">
								<Range label="Columns" bind:value={sheet.cols} min={2} max={10} />
								<Range label="Rows" bind:value={sheet.rows} min={1} max={10} />
							</div>
						</div>
						<div>
							<button type="button" class="btn" disabled={submitting} onclick={() => start({ kind: 'snapshot', mode: 'sheet', ...$state.snapshot(sheet) })}>
								Render {sheet.cols}×{sheet.rows} sheet
							</button>
						</div>
					</div>
				</div>
			{/if}
		</div>

		<div class="sticky stack">
			{#if previewJob}
				<PreviewPanel
					jobId={previewJob}
					onapply={previewApply ?? undefined}
					onclose={() => {
						fetch(`/api/jobs/${previewJob}`, { method: 'DELETE' }).catch(() => {});
						previewJob = null;
					}}
				/>
			{/if}
			<JobPanel {jobId} ondone={() => invalidateAll()} />
		</div>
	</section>
{/if}

<script lang="ts">
	import Range from './Range.svelte';
	import { formatDuration, formatTimecode, type MediaFile } from '$lib/media';
	import {
		DEFAULT_DETECT,
		DEFAULT_EXPORT,
		joinedLength,
		kept,
		lengthOf,
		partId,
		partName,
		type DetectOptions,
		type ExportOptions,
		type Part,
	} from '$lib/parts';
	import { QUALITIES } from '$lib/weave';

	let {
		source,
		currentTime = $bindable(),
		paused = $bindable(),
		selection,
		parts = $bindable(),
		focus = $bindable(),
		onpreview,
		onstart,
	}: {
		source: MediaFile;
		currentTime: number;
		paused: boolean;
		selection: { start: number; end: number } | null;
		parts: Part[];
		focus: string | null;
		onpreview: (body: Record<string, unknown>, apply: () => void) => void;
		onstart: (body: Record<string, unknown>) => void;
	} = $props();

	const D = $derived(source.info?.duration ?? 0);
	const hasVideo = $derived(Boolean(source.info?.video));
	const docUrl = $derived(`/api/parts/${encodeURIComponent(source.bin)}/${source.kind}/${encodeURIComponent(source.name)}`);
	const ref = $derived({ bin: source.bin, kind: source.kind, name: source.name });

	let detect = $state<DetectOptions>({ ...DEFAULT_DETECT });
	let exp = $state<ExportOptions>(structuredClone(DEFAULT_EXPORT));
	let loadedFor = $state<string | null>(null);
	let detecting = $state(false);
	let detectError = $state<string | null>(null);
	let lastDetect = $state('');
	let level = $state<{ floorDb: number; programDb: number; suggestedDb: number } | null>(null);
	let levelBusy = $state(false);
	let audition = $state(true);
	let stopAt: number | null = null;

	/* ------------------------------------------------------------------
	 * Load / save. The part list lives next to the media as JSON, so it
	 * survives reloads and other browsers. A file without one gets an
	 * automatic first detection.
	 * ---------------------------------------------------------------- */

	$effect(() => {
		const url = docUrl;
		if (loadedFor === url) return;
		loadedFor = url;
		parts = [];
		focus = null;
		fetch(url)
			.then((r) => r.json())
			.then(({ doc }) => {
				if (doc) {
					parts = doc.parts;
					detect = doc.detect;
					exp = doc.export;
					lastDetect = JSON.stringify(doc.detect);
				} else {
					// First visit: measure this recording's own noise floor and
					// programme level before guessing what a pause is. A fixed
					// −40 dB is right for a loud podcast and wrong for a quiet
					// live recording.
					detect = { ...DEFAULT_DETECT };
					exp = structuredClone(DEFAULT_EXPORT);
					(source.info?.audio ? auto() : Promise.resolve()).then(run);
				}
			});
	});

	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let saved = $state(true);
	$effect(() => {
		const body = JSON.stringify({ parts: $state.snapshot(parts), detect: $state.snapshot(detect), export: $state.snapshot(exp) });
		if (loadedFor !== docUrl || !parts.length) return;
		saved = false;
		if (saveTimer) clearTimeout(saveTimer);
		const url = docUrl;
		saveTimer = setTimeout(async () => {
			const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body }).catch(() => null);
			saved = Boolean(r?.ok);
		}, 600);
	});

	/* ------------------------------------------------------------------
	 * Detection
	 * ---------------------------------------------------------------- */

	const stale = $derived(lastDetect !== '' && lastDetect !== JSON.stringify(detect));

	async function run() {
		if (parts.length && lastDetect && !confirm('Detect again? This replaces the current parts (including your edits).')) return;
		detecting = true;
		detectError = null;
		try {
			const res = await fetch('/api/parts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'detect', source: ref, detect: $state.snapshot(detect) }),
			});
			const json = await res.json();
			if (!res.ok) throw new Error(json.message);
			parts = json.parts;
			lastDetect = JSON.stringify(detect);
			focus = parts[0]?.id ?? null;
		} catch (e) {
			detectError = e instanceof Error ? e.message : String(e);
		} finally {
			detecting = false;
		}
	}

	async function auto() {
		levelBusy = true;
		try {
			const res = await fetch('/api/parts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'level', source: ref }),
			});
			const json = await res.json();
			if (!res.ok) throw new Error(json.message);
			level = json;
			detect.thresholdDb = json.suggestedDb;
		} catch (e) {
			detectError = e instanceof Error ? e.message : String(e);
		} finally {
			levelBusy = false;
		}
	}

	/* ------------------------------------------------------------------
	 * Editing
	 * ---------------------------------------------------------------- */

	const idx = (id: string | null) => parts.findIndex((p) => p.id === id);
	const at = (t: number) => parts.findIndex((p) => t >= p.start && t < p.end);
	const sorted = () => (parts = [...parts].sort((a, b) => a.start - b.start));

	/** Called from the waveform while you drag a part's edge. */
	export function setEdge(id: string, edge: 'start' | 'end', t: number) {
		const i = idx(id);
		if (i < 0) return;
		const p = parts[i];
		if (edge === 'start') p.start = Math.min(p.end - 0.2, Math.max(i > 0 ? parts[i - 1].end : 0, t));
		else p.end = Math.max(p.start + 0.2, Math.min(i < parts.length - 1 ? parts[i + 1].start : D, t));
	}

	function splitAtPlayhead() {
		const i = at(currentTime);
		if (i < 0) return;
		const p = parts[i];
		if (currentTime - p.start < 0.2 || p.end - currentTime < 0.2) return;
		const next = [...parts];
		next.splice(i, 1, { ...p, end: currentTime }, { id: partId(), start: currentTime, end: p.end, name: partName(i + 1), on: p.on });
		parts = next;
	}

	function mergeNext(i: number) {
		if (i >= parts.length - 1) return;
		const a = parts[i];
		const b = parts[i + 1];
		const next = [...parts];
		next.splice(i, 2, { ...a, end: b.end, on: a.on || b.on });
		parts = next;
	}

	function remove(i: number) {
		parts = parts.filter((_, k) => k !== i);
	}

	/** A new part exactly where the selection is; anything it overlaps gives way. */
	function addFromSelection() {
		if (!selection) return;
		const { start, end } = selection;
		const next: Part[] = [];
		for (const p of parts) {
			if (p.end <= start || p.start >= end) next.push(p);
			else {
				if (p.start < start) next.push({ ...p, end: start });
				if (p.end > end) next.push({ ...p, id: partId(), start: end });
			}
		}
		const fresh: Part = { id: partId(), start, end, name: partName(next.filter((p) => p.end <= start).length), on: true };
		parts = [...next, fresh].sort((a, b) => a.start - b.start);
		focus = fresh.id;
	}

	function play(p: Part) {
		focus = p.id;
		currentTime = p.start;
		stopAt = p.end;
		paused = false;
	}

	// Stop at the end of a part you asked to hear; while auditioning, jump
	// over anything that won't be in the export.
	$effect(() => {
		const t = currentTime;
		if (paused) return;
		if (stopAt != null && t >= stopAt) {
			paused = true;
			stopAt = null;
			return;
		}
		if (!audition || stopAt != null) return;
		const k = kept(parts);
		if (!k.length || k.some((p) => t >= p.start && t < p.end)) return;
		const next = k.find((p) => p.start > t);
		if (next) currentTime = next.start;
		else if (t < D) paused = true;
	});

	let names = $state('');
	function applyNames() {
		const lines = names.split(/\r?\n/).map((l) => l.replace(/^\s*\d+[.)\-:\s]+/, '').trim()).filter(Boolean);
		let k = 0;
		for (const p of parts) if (p.on && k < lines.length) p.name = lines[k++];
	}

	function renumber() {
		let k = 0;
		for (const p of parts) if (p.on) p.name = partName(k++);
	}

	function onKey(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable || e.ctrlKey || e.metaKey || e.altKey) return;
		const k = e.key.toLowerCase();
		if (k === 's') splitAtPlayhead();
		else if (k === 'x') {
			const i = at(currentTime);
			if (i >= 0) parts[i].on = !parts[i].on;
		} else if (k === ']' || k === '[') {
			const list = parts;
			const i = k === ']' ? list.findIndex((p) => p.start > currentTime + 0.05) : list.findLastIndex((p) => p.start < currentTime - 0.5);
			if (i >= 0) {
				focus = list[i].id;
				currentTime = list[i].start;
			}
		}
	}

	/* ------------------------------------------------------------------
	 * Export
	 * ---------------------------------------------------------------- */

	const keptParts = $derived(kept(parts));
	const keptSec = $derived(lengthOf(keptParts));
	const outSec = $derived(exp.as === 'joined' ? joinedLength(parts, hasVideo ? exp.gapMs : exp.crossfadeMs > 0 ? 0 : exp.gapMs, hasVideo ? 0 : exp.crossfadeMs) : keptSec);

	function body(): Record<string, unknown> {
		return { kind: 'parts', parts: $state.snapshot(parts), export: $state.snapshot(exp) };
	}

	function exportNow() {
		onstart(body());
	}

	function preview() {
		onpreview({ ...body(), preview: { fromPart: previewFrom?.id ?? null, seconds: 30 } }, exportNow);
	}

	// Which part the preview starts from: the focused one if it's kept,
	// otherwise the first kept part after it.
	const previewFrom = $derived.by(() => {
		const f = parts.find((p) => p.id === focus);
		return f?.on ? f : (keptParts.find((p) => !f || p.start >= f.start) ?? keptParts[0]);
	});
	const previewLabel = $derived.by(() => {
		if (!previewFrom) return 'Preview';
		const n = idx(previewFrom.id) + 1;
		if (exp.as === 'separate') return `Preview part ${n}`;
		const k = keptParts.indexOf(previewFrom);
		const next = keptParts[k + 1] ?? keptParts[k - 1];
		return next ? `Preview the cut ${k + 1 < keptParts.length ? 'after' : 'before'} part ${n}` : `Preview part ${n}`;
	});

	const formats = $derived(hasVideo ? ['same', 'mp4', 'mp3', 'm4a', 'wav', 'flac'] : ['same', 'mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus']);
</script>

<svelte:window onkeydown={onKey} />

<div class="stack">
	<div class="panel-title">
		<h3>Parts</h3>
		<span class="caps muted">{saved ? 'saved' : 'saving…'}</span>
	</div>
	<p class="help">
		Find the parts of a long recording, fix them by hand, then export them as separate files or as one file with
		everything you left out removed. Edits are saved next to the file.
	</p>

	<!-- Detect ---------------------------------------------------------------->
	<div class="stack-tight box">
		<div class="seg" role="group" aria-label="How to find parts">
			<button type="button" aria-pressed={detect.mode === 'silence'} onclick={() => (detect.mode = 'silence')}>Pauses</button>
			<button type="button" aria-pressed={detect.mode === 'speech'} onclick={() => (detect.mode = 'speech')}>Speech (AI)</button>
			<button type="button" aria-pressed={detect.mode === 'every'} onclick={() => (detect.mode = 'every')}>Every N min</button>
			<button type="button" aria-pressed={detect.mode === 'count'} onclick={() => (detect.mode = 'count')}>N equal</button>
			<button type="button" aria-pressed={detect.mode === 'manual'} onclick={() => (detect.mode = 'manual')}>Manual</button>
		</div>

		{#if detect.mode === 'silence' || detect.mode === 'every' || detect.mode === 'count'}
			{#if detect.mode === 'silence' || detect.snapToPauses}
				<div class="row" style="gap: 0.75rem; align-items: end;">
					<div style="flex: 1; min-width: 12rem;">
						<Range label="Pause = quieter than" bind:value={detect.thresholdDb} min={-80} max={-15} format={(v) => `${v} dB`} />
					</div>
					<button type="button" class="btn-ghost btn-small" onclick={auto} disabled={levelBusy} title="Measure the noise floor and programme level and pick a threshold between them">
						{levelBusy ? 'Measuring…' : 'Auto'}
					</button>
				</div>
				{#if level}
					<div class="help mono">quiet passages peak at {level.floorDb} dB · programme {level.programDb} dB → pause below {level.suggestedDb} dB</div>
				{/if}
			{/if}
		{:else if detect.mode === 'speech'}
			<Range label="Speech sensitivity" bind:value={detect.vadThreshold} min={0.1} max={0.9} step={0.05} format={(v) => v.toFixed(2)} />
		{/if}

		{#if detect.mode === 'silence' || detect.mode === 'speech'}
			<div class="grid-2">
				<Range label="Pause longer than" bind:value={detect.minPauseSec} min={0.3} max={30} step={0.1} format={(v) => `${v.toFixed(1)} s`} help="Shorter pauses stay inside a part." />
				<Range label="Keep at each edge" bind:value={detect.padMs} min={0} max={2000} step={50} format={(v) => `${v} ms`} help="Room tone left around each part, so nothing is clipped." />
			</div>
			<Range label="Parts shorter than" bind:value={detect.minPartSec} min={0} max={120} step={1} format={(v) => (v ? `${v} s` : 'off')} />
			<div class="seg" role="group" aria-label="Short parts">
				<button type="button" aria-pressed={detect.shortParts === 'exclude'} onclick={() => (detect.shortParts = 'exclude')}>…are excluded</button>
				<button type="button" aria-pressed={detect.shortParts === 'merge'} onclick={() => (detect.shortParts = 'merge')}>…merge into a neighbour</button>
			</div>
		{:else if detect.mode === 'every'}
			<Range label="Part length" bind:value={detect.everySec} min={30} max={3600} step={30} format={(v) => formatDuration(v)} />
			<label class="field-check"><input type="checkbox" bind:checked={detect.snapToPauses} /> Move each cut to the nearest real pause</label>
		{:else if detect.mode === 'count'}
			<Range label="Parts" bind:value={detect.count} min={2} max={50} format={(v) => String(v)} />
			<label class="field-check"><input type="checkbox" bind:checked={detect.snapToPauses} /> Move each cut to the nearest real pause</label>
		{/if}

		<div class="row" style="gap: 0.5rem;">
			<button type="button" class="btn" class:btn-primary={stale || !parts.length} onclick={run} disabled={detecting}>
				{detecting ? 'Detecting…' : parts.length ? 'Detect again' : 'Detect'}
			</button>
			{#if stale}<span class="help">Settings changed — detect again to apply them.</span>{/if}
			{#if levelBusy && !parts.length}<span class="help">Measuring this recording's levels to pick a pause threshold…</span>{/if}
			{#if detecting && D > 600}<span class="help">The first scan of a long file takes a few seconds; changes after that are instant.</span>{/if}
		</div>
		{#if detectError}<div class="error"><div class="mono">{detectError}</div></div>{/if}
	</div>

	<!-- Review ---------------------------------------------------------------->
	{#if parts.length}
		<div class="stats" style="gap: 1rem 2.5rem;">
			<div><div class="caps muted">Parts</div><div class="stat__value" style="font-size: var(--fs-3);">{keptParts.length}<small> / {parts.length}</small></div></div>
			<div><div class="caps muted">Kept</div><div class="stat__value" style="font-size: var(--fs-3);">{formatDuration(keptSec)}</div></div>
			<div><div class="caps muted">Removed</div><div class="stat__value" style="font-size: var(--fs-3);">{formatDuration(Math.max(0, D - keptSec))}</div></div>
			<div><div class="caps muted">{exp.as === 'joined' ? 'One file' : 'Files'}</div><div class="stat__value" style="font-size: var(--fs-3);"><mark>{exp.as === 'joined' ? formatDuration(outSec) : keptParts.length}</mark></div></div>
		</div>

		<div class="row spread" style="gap: 0.5rem;">
			<div class="row" style="gap: 0.4rem;">
				<button type="button" class="btn-ghost btn-small" onclick={splitAtPlayhead} title="S">Split at {formatTimecode(currentTime)}</button>
				<button type="button" class="btn-ghost btn-small" onclick={addFromSelection} disabled={!selection}>Part from selection</button>
				<button type="button" class="btn-ghost btn-small" onclick={() => parts.forEach((p) => (p.on = true))}>Include all</button>
				<button type="button" class="btn-ghost btn-small" onclick={renumber}>Renumber</button>
			</div>
			<label class="field-check" title="While playing, jump over everything that won't be exported"><input type="checkbox" bind:checked={audition} /> Skip removed while playing</label>
		</div>
		<div class="help"><kbd>S</kbd> split at playhead · <kbd>X</kbd> include/exclude part under playhead · <kbd>[</kbd> <kbd>]</kbd> previous/next part · drag part edges on the waveform</div>

		<div class="parts">
			{#each parts as p, i (p.id)}
				<div class="part" class:is-off={!p.on} class:is-focus={focus === p.id} class:is-now={currentTime >= p.start && currentTime < p.end}>
					<button type="button" class="part__n mono" onclick={() => ((focus = p.id), (currentTime = p.start))} title="Go to part">{i + 1}</button>
					<input type="checkbox" bind:checked={p.on} aria-label="Include part {i + 1}" />
					<input type="text" class="input-small part__name" bind:value={p.name} aria-label="Name of part {i + 1}" />
					<span class="mono part__time">
						<input type="number" class="input-small" step="0.1" min="0" bind:value={p.start} onchange={sorted} aria-label="Start" />
						<input type="number" class="input-small" step="0.1" min="0" bind:value={p.end} onchange={sorted} aria-label="End" />
					</span>
					<span class="mono part__len" class:muted={!p.on}>{formatDuration(p.end - p.start)}</span>
					<span class="part__actions">
						<button type="button" class="btn-ghost btn-icon" onclick={() => play(p)} title="Play this part">▶</button>
						<button type="button" class="btn-ghost btn-icon" onclick={() => mergeNext(i)} disabled={i === parts.length - 1} title="Merge with next">⤓</button>
						<button type="button" class="btn-icon" onclick={() => remove(i)} title="Delete part">✕</button>
					</span>
				</div>
			{/each}
		</div>

		<details>
			<summary class="caps" style="cursor: pointer;">Paste a tracklist</summary>
			<div class="stack-tight" style="margin-block-start: 0.5rem;">
				<textarea rows="5" bind:value={names} placeholder={'One name per line, in order — numbers like "01." are stripped.\nIntro\nSong for Ikaria\n…'}></textarea>
				<div><button type="button" class="btn-small" onclick={applyNames} disabled={!names.trim()}>Name the {keptParts.length} kept parts</button></div>
			</div>
		</details>

		<!-- Export ---------------------------------------------------------------->
		<div class="stack-tight box">
			<h4 class="caps" style="font-size: var(--fs-small);">Export</h4>
			<div class="seg" role="group" aria-label="Export as">
				<button type="button" aria-pressed={exp.as === 'joined'} onclick={() => (exp.as = 'joined')}>One file, removed parts cut out</button>
				<button type="button" aria-pressed={exp.as === 'separate'} onclick={() => (exp.as = 'separate')}>Separate file per part</button>
			</div>

			{#if exp.as === 'joined'}
				<div class="field">
					<span class="caps">Between parts</span>
					<div class="seg">
						{#each [[0, 'Nothing'], [300, '0.3 s'], [600, '0.6 s'], [1000, '1 s'], [2000, '2 s']] as [ms, l] (ms)}
							<button type="button" aria-pressed={exp.crossfadeMs === 0 && exp.gapMs === ms} onclick={() => ((exp.gapMs = Number(ms)), (exp.crossfadeMs = 0))}>{l} silence</button>
						{/each}
						{#if !hasVideo}
							<button type="button" aria-pressed={exp.crossfadeMs > 0} onclick={() => (exp.crossfadeMs = exp.crossfadeMs || 1500)}>Crossfade</button>
						{/if}
					</div>
				</div>
				{#if exp.crossfadeMs > 0 && !hasVideo}
					<Range label="Crossfade" bind:value={exp.crossfadeMs} min={100} max={8000} step={100} format={(v) => `${(v / 1000).toFixed(1)} s`} />
				{/if}
				<label class="field-check"><input type="checkbox" bind:checked={exp.chapters} /> A chapter marker per part (MP3, M4A, MP4)</label>
			{/if}

			<Range label="Fade at each edge" bind:value={exp.fadeMs} min={0} max={3000} step={10} format={(v) => (v ? `${v} ms` : 'off')} help="20–50 ms removes clicks at cut points; longer is a deliberate fade." />

			<div class="field">
				<span class="caps">Loudness</span>
				<div class="row" style="gap: 0.5rem;">
					<div class="seg">
						<button type="button" aria-pressed={exp.normalize === 'none'} onclick={() => (exp.normalize = 'none')}>As is</button>
						<button type="button" aria-pressed={exp.normalize === 'each'} onclick={() => (exp.normalize = 'each')}>Each part</button>
						{#if exp.as === 'joined'}
							<button type="button" aria-pressed={exp.normalize === 'all'} onclick={() => (exp.normalize = 'all')}>Whole file</button>
						{/if}
					</div>
					{#if exp.normalize !== 'none'}
						<select class="input-small" style="inline-size: auto;" bind:value={exp.lufs} aria-label="Target loudness">
							{#each [[-14, 'Streaming −14'], [-16, 'Podcast −16'], [-19, 'Mono podcast −19'], [-23, 'Broadcast −23']] as [v, l] (v)}<option value={v}>{l} LUFS</option>{/each}
						</select>
					{/if}
				</div>
				<div class="help">Two-pass EBU R128 with a linear gain — levels even out between parts without squashing them.</div>
			</div>

			<div class="row" style="gap: 0.5rem;">
				<select class="input-small" style="inline-size: auto;" bind:value={exp.format} aria-label="Format">
					{#each formats as f (f)}<option value={f}>{f === 'same' ? `Same as source (${source.name.split('.').pop()})` : f}</option>{/each}
				</select>
				<div class="seg">
					{#each QUALITIES as q (q)}<button type="button" aria-pressed={exp.quality === q} onclick={() => (exp.quality = q)}>{q}</button>{/each}
				</div>
			</div>

			<details>
				<summary class="caps" style="cursor: pointer;">Tags</summary>
				<div class="grid-2" style="margin-block-start: 0.5rem;">
					<div class="field"><label for="tg-artist">Artist</label><input id="tg-artist" type="text" class="input-small" bind:value={exp.tags.artist} /></div>
					<div class="field"><label for="tg-album">Album / show</label><input id="tg-album" type="text" class="input-small" bind:value={exp.tags.album} placeholder={source.name.replace(/\.[^.]+$/, '')} /></div>
					<div class="field"><label for="tg-year">Year</label><input id="tg-year" type="text" class="input-small" bind:value={exp.tags.year} /></div>
					<div class="field"><label for="tg-genre">Genre</label><input id="tg-genre" type="text" class="input-small" bind:value={exp.tags.genre} /></div>
				</div>
				<div class="help">Separate files get these plus a title (the part name) and track number (01/12).</div>
			</details>

			<div class="row" style="gap: 0.5rem;">
				<button type="button" class="btn" onclick={preview} disabled={!keptParts.length}>
					{previewLabel}
				</button>
				<button type="button" class="btn-primary" onclick={exportNow} disabled={!keptParts.length}>
					{exp.as === 'joined' ? `Export one file (${formatDuration(outSec)})` : `Export ${keptParts.length} files`}
				</button>
			</div>
			<div class="row help" style="gap: 0.4rem;">
				Cue list:
				<a href="{docUrl}?format=csv">CSV</a>
				<a href="{docUrl}?format=labels" title="Audacity: File → Import → Labels">Audacity labels</a>
				<a href="{docUrl}?format=cue" title="Split the original in DJ software or a player">CUE sheet</a>
				<a href="{docUrl}?format=chapters" title="Paste into a YouTube description">YouTube chapters</a>
			</div>
		</div>
	{/if}
</div>

<style>
	.box {
		border: 1.5px solid var(--ink);
		padding: 1rem;
	}

	.parts {
		display: grid;
		max-block-size: 26rem;
		overflow-y: auto;
		border-block: 1px solid var(--ink);
	}

	.part {
		display: grid;
		grid-template-columns: 2.2rem auto minmax(6rem, 1fr) auto 3.5rem auto;
		gap: 0.5rem;
		align-items: center;
		padding: 0.3rem 0;
		border-block-start: 1px solid color-mix(in oklab, var(--ink) 12%, transparent);
	}

	.part.is-off .part__name,
	.part.is-off .part__time {
		opacity: 0.45;
		text-decoration: line-through;
	}

	.part.is-now {
		background: color-mix(in oklab, var(--ink) 4%, var(--bg));
	}

	.part.is-focus {
		box-shadow: inset 0.3rem 0 0 var(--accent);
	}

	.part__n {
		padding: 0.25rem 0;
		justify-content: center;
		font-size: 0.72rem;
		background: var(--screen);
		color: var(--screen-ink);
	}

	.part.is-focus .part__n {
		color: var(--accent);
	}

	.part__time {
		display: flex;
		gap: 0.25rem;
	}

	.part__time input {
		inline-size: 5.2rem;
		padding: 0.25rem 0.35rem !important;
		font-size: 0.72rem !important;
	}

	.part__len {
		font-size: 0.75rem;
		text-align: end;
	}

	.part__actions {
		display: flex;
		gap: 0.2rem;
	}

	@media (max-width: 700px) {
		.part {
			grid-template-columns: 2.2rem auto minmax(0, 1fr) 3.5rem;
		}
		.part__time,
		.part__actions {
			grid-column: 2 / -1;
		}
	}
</style>

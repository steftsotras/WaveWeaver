<script lang="ts">
	import type { PageData } from './$types';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import JobPanel from '$lib/JobPanel.svelte';
	import PreviewPanel from '$lib/PreviewPanel.svelte';
	import Waveform from '$lib/Waveform.svelte';
	import {
		cueAt,
		cueId,
		DEFAULT_REFLOW,
		LANGUAGES,
		languageName,
		parseSubtitles,
		reflow,
		rewrap,
		shiftCues,
		type CaptionTrack,
		type Cue,
		type TrackSummary,
	} from '$lib/captions';
	import type { EngineStatus } from '$lib/engine';
	import type { JobView } from '$lib/jobs';
	import { formatDuration, formatTimecode, mediaUrl, peaksUrl, refKey, stemOf } from '$lib/media';

	let { data }: { data: PageData } = $props();

	const source = $derived(data.source);
	const hasVideo = $derived(Boolean(source?.info?.video));
	const D = $derived(source?.info?.duration ?? 0);
	const jobId = $derived(page.url.searchParams.get('job'));
	const ref = $derived(source ? { bin: source.bin, kind: source.kind, name: source.name } : null);
	const trackUrl = (lang: string) => `/api/captions/${encodeURIComponent(ref!.bin)}/${ref!.kind}/${encodeURIComponent(ref!.name)}/${lang}`;

	let currentTime = $state(0);
	let paused = $state(true);
	let selection = $state<{ start: number; end: number } | null>(null);
	let mediaEl = $state<HTMLMediaElement | null>(null);

	/* ----------------------------------------------------------------------
	 * Tracks
	 * -------------------------------------------------------------------- */

	let tracks = $state<TrackSummary[]>([]);
	let lang = $state<string | null>(null);
	let compareLang = $state<string>('');
	let cues = $state<Cue[]>([]);
	let compare = $state<Cue[]>([]);
	let origin = $state<CaptionTrack['origin'] | null>(null);
	let saveState = $state<'saved' | 'dirty' | 'saving' | 'error'>('saved');
	let history: string[] = [];

	// Runs only when the server's track list changes. `lang` is read untracked:
	// otherwise picking a just-created track (not yet in a stale data.tracks)
	// would re-run this and snap the editor back to the old one.
	$effect(() => {
		const list = data.tracks;
		untrack(() => {
			tracks = list;
			if (!lang || !list.some((t) => t.lang === lang)) {
				if (!tracks.some((t) => t.lang === lang)) lang = list[list.length - 1]?.lang ?? null;
			}
		});
	});

	async function refreshTracks(select?: string) {
		if (!ref) return;
		const res = await fetch(`/api/captions?bin=${encodeURIComponent(ref.bin)}&kind=${ref.kind}&name=${encodeURIComponent(ref.name)}`);
		if (res.ok) tracks = (await res.json()).tracks;
		if (select) {
			loadedLang = null;
			lang = select;
		}
	}

	let loadedLang = $state<string | null>(null);

	$effect(() => {
		const l = lang;
		if (!ref || !l || loadedLang === l) return;
		fetch(trackUrl(l))
			.then((r) => (r.ok ? r.json() : null))
			.then((t: CaptionTrack | null) => {
				cues = t?.cues ?? [];
				origin = t?.origin ?? null;
				history = [];
				saveState = 'saved';
				loadedLang = l;
			});
	});

	$effect(() => {
		const l = compareLang;
		if (!ref || !l) {
			compare = [];
			return;
		}
		fetch(trackUrl(l))
			.then((r) => (r.ok ? r.json() : null))
			.then((t: CaptionTrack | null) => (compare = t?.cues ?? []));
	});

	// Autosave: every edit lands on disk (JSON + SRT) shortly after you stop typing.
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let lastSaved = '';
	$effect(() => {
		const snapshot = JSON.stringify($state.snapshot(cues));
		if (!lang || loadedLang !== lang) return;
		if (!lastSaved || lastSaved.startsWith(`${lang}:`) === false) {
			lastSaved = `${lang}:${snapshot}`;
			return;
		}
		if (lastSaved === `${lang}:${snapshot}`) return;
		saveState = 'dirty';
		if (saveTimer) clearTimeout(saveTimer);
		const l = lang;
		saveTimer = setTimeout(async () => {
			saveState = 'saving';
			const res = await fetch(trackUrl(l), {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cues: JSON.parse(snapshot) }),
			}).catch(() => null);
			saveState = res?.ok ? 'saved' : 'error';
			if (res?.ok) lastSaved = `${l}:${snapshot}`;
		}, 700);
	});

	/** Structural edits go through here so they can be undone. */
	function edit(next: Cue[]) {
		history.push(JSON.stringify($state.snapshot(cues)));
		if (history.length > 50) history.shift();
		cues = next;
	}

	function undo() {
		const prev = history.pop();
		if (prev) cues = JSON.parse(prev);
	}

	/* ----------------------------------------------------------------------
	 * Playback: the cue on screen, and the word being spoken.
	 * -------------------------------------------------------------------- */

	const active = $derived(cueAt(cues, currentTime));
	const activeCue = $derived(active >= 0 ? cues[active] : null);
	let follow = $state(true);
	let listEl = $state<HTMLElement | null>(null);

	$effect(() => {
		if (!follow || active < 0 || paused || !listEl) return;
		listEl.querySelector(`[data-cue="${active}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	});

	function seek(t: number, play = false) {
		currentTime = t;
		if (play) paused = false;
	}

	function compareText(c: Cue): string {
		const byId = compare.find((x) => x.id === c.id);
		if (byId) return byId.text;
		return compare
			.filter((x) => x.end > c.start + 0.05 && x.start < c.end - 0.05)
			.map((x) => x.text)
			.join(' ');
	}

	/* ----------------------------------------------------------------------
	 * Cue operations
	 * -------------------------------------------------------------------- */

	function splitAt(i: number) {
		const c = cues[i];
		const t = currentTime > c.start + 0.1 && currentTime < c.end - 0.1 ? currentTime : (c.start + c.end) / 2;
		let left: string;
		let right: string;
		let wl = c.words;
		let wr = c.words;
		if (c.words?.length) {
			wl = c.words.filter((w) => w.e <= t + 0.01);
			wr = c.words.filter((w) => w.e > t + 0.01);
			left = wl.map((w) => w.w.trim()).join(' ');
			right = wr.map((w) => w.w.trim()).join(' ');
		} else {
			const words = c.text.replace(/\n/g, ' ').split(' ');
			const k = Math.max(1, Math.round((words.length * (t - c.start)) / (c.end - c.start)));
			left = words.slice(0, k).join(' ');
			right = words.slice(k).join(' ');
		}
		const next = [...cues];
		next.splice(i, 1, { ...c, end: t, text: left, words: wl }, { ...c, id: cueId(), start: t, text: right, words: wr, note: null });
		edit(next);
	}

	function mergeNext(i: number) {
		if (i >= cues.length - 1) return;
		const a = cues[i];
		const b = cues[i + 1];
		const next = [...cues];
		next.splice(i, 2, {
			...a,
			end: b.end,
			text: `${a.text.replace(/\n/g, ' ')} ${b.text.replace(/\n/g, ' ')}`,
			words: a.words && b.words ? [...a.words, ...b.words] : undefined,
			note: [a.note, b.note].filter(Boolean).join(' / ') || null,
		});
		edit(next);
	}

	function remove(i: number) {
		edit(cues.filter((_, k) => k !== i));
	}

	function insertAfter(i: number) {
		const prev = cues[i];
		const start = prev ? prev.end + 0.05 : currentTime;
		const end = Math.min(start + 2, cues[i + 1]?.start ?? start + 2);
		const next = [...cues];
		next.splice(i + 1, 0, { id: cueId(), start, end: Math.max(end, start + 0.5), text: '', speaker: prev?.speaker ?? null });
		edit(next);
	}

	let reflowChars = $state(DEFAULT_REFLOW.maxChars);
	function doReflow() {
		const opts = { ...DEFAULT_REFLOW, maxChars: reflowChars };
		const hasWords = cues.some((c) => c.words?.length);
		edit(hasWords ? reflow($state.snapshot(cues), opts) : rewrap($state.snapshot(cues), opts));
	}

	let shiftMs = $state(0);
	function doShift() {
		if (shiftMs) edit(shiftCues($state.snapshot(cues), shiftMs / 1000));
	}

	let find = $state('');
	let replaceWith = $state('');
	const matches = $derived(find ? cues.filter((c) => c.text.toLowerCase().includes(find.toLowerCase())).length : 0);
	function doReplace() {
		if (!find) return;
		const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
		edit(cues.map((c) => ({ ...c, text: c.text.replace(re, replaceWith) })));
	}

	function setSpeakerForSelection(name: string) {
		if (!selection) return;
		const s = selection;
		edit(cues.map((c) => (c.end > s.start && c.start < s.end ? { ...c, speaker: name || null } : c)));
	}

	async function importFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file || !ref) return;
		const parsed = parseSubtitles(await file.text());
		if (!parsed.length) {
			alert('No cues found in that file.');
			return;
		}
		const guess = /\.([a-z]{2})\.(srt|vtt)$/i.exec(file.name)?.[1]?.toLowerCase() ?? 'en';
		const l = prompt(`Language code for ${parsed.length} cues from ${file.name}`, guess);
		if (!l) return;
		const res = await fetch(trackUrl(l), {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cues: parsed, origin: { kind: 'import', file: file.name } }),
		});
		if (!res.ok) alert(`Import failed: ${(await res.json().catch(() => ({ message: '' }))).message}`);
		else refreshTracks(l);
	}

	async function newTrack() {
		const l = prompt('Language code for a new, empty track', 'en');
		if (!l || !ref) return;
		await fetch(trackUrl(l), {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cues: [{ id: cueId(), start: currentTime, end: currentTime + 2, text: '' }] }),
		});
		refreshTracks(l);
	}

	async function deleteTrack() {
		if (!lang || !confirm(`Delete the ${languageName(lang)} track (JSON and SRT)?`)) return;
		await fetch(trackUrl(lang), { method: 'DELETE' });
		loadedLang = null;
		lang = null;
		cues = [];
		refreshTracks();
	}

	/* ----------------------------------------------------------------------
	 * Jobs: transcribe (with a 30-second preview), translate, export
	 * -------------------------------------------------------------------- */

	let panel = $state<'transcribe' | 'translate' | 'export'>('transcribe');
	// Open on Translate once a file has captions — only on arrival, not on every refresh.
	let panelFor = '';
	$effect(() => {
		const key = ref ? `${ref.bin}/${ref.kind}/${ref.name}` : '';
		if (key === panelFor) return;
		panelFor = key;
		if (untrack(() => data.tracks.length)) panel = 'translate';
	});

	let engine = $state<EngineStatus | null>(null);
	$effect(() => {
		if (source && !engine) {
			fetch('/api/engine')
				.then((r) => r.json())
				.then((e) => (engine = e));
		}
	});
	const transcribeTool = $derived(engine?.tools.find((t) => t.id === 'transcribe'));
	const translateTool = $derived(engine?.tools.find((t) => t.id === 'translate'));

	let tx = $state({ model: 'auto', language: 'auto', task: 'transcribe', vad: true, prompt: '' });
	let tr = $state({ to: 'el', provider: 'auto' });
	let ex = $state({ speakers: false, size: 'm', position: 'bottom', box: true, color: 'white', container: 'mp4', soft: [] as string[] });

	let txPreviewJob = $state<string | null>(null);
	let txPreview = $state<JobView | null>(null);
	let burnPreviewJob = $state<string | null>(null);

	async function post(url: string, body: Record<string, unknown>): Promise<string | null> {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ source: ref, ...body }),
		});
		const json = await res.json().catch(() => ({}));
		if (!res.ok) {
			alert(`Failed: ${json.message ?? res.statusText}`);
			return null;
		}
		return json.id;
	}

	async function startJob(body: Record<string, unknown>) {
		const id = await post('/api/jobs', body);
		if (!id) return;
		const url = new URL(page.url);
		url.searchParams.set('job', id);
		goto(url, { replaceState: true, keepFocus: true, noScroll: true });
	}

	const window30 = $derived(
		selection && selection.end - selection.start > 1
			? { start: selection.start, duration: Math.min(90, selection.end - selection.start) }
			: { start: currentTime, duration: Math.min(30, Math.max(1, D - currentTime)) },
	);

	async function previewTranscribe() {
		txPreview = null;
		txPreviewJob = await post('/api/jobs', { kind: 'transcribe', ...$state.snapshot(tx), window: window30 });
	}

	$effect(() => {
		const id = txPreviewJob;
		if (!id) return;
		let alive = true;
		const poll = async () => {
			const r = await fetch(`/api/jobs/${id}`).then((x) => x.json()).catch(() => null);
			if (!alive || !r) return;
			txPreview = r.job;
			if (r.job.status === 'queued' || r.job.status === 'running') setTimeout(poll, 400);
		};
		poll();
		return () => {
			alive = false;
		};
	});

	const previewCues = $derived(((txPreview?.result?.data as { cues?: Cue[] } | undefined)?.cues ?? []) as Cue[]);

	function onJobDone(job: JobView) {
		const d = job.result?.data as { lang?: string } | undefined;
		if (job.status === 'done' && d?.lang) refreshTracks(d.lang);
		invalidateAll();
	}

	async function previewBurn() {
		if (!lang) return;
		burnPreviewJob = await post('/api/preview', {
			kind: 'subtitle',
			langs: [lang],
			style: { size: ex.size, position: ex.position, box: ex.box, color: ex.color },
			speakers: ex.speakers,
			window: { start: activeCue ? activeCue.start : currentTime, duration: 10 },
		});
	}

	function originLabel(o: CaptionTrack['origin'] | null): string {
		if (!o) return '';
		if (o.kind === 'whisper') return `Whisper ${o.model} · ${o.device}${o.task === 'translate' ? ' · translated' : ''}`;
		if (o.kind === 'translation') return `translated from ${languageName(o.from)} · ${o.provider}`;
		if (o.kind === 'import') return `imported ${o.file}`;
		return 'typed by hand';
	}

	function onKey(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable) return;
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
			e.preventDefault();
			undo();
			return;
		}
		if (e.key === ' ' && !['BUTTON', 'VIDEO', 'AUDIO', 'A'].includes(t.tagName)) {
			e.preventDefault();
			paused = !paused;
		}
	}
</script>

<svelte:window onkeydown={onKey} />

{#if !source}
	<section class="hero">
		<h1>Captions</h1>
		<p class="muted">
			Transcribe with Whisper, edit with word-level timing, translate with Claude or offline NLLB, and export SRT, VTT,
			burned-in or multi-language subtitles. Pick a file.
		</p>
	</section>
	{#each data.bins as bin (bin)}
		{@const rows = data.files.filter((f) => f.bin === bin)}
		{#if rows.length}
			<section class="stack">
				<h3>{bin}</h3>
				<div class="table-wrap">
					<table>
						<tbody>
							{#each rows as f (refKey(f))}
								{@const langs = data.counts[refKey(f)] ?? []}
								<tr>
									<td style="inline-size: 5rem;"><span class="tag" class:tag-accent={f.kind === 'renders'}>{f.kind === 'renders' ? 'render' : f.type}</span></td>
									<td>
										<a href="/captions?bin={encodeURIComponent(f.bin)}&kind={f.kind}&file={encodeURIComponent(f.name)}" style="font-weight: 600; word-break: break-word;">{f.name}</a>
									</td>
									<td class="num">{formatDuration(f.info?.duration)}</td>
									<td>
										{#each langs as l (l)}<span class="tag tag-accent" style="margin-inline-end: 0.3rem;">{l}</span>{:else}<span class="pip"></span>{/each}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/if}
	{/each}
{:else}
	<section class="stack-tight">
		<div class="row" style="gap: 0.5rem;">
			<span class="tag">{source.bin}</span>
			<span class="tag" class:tag-accent={source.kind === 'renders'}>{source.kind}</span>
			<a href="/captions" class="caps">Change file</a>
			<a href="/desk?bin={encodeURIComponent(source.bin)}&kind={source.kind}&file={encodeURIComponent(source.name)}" class="caps">Open on Desk</a>
		</div>
		<h2 style="font-size: clamp(1.5rem, 3vw, 2.5rem); word-break: break-word;">{stemOf(source.name)}</h2>
	</section>

	<section class="split">
		<div class="stack">
			<div class="stage" class:is-audio={!hasVideo}>
				{#if hasVideo}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video class="screen" src={mediaUrl(source)} preload="metadata" bind:this={mediaEl} bind:currentTime bind:paused onclick={() => (paused = !paused)}></video>
				{/if}
				{#if activeCue}
					<div class="stage__cue">
						{#if activeCue.speaker}<span class="stage__speaker">{activeCue.speaker}</span>{/if}
						{#if activeCue.words?.length}
							{#each activeCue.words as w, k (k)}<span class:is-now={currentTime >= w.s && currentTime < w.e}>{w.w.trim()}</span>{' '}{/each}
						{:else}
							{activeCue.text}
						{/if}
					</div>
				{/if}
			</div>
			{#if !hasVideo}
				<audio class="screen-audio" src={mediaUrl(source)} preload="metadata" controls bind:this={mediaEl} bind:currentTime bind:paused></audio>
			{:else}
				<div class="row spread">
					<button type="button" class="btn-small" onclick={() => (paused = !paused)}>{paused ? 'Play' : 'Pause'}</button>
					<span class="mono">{formatTimecode(currentTime)} / {formatTimecode(D)}</span>
				</div>
			{/if}

			<Waveform src={peaksUrl(source)} duration={D} {currentTime} bind:selection marks={cues.length < 400 ? cues.map((c) => c.start) : []} onseek={(t) => (currentTime = t)} />

			<div class="panel-title">
				<div class="row" style="gap: 0.4rem;">
					{#each tracks as t (t.lang)}
						<button type="button" class="btn-small" class:btn-primary={lang === t.lang} class:btn-ghost={lang !== t.lang} onclick={() => (lang = t.lang)}>
							{t.lang} <span style="opacity: 0.6; font-weight: 400;">{t.cues}</span>
						</button>
					{/each}
					<label class="btn btn-ghost btn-small" style="margin: 0; cursor: pointer;">
						Import SRT/VTT<input type="file" accept=".srt,.vtt,text/vtt" class="visually-hidden" onchange={importFile} />
					</label>
					<button type="button" class="btn-ghost btn-small" onclick={newTrack}>+ Empty</button>
				</div>
				{#if lang}
					<span class="caps muted">
						{saveState === 'saved' ? 'saved' : saveState === 'saving' ? 'saving…' : saveState === 'dirty' ? 'editing' : 'save failed'}
					</span>
				{/if}
			</div>

			{#if lang}
				<div class="help">{languageName(lang)} · {cues.length} cues · {originLabel(origin)}</div>
				<div class="toolbar">
					<div class="row" style="gap: 0.4rem;">
						<button type="button" class="btn-ghost btn-small" onclick={undo} title="Ctrl+Z">Undo</button>
						<input type="number" class="input-small" style="inline-size: 4.5rem;" min="20" max="80" bind:value={reflowChars} aria-label="Characters per line" />
						<button type="button" class="btn-ghost btn-small" onclick={doReflow} title="Rebuild cues: 2 lines, this many characters, ≤6 s, break at pauses and punctuation">Reflow</button>
						<input type="number" class="input-small" style="inline-size: 5.5rem;" step="50" bind:value={shiftMs} aria-label="Shift by milliseconds" />
						<button type="button" class="btn-ghost btn-small" onclick={doShift}>Shift ms</button>
					</div>
					<div class="row" style="gap: 0.4rem;">
						<input type="search" class="input-small" style="inline-size: 9rem;" placeholder="FIND" bind:value={find} />
						<input type="text" class="input-small" style="inline-size: 9rem;" placeholder="REPLACE" bind:value={replaceWith} />
						<button type="button" class="btn-ghost btn-small" onclick={doReplace} disabled={!matches}>Replace {matches || ''}</button>
					</div>
					<div class="row" style="gap: 0.4rem;">
						<select class="input-small" style="inline-size: auto;" bind:value={compareLang} aria-label="Compare with">
							<option value="">Compare with…</option>
							{#each tracks.filter((t) => t.lang !== lang) as t (t.lang)}<option value={t.lang}>{languageName(t.lang)}</option>{/each}
						</select>
						{#if selection}
							<button
								type="button"
								class="btn-small"
								onclick={() => {
									const n = prompt('Speaker for every cue in the selection');
									if (n != null) setSpeakerForSelection(n);
								}}>Speaker for selection</button
							>
						{/if}
						<label class="field-check"><input type="checkbox" bind:checked={follow} /> Follow</label>
						<button type="button" class="btn-ghost btn-small" onclick={deleteTrack}>Delete track</button>
					</div>
				</div>

				<div class="cues" bind:this={listEl}>
					{#each cues as c, i (c.id)}
						<div class="cue" class:is-now={i === active} data-cue={i}>
							<button type="button" class="cue__index mono" onclick={() => seek(c.start, true)} title="Play from here">{i + 1}</button>
							<div class="cue__times mono">
								<input type="number" step="0.01" min="0" class="input-small" bind:value={c.start} aria-label="Start" />
								<input type="number" step="0.01" min="0" class="input-small" bind:value={c.end} aria-label="End" />
								<span class="muted">{(c.end - c.start).toFixed(1)}s</span>
							</div>
							<div class="cue__body">
								<input type="text" class="input-small cue__speaker" placeholder="speaker" bind:value={c.speaker} />
								<textarea rows={Math.max(1, c.text.split('\n').length)} bind:value={c.text} class:is-long={c.text.split('\n').some((l) => l.length > reflowChars)}></textarea>
								{#if compareLang}<div class="cue__compare">{compareText(c)}</div>{/if}
								<input type="text" class="input-small cue__note" placeholder="✎ note (exported in TXT/VTT, never burned in)" bind:value={c.note} />
							</div>
							<div class="cue__actions">
								<button type="button" class="btn-ghost btn-icon" onclick={() => splitAt(i)} title="Split at playhead">⫶</button>
								<button type="button" class="btn-ghost btn-icon" onclick={() => mergeNext(i)} disabled={i === cues.length - 1} title="Merge with next">⤓</button>
								<button type="button" class="btn-ghost btn-icon" onclick={() => insertAfter(i)} title="Insert a cue after">＋</button>
								<button type="button" class="btn-icon" onclick={() => remove(i)} title="Delete">✕</button>
							</div>
						</div>
					{/each}
				</div>
			{:else}
				<div class="logs logs-empty">No captions yet. Transcribe on the right, or import an SRT.</div>
			{/if}
		</div>

		<div class="sticky stack">
			<div class="seg" role="group" aria-label="Caption tools">
				<button type="button" aria-pressed={panel === 'transcribe'} onclick={() => (panel = 'transcribe')}>Transcribe</button>
				<button type="button" aria-pressed={panel === 'translate'} disabled={!tracks.length} onclick={() => (panel = 'translate')}>Translate</button>
				<button type="button" aria-pressed={panel === 'export'} disabled={!tracks.length} onclick={() => (panel = 'export')}>Export</button>
			</div>

			{#if panel === 'transcribe'}
				<div class="stack-tight">
					<h3>Transcribe</h3>
					{#if engine && !engine.online}
						<div class="error"><strong class="caps">Engine offline</strong><div class="mono">{engine.error}</div></div>
					{:else if transcribeTool && !transcribeTool.available}
						<div class="error"><strong class="caps">Unavailable</strong><div class="mono">{transcribeTool.reason}</div></div>
					{/if}
					<div class="field">
						<span class="caps">Model</span>
						<div class="seg">
							{#each [['auto', 'Auto'], ['small', 'Small'], ['medium', 'Medium'], ['large-v3-turbo', 'Turbo'], ['large-v3', 'Large v3']] as [v, l] (v)}
								<button type="button" aria-pressed={tx.model === v} onclick={() => (tx.model = v)}>{l}</button>
							{/each}
						</div>
						<div class="help">Auto = Turbo on a GPU{engine?.device === 'cuda' ? ' (you have one)' : ''}, Small on CPU. First use downloads the weights.</div>
					</div>
					<div class="field">
						<label for="tx-lang">Spoken language</label>
						<select id="tx-lang" class="input-small" bind:value={tx.language}>
							<option value="auto">Auto-detect</option>
							{#each LANGUAGES as [c, n] (c)}<option value={c}>{n}</option>{/each}
						</select>
					</div>
					<div class="seg">
						<button type="button" aria-pressed={tx.task === 'transcribe'} onclick={() => (tx.task = 'transcribe')}>Transcribe</button>
						<button type="button" aria-pressed={tx.task === 'translate'} onclick={() => (tx.task = 'translate')}>Straight to English</button>
					</div>
					<label class="field-check"><input type="checkbox" bind:checked={tx.vad} /> Skip music &amp; silence (VAD)</label>
					<div class="field">
						<label for="tx-prompt">Vocabulary hint</label>
						<input id="tx-prompt" type="text" class="input-small" placeholder="Names, jargon, spellings" bind:value={tx.prompt} />
					</div>
					<div class="row" style="gap: 0.5rem;">
						<button type="button" class="btn" onclick={previewTranscribe}>Preview {formatTimecode(window30.start)} +{Math.round(window30.duration)}s</button>
						<button type="button" class="btn-primary" onclick={() => startJob({ kind: 'transcribe', ...$state.snapshot(tx) })}>Transcribe whole file</button>
					</div>
					{#if txPreviewJob}
						{#if !txPreview || txPreview.status === 'running' || txPreview.status === 'queued'}
							<div class="meter meter-indeterminate"><div class="meter__fill"></div><div class="meter__label"><span>{txPreview?.progress.phase ?? 'starting'}</span></div></div>
						{:else if txPreview.status === 'error'}
							<div class="error"><div class="mono">{txPreview.error}</div></div>
						{:else}
							<div class="preview-cues">
								<div class="caps muted">Preview · {languageName(String((txPreview.result?.data as { language?: string })?.language ?? ''))} · not saved</div>
								{#each previewCues as c (c.id)}
									<button type="button" class="preview-cue" onclick={() => seek(c.start, true)}>
										<span class="mono muted">{formatTimecode(c.start)}</span>
										<span>{c.text}</span>
									</button>
								{/each}
							</div>
						{/if}
					{/if}
				</div>
			{:else if panel === 'translate'}
				<div class="stack-tight">
					<h3>Translate</h3>
					{#if translateTool && !translateTool.available}
						<div class="error"><strong class="caps">No translator</strong><div class="mono">{translateTool.reason}</div></div>
					{/if}
					<div class="help">From <strong>{lang ? languageName(lang) : '—'}</strong> (the track open on the left). Every cue keeps its timing.</div>
					<div class="field">
						<label for="tr-to">Into</label>
						<select id="tr-to" class="input-small" bind:value={tr.to}>
							{#each LANGUAGES.filter(([c]) => c !== lang) as [c, n] (c)}<option value={c}>{n}</option>{/each}
						</select>
					</div>
					<div class="field">
						<span class="caps">Engine</span>
						<div class="seg">
							<button type="button" aria-pressed={tr.provider === 'auto'} onclick={() => (tr.provider = 'auto')}>Best available</button>
							<button type="button" aria-pressed={tr.provider === 'claude'} onclick={() => (tr.provider = 'claude')}>Claude</button>
							<button type="button" aria-pressed={tr.provider === 'nllb'} onclick={() => (tr.provider = 'nllb')}>NLLB offline</button>
						</div>
						<div class="help">
							Claude reads whole scenes so sentences split across cues stay coherent (needs ANTHROPIC_API_KEY). NLLB-200 runs
							locally on {engine?.device === 'cuda' ? 'your GPU' : 'the CPU'}; its weights are non-commercial (CC-BY-NC).
						</div>
					</div>
					<button type="button" class="btn-primary" disabled={!lang} onclick={() => startJob({ kind: 'translate', from: lang, to: tr.to, provider: tr.provider })}>
						Translate to {languageName(tr.to)}
					</button>
				</div>
			{:else}
				<div class="stack-tight">
					<h3>Export</h3>
					<label class="field-check"><input type="checkbox" bind:checked={ex.speakers} /> Prefix speaker names</label>
					<div class="row" style="gap: 0.4rem;">
						{#each ['srt', 'vtt', 'txt'] as f (f)}
							<a class="btn btn-ghost btn-small" href="{trackUrl(lang ?? 'en')}?format={f}{ex.speakers ? '&speakers' : ''}">{f}</a>
						{/each}
						<a class="btn btn-ghost btn-small" href={trackUrl(lang ?? 'en')} download="{stemOf(source.name)}.{lang}.json">json</a>
					</div>

					<h4 class="caps" style="font-size: var(--fs-small); margin-block-start: 1rem;">Burn in ({lang})</h4>
					<div class="seg">
						{#each [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']] as [v, l] (v)}
							<button type="button" aria-pressed={ex.size === v} onclick={() => (ex.size = v)}>{l}</button>
						{/each}
					</div>
					<div class="seg">
						<button type="button" aria-pressed={ex.position === 'bottom'} onclick={() => (ex.position = 'bottom')}>Bottom</button>
						<button type="button" aria-pressed={ex.position === 'top'} onclick={() => (ex.position = 'top')}>Top</button>
						<button type="button" aria-pressed={ex.box} onclick={() => (ex.box = !ex.box)}>Box</button>
					</div>
					<div class="seg">
						{#each ['white', 'yellow', 'accent'] as c (c)}
							<button type="button" aria-pressed={ex.color === c} onclick={() => (ex.color = c)}>{c}</button>
						{/each}
					</div>
					{#if !hasVideo}<div class="help">Audio only: the subtitles go over an accent waveform — a captioned audiogram.</div>{/if}
					<div class="row" style="gap: 0.5rem;">
						<button type="button" class="btn" onclick={previewBurn}>Preview 10s</button>
						<button
							type="button"
							class="btn-primary"
							onclick={() => startJob({ kind: 'subtitle', mode: 'burn', langs: [lang], style: { size: ex.size, position: ex.position, box: ex.box, color: ex.color }, speakers: ex.speakers })}
							>Render with subtitles</button
						>
					</div>

					{#if hasVideo}
						<h4 class="caps" style="font-size: var(--fs-small); margin-block-start: 1rem;">Subtitle tracks (switchable)</h4>
						<div class="row" style="gap: 0.75rem;">
							{#each tracks as t (t.lang)}
								<label class="field-check">
									<input
										type="checkbox"
										checked={ex.soft.includes(t.lang)}
										onchange={(e) => (ex.soft = (e.currentTarget as HTMLInputElement).checked ? [...ex.soft, t.lang] : ex.soft.filter((x) => x !== t.lang))}
									/>
									{languageName(t.lang)}
								</label>
							{/each}
						</div>
						<div class="row" style="gap: 0.5rem;">
							<div class="seg">
								<button type="button" aria-pressed={ex.container === 'mp4'} onclick={() => (ex.container = 'mp4')}>mp4</button>
								<button type="button" aria-pressed={ex.container === 'mkv'} onclick={() => (ex.container = 'mkv')}>mkv</button>
							</div>
							<button
								type="button"
								class="btn"
								disabled={!ex.soft.length}
								onclick={() => startJob({ kind: 'subtitle', mode: 'soft', langs: ex.soft, container: ex.container, speakers: ex.speakers })}
								>Mux {ex.soft.length || ''} tracks</button
							>
						</div>
						<div class="help">Video and audio are copied untouched; players show a subtitle menu.</div>
					{/if}
				</div>
			{/if}

			{#if burnPreviewJob}
				<PreviewPanel jobId={burnPreviewJob} onclose={() => (burnPreviewJob = null)} />
			{/if}
			<JobPanel {jobId} ondone={onJobDone} empty="Transcripts appear in the log as they're recognised." />
		</div>
	</section>
{/if}

<style>
	.stage {
		position: relative;
		background: var(--screen);
	}

	.stage.is-audio {
		aspect-ratio: 16 / 9;
		display: grid;
		place-items: center;
	}

	.stage__cue {
		position: absolute;
		inset: auto 5% 7% 5%;
		text-align: center;
		font-weight: 600;
		font-size: clamp(0.9rem, 2.2vw, 1.5rem);
		line-height: 1.35;
		color: #fff;
		background: rgba(10, 10, 10, 0.72);
		padding: 0.35em 0.6em;
		pointer-events: none;
		white-space: pre-wrap;
	}

	.stage.is-audio .stage__cue {
		position: static;
		background: none;
		font-size: clamp(1.1rem, 3vw, 2.2rem);
		max-inline-size: 85%;
	}

	.stage__cue .is-now {
		background: var(--accent);
		color: var(--on-accent);
	}

	.stage__speaker {
		display: block;
		font-family: var(--font-mono);
		font-size: 0.6em;
		color: var(--accent);
		text-transform: uppercase;
	}

	.toolbar {
		display: grid;
		gap: 0.5rem;
		padding-block: 0.75rem;
		border-block: 1px solid var(--ink);
	}

	.cues {
		display: grid;
		max-block-size: 70vh;
		overflow-y: auto;
		border-block-end: 1px solid var(--ink);
	}

	.cue {
		display: grid;
		grid-template-columns: 2.5rem 6.5rem minmax(0, 1fr) auto;
		gap: 0.6rem;
		align-items: start;
		padding: 0.5rem 0;
		border-block-start: 1px solid color-mix(in oklab, var(--ink) 15%, transparent);
	}

	.cue.is-now {
		background: color-mix(in oklab, var(--accent) 22%, var(--bg));
		box-shadow: inset 0.35rem 0 0 var(--accent);
	}

	.cue__index {
		padding: 0.35rem 0;
		justify-content: center;
		background: var(--screen);
		color: var(--accent);
		font-size: 0.75rem;
	}

	.cue__times {
		display: grid;
		gap: 0.25rem;
		font-size: 0.7rem;
	}

	.cue__times input {
		padding: 0.25rem 0.35rem !important;
		font-size: 0.75rem !important;
	}

	.cue__body {
		display: grid;
		gap: 0.3rem;
	}

	.cue__body textarea {
		min-height: 0;
		resize: vertical;
		font-family: var(--font-sans);
		font-size: 0.95rem;
		padding: 0.4rem 0.6rem;
	}

	.cue__body textarea.is-long {
		box-shadow: inset 0.25rem 0 0 var(--accent);
	}

	.cue__speaker {
		inline-size: 10rem;
		padding: 0.2rem 0.4rem !important;
		font-size: 0.7rem !important;
		font-family: var(--font-mono) !important;
		text-transform: uppercase;
	}

	.cue__note {
		border-style: dashed !important;
		padding: 0.2rem 0.4rem !important;
		font-size: 0.75rem !important;
	}

	.cue__compare {
		font-size: 0.85rem;
		color: var(--muted);
		padding-inline-start: 0.6rem;
		border-inline-start: 2px solid var(--accent);
	}

	.cue__actions {
		display: grid;
		grid-template-columns: repeat(2, auto);
		gap: 0.25rem;
	}

	.preview-cues {
		display: grid;
		gap: 0.2rem;
		max-block-size: 18rem;
		overflow-y: auto;
		border: 1.5px solid var(--ink);
		padding: 0.5rem;
	}

	.preview-cue {
		all: unset;
		cursor: pointer;
		display: grid;
		grid-template-columns: 4rem 1fr;
		gap: 0.5rem;
		font-size: 0.9rem;
		padding: 0.15rem 0.25rem;
	}

	.preview-cue:hover {
		background: var(--accent);
		color: var(--on-accent);
	}

	@media (max-width: 600px) {
		.cue {
			grid-template-columns: 2.5rem minmax(0, 1fr);
		}
		.cue__times,
		.cue__actions {
			grid-column: 2;
		}
		.cue__actions {
			grid-template-columns: repeat(4, auto);
			justify-content: start;
		}
	}
</style>

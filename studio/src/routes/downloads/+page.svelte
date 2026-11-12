<script lang="ts">
	import type { PageData } from './$types';
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import CopyButton from '$lib/CopyButton.svelte';
	import DownloadOptionsForm from '$lib/DownloadOptionsForm.svelte';
	import InspectPanel from '$lib/InspectPanel.svelte';
	import {
		COOKIE_BROWSERS,
		DEFAULT_OPTIONS,
		formatEta,
		formatSpeed,
		hostOf,
		isFinished,
		isRunning,
		optionsLine,
		parseClock,
		type AddingState,
		type DownloadEvent,
		type DownloadItem,
		type DownloadOptions,
		type DownloadSettings,
		type ProbeInfo,
		type Subscription,
		type YtdlpStatus,
	} from '$lib/downloads';
	import { deskUrl, formatBytes, formatDuration, mediaTypeOf, mediaUrl, thumbUrl } from '$lib/media';

	let { data }: { data: PageData } = $props();

	/* ------------------------------------------------------------------
	 * Live state, from the event stream
	 * ---------------------------------------------------------------- */

	// The server's snapshot seeds the page; from then on the event stream keeps it current.
	const initial = untrack(() => data.snapshot);
	const prefill = untrack(() => data.prefill);
	let items = $state<DownloadItem[]>(initial.items);
	let subs = $state<Subscription[]>(initial.subscriptions);
	let settings = $state<DownloadSettings>(initial.settings);
	let adding = $state<AddingState | null>(initial.adding);
	let ytdlp = $state<YtdlpStatus>(initial.ytdlp);
	let connected = $state(false);
	let now = $state(Date.now());

	type Notice = { id: number; level: 'info' | 'error'; message: string };
	let notices = $state<Notice[]>([]);
	let noticeId = 0;
	function notify(level: Notice['level'], message: string) {
		const id = ++noticeId;
		notices = [...notices.slice(-4), { id, level, message }];
		setTimeout(() => (notices = notices.filter((n) => n.id !== id)), level === 'error' ? 15000 : 7000);
	}

	function apply(e: DownloadEvent) {
		switch (e.type) {
			case 'snapshot':
				items = e.items;
				subs = e.subscriptions;
				settings = e.settings;
				adding = e.adding;
				ytdlp = e.ytdlp;
				break;
			case 'item': {
				const i = items.findIndex((x) => x.id === e.item.id);
				if (i === -1) items.push(e.item);
				else items[i] = e.item;
				break;
			}
			case 'remove':
				items = items.filter((x) => !e.ids.includes(x.id));
				break;
			case 'subscriptions':
				subs = e.subscriptions;
				break;
			case 'settings':
				settings = e.settings;
				break;
			case 'adding':
				adding = e.adding;
				break;
			case 'ytdlp':
				ytdlp = e.ytdlp;
				break;
			case 'notice':
				notify(e.level, e.message);
				break;
		}
	}

	onMount(() => {
		const source = new EventSource('/api/downloads/events');
		source.onmessage = (m) => apply(JSON.parse(m.data) as DownloadEvent);
		source.onopen = () => (connected = true);
		source.onerror = () => (connected = false);
		const clock = setInterval(() => (now = Date.now()), 1000);
		restoreForm();
		if (prefill) inspect();
		return () => {
			source.close();
			clearInterval(clock);
		};
	});

	/* ------------------------------------------------------------------
	 * The add form (remembered between visits)
	 * ---------------------------------------------------------------- */

	const FORM_KEY = 'ww:downloads:form';
	let options = $state<DownloadOptions>({ ...DEFAULT_OPTIONS });
	let urlText = $state(prefill);
	let password = $state('');
	let overridesText = $state('');
	let clipStartText = $state('');
	let clipEndText = $state('');
	let subInterval = $state(60);
	let titleFilter = $state('');
	let skipMembersOnly = $state(false);
	let advancedOpen = $state(false);
	let restored = $state(false);

	function restoreForm() {
		try {
			const saved = JSON.parse(localStorage.getItem(FORM_KEY) ?? 'null');
			if (saved?.options) options = { ...DEFAULT_OPTIONS, ...saved.options, clipStart: null, clipEnd: null, formatSpec: '', overrides: {}, namePrefix: '' };
			if (saved?.subInterval) subInterval = saved.subInterval;
			if (saved?.advancedOpen) advancedOpen = true;
		} catch {
			// storage blocked; start from the defaults
		}
		restored = true;
	}

	$effect(() => {
		const snapshot = JSON.stringify({ options, subInterval, advancedOpen });
		if (!restored) return;
		try {
			localStorage.setItem(FORM_KEY, snapshot);
		} catch {
			// storage blocked or full; the form just won't be remembered
		}
	});

	const urls = $derived(
		urlText
			.split(/\s+/)
			.map((u) => u.trim())
			.filter((u) => /^https?:\/\//i.test(u)),
	);

	const clipError = $derived.by(() => {
		const s = parseClock(clipStartText);
		const e = parseClock(clipEndText);
		if (Number.isNaN(s) || Number.isNaN(e)) return 'Times look like 90, 1:30 or 1:02:03.';
		if (s != null && e != null && e <= s) return 'The end comes after the start.';
		return null;
	});

	$effect(() => {
		if (clipError) return;
		options.clipStart = parseClock(clipStartText);
		options.clipEnd = parseClock(clipEndText);
	});

	function clockText(sec: number | null): string {
		if (sec == null) return '';
		const t = Math.round(sec);
		const h = Math.floor(t / 3600);
		const m = Math.floor((t % 3600) / 60);
		const s = String(t % 60).padStart(2, '0');
		return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
	}

	function setClip(start: number | null, end: number | null) {
		clipStartText = clockText(start);
		clipEndText = clockText(end);
		if (start != null || end != null) advancedOpen = true;
	}

	function payloadOptions(): DownloadOptions | null {
		let overrides: Record<string, unknown> = {};
		if (overridesText.trim()) {
			try {
				overrides = JSON.parse(overridesText);
			} catch {
				notify('error', 'yt-dlp options aren’t valid JSON.');
				return null;
			}
		}
		if (clipError) {
			notify('error', clipError);
			return null;
		}
		return { ...$state.snapshot(options), overrides };
	}

	async function api<T>(path: string, body: unknown, method = 'POST'): Promise<T | null> {
		try {
			const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
			const out = await res.json().catch(() => ({}));
			if (!res.ok) {
				notify('error', out.message ?? `Error ${res.status}`);
				return null;
			}
			return out as T;
		} catch (err) {
			notify('error', err instanceof Error ? err.message : String(err));
			return null;
		}
	}

	let submitting = $state(false);

	async function download(list: string[] | null = null, feedTitle?: string) {
		const targets = list ?? urls;
		if (!targets.length) return notify('error', 'Paste a link first.');
		const opts = payloadOptions();
		if (!opts) return;
		submitting = true;
		const result = await api<{ added: number; skipped: string[]; errors: string[] }>('/api/downloads', {
			urls: targets,
			options: opts,
			password: password || undefined,
			feedTitle,
		});
		submitting = false;
		if (!result) return;
		password = '';
		if (result.added) {
			notify('info', `${result.added} ${result.added === 1 ? 'download' : 'downloads'} added.`);
			if (!list) urlText = '';
		}
		for (const s of result.skipped.slice(0, 3)) notify('info', s);
		for (const e of result.errors.slice(0, 3)) notify('error', e);
	}

	async function subscribe() {
		if (urls.length !== 1) return notify('error', 'Paste one channel or playlist link to subscribe to.');
		const opts = payloadOptions();
		if (!opts) return;
		submitting = true;
		const sub = await api<Subscription>('/api/downloads/subscriptions', {
			url: urls[0],
			options: opts,
			intervalMinutes: subInterval,
			titleFilter,
			skipMembersOnly,
		});
		submitting = false;
		if (sub) {
			notify('info', `Subscribed to ${sub.name}. New uploads will be downloaded every ${sub.intervalMinutes} minutes.`);
			urlText = '';
		}
	}

	async function act(action: string, ids: string[] = [], extra: Record<string, unknown> = {}) {
		await api('/api/downloads/actions', { action, ids, ...extra });
	}

	/* ------------------------------------------------------------------
	 * Inspect — read a link before downloading it
	 * ---------------------------------------------------------------- */

	let inspecting = $state(false);
	let inspected = $state<{ url: string; info: ProbeInfo } | null>(null);
	let selecting = $state(false);
	let selectKey = '';

	async function inspect() {
		const url = urls[0];
		if (!url) return notify('error', 'Paste a link to inspect.');
		const opts = payloadOptions();
		if (!opts) return;
		inspecting = true;
		inspected = null;
		const out = await api<{ info: ProbeInfo }>('/api/downloads/inspect', { url, options: opts, password: password || undefined });
		inspecting = false;
		if (out) {
			inspected = { url, info: out.info };
			selectKey = selectionKey();
		}
	}

	function selectionKey(): string {
		const { type, codec, format, quality, formatSpec, captions, subtitleLanguage, subtitleMode, presets } = options;
		return JSON.stringify({ type, codec, format, quality, formatSpec, captions, subtitleLanguage, subtitleMode, presets, overridesText });
	}

	// Follow the form: re-run yt-dlp's format choice (offline) as options change.
	$effect(() => {
		const key = selectionKey();
		const current = inspected;
		if (!current || current.info.type !== 'video' || key === selectKey) return;
		const timer = setTimeout(async () => {
			const opts = payloadOptions();
			if (!opts) return;
			selectKey = key;
			selecting = true;
			const out = await api<{ selected: ProbeInfo['selected'] }>('/api/downloads/inspect', { url: current.url, options: opts, select: true });
			selecting = false;
			if (out && inspected?.url === current.url) inspected.info.selected = out.selected;
		}, 350);
		return () => clearTimeout(timer);
	});

	/* ------------------------------------------------------------------
	 * Queue and history
	 * ---------------------------------------------------------------- */

	const active = $derived(items.filter((i) => !isFinished(i.status)).sort((a, b) => a.createdAt - b.createdAt));
	let newestFirst = $state(true);
	let showAll = $state(false);
	const finished = $derived(
		items
			.filter((i) => isFinished(i.status))
			.sort((a, b) => ((b.finishedAt ?? 0) - (a.finishedAt ?? 0)) * (newestFirst ? 1 : -1)),
	);
	const shownFinished = $derived(showAll ? finished : finished.slice(0, 150));

	const counts = $derived({
		running: items.filter((i) => isRunning(i.status)).length,
		waiting: items.filter((i) => ['queued', 'pending', 'paused', 'scheduled'].includes(i.status)).length,
		done: items.filter((i) => i.status === 'done').length,
		failed: items.filter((i) => i.status === 'error').length,
		speed: items.reduce((s, i) => s + (isRunning(i.status) ? (i.progress.speed ?? 0) : 0), 0),
	});

	let pickedActive = $state<Set<string>>(new Set());
	let pickedDone = $state<Set<string>>(new Set());

	function togglePick(set: 'active' | 'done', id: string) {
		const s = new Set(set === 'active' ? pickedActive : pickedDone);
		if (s.has(id)) s.delete(id);
		else s.add(id);
		if (set === 'active') pickedActive = s;
		else pickedDone = s;
	}

	const pickedActiveIds = $derived(active.filter((i) => pickedActive.has(i.id)).map((i) => i.id));
	const pickedDoneIds = $derived(finished.filter((i) => pickedDone.has(i.id)).map((i) => i.id));

	async function remove(ids: string[]) {
		if (!ids.length) return;
		let deleteFiles = false;
		const withFiles = items.filter((i) => ids.includes(i.id) && i.files.length);
		if (settings.deleteFiles === 'ask' && withFiles.length) {
			deleteFiles = confirm(
				`Also delete the ${withFiles.length === 1 ? 'file' : `files of ${withFiles.length} downloads`} from the bin?\n\nOK deletes them. Cancel keeps them and only clears the list.`,
			);
		}
		await act('remove', ids, { deleteFiles });
		pickedDone = new Set();
	}

	let openLog = $state<string | null>(null);
	let logLines = $state<string[]>([]);

	$effect(() => {
		const id = openLog;
		if (!id) return;
		let timer: ReturnType<typeof setTimeout>;
		let stop = false;
		const load = async () => {
			const res = await fetch(`/api/downloads/${id}`).catch(() => null);
			if (stop) return;
			if (res?.ok) logLines = (await res.json()).logs;
			const item = items.find((i) => i.id === id);
			if (item && !isFinished(item.status)) timer = setTimeout(load, 1200);
		};
		load();
		return () => {
			stop = true;
			clearTimeout(timer);
		};
	});

	function mainFile(i: DownloadItem) {
		return i.files.find((f) => f.role === 'main' && f.folder === 'sources') ?? i.files.find((f) => f.folder === 'sources') ?? null;
	}

	function rowThumb(i: DownloadItem): string | null {
		const m = mainFile(i);
		if (m && mediaTypeOf(m.name) === 'video') return thumbUrl({ bin: m.bin, kind: 'sources', name: m.name });
		return i.thumbnail;
	}

	function captionsUrl(i: DownloadItem): string | null {
		const m = mainFile(i);
		return m && i.captions.length ? `/captions?bin=${encodeURIComponent(m.bin)}&kind=sources&file=${encodeURIComponent(m.name)}` : null;
	}

	function fileHref(i: DownloadItem, index: number): string {
		const f = i.files[index];
		return f.folder === 'sources' ? mediaUrl({ bin: f.bin, kind: 'sources', name: f.name }) : `/api/downloads/${i.id}/files/${index}`;
	}

	function when(ms: number | null): string {
		if (!ms) return '—';
		const d = new Date(ms);
		const today = new Date().toDateString() === d.toDateString();
		return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}

	function statusText(i: DownloadItem): string {
		switch (i.status) {
			case 'pending':
				return 'waiting for Start';
			case 'paused':
				return i.progress.ratio ? `paused at ${Math.round(i.progress.ratio * 100)}%` : 'paused';
			case 'queued':
				return 'queued';
			case 'scheduled':
				return i.releaseAt ? (i.releaseAt > now ? `live in ${formatEta((i.releaseAt - now) / 1000)}` : 'going live…') : 'scheduled';
			default:
				if (i.progress.phase === 'recording' && i.startedAt) return `recording · ${formatDuration((now - i.startedAt) / 1000)}`;
				return i.progress.phase ?? i.status;
		}
	}

	/* ------------------------------------------------------------------
	 * Subscriptions
	 * ---------------------------------------------------------------- */

	async function patchSub(id: string, patch: Partial<Subscription>) {
		await api('/api/downloads/subscriptions', { id, ...patch }, 'PATCH');
	}

	async function deleteSub(s: Subscription) {
		if (!confirm(`Unsubscribe from ${s.name}?\n\nWhat it already downloaded stays.`)) return;
		await api('/api/downloads/subscriptions', { ids: [s.id] }, 'DELETE');
	}

	function ago(ms: number | null): string {
		if (!ms) return 'never';
		const s = Math.max(0, (now - ms) / 1000);
		if (s < 60) return 'just now';
		if (s < 3600) return `${Math.floor(s / 60)} min ago`;
		if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
		return `${Math.floor(s / 86400)} d ago`;
	}

	/* ------------------------------------------------------------------
	 * Settings, cookies, yt-dlp
	 * ---------------------------------------------------------------- */

	let draft = $state<DownloadSettings>(structuredClone(initial.settings));
	let ytdlOptionsText = $state(JSON.stringify(initial.settings.ytdlOptions, null, 2));
	let presetsText = $state(JSON.stringify(initial.settings.presets, null, 2));
	let savingSettings = $state(false);

	async function saveSettings() {
		let ytdlOptions: Record<string, unknown>;
		let presets: Record<string, Record<string, unknown>>;
		try {
			ytdlOptions = ytdlOptionsText.trim() ? JSON.parse(ytdlOptionsText) : {};
			presets = presetsText.trim() ? JSON.parse(presetsText) : {};
		} catch {
			return notify('error', 'yt-dlp options and presets must be JSON objects.');
		}
		savingSettings = true;
		const out = await api<DownloadSettings>('/api/downloads/settings', { ...$state.snapshot(draft), ytdlOptions, presets }, 'PUT');
		savingSettings = false;
		if (out) {
			draft = structuredClone(out);
			notify('info', 'Settings saved.');
		}
	}

	async function uploadCookies(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		const res = await fetch('/api/downloads/cookies', { method: 'PUT', body: await file.text() });
		if (!res.ok) notify('error', (await res.json().catch(() => ({}))).message ?? 'Upload failed');
		else notify('info', 'Cookies saved. yt-dlp will use them for every download.');
	}

	async function deleteCookies() {
		await fetch('/api/downloads/cookies', { method: 'DELETE' });
	}

	let updating = $state(false);
	let updateLog = $state<string[]>([]);
	async function updateYtdlp() {
		updating = true;
		const out = await api<{ ok: boolean; log: string[] }>('/api/downloads/ytdlp', {});
		updating = false;
		if (out) updateLog = out.log;
	}

	const bookmarklet = $derived(`javascript:(()=>{window.open('${page.url.origin}/downloads?url='+encodeURIComponent(location.href))})()`);
</script>

<section class="hero">
	<h1>Downloads</h1>
	<p class="muted">
		Paste a link from YouTube or any of the sites yt-dlp supports. Videos land in a bin, ready for the Desk; captions come
		along as editable tracks. Inspect first to see exactly what you’ll get.
	</p>
</section>

{#if !ytdlp.ready}
	<div class="error stack-tight">
		<strong class="caps">yt-dlp isn’t ready</strong>
		<p>
			Downloads run yt-dlp from WaveWeaver’s Python environment, which <a href="/setup">Setup</a> installs.
			{#if ytdlp.error}<span class="mono">{ytdlp.error}</span>{/if}
		</p>
		<div class="row"><button class="btn-small" onclick={updateYtdlp} disabled={updating || ytdlp.updating}>{updating || ytdlp.updating ? 'Installing…' : 'Install yt-dlp'}</button></div>
	</div>
{/if}

<section class="stats">
	<div><div class="caps muted">Downloading</div><div class="stat__value">{#if counts.running}<mark>{counts.running}</mark>{:else}0{/if}</div></div>
	<div><div class="caps muted">Waiting</div><div class="stat__value">{counts.waiting}</div></div>
	<div><div class="caps muted">Done</div><div class="stat__value">{counts.done}</div></div>
	<div><div class="caps muted">Failed</div><div class="stat__value">{counts.failed}</div></div>
	<div><div class="caps muted">Speed</div><div class="stat__value">{counts.speed ? formatSpeed(counts.speed) : '—'}</div></div>
</section>

<!-- ------------------------------------------------------------------ add -->
<section class="stack">
	<form
		class="urlbar"
		onsubmit={(e) => {
			e.preventDefault();
			download();
		}}
	>
		<textarea
			bind:value={urlText}
			rows="1"
			placeholder="PASTE A LINK — VIDEO, PLAYLIST OR CHANNEL"
			title="One link per line to add several at once (Shift+Enter for a new line)"
			aria-label="Links to download"
			spellcheck="false"
			autocomplete="off"
			onkeydown={(e) => {
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					download();
				}
			}}
		></textarea>
		<div class="urlbar__actions">
			<button type="submit" class="btn-primary" disabled={submitting || !urls.length}>{submitting ? 'Adding…' : urls.length > 1 ? `Download ${urls.length}` : 'Download'}</button>
			<button type="button" class="btn-ghost" onclick={inspect} disabled={inspecting || !urls.length}>{inspecting ? 'Reading…' : 'Inspect'}</button>
			<button type="button" class="btn-ghost" onclick={subscribe} disabled={submitting || urls.length !== 1}>Subscribe</button>
		</div>
	</form>

	{#if adding}
		<div class="adding row">
			<span class="mono">
				Reading {adding.title ?? hostOf(adding.url)}{adding.total ? ` · ${adding.added} of ${adding.total}` : '…'}
			</span>
			<button type="button" class="btn-small btn-ghost" onclick={() => act('cancel-add')}>Stop adding</button>
		</div>
	{/if}

	{#each notices as n (n.id)}
		<div class="notice mono" class:is-error={n.level === 'error'}>{n.level === 'error' ? '✕' : '✓'} {n.message}</div>
	{/each}

	<DownloadOptionsForm bind:options bins={data.bins} defaultBin={settings.defaultBin} disabled={submitting} />

	<details class="advanced" bind:open={advancedOpen}>
		<summary class="caps">Advanced</summary>
		<div class="adv-grid">
			<div class="field">
				<label for="dl-clip-start">Clip from</label>
				<input id="dl-clip-start" type="text" bind:value={clipStartText} placeholder="0:00" disabled={options.type !== 'video' && options.type !== 'audio'} />
			</div>
			<div class="field">
				<label for="dl-clip-end">Clip to</label>
				<input id="dl-clip-end" type="text" bind:value={clipEndText} placeholder="end" disabled={options.type !== 'video' && options.type !== 'audio'} />
			</div>
			<div class="field">
				<label for="dl-prefix">Name prefix</label>
				<input id="dl-prefix" type="text" bind:value={options.namePrefix} placeholder="none" />
			</div>
			<div class="field">
				<label for="dl-fmt" title="A yt-dlp format selector (-f). Replaces type, codec and quality. Pick rows in Inspect to fill it.">Format selector</label>
				<input id="dl-fmt" type="text" class="mono-input" bind:value={options.formatSpec} placeholder="e.g. 137+140" />
			</div>
			<div class="field">
				<label for="dl-limit" title="How many entries of a playlist or channel to take (0 = all).">Playlist items</label>
				<input id="dl-limit" type="number" min="0" bind:value={options.playlistLimit} />
			</div>
			<div class="field">
				<label for="dl-pass" title="For password-protected videos (Vimeo…). Not saved anywhere.">Video password</label>
				<input id="dl-pass" type="text" bind:value={password} placeholder="none" autocomplete="off" />
			</div>
		</div>
		{#if clipError}<p class="help">✕ {clipError}</p>{/if}
		<div class="row" style="gap: 1.5rem;">
			<label class="field-check"><input type="checkbox" bind:checked={options.autoStart} /> Start right away</label>
			<label class="field-check" title="Cut out sponsor segments using SponsorBlock's crowd-sourced markers (YouTube only)."><input type="checkbox" bind:checked={options.sponsorblock} /> Remove sponsor segments</label>
			<label class="field-check"><input type="checkbox" bind:checked={options.splitChapters} /> Split by chapters</label>
		</div>
		{#if options.splitChapters}
			<div class="field">
				<label for="dl-chapter-tpl">Chapter file names</label>
				<input id="dl-chapter-tpl" type="text" class="mono-input" bind:value={options.chapterTemplate} placeholder={settings.chapterTemplate} />
			</div>
		{/if}

		<h4 class="sub-h">Subscriptions</h4>
		<div class="adv-grid">
			<div class="field">
				<label for="dl-interval">Check every (min)</label>
				<input id="dl-interval" type="number" min="5" bind:value={subInterval} />
			</div>
			<div class="field">
				<label for="dl-filter" title="Only titles matching this regular expression are downloaded. Empty = all.">Title filter</label>
				<input id="dl-filter" type="text" class="mono-input" bind:value={titleFilter} placeholder="regex, optional" />
			</div>
		</div>
		<label class="field-check"><input type="checkbox" bind:checked={skipMembersOnly} /> Skip members-only videos</label>

		<h4 class="sub-h">yt-dlp</h4>
		{#if Object.keys(settings.presets).length}
			<div class="row" style="gap: 0.5rem;">
				<span class="caps">Presets</span>
				{#each Object.keys(settings.presets) as p (p)}
					<button
						type="button"
						class="btn-small"
						class:btn-primary={options.presets.includes(p)}
						class:btn-ghost={!options.presets.includes(p)}
						onclick={() => (options.presets = options.presets.includes(p) ? options.presets.filter((x) => x !== p) : [...options.presets, p])}
					>{p}</button>
				{/each}
			</div>
		{/if}
		<div class="field">
			<label for="dl-overrides" title="yt-dlp API option names (not CLI flags) for this download only, as JSON.">Options for this download (JSON)</label>
			<textarea id="dl-overrides" rows="2" bind:value={overridesText} placeholder={'{"writedescription": true}'}></textarea>
		</div>
	</details>
</section>

{#if inspecting}
	<div class="logs logs-empty">Reading {urls[0]} …</div>
{:else if inspected}
	<InspectPanel
		info={inspected.info}
		bind:options
		{selecting}
		busy={submitting}
		ondownload={(list, feedTitle) => download(list ?? [inspected!.url], feedTitle)}
		onclip={setClip}
		onclose={() => (inspected = null)}
	/>
{/if}

<!-- ---------------------------------------------------------------- queue -->
<section class="stack">
	<div class="panel-title">
		<h3>In progress</h3>
		<div class="row" style="gap: 0.75rem;">
			{#if !connected}<span class="mono muted">reconnecting…</span>{/if}
			<button class="btn-small btn-ghost" onclick={() => act('start', pickedActiveIds)} disabled={!pickedActiveIds.length}>Start</button>
			<button class="btn-small btn-ghost" onclick={() => act('pause', pickedActiveIds)} disabled={!pickedActiveIds.length}>Pause</button>
			<button class="btn-small btn-ghost" onclick={() => act('cancel', pickedActiveIds)} disabled={!pickedActiveIds.length}>Cancel</button>
		</div>
	</div>

	{#if !active.length}
		<div class="logs logs-empty">Nothing downloading. Paste a link above.</div>
	{:else}
		<div class="table-wrap">
			<table class="dl">
				<thead>
					<tr>
						<th style="inline-size: 2rem;">
							<input
								type="checkbox"
								aria-label="Pick all"
								checked={active.length > 0 && active.every((i) => pickedActive.has(i.id))}
								onchange={(e) => (pickedActive = e.currentTarget.checked ? new Set(active.map((i) => i.id)) : new Set())}
							/>
						</th>
						<th style="inline-size: 7rem;"></th>
						<th>Download</th>
						<th style="min-inline-size: 16rem;">Progress</th>
						<th class="num">Speed</th>
						<th class="num">Left</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each active as i (i.id)}
						{@const running = isRunning(i.status)}
						<tr>
							<td><input type="checkbox" checked={pickedActive.has(i.id)} onchange={() => togglePick('active', i.id)} aria-label="Pick {i.title}" /></td>
							<td>
								<div class="thumb">{#if i.thumbnail}<img src={i.thumbnail} alt="" referrerpolicy="no-referrer" loading="lazy" />{/if}</div>
							</td>
							<td class="title-cell">
								<button type="button" class="linkish" onclick={() => (openLog = openLog === i.id ? null : i.id)} title="Show yt-dlp’s log">{i.title}</button>
								<div class="mono muted">
									{optionsLine(i.options)} · → {i.bin}{#if i.playlist} · {i.playlist.index}/{i.playlist.count}{/if}
									{#if i.live === 'is_live'}<span class="tag tag-accent">LIVE</span>{/if}
								</div>
							</td>
							<td>
								<div class="meter meter-slim" class:meter-indeterminate={running && i.progress.ratio == null}>
									<div class="meter__fill" style="inline-size: {Math.round((i.progress.ratio ?? 0) * 100)}%"></div>
									<div class="meter__label">
										<span>{statusText(i)}{#if i.progress.fragment} · {i.progress.fragment[0]}/{i.progress.fragment[1]}{/if}</span>
										<span>{#if i.progress.ratio != null && i.status !== 'queued'}{Math.round(i.progress.ratio * 100)}%{:else if i.progress.downloaded}{formatBytes(i.progress.downloaded)}{/if}</span>
									</div>
								</div>
							</td>
							<td class="num mono">{running ? formatSpeed(i.progress.speed) : ''}</td>
							<td class="num mono">{running && i.progress.eta != null ? formatEta(i.progress.eta) : ''}</td>
							<td>
								<div class="row actions">
									{#if i.status === 'pending' || i.status === 'paused' || i.status === 'scheduled'}
										<button class="btn-small" onclick={() => act('start', [i.id])}>{i.status === 'scheduled' ? 'Start now' : i.status === 'paused' ? 'Resume' : 'Start'}</button>
									{/if}
									{#if running && i.live === 'is_live'}
										<button class="btn-small" onclick={() => act('stop', [i.id])} title="Stop recording and keep what’s been recorded">Stop &amp; keep</button>
									{:else if running || i.status === 'queued'}
										<button class="btn-small btn-ghost" onclick={() => act('pause', [i.id])} title="Stop for now; Resume continues where it left off">Pause</button>
									{/if}
									<a class="btn btn-ghost btn-small" href={i.url} target="_blank" rel="noreferrer" title="Open the source">↗</a>
									<button class="btn-small btn-ghost" onclick={() => act('cancel', [i.id])} title="Cancel and throw away what’s downloaded">✕</button>
								</div>
							</td>
						</tr>
						{#if openLog === i.id}
							<tr class="detail"><td colspan="7"><pre class="logs">{logLines.join('\n') || 'No output yet.'}</pre></td></tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<!-- ------------------------------------------------------------- finished -->
<section class="stack">
	<div class="panel-title">
		<h3>Finished</h3>
		<div class="row" style="gap: 0.75rem;">
			<button class="btn-small btn-ghost" onclick={() => (newestFirst = !newestFirst)}>{newestFirst ? 'Newest first' : 'Oldest first'}</button>
			<button class="btn-small btn-ghost" onclick={() => act('retry', finished.filter((i) => i.status === 'error').map((i) => i.id))} disabled={!counts.failed}>Retry failed</button>
			<button class="btn-small btn-ghost" onclick={() => act('remove', finished.filter((i) => i.status === 'error').map((i) => i.id))} disabled={!counts.failed}>Clear failed</button>
			<button class="btn-small btn-ghost" onclick={() => act('remove', finished.filter((i) => i.status === 'done').map((i) => i.id))} disabled={!counts.done} title="Clears the list; files stay in their bins">Clear done</button>
			<button class="btn-small btn-ghost" onclick={() => remove(pickedDoneIds)} disabled={!pickedDoneIds.length}>Remove picked</button>
		</div>
	</div>

	{#if !finished.length}
		<div class="logs logs-empty">Finished downloads show up here, with a way onto the Desk.</div>
	{:else}
		<div class="table-wrap">
			<table class="dl">
				<thead>
					<tr>
						<th style="inline-size: 2rem;">
							<input
								type="checkbox"
								aria-label="Pick all"
								checked={finished.length > 0 && finished.every((i) => pickedDone.has(i.id))}
								onchange={(e) => (pickedDone = e.currentTarget.checked ? new Set(finished.map((i) => i.id)) : new Set())}
							/>
						</th>
						<th style="inline-size: 1.5rem;"></th>
						<th style="inline-size: 7rem;"></th>
						<th>Download</th>
						<th class="num">Size</th>
						<th class="num">When</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each shownFinished as i (i.id)}
						{@const m = mainFile(i)}
						{@const thumb = rowThumb(i)}
						<tr>
							<td><input type="checkbox" checked={pickedDone.has(i.id)} onchange={() => togglePick('done', i.id)} aria-label="Pick {i.title}" /></td>
							<td><span class="pip" class:pip-filled={i.status === 'done'} class:pip-ink={i.status === 'error'} title={i.status}></span></td>
							<td>
								{#if m}
									<a class="thumb" href={deskUrl({ bin: m.bin, kind: 'sources', name: m.name })} aria-label="Open {m.name} on the Desk">
										{#if thumb}<img src={thumb} alt="" referrerpolicy="no-referrer" loading="lazy" />{:else}<span>{m.name.split('.').pop()}</span>{/if}
									</a>
								{:else}
									<div class="thumb">{#if thumb}<img src={thumb} alt="" referrerpolicy="no-referrer" loading="lazy" />{/if}</div>
								{/if}
							</td>
							<td class="title-cell">
								<button type="button" class="linkish" onclick={() => (openLog = openLog === i.id ? null : i.id)}>{i.title}</button>
								<div class="mono muted">
									{optionsLine(i.options)}{#if i.bin} · {i.bin}{/if}{#if i.captions.length} · captions {i.captions.join(', ')}{/if}
								</div>
								{#each i.files as f, n (n)}
									<div class="mono file">
										<a href={fileHref(i, n)} target="_blank" rel="noreferrer">{f.name}</a>
										<span class="muted">{f.folder}{f.role === 'chapter' ? ' · chapter' : ''}</span>
									</div>
								{/each}
								{#if i.status === 'error' && i.error}
									<div class="err">
										<pre class="mono">{i.error}</pre>
										<CopyButton text={`${i.url}\n${i.error}`} label="Copy error" />
									</div>
								{/if}
							</td>
							<td class="num mono">{i.files.length ? formatBytes(i.files.reduce((s, f) => s + f.sizeBytes, 0)) : '—'}</td>
							<td class="num mono" title={i.finishedAt ? new Date(i.finishedAt).toLocaleString() : ''}>{when(i.finishedAt)}</td>
							<td>
								<div class="row actions">
									{#if i.status === 'error'}
										<button class="btn-small" onclick={() => act('retry', [i.id])}>Retry</button>
									{/if}
									{#if m}
										<a class="btn btn-small" href={deskUrl({ bin: m.bin, kind: 'sources', name: m.name })}>Desk</a>
									{/if}
									{#if captionsUrl(i)}
										<a class="btn btn-ghost btn-small" href={captionsUrl(i)}>Captions</a>
									{/if}
									{#if i.files.length}
										<a class="btn btn-ghost btn-small" href="{fileHref(i, i.files.indexOf(m ?? i.files[0]))}?download" title="Save a copy">↓</a>
									{/if}
									<a class="btn btn-ghost btn-small" href={i.url} target="_blank" rel="noreferrer" title="Open the source">↗</a>
									<button class="btn-small btn-ghost" onclick={() => remove([i.id])} title="Remove from the list">✕</button>
								</div>
							</td>
						</tr>
						{#if openLog === i.id}
							<tr class="detail"><td colspan="7"><pre class="logs">{logLines.join('\n') || 'The log is kept until the server restarts.'}</pre></td></tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
		{#if finished.length > shownFinished.length}
			<button class="btn-small btn-ghost" onclick={() => (showAll = true)}>Show all {finished.length}</button>
		{/if}
	{/if}
</section>

<!-- --------------------------------------------------------- subscriptions -->
<section class="stack">
	<div class="panel-title">
		<h3>Subscriptions</h3>
		<button class="btn-small btn-ghost" onclick={() => act('check', subs.map((s) => s.id))} disabled={!subs.length}>Check all now</button>
	</div>
	{#if !subs.length}
		<p class="help">
			Paste a channel or playlist link and press Subscribe: what’s there now is skipped, and every new upload is downloaded with
			the options you picked.
		</p>
	{:else}
		<div class="table-wrap">
			<table class="dl">
				<thead>
					<tr><th style="inline-size: 1.5rem;"></th><th>Channel or playlist</th><th class="num">Every</th><th>Filter</th><th class="num">Last check</th><th class="num">Seen</th><th></th></tr>
				</thead>
				<tbody>
					{#each subs as s (s.id)}
						<tr>
							<td><span class="pip" class:pip-filled={s.enabled && !s.error} class:pip-ink={!!s.error} title={s.enabled ? 'on' : 'off'}></span></td>
							<td class="title-cell">
								<a href={s.url} target="_blank" rel="noreferrer">{s.name}</a>
								<div class="mono muted">{optionsLine(s.options)} · → {s.options.binPerPlaylist ? 'own bin' : s.options.bin || settings.defaultBin}</div>
								{#if s.error}<div class="mono err-line">✕ {s.error}</div>{/if}
							</td>
							<td class="num">
								<input
									type="number"
									class="input-small"
									style="inline-size: 5rem;"
									min="5"
									value={s.intervalMinutes}
									onchange={(e) => patchSub(s.id, { intervalMinutes: Number(e.currentTarget.value) })}
									aria-label="Minutes between checks"
								/>
							</td>
							<td>
								<input
									type="text"
									class="input-small mono-input"
									value={s.titleFilter}
									placeholder="all titles"
									onchange={(e) => patchSub(s.id, { titleFilter: e.currentTarget.value })}
									aria-label="Title filter"
								/>
							</td>
							<td class="num mono">{s.checking ? 'checking…' : ago(s.lastChecked)}{#if s.lastFound} · +{s.lastFound}{/if}</td>
							<td class="num mono">{s.seenCount}</td>
							<td>
								<div class="row actions">
									<button class="btn-small btn-ghost" onclick={() => act('check', [s.id])} disabled={s.checking}>Check</button>
									<button class="btn-small" class:btn-ghost={!s.enabled} onclick={() => patchSub(s.id, { enabled: !s.enabled })}>{s.enabled ? 'On' : 'Off'}</button>
									<button class="btn-small btn-ghost" onclick={() => deleteSub(s)} title="Unsubscribe">✕</button>
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<!-- -------------------------------------------------------------- settings -->
<section class="stack">
	<details class="advanced">
		<summary class="caps">Settings</summary>
		<div class="adv-grid">
			<div class="field">
				<label for="s-conc">Downloads at once</label>
				<input id="s-conc" type="number" min="1" max="10" bind:value={draft.concurrency} />
			</div>
			<div class="field">
				<label for="s-bin">Default bin</label>
				<select id="s-bin" bind:value={draft.defaultBin}>
					{#each [...new Set([...data.bins, draft.defaultBin])] as b (b)}<option value={b}>{b}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="s-rate" title="Bytes per second, like 500K or 4.2M. Empty = as fast as possible.">Speed limit</label>
				<input id="s-rate" type="text" bind:value={draft.rateLimit} placeholder="unlimited" />
			</div>
			<div class="field">
				<label for="s-clear" title="Finished rows clear themselves after this many hours. Files stay. 0 = never.">Clear done after (h)</label>
				<input id="s-clear" type="number" min="0" bind:value={draft.clearAfterHours} />
			</div>
			<div class="field">
				<label for="s-scan" title="How many of the newest entries each subscription check reads.">Subscription scan</label>
				<input id="s-scan" type="number" min="5" max="500" bind:value={draft.subscriptionScan} />
			</div>
		</div>

		<div class="field">
			<span class="caps">Removing a finished row</span>
			<div class="seg" role="group" aria-label="Delete files when removing a row">
				{#each [['never', 'Keeps files'], ['ask', 'Asks'], ['always', 'Deletes files']] as [id, text] (id)}
					<button type="button" aria-pressed={draft.deleteFiles === id} onclick={() => (draft.deleteFiles = id as DownloadSettings['deleteFiles'])}>{text}</button>
				{/each}
			</div>
		</div>

		<h4 class="sub-h">File names</h4>
		<p class="help">
			yt-dlp <a href="https://github.com/yt-dlp/yt-dlp#output-template" target="_blank" rel="noreferrer">output templates</a>. Playlist
			fields (<code>%(playlist_index)s</code>, <code>%(playlist_title)s</code>) are filled in when the playlist is added.
		</p>
		<div class="adv-grid wide">
			<div class="field"><label for="s-t">Single videos</label><input id="s-t" type="text" class="mono-input" bind:value={draft.template} /></div>
			<div class="field"><label for="s-tp">From a playlist</label><input id="s-tp" type="text" class="mono-input" bind:value={draft.playlistTemplate} /></div>
			<div class="field"><label for="s-tc">From a channel</label><input id="s-tc" type="text" class="mono-input" bind:value={draft.channelTemplate} /></div>
			<div class="field"><label for="s-tch">Chapters</label><input id="s-tch" type="text" class="mono-input" bind:value={draft.chapterTemplate} /></div>
		</div>

		<h4 class="sub-h">Signing in</h4>
		<p class="help">
			For private, age-restricted and “confirm you’re not a bot” videos, give yt-dlp your cookies: a <code>cookies.txt</code> exported
			from your browser, or read straight from a browser (Firefox works best; Chrome locks its cookies while it’s open).
		</p>
		<div class="row" style="gap: 1rem;">
			<span class="mono">{ytdlp.cookies ? 'cookies.txt is set' : 'no cookies.txt'}</span>
			<label class="btn btn-small btn-ghost upload">Upload cookies.txt<input type="file" accept=".txt,text/plain" onchange={uploadCookies} /></label>
			{#if ytdlp.cookies}<button class="btn-small btn-ghost" onclick={deleteCookies}>Remove</button>{/if}
			<div class="field" style="min-inline-size: 12rem;">
				<select bind:value={draft.cookiesFromBrowser} aria-label="Cookies from browser">
					<option value="">No browser cookies</option>
					{#each COOKIE_BROWSERS as b (b)}<option value={b}>Cookies from {b}</option>{/each}
				</select>
			</div>
		</div>

		<h4 class="sub-h">yt-dlp options</h4>
		<p class="help">
			JSON objects of yt-dlp’s <a href="https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/YoutubeDL.py" target="_blank" rel="noreferrer">API option names</a>.
			Global options apply to every download; presets are named bundles you switch on per download under Advanced.
		</p>
		<div class="adv-grid wide">
			<div class="field"><label for="s-opts">Every download</label><textarea id="s-opts" rows="5" bind:value={ytdlOptionsText}></textarea></div>
			<div class="field"><label for="s-presets">Presets</label><textarea id="s-presets" rows="5" bind:value={presetsText} placeholder={'{"metadata": {"writeinfojson": true}}'}></textarea></div>
		</div>
		<div class="row"><button class="btn-primary" onclick={saveSettings} disabled={savingSettings}>{savingSettings ? 'Saving…' : 'Save settings'}</button></div>
	</details>
</section>

<footer class="foot row spread">
	<div class="mono muted">
		{#if ytdlp.ready}
			yt-dlp {ytdlp.ytdlp} · ejs {ytdlp.ejs ?? '—'} · Python {ytdlp.python} · JS runtime: node
		{:else}
			yt-dlp not installed
		{/if}
		· state in <code>{data.mediaRoot}/.downloads</code>
	</div>
	<div class="row" style="gap: 0.75rem;">
		<a class="btn btn-ghost btn-small" href={bookmarklet} title="Drag this to your bookmarks bar; click it on any video page to open it here" onclick={(e) => e.preventDefault()}>→ WaveWeaver</a>
		<button class="btn-small btn-ghost" onclick={updateYtdlp} disabled={updating || ytdlp.updating} title="Sites change constantly; yt-dlp keeps up. Update often.">{updating || ytdlp.updating ? 'Updating…' : 'Update yt-dlp'}</button>
	</div>
</footer>
{#if updateLog.length}
	<pre class="logs">{updateLog.join('\n')}</pre>
{/if}

<style>
	.urlbar {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.75rem;
	}

	@media (min-width: 1200px) {
		.urlbar {
			grid-template-columns: minmax(0, 1fr) auto;
			align-items: start;
		}
	}

	/* One line until you paste several links, then it grows with them. */
	.urlbar textarea {
		field-sizing: content;
		min-height: 0;
		max-block-size: 14rem;
		font-family: var(--font-sans);
		font-size: 1.05rem;
		padding: 0.95rem 1.1rem;
		resize: none;
		line-height: 1.4;
	}

	.urlbar__actions {
		display: flex;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.adding {
		gap: 1rem;
	}

	.notice {
		padding-inline-start: 0.2rem;
	}

	.notice.is-error {
		box-shadow: inset 0.25rem 0 0 var(--ink);
		padding-inline-start: 0.75rem;
	}

	.advanced {
		border-block-start: 1px solid var(--ink);
		padding-block-start: 1rem;
		display: grid;
		gap: 1.25rem;
	}

	.advanced[open] {
		gap: 1.25rem;
	}

	.advanced > summary {
		cursor: pointer;
		list-style: none;
		margin-block-end: 1rem;
	}

	.advanced > summary::before {
		content: '+ ';
		font-family: var(--font-mono);
	}

	.advanced[open] > summary::before {
		content: '− ';
	}

	.advanced > :global(* + *) {
		margin-block-start: 1.25rem;
	}

	.adv-grid {
		display: grid;
		gap: 1rem;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 12rem), 1fr));
	}

	.adv-grid.wide {
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 24rem), 1fr));
	}

	.adv-grid input,
	.adv-grid select,
	.adv-grid textarea {
		padding: 0.6rem 0.75rem;
		font-size: 0.9rem;
	}

	.mono-input {
		font-family: var(--font-mono) !important;
	}

	.sub-h {
		font-size: var(--fs-small);
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
		padding-block-start: 0.5rem;
	}

	.dl td {
		padding-block: 0.7rem;
	}

	.title-cell {
		max-inline-size: 40rem;
		word-break: break-word;
	}

	.linkish {
		all: unset;
		cursor: pointer;
		font-weight: 600;
		line-height: 1.3;
	}

	.linkish:hover {
		text-decoration: underline;
		text-decoration-thickness: 2px;
	}

	.thumb {
		display: grid;
		place-items: center;
		inline-size: 6.5rem;
		aspect-ratio: 16 / 9;
		background: var(--screen);
		overflow: hidden;
		text-decoration: none;
	}

	a.thumb:hover {
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

	.meter-slim {
		block-size: 1.9rem;
	}

	.actions {
		gap: 0.4rem;
		justify-content: flex-end;
		flex-wrap: nowrap;
	}

	.file {
		display: flex;
		gap: 0.75rem;
		flex-wrap: wrap;
		margin-block-start: 0.2rem;
	}

	.err {
		display: grid;
		gap: 0.5rem;
		justify-items: start;
		margin-block-start: 0.5rem;
	}

	.err pre {
		margin: 0;
		white-space: pre-wrap;
		word-break: break-word;
		max-block-size: 10rem;
		overflow: auto;
		box-shadow: inset 0.25rem 0 0 var(--ink);
		padding-inline-start: 0.75rem;
	}

	.err-line {
		margin-block-start: 0.25rem;
	}

	tr.detail:hover td {
		background: var(--bg);
	}

	tr.detail .logs {
		max-block-size: 22rem;
	}

	.upload {
		position: relative;
		overflow: hidden;
		margin: 0;
	}

	.upload input {
		position: absolute;
		inset: 0;
		opacity: 0;
		cursor: pointer;
	}

	.foot {
		border-block-start: 1px solid var(--ink);
		padding-block-start: 1rem;
		gap: 1rem;
	}
</style>

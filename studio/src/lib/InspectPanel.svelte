<script lang="ts">
	import { formatEntry, typeEntry, type DownloadOptions, type ProbeFormat, type ProbeInfo, type ProbeSelection } from '$lib/downloads';
	import { formatBytes, formatDuration } from '$lib/media';

	/**
	 * What a link is before anything is downloaded: for a video, which
	 * streams your options will fetch (marked in the formats table), its
	 * captions and chapters; for a playlist or channel, its entries to pick
	 * from. The download equivalent of a preview.
	 */
	let {
		info,
		options = $bindable(),
		selecting = false,
		busy = false,
		ondownload,
		onclip,
		onclose,
	}: {
		info: ProbeInfo;
		options: DownloadOptions;
		selecting?: boolean;
		busy?: boolean;
		ondownload: (urls: string[] | null, feedTitle?: string) => void;
		onclip: (start: number | null, end: number | null) => void;
		onclose: () => void;
	} = $props();

	const isFeed = $derived(info.type === 'playlist' || info.type === 'multi_video');
	const selected = $derived<ProbeSelection | null>(info.selected ?? null);
	const selectedIds = $derived(new Set(selected?.ids ?? []));

	/* ------------------------------------------------------------- video */

	const formats = $derived(
		[...(info.formats ?? [])].sort(
			(a, b) =>
				Number(!!b.vcodec && b.vcodec !== 'none') - Number(!!a.vcodec && a.vcodec !== 'none') ||
				(b.height ?? 0) - (a.height ?? 0) ||
				(b.tbr ?? 0) - (a.tbr ?? 0),
		),
	);
	let showFormats = $state(false);
	let picked = $state<string[]>([]);

	function kind(f: ProbeFormat): string {
		const v = f.vcodec && f.vcodec !== 'none';
		const a = f.acodec && f.acodec !== 'none';
		return v && a ? 'video+audio' : v ? 'video' : a ? 'audio' : '—';
	}

	function res(f: { width: number | null; height: number | null }): string {
		return f.height ? (f.width ? `${f.width}×${f.height}` : `${f.height}p`) : 'audio';
	}

	function codec(c: string | null): string {
		return !c || c === 'none' ? '—' : c.split('.')[0];
	}

	function pick(id: string) {
		picked = picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id];
	}

	function usePicked() {
		options.formatSpec = picked.join('+');
		picked = [];
	}

	const summary = $derived.by(() => {
		if (!selected) return null;
		const parts = selected.ids.map((id) => {
			const f = info.formats?.find((x) => x.id === id);
			if (!f) return id;
			const k = kind(f);
			if (k === 'audio') return `${id} · ${f.ext} · ${codec(f.acodec)}${f.abr ? ` ${Math.round(f.abr)}k` : ''}`;
			return `${id} · ${res(f)}${f.fps ? ` ${Math.round(f.fps)}fps` : ''} · ${codec(f.vcodec)}`;
		});
		return parts.join('  +  ');
	});

	const conversion = $derived.by(() => {
		if (options.formatSpec) return null;
		if (options.type === 'audio') {
			const f = formatEntry('audio', options.format);
			return options.format === 'auto' ? 'kept as served, moved into a taggable container' : `→ ${f?.text}${options.quality !== 'best' ? ` ${options.quality} kbps` : ''}`;
		}
		if (options.type === 'captions') return `captions only: ${options.subtitleLanguage} → ${formatEntry('captions', options.format)?.text}`;
		if (options.type === 'thumbnail') return 'the thumbnail only, as JPG';
		return null;
	});

	const manualSubs = $derived(Object.keys(info.subtitles ?? {}).filter((l) => l !== 'live_chat'));
	const origAuto = $derived(Object.keys(info.auto_captions ?? {}).filter((l) => l.endsWith('-orig')));
	const autoCount = $derived(Object.keys(info.auto_captions ?? {}).length);

	function uploaded(d: string | null): string {
		return d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : '';
	}

	/* ---------------------------------------------------------- playlist */

	let chosen = $state<Set<string>>(new Set());
	const entries = $derived(info.entries ?? []);
	const allChosen = $derived(entries.length > 0 && entries.every((e) => chosen.has(e.url)));

	function toggle(url: string) {
		const next = new Set(chosen);
		if (next.has(url)) next.delete(url);
		else next.add(url);
		chosen = next;
	}

	function toggleAll() {
		chosen = allChosen ? new Set() : new Set(entries.map((e) => e.url));
	}

	const totalChosen = $derived(entries.filter((e) => chosen.has(e.url)).reduce((s, e) => s + (e.duration ?? 0), 0));
</script>

<section class="inspect stack">
	<div class="panel-title">
		<h3>{isFeed ? 'Playlist' : 'Inspect'}</h3>
		<button type="button" class="btn-small btn-ghost" onclick={onclose}>Close</button>
	</div>

	<div class="head">
		{#if info.thumbnail}
			<div class="poster"><img src={info.thumbnail} alt="" referrerpolicy="no-referrer" loading="lazy" /></div>
		{/if}
		<div class="stack-tight">
			<h4>{info.title ?? info.url}</h4>
			<div class="meta mono muted">
				{#if info.uploader}<span>{info.uploader}</span>{/if}
				{#if isFeed}<span>{entries.length} entries</span>{:else}<span>{formatDuration(info.duration)}</span>{/if}
				{#if uploaded(info.upload_date)}<span>{uploaded(info.upload_date)}</span>{/if}
				{#if info.view_count}<span>{info.view_count.toLocaleString()} views</span>{/if}
				{#if info.extractor}<span>{info.extractor}</span>{/if}
				{#if info.live_status === 'is_live'}<span class="tag tag-accent">LIVE</span>{/if}
				{#if info.live_status === 'is_upcoming'}<span class="tag">UPCOMING{info.release_timestamp ? ` · ${new Date(info.release_timestamp * 1000).toLocaleString()}` : ''}</span>{/if}
				{#if info.availability && info.availability !== 'public'}<span class="tag tag-ghost">{info.availability}</span>{/if}
			</div>
			{#if !isFeed}
				<div class="will">
					<span class="caps">Will fetch</span>
					{#if selecting}
						<span class="mono muted">choosing…</span>
					{:else if options.formatSpec}
						<span class="mono"><mark>-f {options.formatSpec}</mark></span>
						<button type="button" class="btn-small btn-ghost" onclick={() => (options.formatSpec = '')}>Use {typeEntry(options.type)?.text} options</button>
					{:else if summary}
						<span class="mono"><mark>{summary}</mark></span>
						<span class="mono">{selected?.size ? `${selected.approx ? '≈ ' : ''}${formatBytes(selected.size)}` : 'size unknown'} → .{selected?.ext}</span>
					{:else}
						<span class="mono muted">nothing matches these options</span>
					{/if}
					{#if conversion}<span class="mono muted">{conversion}</span>{/if}
					{#if options.clipStart != null || options.clipEnd != null}
						<span class="mono">clip {formatDuration(options.clipStart ?? 0) === '—' ? '0:00' : formatDuration(options.clipStart ?? 0)}–{options.clipEnd != null ? formatDuration(options.clipEnd) : 'end'}</span>
					{/if}
				</div>
				<div class="row" style="gap: 0.75rem;">
					<button type="button" class="btn-primary" onclick={() => ondownload(null)} disabled={busy}>Download</button>
					<button type="button" class="btn-ghost" onclick={() => (showFormats = !showFormats)}>{showFormats ? 'Hide' : 'All'} formats ({formats.length})</button>
				</div>
			{/if}
		</div>
	</div>

	{#if !isFeed}
		{#if manualSubs.length || autoCount}
			<div class="stack-tight">
				<span class="caps">Captions</span>
				<div class="row" style="gap: 0.5rem;">
					{#each manualSubs as l (l)}
						<button type="button" class="btn-small" class:btn-primary={options.captions === l} class:btn-ghost={options.captions !== l} onclick={() => (options.captions = options.captions === l ? '' : l)} title="Fetch alongside as an editable track">{l}</button>
					{/each}
					{#each origAuto as l (l)}
						{@const lang = l.replace(/-orig$/, '')}
						<button type="button" class="btn-small" class:btn-primary={options.captions === lang} class:btn-ghost={options.captions !== lang} onclick={() => (options.captions = options.captions === lang ? '' : lang)} title="Automatic captions in the original language — with word timings">{lang} · auto</button>
					{/each}
					{#if autoCount > origAuto.length}<span class="help">+ {autoCount - origAuto.length} auto-translated</span>{/if}
				</div>
			</div>
		{/if}

		{#if info.chapters?.length}
			<div class="stack-tight">
				<span class="caps">Chapters — pick one to download just that</span>
				<ol class="chapters">
					{#each info.chapters as c, i (i)}
						{@const active = options.clipStart === c.start && options.clipEnd === c.end}
						<li>
							<button type="button" class="chapter" class:on={active} onclick={() => (active ? onclip(null, null) : onclip(c.start, c.end))}>
								<span class="mono">{formatDuration(c.start ?? 0) === '—' ? '0:00' : formatDuration(c.start ?? 0)}</span>
								<span>{c.title}</span>
							</button>
						</li>
					{/each}
				</ol>
			</div>
		{/if}

		{#if showFormats}
			<div class="stack-tight">
				<div class="row spread">
					<span class="help">Marked: what your options pick. Click rows to choose streams yourself (one video + one audio), then use them.</span>
					{#if picked.length}<button type="button" class="btn-small btn-primary" onclick={usePicked}>Use {picked.join('+')}</button>{/if}
				</div>
				<div class="table-wrap">
					<table class="formats">
						<thead>
							<tr><th>ID</th><th>Kind</th><th>Ext</th><th>Resolution</th><th class="num">FPS</th><th>Video</th><th>Audio</th><th class="num">Bitrate</th><th class="num">Size</th><th>Note</th></tr>
						</thead>
						<tbody>
							{#each formats as f (f.id)}
								<tr class:sel={selectedIds.has(f.id)} class:picked={picked.includes(f.id)} onclick={() => pick(f.id)}>
									<td class="mono">{f.id}</td>
									<td>{kind(f)}</td>
									<td class="mono">{f.ext}</td>
									<td class="mono">{res(f)}{f.hdr && f.hdr !== 'SDR' ? ` ${f.hdr}` : ''}</td>
									<td class="num mono">{f.fps ?? ''}</td>
									<td class="mono">{codec(f.vcodec)}</td>
									<td class="mono">{codec(f.acodec)}{f.channels ? ` ${f.channels}ch` : ''}</td>
									<td class="num mono">{f.tbr ? `${Math.round(f.tbr)}k` : ''}</td>
									<td class="num mono">{f.size ? `${f.approx ? '≈' : ''}${formatBytes(f.size)}` : ''}</td>
									<td class="muted">{[f.note, f.language, f.protocol?.startsWith('m3u8') ? 'hls' : ''].filter(Boolean).join(' · ')}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		{/if}
	{:else}
		<div class="row spread">
			<label class="field-check"><input type="checkbox" checked={allChosen} onchange={toggleAll} /> All {entries.length}</label>
			<div class="row" style="gap: 0.75rem;">
				{#if chosen.size}<span class="mono muted">{chosen.size} picked · {formatDuration(totalChosen)}</span>{/if}
				<button type="button" class="btn-ghost" onclick={() => ondownload(null)} disabled={busy}>Download all</button>
				<button type="button" class="btn-primary" onclick={() => ondownload([...chosen], info.title ?? undefined)} disabled={busy || !chosen.size}>Download picked</button>
			</div>
		</div>
		<div class="table-wrap entries">
			<table>
				<tbody>
					{#each entries as e, i (e.url + i)}
						<tr onclick={() => toggle(e.url)} class:picked={chosen.has(e.url)}>
							<td style="inline-size: 2rem;"><input type="checkbox" checked={chosen.has(e.url)} onclick={(ev) => ev.stopPropagation()} onchange={() => toggle(e.url)} aria-label="Pick {e.title}" /></td>
							<td class="num mono muted" style="inline-size: 3rem;">{i + 1}</td>
							<td style="inline-size: 6rem;">
								<div class="mini">{#if e.thumbnail}<img src={e.thumbnail} alt="" referrerpolicy="no-referrer" loading="lazy" />{/if}</div>
							</td>
							<td>
								<div style="font-weight: 600; word-break: break-word;">{e.title}</div>
								<div class="mono muted">
									{#if e.uploader}{e.uploader}{/if}
									{#if e.live_status === 'is_live'}<span class="tag tag-accent">LIVE</span>{/if}
									{#if e.live_status === 'is_upcoming'}<span class="tag">UPCOMING</span>{/if}
									{#if e.availability && e.availability !== 'public'}<span class="tag tag-ghost">{e.availability}</span>{/if}
								</div>
							</td>
							<td class="num mono">{formatDuration(e.duration)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	.inspect {
		border: 1.5px solid var(--ink);
		padding: clamp(1rem, 2.5vw, 2rem);
	}

	.head {
		display: grid;
		gap: 1.5rem;
		grid-template-columns: minmax(0, 1fr);
		align-items: start;
	}

	@media (min-width: 800px) {
		.head {
			grid-template-columns: minmax(0, 22rem) minmax(0, 1fr);
		}
	}

	.poster,
	.mini {
		aspect-ratio: 16 / 9;
		background: var(--screen);
		overflow: hidden;
	}

	.poster img,
	.mini img {
		inline-size: 100%;
		block-size: 100%;
		object-fit: cover;
		display: block;
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1rem;
		align-items: center;
	}

	.will {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		align-items: baseline;
		padding-block: 0.75rem;
		border-block: 1px solid var(--ink);
	}

	.chapters {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 1fr));
		gap: 0.25rem 1rem;
	}

	.chapter {
		all: unset;
		box-sizing: border-box;
		display: flex;
		gap: 0.75rem;
		inline-size: 100%;
		padding: 0.3rem 0.4rem;
		cursor: pointer;
		font-size: 0.9rem;
	}

	.chapter:hover {
		text-decoration: underline;
		text-decoration-thickness: 2px;
	}

	.chapter.on {
		background: var(--accent);
		color: var(--on-accent);
	}

	.formats {
		font-size: var(--fs-small);
	}

	.formats td,
	.entries td {
		padding-block: 0.45rem;
	}

	.formats tr,
	.entries tr {
		cursor: pointer;
	}

	/* What your options pick is state — the accent. What you click is ink. */
	.formats tr.sel td {
		background: var(--accent);
		color: var(--on-accent);
	}

	tr.picked td {
		box-shadow: inset 0 -2px 0 var(--ink), inset 0 2px 0 var(--ink);
	}

	.entries {
		max-block-size: 34rem;
		overflow-y: auto;
	}
</style>

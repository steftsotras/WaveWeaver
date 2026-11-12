<script lang="ts">
	import {
		AUDIO_TAGS,
		CATALOG,
		formatEntry,
		SUBTITLE_LANGUAGES,
		SUBTITLE_MODES,
		typeEntry,
		type DownloadOptions,
		type DownloadType,
	} from '$lib/downloads';

	/**
	 * The everyday choices for a download, rendered from the catalog: what to
	 * fetch (type, codec, format, quality…) and which bin it lands in. The
	 * rarer ones live under the page's Advanced section.
	 */
	let {
		options = $bindable(),
		bins,
		defaultBin,
		disabled = false,
	}: { options: DownloadOptions; bins: string[]; defaultBin: string; disabled?: boolean } = $props();

	const type = $derived(typeEntry(options.type)!);
	const format = $derived(formatEntry(options.type, options.format));
	let newBin = $state(false);

	function setType(id: DownloadType) {
		const t = typeEntry(id)!;
		options.type = id;
		options.format = t.defaultFormat;
		options.codec = 'auto';
		options.quality = 'best';
	}

	function setFormat(id: string) {
		options.format = id;
		if (!formatEntry(options.type, id)?.qualities?.some((q) => q.id === options.quality)) options.quality = 'best';
	}

	const binChoices = $derived([...new Set([...bins, ...(options.bin ? [options.bin] : [])])].sort((a, b) => a.localeCompare(b)));
</script>

<div class="opts">
	<div class="field">
		<span class="caps">Type</span>
		<div class="seg" role="group" aria-label="What to download">
			{#each CATALOG as t (t.id)}
				<button type="button" aria-pressed={options.type === t.id} onclick={() => setType(t.id)} {disabled}>{t.text}</button>
			{/each}
		</div>
	</div>

	<div class="grid">
		{#if type.codecs}
			<div class="field">
				<label for="dl-codec">Codec</label>
				<select id="dl-codec" bind:value={options.codec} {disabled}>
					{#each type.codecs as c (c.id)}<option value={c.id}>{c.text}</option>{/each}
				</select>
			</div>
		{/if}
		{#if type.formats.length > 1}
			<div class="field">
				<label for="dl-format">Format</label>
				<select id="dl-format" value={options.format} onchange={(e) => setFormat(e.currentTarget.value)} {disabled}>
					{#each type.formats as f (f.id)}<option value={f.id}>{f.text}</option>{/each}
				</select>
			</div>
		{/if}
		{#if format?.qualities && format.qualities.length > 1}
			<div class="field">
				<label for="dl-quality">Quality</label>
				<select id="dl-quality" bind:value={options.quality} {disabled}>
					{#each format.qualities as q (q.id)}<option value={q.id}>{q.text}</option>{/each}
				</select>
			</div>
		{/if}
		{#if options.type === 'audio'}
			<div class="field">
				<label for="dl-tags" title="Tags and cover art written into the file. Auto with “As served” keeps the audio exactly as the site sends it.">Tags</label>
				<select id="dl-tags" bind:value={options.audioTags} disabled={disabled || !format?.tags}>
					{#each AUDIO_TAGS as t (t.id)}<option value={t.id}>{t.text}</option>{/each}
				</select>
			</div>
		{/if}
		{#if options.type === 'captions'}
			<div class="field">
				<label for="dl-sublang">Language</label>
				<input id="dl-sublang" type="text" list="dl-langs" bind:value={options.subtitleLanguage} placeholder="en, pt-BR, zh-Hans" {disabled} />
			</div>
			<div class="field">
				<label for="dl-submode">Source</label>
				<select id="dl-submode" bind:value={options.subtitleMode} {disabled}>
					{#each SUBTITLE_MODES as m (m.id)}<option value={m.id}>{m.text}</option>{/each}
				</select>
			</div>
		{/if}
		{#if options.type === 'video' || options.type === 'audio'}
			<div class="field">
				<label for="dl-captions" title="Fetch this language's captions too, as an editable track on the file (Captions page). Manual captions first, then automatic ones.">Captions</label>
				<select id="dl-captions" bind:value={options.captions} {disabled}>
					<option value="">None</option>
					{#each SUBTITLE_LANGUAGES as l (l.id)}<option value={l.id}>{l.text}</option>{/each}
				</select>
			</div>
		{/if}
		<div class="field">
			<label for="dl-bin">Into bin</label>
			{#if newBin}
				<div class="row" style="gap: 0; flex-wrap: nowrap;">
					<input id="dl-bin" type="text" bind:value={options.bin} placeholder="NEW BIN" {disabled} style="border-inline-end: 0;" />
					<button type="button" class="btn-small btn-ghost" onclick={() => (newBin = false)} title="Pick an existing bin">×</button>
				</div>
			{:else}
				<select
					id="dl-bin"
					value={options.bin}
					onchange={(e) => {
						if (e.currentTarget.value === '\u0000new') {
							newBin = true;
							options.bin = '';
						} else options.bin = e.currentTarget.value;
					}}
					{disabled}
				>
					<option value="">Default ({defaultBin})</option>
					{#each binChoices as b (b)}<option value={b}>{b}</option>{/each}
					<option value={'\u0000new'}>New bin…</option>
				</select>
			{/if}
		</div>
	</div>

	<label class="field-check">
		<input type="checkbox" bind:checked={options.binPerPlaylist} {disabled} />
		A playlist or channel gets a bin of its own
	</label>
</div>

<datalist id="dl-langs">
	{#each SUBTITLE_LANGUAGES as l (l.id)}<option value={l.id}>{l.text}</option>{/each}
</datalist>

<style>
	.opts {
		display: grid;
		gap: 1.25rem;
	}

	.grid {
		display: grid;
		gap: 1rem;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 11rem), 1fr));
	}

	.field > .caps {
		margin: 0;
	}

	.field > .seg {
		justify-self: start;
	}

	select,
	input[type='text'] {
		padding: 0.6rem 0.75rem;
		font-size: 0.9rem;
	}

	select {
		padding-inline-end: 2.25rem;
	}
</style>

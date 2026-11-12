<script lang="ts">
	import Range from './Range.svelte';
	import type { EngineParam, EngineTool } from '$lib/engine';
	import { formatTimecode, refKey, type MediaFile } from '$lib/media';

	/**
	 * A form for any engine tool, generated from the schema the engine
	 * publishes. New plugins get a UI for free.
	 */
	let {
		tool,
		values = $bindable(),
		selection,
		files,
	}: {
		tool: EngineTool;
		values: Record<string, unknown>;
		selection: { start: number; end: number } | null;
		files: MediaFile[];
	} = $props();

	interface VstInfo {
		plugins: { path: string; name: string }[];
		states: { id: string; plugin: string; name: string }[];
	}
	let vst = $state<VstInfo | null>(null);
	let vstError = $state<string | null>(null);
	let editing = $state(false);

	async function loadVst() {
		try {
			const res = await fetch('/api/engine/vst');
			if (!res.ok) throw new Error((await res.json()).message);
			vst = await res.json();
		} catch (e) {
			vstError = e instanceof Error ? e.message : String(e);
		}
	}

	$effect(() => {
		if (tool.params.some((p) => p.kind === 'vst') && !vst) loadVst();
	});

	const pluginSlug = (path: string) =>
		(path.split(/[\\/]/).pop() ?? '').replace(/\.vst3$/i, '').replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '');

	async function openEditor() {
		const plugin = String(values.plugin ?? '');
		if (!plugin) return;
		const saveAs = prompt('Save the settings you make as…', 'My settings');
		if (!saveAs) return;
		editing = true;
		try {
			const res = await fetch('/api/engine/vst', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ plugin, state: values.state || null, saveAs }),
			});
			const json = await res.json();
			if (!res.ok) throw new Error(json.message);
			await loadVst();
			values.state = json.state;
		} catch (e) {
			alert(`Plugin window failed: ${e instanceof Error ? e.message : e}`);
		} finally {
			editing = false;
		}
	}

	function fmt(p: EngineParam) {
		return (v: number) => `${Number.isInteger(p.step ?? 1) ? Math.round(v) : v.toFixed(2)}${p.unit ? ` ${p.unit}` : ''}`;
	}

	function applyPreset(name: string) {
		Object.assign(values, tool.presets[name]);
	}
</script>

<div class="stack-tight">
	{#if Object.keys(tool.presets).length}
		<div class="row" style="gap: 0.4rem;">
			<span class="caps muted">Presets</span>
			{#each Object.keys(tool.presets) as name (name)}
				<button type="button" class="btn-ghost btn-small" onclick={() => applyPreset(name)}>{name}</button>
			{/each}
		</div>
	{/if}

	{#each tool.params as p (p.key)}
		{#if p.kind === 'number'}
			<Range
				label={p.label}
				bind:value={values[p.key] as number}
				min={p.min ?? 0}
				max={p.max ?? 1}
				step={p.step ?? 0.01}
				format={fmt(p)}
				help={p.help ?? ''}
			/>
		{:else if p.kind === 'bool'}
			<label class="field-check"><input type="checkbox" bind:checked={values[p.key] as boolean} /> {p.label}</label>
			{#if p.help}<div class="help">{p.help}</div>{/if}
		{:else if p.kind === 'select'}
			<div class="field">
				<span class="caps">{p.label}</span>
				{#if (p.options?.length ?? 0) <= 5}
					<div class="seg">
						{#each p.options ?? [] as o (o.value)}
							<button type="button" aria-pressed={values[p.key] === o.value} onclick={() => (values[p.key] = o.value)}>{o.label}</button>
						{/each}
					</div>
				{:else}
					<select bind:value={values[p.key]} class="input-small" style="max-width: 20rem;">
						{#each p.options ?? [] as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
					</select>
				{/if}
				{#if p.help}<div class="help">{p.help}</div>{/if}
			</div>
		{:else if p.kind === 'region'}
			{@const r = values[p.key] as [number, number] | null}
			<div class="field">
				<span class="caps">{p.label}</span>
				<div class="row" style="gap: 0.5rem;">
					{#if r}
						<span class="tag tag-accent">{formatTimecode(r[0])} → {formatTimecode(r[1])}</span>
						<button type="button" class="btn-ghost btn-small" onclick={() => (values[p.key] = null)}>Clear</button>
					{:else}
						<span class="tag tag-ghost">none</span>
					{/if}
					<button
						type="button"
						class="btn-small"
						disabled={!selection}
						onclick={() => selection && (values[p.key] = [selection.start, selection.end])}
					>
						Use selection
					</button>
				</div>
				{#if p.help}<div class="help">{p.help}</div>{/if}
			</div>
		{:else if p.kind === 'media'}
			{@const cur = values[p.key] as { bin: string; kind: string; name: string } | null}
			<div class="field">
				<label for="tf-{p.key}">{p.label}</label>
				<select
					id="tf-{p.key}"
					class="input-small"
					value={cur ? refKey(cur as never) : ''}
					onchange={(e) => {
						const f = files.find((x) => refKey(x) === (e.currentTarget as HTMLSelectElement).value);
						values[p.key] = f ? { bin: f.bin, kind: f.kind, name: f.name } : null;
					}}
				>
					<option value="">Choose a file…</option>
					{#each files as f (refKey(f))}<option value={refKey(f)}>{f.bin} / {f.name}</option>{/each}
				</select>
				{#if p.help}<div class="help">{p.help}</div>{/if}
			</div>
		{:else if p.kind === 'vst'}
			<div class="field">
				<label for="tf-{p.key}">{p.label}</label>
				{#if vstError}
					<div class="help">✕ {vstError}</div>
				{:else if !vst}
					<div class="help">Scanning VST3 folders…</div>
				{:else}
					<select id="tf-{p.key}" class="input-small" bind:value={values[p.key]}>
						<option value="">Choose a plugin…</option>
						{#each vst.plugins as pl (pl.path)}<option value={pl.path}>{pl.name}</option>{/each}
					</select>
					<div class="help">{vst.plugins.length} VST3 plugins found. Instruments won't work — pick an effect.</div>
				{/if}
			</div>
		{:else if p.kind === 'text' && p.key === 'state' && tool.params.some((x) => x.kind === 'vst')}
			{@const plugin = String(values.plugin ?? '')}
			{@const mine = vst?.states.filter((s) => s.plugin === pluginSlug(plugin)) ?? []}
			<div class="field">
				<label for="tf-state">{p.label}</label>
				<div class="row" style="gap: 0.5rem;">
					<select id="tf-state" class="input-small" style="inline-size: auto;" bind:value={values.state}>
						<option value="">Plugin defaults</option>
						{#each mine as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
					</select>
					<button type="button" class="btn-small" disabled={!plugin || editing} onclick={openEditor}>
						{editing ? 'Window open — close it to save' : 'Open plugin window'}
					</button>
				</div>
				<div class="help">Opens the plugin's own interface on this computer. Dial it in, close the window, and those settings are saved for rendering.</div>
			</div>
		{:else if p.kind === 'text'}
			<div class="field">
				<label for="tf-{p.key}">{p.label}</label>
				<input id="tf-{p.key}" type="text" class="input-small" bind:value={values[p.key]} />
				{#if p.help}<div class="help">{p.help}</div>{/if}
			</div>
		{/if}
	{/each}

	{#if tool.credits}<div class="help mono">{tool.credits}</div>{/if}
</div>

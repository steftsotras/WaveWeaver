<script lang="ts">
	import EqCurve from './EqCurve.svelte';
	import Range from './Range.svelte';
	import { formatTimecode } from '$lib/media';
	import { ASPECTS, FPS_CHOICES, metaFor, SCALE_HEIGHTS, type Step } from '$lib/weave';

	let {
		step = $bindable(),
		index,
		count,
		currentTime,
		selection,
		duration,
		previewing = false,
		onremove,
		onmove,
		onpreview,
	}: {
		step: Step;
		index: number;
		count: number;
		currentTime: number;
		selection: { start: number; end: number } | null;
		duration: number | null;
		previewing?: boolean;
		onremove: () => void;
		onmove: (dir: -1 | 1) => void;
		onpreview?: () => void;
	} = $props();

	const meta = $derived(metaFor(step.op));
	const round1 = (n: number) => Math.round(n * 10) / 10;
	const signed = (n: number, unit: string) => `${n > 0 ? '+' : ''}${n}${unit}`;
	const BAND_NAMES = { highpass: 'low cut', lowshelf: 'low shelf', peak: 'bell', highshelf: 'high shelf', lowpass: 'high cut' };
</script>

<div class="step" class:is-off={!step.on}>
	<div class="step__head">
		<span class="step__index">{String(index + 1).padStart(2, '0')}</span>
		<span class="step__title">{meta.label}</span>
		{#if meta.analysis}
			<span class="tag tag-ghost" title="Measured in a fast audio-only pass before rendering">+ pass</span>
		{/if}
		<label class="field-check" title="Bypass this step without deleting it">
			<input type="checkbox" bind:checked={step.on} />
			On
		</label>
		<button type="button" class="btn-ghost btn-icon" onclick={() => onmove(-1)} disabled={index === 0} aria-label="Move up">↑</button>
		<button type="button" class="btn-ghost btn-icon" onclick={() => onmove(1)} disabled={index === count - 1} aria-label="Move down">↓</button>
		<button type="button" class="btn-icon" onclick={onremove} aria-label="Remove step">✕</button>
	</div>

	<div class="step__body">
		<div class="help">{meta.blurb}</div>

		{#if step.op === 'trim'}
			<div class="grid-2">
				<div class="field">
					<label for="{step.id}-in">In (s)</label>
					<input id="{step.id}-in" type="number" min="0" step="0.1" bind:value={step.start} class="input-small" />
				</div>
				<div class="field">
					<label for="{step.id}-out">Out (s)</label>
					<input
						id="{step.id}-out"
						type="number"
						min="0"
						step="0.1"
						placeholder="end"
						value={step.end ?? ''}
						oninput={(e) => {
							const v = (e.currentTarget as HTMLInputElement).value;
							if (step.op === 'trim') step.end = v === '' ? null : Number(v);
						}}
						class="input-small"
					/>
				</div>
			</div>
			<div class="row" style="gap: 0.5rem;">
				<button type="button" class="btn-ghost btn-small" onclick={() => step.op === 'trim' && (step.start = round1(currentTime))}>
					In ← {formatTimecode(currentTime)}
				</button>
				<button type="button" class="btn-ghost btn-small" onclick={() => step.op === 'trim' && (step.end = round1(currentTime))}>
					Out ← {formatTimecode(currentTime)}
				</button>
				<button
					type="button"
					class="btn-small"
					disabled={!selection}
					onclick={() => {
						if (step.op === 'trim' && selection) {
							step.start = round1(selection.start);
							step.end = round1(selection.end);
						}
					}}
				>
					Use selection
				</button>
			</div>
			<div class="help">
				Keeps {formatTimecode(Math.max(0, (step.end ?? duration ?? 0) - step.start))}. As the first step it becomes an input seek, so even
				two-hour sources start instantly.
			</div>
		{:else if step.op === 'speed'}
			<Range label="Speed" bind:value={step.factor} min={0.25} max={4} step={0.05} format={(v) => `${v.toFixed(2)}×`} />
			<div class="seg">
				{#each [0.5, 0.75, 1.25, 1.5, 2] as f (f)}
					<button type="button" aria-pressed={step.factor === f} onclick={() => step.op === 'speed' && (step.factor = f)}>{f}×</button>
				{/each}
			</div>
		{:else if step.op === 'jumpcut'}
			<div class="field">
				<span class="caps">Detect pauses by</span>
				<div class="seg">
					<button type="button" aria-pressed={step.detector === 'level'} onclick={() => step.op === 'jumpcut' && (step.detector = 'level')}>Level</button>
					<button type="button" aria-pressed={step.detector === 'speech'} onclick={() => step.op === 'jumpcut' && (step.detector = 'speech')}>Speech (AI)</button>
				</div>
				<div class="help">
					{step.detector === 'speech'
						? 'Silero VAD in the engine finds actual talking — cuts gaps between words even under music or hum.'
						: 'Anything quieter than the threshold counts as a pause. Fast; best on clean recordings.'}
				</div>
			</div>
			{#if step.detector === 'speech'}
				<Range label="Speech sensitivity" bind:value={step.vadThreshold} min={0.1} max={0.9} step={0.05} format={(v) => v.toFixed(2)} />
			{:else}
				<Range label="Silence below" bind:value={step.thresholdDb} min={-70} max={-15} format={(v) => `${v} dB`} />
			{/if}
			<Range label="Longer than" bind:value={step.minSilenceMs} min={200} max={3000} step={50} format={(v) => `${v} ms`} />
			<Range
				label="Breathing room"
				bind:value={step.padMs}
				min={0}
				max={400}
				step={10}
				format={(v) => `${v} ms`}
				help="Kept on each side of a cut so words don't get clipped."
			/>
			{#if onpreview}
				<div>
					<button type="button" class="btn-ghost btn-small" onclick={onpreview} disabled={previewing}>
						{previewing ? 'Listening…' : 'Preview cuts on waveform'}
					</button>
				</div>
			{/if}
		{:else if step.op === 'volume'}
			<Range label="Gain" bind:value={step.db} min={-20} max={20} step={0.5} format={(v) => signed(v, ' dB')} />
		{:else if step.op === 'loudnorm'}
			<div class="seg">
				{#each [
					[-14, 'Streaming −14'],
					[-16, 'Podcast −16'],
					[-23, 'Broadcast −23'],
				] as [v, label] (v)}
					<button type="button" aria-pressed={step.lufs === v} onclick={() => step.op === 'loudnorm' && (step.lufs = Number(v))}>{label}</button>
				{/each}
			</div>
			<Range label="Target" bind:value={step.lufs} min={-30} max={-8} step={0.5} format={(v) => `${v} LUFS`} />
			<Range label="True peak" bind:value={step.truePeak} min={-3} max={0} step={0.1} format={(v) => `${v.toFixed(1)} dBTP`} />
		{:else if step.op === 'fade'}
			<div class="grid-2">
				<Range label="Fade in" bind:value={step.inSec} min={0} max={10} step={0.1} format={(v) => `${v.toFixed(1)} s`} />
				<Range label="Fade out" bind:value={step.outSec} min={0} max={10} step={0.1} format={(v) => `${v.toFixed(1)} s`} />
			</div>
		{:else if step.op === 'denoise'}
			<Range label="Strength" bind:value={step.amount} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} />
		{:else if step.op === 'pitch'}
			<Range label="Shift" bind:value={step.semitones} min={-12} max={12} step={1} format={(v) => signed(v, ' st')} />
		{:else if step.op === 'reframe'}
			<div class="field">
				<span class="caps">Aspect</span>
				<div class="seg">
					{#each ASPECTS as a (a)}
						<button type="button" aria-pressed={step.aspect === a} onclick={() => step.op === 'reframe' && (step.aspect = a)}>{a}</button>
					{/each}
				</div>
			</div>
			<div class="field">
				<span class="caps">Fit</span>
				<div class="seg">
					{#each [
						['crop', 'Crop to fill'],
						['pad', 'Bars'],
						['blur', 'Blurred fill'],
					] as const as [f, label] (f)}
						<button type="button" aria-pressed={step.fit === f} onclick={() => step.op === 'reframe' && (step.fit = f)}>{label}</button>
					{/each}
				</div>
			</div>
		{:else if step.op === 'scale'}
			<div class="seg">
				{#each SCALE_HEIGHTS as h (h)}
					<button type="button" aria-pressed={step.height === h} onclick={() => step.op === 'scale' && (step.height = h)}>{h}p</button>
				{/each}
			</div>
		{:else if step.op === 'color'}
			<Range label="Brightness" bind:value={step.brightness} min={-0.3} max={0.3} step={0.01} format={(v) => signed(Number(v.toFixed(2)), '')} />
			<Range label="Contrast" bind:value={step.contrast} min={0.5} max={2} step={0.05} format={(v) => `${v.toFixed(2)}×`} />
			<Range label="Saturation" bind:value={step.saturation} min={0} max={2.5} step={0.05} format={(v) => `${v.toFixed(2)}×`} />
		{:else if step.op === 'rotate'}
			<div class="seg">
				{#each [
					[1, '90°'],
					[2, '180°'],
					[3, '270°'],
				] as const as [t, label] (t)}
					<button type="button" aria-pressed={step.turns === t} onclick={() => step.op === 'rotate' && (step.turns = t)}>{label}</button>
				{/each}
			</div>
		{:else if step.op === 'flip'}
			<div class="seg">
				<button type="button" aria-pressed={step.axis === 'h'} onclick={() => step.op === 'flip' && (step.axis = 'h')}>Horizontal</button>
				<button type="button" aria-pressed={step.axis === 'v'} onclick={() => step.op === 'flip' && (step.axis = 'v')}>Vertical</button>
			</div>
		{:else if step.op === 'eq'}
			<EqCurve bind:bands={step.bands} />
			<table class="eq-bands">
				<thead><tr><th></th><th>Band</th><th class="num">Hz</th><th class="num">dB</th><th class="num">Q</th></tr></thead>
				<tbody>
					{#each step.bands as b, k (k)}
						<tr class:is-off={!b.on}>
							<td><input type="checkbox" bind:checked={b.on} aria-label="Band {k + 1} on" /></td>
							<td class="mono">{k + 1} · {BAND_NAMES[b.type]}</td>
							<td><input type="number" class="input-small" min="20" max="20000" bind:value={b.f} /></td>
							<td>
								{#if b.type !== 'highpass' && b.type !== 'lowpass'}
									<input type="number" class="input-small" min="-24" max="24" step="0.5" bind:value={b.g} />
								{/if}
							</td>
							<td><input type="number" class="input-small" min="0.1" max="18" step="0.05" bind:value={b.q} /></td>
						</tr>
					{/each}
				</tbody>
			</table>
		{:else if step.op === 'compressor'}
			<div class="grid-2">
				<Range label="Threshold" bind:value={step.thresholdDb} min={-60} max={0} step={0.5} format={(v) => `${v} dB`} />
				<Range label="Ratio" bind:value={step.ratio} min={1} max={20} step={0.1} format={(v) => `${v.toFixed(1)}:1`} />
				<Range label="Attack" bind:value={step.attackMs} min={0.1} max={200} step={0.1} format={(v) => `${v.toFixed(1)} ms`} />
				<Range label="Release" bind:value={step.releaseMs} min={5} max={2000} step={5} format={(v) => `${v} ms`} />
				<Range label="Make-up" bind:value={step.makeupDb} min={0} max={24} step={0.5} format={(v) => `+${v} dB`} />
			</div>
		{:else if step.op === 'limiter'}
			<div class="grid-2">
				<Range label="Ceiling" bind:value={step.ceilingDb} min={-12} max={0} step={0.1} format={(v) => `${v.toFixed(1)} dB`} />
				<Range label="Release" bind:value={step.releaseMs} min={1} max={500} step={1} format={(v) => `${v} ms`} />
			</div>
		{:else if step.op === 'gate'}
			<div class="grid-2">
				<Range label="Threshold" bind:value={step.thresholdDb} min={-80} max={-10} step={1} format={(v) => `${v} dB`} />
				<Range label="Range" bind:value={step.rangeDb} min={-80} max={0} step={1} format={(v) => `${v} dB`} />
				<Range label="Attack" bind:value={step.attackMs} min={0.1} max={100} step={0.1} format={(v) => `${v.toFixed(1)} ms`} />
				<Range label="Release" bind:value={step.releaseMs} min={5} max={2000} step={5} format={(v) => `${v} ms`} />
			</div>
		{:else if step.op === 'deesser'}
			<Range label="Amount" bind:value={step.amount} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} />
		{:else if step.op === 'dehum'}
			<div class="seg">
				<button type="button" aria-pressed={step.freq === 50} onclick={() => step.op === 'dehum' && (step.freq = 50)}>50 Hz</button>
				<button type="button" aria-pressed={step.freq === 60} onclick={() => step.op === 'dehum' && (step.freq = 60)}>60 Hz</button>
			</div>
			<Range label="Harmonics" bind:value={step.harmonics} min={1} max={8} format={(v) => `${v} (up to ${v * (step.op === 'dehum' ? step.freq : 50)} Hz)`} />
		{:else if step.op === 'declick'}
			<label class="field-check"><input type="checkbox" bind:checked={step.clicks} /> Clicks &amp; pops</label>
			<label class="field-check"><input type="checkbox" bind:checked={step.clipping} /> Clipped peaks</label>
		{:else if step.op === 'stereo'}
			<div class="seg">
				{#each [
					['keep', 'Keep'],
					['mono', 'Mono'],
					['swap', 'Swap L/R'],
					['left', 'Left only'],
					['right', 'Right only'],
				] as const as [m, label] (m)}
					<button type="button" aria-pressed={step.mode === m} onclick={() => step.op === 'stereo' && (step.mode = m)}>{label}</button>
				{/each}
			</div>
			<div class="grid-2">
				<Range label="Width" bind:value={step.width} min={0} max={2.5} step={0.05} format={(v) => `${Math.round(v * 100)}%`} />
				<Range label="Balance" bind:value={step.balance} min={-1} max={1} step={0.05} format={(v) => (v === 0 ? 'centre' : v < 0 ? `L ${Math.round(-v * 100)}` : `R ${Math.round(v * 100)}`)} />
			</div>
		{:else if step.op === 'fps'}
			<div class="seg">
				{#each FPS_CHOICES as f (f)}
					<button type="button" aria-pressed={step.fps === f} onclick={() => step.op === 'fps' && (step.fps = f)}>{f}</button>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.eq-bands td,
	.eq-bands th {
		padding: 0.25rem 0.5rem 0.25rem 0;
	}

	.eq-bands input[type='number'] {
		inline-size: 5.5rem;
	}

	.eq-bands tr:hover td {
		background: none;
	}

	.eq-bands tr.is-off {
		opacity: 0.45;
	}
</style>

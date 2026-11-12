<script lang="ts">
	let {
		label,
		value = $bindable(),
		min,
		max,
		step = 1,
		format = (v: number) => String(v),
		help = '',
	}: {
		label: string;
		value: number;
		min: number;
		max: number;
		step?: number;
		format?: (v: number) => string;
		help?: string;
	} = $props();

	const id = `r${Math.random().toString(36).slice(2, 9)}`;
</script>

<div class="field">
	<div class="slider-head">
		<label for={id}>{label}</label>
		<output for={id}>{format(value)}</output>
	</div>
	<input {id} type="range" {min} {max} {step} bind:value />
	{#if help}<div class="help">{help}</div>{/if}
</div>

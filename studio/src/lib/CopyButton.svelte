<script lang="ts">
	let { text, label = 'Copy' }: { text: string; label?: string } = $props();
	let copied = $state(false);

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			setTimeout(() => (copied = false), 1200);
		} catch {
			// Clipboard can be blocked (http, iframes); the text is selectable anyway.
		}
	}
</script>

<button type="button" class="btn-primary btn-small" onclick={copy}>{copied ? 'Copied' : label}</button>

<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { initTheme, setTheme, theme, type ThemeChoice } from '$lib/theme.svelte';

	const THEMES: { id: ThemeChoice; glyph: string; label: string; next: ThemeChoice }[] = [
		{ id: 'auto', glyph: '◐', label: 'Auto', next: 'light' },
		{ id: 'light', glyph: '○', label: 'Light', next: 'dark' },
		{ id: 'dark', glyph: '●', label: 'Dark', next: 'auto' },
	];
	const current = $derived(THEMES.find((t) => t.id === theme.choice)!);

	onMount(initTheme);

	const links = [
		{ href: '/', label: 'Library' },
		{ href: '/downloads', label: 'Downloads' },
		{ href: '/desk', label: 'Desk' },
		{ href: '/captions', label: 'Captions' },
		{ href: '/mix', label: 'Mix' },
		{ href: '/stitch', label: 'Stitch' },
		{ href: '/presets', label: 'Presets' },
		{ href: '/renders', label: 'Renders' },
		{ href: '/jobs', label: 'Jobs' },
		{ href: '/setup', label: 'Setup' },
	];

	let { children } = $props();
	let active = $state(0);
	let downloading = $state(0);

	// A tiny summary poll so the Jobs and Downloads links show what's
	// running, from any page.
	onMount(() => {
		let timer: ReturnType<typeof setTimeout>;
		async function tick() {
			try {
				const res = await fetch('/api/jobs?summary');
				if (res.ok) ({ active, downloads: downloading } = await res.json());
			} catch {
				// server restarting; try again
			}
			timer = setTimeout(tick, active > 0 || downloading > 0 ? 1500 : 4000);
		}
		tick();
		return () => clearTimeout(timer);
	});
</script>

<header class="topbar">
	<div class="topbar__inner">
		<a href="/" class="wordmark">Wave<mark>Weaver</mark></a>
		<nav class="nav">
			{#each links as link (link.href)}
				<a href={link.href} aria-current={page.url.pathname.startsWith(link.href) && (link.href !== '/' || page.url.pathname === '/') ? 'page' : undefined}>
					{link.label}{#if link.href === '/jobs' && active > 0}<span class="count">{active}</span>{:else if link.href === '/downloads' && downloading > 0}<span class="count">{downloading}</span>{/if}
				</a>
			{/each}
		</nav>
		<button
			type="button"
			class="theme"
			onclick={() => setTheme(current.next)}
			title={`Theme: ${current.label}${current.id === 'auto' ? ' (follows your system)' : ''}. Click for ${THEMES.find((t) => t.id === current.next)!.label.toLowerCase()}.`}
			aria-label={`Theme: ${current.label}`}
		>
			<span aria-hidden="true">{current.glyph}</span>
			{current.label}
		</button>
	</div>
</header>

<style>
	/* Set like a nav item: hover underlines, the accent stays for state. */
	.theme {
		all: unset;
		cursor: pointer;
		display: inline-flex;
		gap: 0.4em;
		align-items: center;
		font-weight: 600;
		font-size: 0.95rem;
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
		padding-block: 0.15em;
		color: var(--muted);
	}

	.theme:hover {
		color: var(--ink);
		text-decoration: underline;
		text-decoration-thickness: 2px;
		text-underline-offset: 4px;
	}

	.theme:focus-visible {
		outline: 3px solid var(--accent);
		outline-offset: 2px;
	}

	.theme span {
		font-family: var(--font-mono);
	}
</style>

<main class="shell">
	{@render children()}
</main>

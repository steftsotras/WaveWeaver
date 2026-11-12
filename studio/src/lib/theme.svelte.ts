/**
 * Light and dark. The page follows the system unless you pick one in the
 * top bar; the choice is remembered per browser. app.html applies a saved
 * choice before the first paint, so there's no flash of the wrong theme.
 *
 * CSS handles everything through the tokens in app.css. Canvases (the
 * waveform, the EQ curve, the A/B lanes) read the tokens when they draw, so
 * they depend on `theme.version` to redraw when the theme changes.
 */

export type ThemeChoice = 'auto' | 'light' | 'dark';

export const THEME_KEY = 'ww:theme';

export const theme = $state({ choice: 'auto' as ThemeChoice, version: 0 });

export function initTheme(): () => void {
	try {
		const saved = localStorage.getItem(THEME_KEY);
		if (saved === 'light' || saved === 'dark') theme.choice = saved;
	} catch {
		// storage blocked; follow the system
	}
	const media = matchMedia('(prefers-color-scheme: dark)');
	const onSystem = () => {
		if (theme.choice === 'auto') theme.version++;
	};
	media.addEventListener('change', onSystem);
	return () => media.removeEventListener('change', onSystem);
}

export function setTheme(choice: ThemeChoice) {
	theme.choice = choice;
	if (choice === 'auto') delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = choice;
	try {
		if (choice === 'auto') localStorage.removeItem(THEME_KEY);
		else localStorage.setItem(THEME_KEY, choice);
	} catch {
		// storage blocked; the choice lasts until the page reloads
	}
	theme.version++;
}

/** `#rgb` / `#rrggbb` at an opacity, for canvas fills. Anything else is returned as it is. */
function fade(color: string, alpha: number): string {
	let hex = color.trim().replace(/^#/, '');
	if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
	if (!/^[0-9a-f]{6}$/i.test(hex)) return color;
	const n = parseInt(hex, 16);
	return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export interface Palette {
	ink: string;
	bg: string;
	accent: string;
	wash: string;
	/** Text and marks drawn on top of the accent: dark in both themes. */
	onAccent: string;
	fade: (color: string, alpha: number) => string;
}

/** The design tokens as resolved on an element, for drawing on a canvas. */
export function palette(el: Element): Palette {
	const css = getComputedStyle(el);
	const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
	return {
		ink: token('--ink', '#0a0a0a'),
		bg: token('--bg', '#ffffff'),
		accent: token('--accent', '#ff4f00'),
		wash: token('--wash', '#f2f2f2'),
		onAccent: token('--on-accent', '#0a0a0a'),
		fade,
	};
}

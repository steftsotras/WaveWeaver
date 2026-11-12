/**
 * Short filename-safe timestamp (`YYYYMMDD-hhmmss`) appended to every render
 * so a second run with identical inputs doesn't overwrite the first — and so
 * the browser doesn't serve a stale cached copy of an identically-named file.
 */
export function timestampSuffix(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
		`-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
	);
}

/** "My Interview (final)" → "my-interview-final". */
export function slugify(text: string): string {
	return text
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
}

/** Keep a source stem readable but bounded so render names don't explode. */
export function shortStem(stem: string): string {
	return stem.length > 48 ? stem.slice(0, 48).replace(/[\s.-]+$/, '') : stem;
}

import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		port: 5190,
		watch: {
			// media/ holds gigabytes of sources and renders that change while
			// jobs run. Vite has no business watching any of it.
			ignored: ['**/media/**'],
		},
	},
});

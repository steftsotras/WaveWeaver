<script lang="ts">
	import { formatBytes, isUploadable } from '$lib/media';

	interface Uploaded {
		ref: { bin: string; kind: 'sources'; name: string };
	}

	let {
		bin,
		onuploaded,
		compact = false,
	}: {
		bin: string;
		onuploaded?: (refs: Uploaded['ref'][]) => void;
		compact?: boolean;
	} = $props();

	interface Item {
		name: string;
		size: number;
		loaded: number;
		status: 'waiting' | 'uploading' | 'done' | 'error';
		message?: string;
	}

	let items: Item[] = $state([]);
	let over = $state(false);
	let input: HTMLInputElement | null = $state(null);

	/**
	 * XHR rather than fetch: fetch still can't report upload progress, and a
	 * 2 GB file with no progress bar feels broken. One file at a time keeps
	 * the disk writing sequentially.
	 */
	function put(file: File, item: Item): Promise<Uploaded> {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open('PUT', `/api/upload?bin=${encodeURIComponent(bin)}&name=${encodeURIComponent(file.name)}`);
			// SvelteKit drops the body of any request without a Content-Type,
			// and browsers leave File.type empty for e.g. .mkv on Windows.
			xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
			xhr.upload.onprogress = (e) => (item.loaded = e.loaded);
			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
				else {
					let msg = xhr.statusText;
					try {
						msg = JSON.parse(xhr.responseText).message ?? msg;
					} catch {
						// keep statusText
					}
					reject(new Error(msg));
				}
			};
			xhr.onerror = () => reject(new Error('Network error'));
			xhr.send(file);
		});
	}

	async function accept(files: FileList | File[]) {
		const list = [...files];
		const batch: Item[] = list.map((f) => ({
			name: f.name,
			size: f.size,
			loaded: 0,
			status: isUploadable(f.name) ? 'waiting' : 'error',
			message: isUploadable(f.name) ? undefined : 'Not an audio/video file',
		}));
		items = [...batch, ...items].slice(0, Math.max(12, batch.length));
		// Read back through `items`: $state wraps each object in a proxy, and
		// only mutations through the proxy re-render the meters.
		const live = items.slice(0, batch.length);
		const refs: Uploaded['ref'][] = [];
		for (let i = 0; i < list.length; i++) {
			const item = live[i];
			if (item.status === 'error') continue;
			item.status = 'uploading';
			try {
				const res = await put(list[i], item);
				item.status = 'done';
				item.loaded = item.size;
				refs.push(res.ref);
			} catch (err) {
				item.status = 'error';
				item.message = err instanceof Error ? err.message : String(err);
			}
		}
		if (refs.length) onuploaded?.(refs);
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		over = false;
		if (e.dataTransfer?.files.length) accept(e.dataTransfer.files);
	}
</script>

<div
	class="dropzone"
	class:is-over={over}
	style:padding={compact ? '1.25rem' : '2.5rem 2rem'}
	role="button"
	tabindex="0"
	ondragover={(e) => {
		e.preventDefault();
		over = true;
	}}
	ondragleave={() => (over = false)}
	ondrop={onDrop}
	onclick={() => input?.click()}
	onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && input?.click()}
>
	<div class="caps" style="font-size: {compact ? 'var(--fs-small)' : '1rem'};">
		Drop audio or video <span class="muted">or click to browse</span>
	</div>
	<div class="help">Lands in <strong>{bin}/sources</strong>. Files keep their names — never renamed to UUIDs.</div>
	<input
		bind:this={input}
		type="file"
		multiple
		accept="audio/*,video/*,.mkv,.flac,.opus"
		class="visually-hidden"
		onchange={(e) => {
			const f = (e.currentTarget as HTMLInputElement).files;
			if (f?.length) accept(f);
			(e.currentTarget as HTMLInputElement).value = '';
		}}
	/>
</div>

{#if items.length}
	<div class="stack-tight" style="margin-block-start: 0.75rem;">
		{#each items as item, i (item.name + i)}
			<div class="meter" style="block-size: 1.9rem;">
				<div
					class="meter__fill"
					style:inline-size="{item.size ? (item.loaded / item.size) * 100 : 0}%"
					style:background={item.status === 'error' ? 'var(--wash)' : undefined}
				></div>
				<div class="meter__label">
					<span class="truncate">{item.name}</span>
					<span>
						{#if item.status === 'error'}✕ {item.message}{:else if item.status === 'done'}done{:else}{formatBytes(item.loaded)} / {formatBytes(item.size)}{/if}
					</span>
				</div>
			</div>
		{/each}
	</div>
{/if}

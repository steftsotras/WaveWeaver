/**
 * What the Setup page shows. Everything WaveWeaver needs beyond the app
 * itself is a component here: installed once, into the user's own folders.
 */

export type ComponentId = 'ffmpeg' | 'python' | 'ytdlp' | 'engine' | 'gpu' | 'whisper-turbo' | 'whisper-small' | 'nllb';

export interface SetupComponent {
	id: ComponentId;
	label: string;
	blurb: string;
	/** Rough download size, for deciding whether to do this on hotel wifi. */
	size: string;
	group: 'runtime' | 'model';
	ready: boolean;
	/** A version or path once installed. */
	detail: string | null;
	/** Part of "Install what's needed" on this machine. */
	recommended: boolean;
	/** This component can't be installed here, and why. */
	unavailable: string | null;
	/** Must be ready first. Installing a batch runs in order, so this only stops a lone Install. */
	needs: ComponentId | null;
	/** Show an Update button once it's ready: this one moves fast. */
	updatable: boolean;
}

export interface SetupStatus {
	components: SetupComponent[];
	/** The install running now, if any. */
	jobId: string | null;
	mediaRoot: string;
	modelsDir: string;
	dataDir: string;
}

/** What the desktop app's preload script puts on `window.waveweaver`. Absent in a plain browser. */
export interface DesktopBridge {
	folders(): Promise<{ media: string; models: string; configured: boolean }>;
	chooseFolder(current: string): Promise<string | null>;
	saveFolders(folders: { media: string; models: string }): Promise<{ error?: string }>;
	finishSetup(): Promise<void>;
}

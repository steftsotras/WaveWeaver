/**
 * The mixer's vocabulary: tracks laid on a timeline, each with gain, pan,
 * offset and fades, and a role. Roles drive the one automatic move a basic
 * mixer should make: music ducks under voice.
 */
import type { MediaKind } from './media';

export type TrackRole = 'voice' | 'music' | 'fx';

export interface MixTrack {
	id: string;
	ref: { bin: string; kind: MediaKind; name: string };
	role: TrackRole;
	gainDb: number;
	/** −1 left … +1 right */
	pan: number;
	/** Seconds from the start of the mix. */
	offset: number;
	fadeIn: number;
	fadeOut: number;
	mute: boolean;
	solo: boolean;
}

export interface Ducking {
	on: boolean;
	/** How far music drops while someone talks. */
	depthDb: number;
	attackMs: number;
	releaseMs: number;
}

export interface MixSpec {
	tracks: MixTrack[];
	duck: Ducking;
	/** A preset id whose steps master the finished mix (EQ, comp, limiter, loudness). */
	master: string | null;
	format: 'mp3' | 'wav' | 'flac' | 'm4a' | 'mp4';
	/** Track id whose picture becomes the video (mp4 only). */
	videoFrom: string | null;
}

export const DEFAULT_DUCK: Ducking = { on: true, depthDb: -12, attackMs: 40, releaseMs: 600 };

let n = 0;
export function trackId(): string {
	return `t${Date.now().toString(36)}${(++n).toString(36)}`;
}

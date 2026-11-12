// Generate a small `demo` bin of synthetic media so every tool can be tried
// without hunting for footage: a "talking head" with pauses (jump cut), a
// noisy voice memo (clean up, loudness, split), and a vertical phone clip
// (reframe, stitch).
//
//   npm run demo
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.env.WAVEWEAVER_MEDIA_DIR ?? join(process.cwd(), 'media'));
const sources = join(root, 'demo', 'sources');
mkdirSync(sources, { recursive: true });
mkdirSync(join(root, 'demo', 'renders'), { recursive: true });

// "Speech": a wobbling tone that talks for 2.6 s, then pauses for 1.4 s.
const speech = (freq, talk, cycle) =>
	`aevalsrc='if(lt(mod(t,${cycle}),${talk}),0.45*sin(2*PI*${freq}*t)*(0.55+0.45*sin(2*PI*3.1*t)),0)':s=48000:c=stereo`;

const clips = [
	{
		name: 'talking-head.mp4',
		args: [
			'-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=24',
			'-f', 'lavfi', '-i', `${speech(220, 2.6, 4)}:d=24`,
			'-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
			'-c:a', 'aac', '-b:a', '160k', '-shortest',
		],
	},
	{
		name: 'voice-memo.mp3',
		args: [
			'-f', 'lavfi', '-i', `${speech(180, 3.5, 6)}:d=48`,
			'-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.02:d=48:r=48000',
			'-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0,volume=-9dB[a]',
			'-map', '[a]', '-c:a', 'libmp3lame', '-q:a', '3',
		],
	},
	{
		name: 'vertical-phone.mp4',
		args: [
			'-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=30:d=8',
			'-f', 'lavfi', '-i', 'sine=f=440:d=8:r=48000',
			'-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
			'-c:a', 'aac', '-shortest',
		],
	},
];

// A sustained A-major chord with a slow swell: a stand-in music bed for the
// mixer's ducking.
clips.push({
	name: 'music-bed.mp3',
	args: [
		'-f', 'lavfi', '-i', 'sine=f=220:d=45:r=48000',
		'-f', 'lavfi', '-i', 'sine=f=277.18:d=45:r=48000',
		'-f', 'lavfi', '-i', 'sine=f=329.63:d=45:r=48000',
		'-filter_complex', "[0:a][1:a][2:a]amix=inputs=3:normalize=0,volume='0.25+0.08*sin(2*PI*0.25*t)':eval=frame,aformat=channel_layouts=stereo[a]",
		'-map', '[a]', '-c:a', 'libmp3lame', '-q:a', '3',
	],
});

// Real speech for transcription, captions and cleanup tools. Windows ships a
// text-to-speech voice; elsewhere this clip is skipped.
if (process.platform === 'win32') {
	const tmp = join(root, '.cache', 'demo-speech.wav');
	mkdirSync(join(root, '.cache'), { recursive: true });
	const lines = [
		'Welcome to WaveWeaver.',
		'Today we are testing transcription, translation, and subtitles.',
		'Every edit can be previewed on a short excerpt before you commit to the whole file.',
		'This sentence was spoken after a long pause, so the jump cut should remove the silence.',
		'Thanks for listening, and see you next time.',
	];
	const ps = [
		'Add-Type -AssemblyName System.Speech',
		'$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
		'$s.Rate = -1',
		`$s.SetOutputToWaveFile('${tmp.replace(/'/g, "''")}')`,
		'$p = New-Object System.Speech.Synthesis.PromptBuilder',
		...lines.map((l, i) => `$p.AppendText('${l}'); $p.AppendBreak([TimeSpan]::FromMilliseconds(${i === 2 ? 2600 : 900}))`),
		'$s.Speak($p); $s.Dispose()',
	].join('; ');
	clips.push({
		name: 'interview.mp4',
		before: () => spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' }).status === 0,
		args: [
			'-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30',
			'-i', tmp,
			// Room noise and 50 Hz mains hum, so the cleanup tools have something to fix.
			'-f', 'lavfi', '-i', 'anoisesrc=color=brown:amplitude=0.03:r=48000',
			'-f', 'lavfi', '-i', 'sine=f=50:r=48000',
			'-filter_complex',
			'[1:a]aresample=48000,apad=pad_dur=1[v];[3:a]volume=0.04[h];[v][2:a][h]amix=inputs=3:duration=first:normalize=0[a]',
			'-map', '0:v', '-map', '[a]', '-shortest',
			'-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
		],
	});
}

for (const clip of clips) {
	const out = join(sources, clip.name);
	if (existsSync(out)) {
		console.log(`skip  ${clip.name} (exists)`);
		continue;
	}
	if (clip.before && !clip.before()) {
		console.log(`skip  ${clip.name} (text-to-speech unavailable)`);
		continue;
	}
	const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...clip.args, out], { stdio: 'inherit' });
	if (r.status !== 0) {
		console.error(`fail  ${clip.name}`);
		process.exit(1);
	}
	console.log(`made  ${clip.name}`);
}
console.log(`\nDemo bin ready: ${join(root, 'demo')}`);

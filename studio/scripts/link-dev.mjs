// Run by `npm run dist`. Tells the installed app on this PC where the
// repository checkout is, so it reuses that .venv and models folder
// instead of downloading them again. The note goes in the app's data folder
// (%LOCALAPPDATA%\WaveWeaver), never into the installer.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const localAppData = process.env.LOCALAPPDATA;
const dataDir = process.env.WAVEWEAVER_DATA_DIR || (localAppData && join(localAppData, 'WaveWeaver'));

if (!dataDir || !existsSync(join(backend, 'engine'))) {
	console.log('link-dev: no engine checkout above the studio, skipped.');
} else {
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(dataDir, 'dev-checkout.json'), JSON.stringify({ backend }, null, '\t'));
	console.log(`link-dev: installed app will reuse ${backend}`);
}

// The desktop shell. It owns a window, the user's settings and the server's
// lifetime. The studio itself is unchanged: its SvelteKit server runs as a
// child process on Electron's own Node, and this window is a browser on it.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const STUDIO_PORT = 51900;
const ENGINE_PORT = 51950;

// Local, not Roaming: this ends up holding gigabytes of Python and models.
// WAVEWEAVER_DATA_DIR gives a throwaway install for testing a first run.
const dataDir = process.env.WAVEWEAVER_DATA_DIR || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'WaveWeaver');
app.setPath('userData', path.join(dataDir, 'electron'));

const settingsPath = path.join(dataDir, 'settings.json');
const logPath = path.join(dataDir, 'logs', 'studio.log');

const hasPython = (venv) => fs.existsSync(path.join(venv, 'Scripts', 'python.exe')) || fs.existsSync(path.join(venv, 'bin', 'python'));

/**
 * The developer's own repository checkout, when this PC has one. From a
 * checkout it is the folder above the studio. Packaged, `npm run dist` leaves its path
 * in dev-checkout.json in the data folder: a file on this PC, not in the
 * installer, so other people's installs never see it.
 */
function devBackend() {
	let dir = null;
	if (!app.isPackaged) dir = path.join(__dirname, '..', '..');
	else {
		try {
			dir = JSON.parse(fs.readFileSync(path.join(dataDir, 'dev-checkout.json'), 'utf8')).backend;
		} catch {
			// not a dev machine
		}
	}
	return typeof dir === 'string' && path.isAbsolute(dir) && fs.existsSync(dir) ? dir : null;
}

/**
 * Which Python environment the engine runs in. Setup's own copy wins once there
 * is one. Before that, a dev checkout's .venv already holds the engine, the GPU
 * libraries and yt-dlp, so reuse it instead of downloading gigabytes again.
 */
function chooseVenv() {
	const own = path.join(dataDir, 'python');
	if (hasPython(own)) return own;
	const dev = devBackend();
	if (dev && hasPython(path.join(dev, '.venv'))) return path.join(dev, '.venv');
	return own;
}

/** Likewise for models, but only as a default: a folder picked in Setup is kept. */
function defaultModels() {
	const dev = devBackend();
	const devModels = dev && path.join(dev, 'models');
	if (devModels && fs.existsSync(devModels) && fs.readdirSync(devModels).length > 0) return devModels;
	return path.join(dataDir, 'models');
}

function loadSettings() {
	const defaults = {
		media: path.join(app.getPath('documents'), 'WaveWeaver'),
		models: defaultModels(),
		configured: false,
	};
	try {
		return { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
	} catch {
		return defaults;
	}
}

function saveSettings() {
	fs.mkdirSync(dataDir, { recursive: true });
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, '\t'));
}

/** Packaged, the server and engine sit in resources/. From a checkout, next to this file. */
function appPaths() {
	if (app.isPackaged) {
		return {
			entry: path.join(process.resourcesPath, 'studio', 'scripts', 'start.mjs'),
			engine: path.join(process.resourcesPath, 'engine'),
		};
	}
	const root = path.join(__dirname, '..');
	return { entry: path.join(root, 'scripts', 'start.mjs'), engine: path.join(root, '..') };
}

/** The first free port from `start`. Stable across launches, because the theme lives in localStorage, keyed by origin. */
function freePort(start) {
	return new Promise((resolve, reject) => {
		const attempt = (port) => {
			if (port > start + 40) return reject(new Error(`No free port near ${start}`));
			const probe = net.createServer();
			probe.once('error', () => attempt(port + 1));
			probe.once('listening', () => probe.close(() => resolve(port)));
			probe.listen(port, '127.0.0.1');
		};
		attempt(start);
	});
}

let settings;
let server = null;
let origin = '';
let win = null;
let quitting = false;

async function startServer() {
	const { entry, engine } = appPaths();
	const [port, enginePort] = await Promise.all([freePort(STUDIO_PORT), freePort(ENGINE_PORT)]);
	origin = `http://127.0.0.1:${port}`;
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	const log = fs.createWriteStream(logPath);
	const child = spawn(process.execPath, [entry], {
		cwd: dataDir,
		windowsHide: true,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			// Run this binary as plain Node. It's inherited on purpose: yt-dlp
			// gets this same executable as its JavaScript runtime.
			ELECTRON_RUN_AS_NODE: '1',
			HOST: '127.0.0.1',
			PORT: String(port),
			ORIGIN: origin,
			WAVEWEAVER_DESKTOP: '1',
			WAVEWEAVER_DATA_DIR: dataDir,
			WAVEWEAVER_MEDIA_DIR: settings.media,
			WAVEWEAVER_MODELS_DIR: settings.models,
			WAVEWEAVER_PLUGINS: path.join(dataDir, 'plugins'),
			WAVEWEAVER_ENGINE_DIR: engine,
			WAVEWEAVER_VENV: chooseVenv(),
			WAVEWEAVER_ENGINE_PORT: String(enginePort),
			WAVEWEAVER_ENGINE_URL: `http://127.0.0.1:${enginePort}`,
		},
	});
	child.stdout.pipe(log);
	child.stderr.pipe(log);
	server = child;

	child.once('exit', (code) => {
		if (server !== child) return;
		server = null;
		if (quitting || !win) return;
		dialog.showErrorBox('WaveWeaver stopped', `The studio server exited (${code}). Details are in:\n${logPath}`);
		app.quit();
	});

	for (let i = 0; i < 150; i++) {
		if (server !== child) throw new Error(`The studio server exited during startup. Details are in:\n${logPath}`);
		try {
			if ((await fetch(`${origin}/api/jobs?summary`)).ok) return;
		} catch {
			// not listening yet
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`The studio server didn't start. Details are in:\n${logPath}`);
}

/** The whole tree: the server, the engine it started, any ffmpeg or download running. */
function stopServer() {
	const child = server;
	server = null;
	if (!child?.pid) return;
	if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
	else child.kill();
}

/** Renders, installs and downloads that stopping the server would throw away. */
async function runningWork() {
	try {
		const { active = 0, downloads = 0 } = await (await fetch(`${origin}/api/jobs?summary`)).json();
		return active + downloads;
	} catch {
		return 0;
	}
}

async function confirmStop(action) {
	const n = await runningWork();
	if (n === 0) return true;
	const { response } = await dialog.showMessageBox(win, {
		type: 'warning',
		buttons: [action, 'Keep working'],
		defaultId: 1,
		cancelId: 1,
		message: `${n} job${n === 1 ? ' is' : 's are'} still running`,
		detail: 'Stopping now cancels them. Queued downloads resume next time.',
	});
	return response === 0;
}

function isOwn(url) {
	try {
		return new URL(url).origin === origin;
	} catch {
		return false;
	}
}

function openExternal(url) {
	if (/^https?:/i.test(url)) shell.openExternal(url);
}

function createWindow() {
	win = new BrowserWindow({
		width: 1440,
		height: 920,
		minWidth: 900,
		minHeight: 600,
		show: false,
		backgroundColor: '#0a0a0a',
		title: 'WaveWeaver',
		webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true },
	});
	win.once('ready-to-show', () => win.show());

	// Anything off-site belongs in the user's browser. A file dropped outside a
	// dropzone would otherwise navigate this window to file://.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (isOwn(url)) return { action: 'allow' };
		openExternal(url);
		return { action: 'deny' };
	});
	win.webContents.on('will-navigate', (event, url) => {
		if (isOwn(url)) return;
		event.preventDefault();
		openExternal(url);
	});

	// Electron has no right-click menu of its own, and pasting links is half of Downloads.
	win.webContents.on('context-menu', (_event, params) => {
		if (params.isEditable) Menu.buildFromTemplate([{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]).popup();
		else if (params.selectionText) Menu.buildFromTemplate([{ role: 'copy' }]).popup();
	});

	win.on('close', async (event) => {
		if (quitting) return;
		event.preventDefault();
		if (!(await confirmStop('Quit anyway'))) return;
		quitting = true;
		stopServer();
		app.quit();
	});
	win.on('closed', () => {
		win = null;
	});

	win.loadURL(`${origin}${settings.configured ? '/' : '/setup'}`);
}

function ipc(channel, handler) {
	ipcMain.handle(channel, (event, ...args) => {
		if (!isOwn(event.senderFrame?.url ?? '')) throw new Error('Refused: not the studio');
		return handler(...args);
	});
}

ipc('folders', () => ({ media: settings.media, models: settings.models, configured: settings.configured }));

ipc('choose-folder', async (current) => {
	const { canceled, filePaths } = await dialog.showOpenDialog(win, {
		defaultPath: typeof current === 'string' ? current : undefined,
		properties: ['openDirectory', 'createDirectory'],
	});
	return canceled ? null : filePaths[0];
});

/** Folders reach the server as environment, so changing them means restarting it. */
ipc('save-folders', async (folders) => {
	const { media, models } = folders ?? {};
	if (![media, models].every((p) => typeof p === 'string' && path.isAbsolute(p))) return { error: 'Both folders need a full path.' };
	if (!(await confirmStop('Change folders anyway'))) return { error: 'Folders not changed.' };
	try {
		fs.mkdirSync(media, { recursive: true });
		fs.mkdirSync(models, { recursive: true });
	} catch (err) {
		return { error: `Can't use that folder: ${err.message}` };
	}
	settings = { ...settings, media, models };
	saveSettings();
	stopServer();
	try {
		await startServer();
	} catch (err) {
		dialog.showErrorBox('WaveWeaver', err.message);
		app.quit();
		return {};
	}
	win?.loadURL(`${origin}/setup`);
	return {};
});

ipc('finish-setup', () => {
	settings = { ...settings, configured: true };
	saveSettings();
});

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		if (!win) return;
		if (win.isMinimized()) win.restore();
		win.focus();
	});

	app.whenReady().then(async () => {
		Menu.setApplicationMenu(null);
		settings = loadSettings();
		fs.mkdirSync(settings.media, { recursive: true });
		try {
			await startServer();
		} catch (err) {
			dialog.showErrorBox('WaveWeaver', err.message);
			quitting = true;
			stopServer();
			app.quit();
			return;
		}
		createWindow();
	});

	app.on('window-all-closed', () => app.quit());
	// Task Manager, a shutdown: anything that skips the window's close handler.
	app.on('will-quit', stopServer);
}

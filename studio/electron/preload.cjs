// The only desktop features the studio's pages can reach. The server stays
// plain HTTP, so everything else works the same in a browser.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('waveweaver', {
	folders: () => ipcRenderer.invoke('folders'),
	chooseFolder: (current) => ipcRenderer.invoke('choose-folder', current),
	saveFolders: (folders) => ipcRenderer.invoke('save-folders', folders),
	finishSetup: () => ipcRenderer.invoke('finish-setup'),
});

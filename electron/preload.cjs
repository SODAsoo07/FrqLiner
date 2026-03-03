const { contextBridge, ipcRenderer } = require('electron');

// Expose safe APIs to the renderer (React app) via window.electronAPI
contextBridge.exposeInMainWorld('electronAPI', {
    /** Find and read the matching .wav for a given .frq path */
    findMatchingWav: (frqPath) => ipcRenderer.invoke('find-matching-wav', frqPath),

    /** Show a native open-file or open-directory dialog */
    openFileDialog: (opts) => ipcRenderer.invoke('open-file-dialog', opts),

    /** Read any file as an ArrayBuffer */
    readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),

    /** Write an ArrayBuffer to a file path */
    writeFile: (filePath, buffer) => ipcRenderer.invoke('write-file', filePath, buffer),

    /** True if running inside Electron */
    isElectron: true,
});

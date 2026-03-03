const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// ── Dev vs Production ────────────────────────────────────
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function createWindow() {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        title: 'Frqliner',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    if (isDev) {
        win.loadURL('http://localhost:5173');
        win.webContents.openDevTools({ mode: 'detach' });
    } else {
        win.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    win.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// ── IPC: Read a .wav file path next to a given .frq path ──────────────────
// In the browser we can't do this; in Electron we can scan the filesystem.
ipcMain.handle('find-matching-wav', async (_event, frqPath) => {
    try {
        // UTAU convention: _name_wav.frq → _name.wav
        const dir = path.dirname(frqPath);
        const base = path.basename(frqPath);
        const wavName = base
            .replace(/_wav\.frq$/i, '.wav')
            .replace(/\.frq$/i, '.wav');
        const wavPath = path.join(dir, wavName);
        if (fs.existsSync(wavPath)) {
            // Return the raw bytes so the renderer can create a Blob
            const data = fs.readFileSync(wavPath);
            return { found: true, wavPath, data: data.buffer };
        }
        return { found: false };
    } catch {
        return { found: false };
    }
});

// ── IPC: Show open-file dialog ─────────────────────────────────────────────
ipcMain.handle('open-file-dialog', async (_event, opts) => {
    const result = await dialog.showOpenDialog({
        properties: opts?.directory
            ? ['openDirectory', 'multiSelections']
            : ['openFile', 'multiSelections'],
        filters: opts?.directory ? [] : [
            { name: 'FRQ / WAV', extensions: ['frq', 'wav'] }
        ],
    });
    if (result.canceled) return [];

    // If directory, gather all .frq and .wav files from it
    if (opts?.directory) {
        const files = [];
        for (const dir of result.filePaths) {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
                if (e.isFile() && /\.(frq|wav)$/i.test(e.name)) {
                    const full = path.join(dir, e.name);
                    files.push({ path: full, name: e.name, relPath: e.name });
                }
            }
        }
        return files;
    }

    return result.filePaths.map(p => ({
        path: p,
        name: path.basename(p),
        relPath: path.basename(p),
    }));
});

// ── IPC: Read a file as ArrayBuffer ───────────────────────────────────────
ipcMain.handle('read-file', async (_event, filePath) => {
    try {
        const data = fs.readFileSync(filePath);
        return { ok: true, buffer: data.buffer };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
});

// ── IPC: Write file ───────────────────────────────────────────────────────
ipcMain.handle('write-file', async (_event, filePath, buffer) => {
    try {
        fs.writeFileSync(filePath, Buffer.from(buffer));
        return { ok: true };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
});

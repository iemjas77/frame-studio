/**
 * Electron shell. The renderer is untrusted web content: no Node integration, context isolation + sandbox on, navigation and popups
 * denied, permissions denied, and a single narrow IPC channel (file picker) validated against the sender's origin.
 * All engine work happens in the host (same process here, behind the token-protected localhost API).
 */
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startHost } from './host.ts';

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
let host: Awaited<ReturnType<typeof startHost>> | null = null;

app.whenReady().then(async () => {
  const projectFile = arg('project') ?? path.join(app.getPath('documents'), 'Frame Studio', 'Untitled Project.fstudio');
  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  const staticDir = arg('static') ?? path.join(__dirname, '../../editor/dist');
  host = await startHost({ projectFile, staticDir });
  const origin = host.origin;
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(d.url.startsWith(origin) || d.url.startsWith('devtools://') || d.url.startsWith('data:') || d.url.startsWith('blob:')) }));

  const win = new BrowserWindow({
    width: 1600, height: 950, show: process.env.FS_SHOW !== '0', backgroundColor: '#101315', title: 'Frame Studio',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, preload: path.join(__dirname, 'preload.cjs') },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin)) e.preventDefault(); });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  ipcMain.handle('fs:pickMedia', async (ev) => {
    if (!ev.senderFrame || !ev.senderFrame.url.startsWith(origin)) throw new Error('untrusted sender');
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'openDirectory', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths.filter((p) => path.isAbsolute(p));
  });
  await win.loadURL(host.url);
  if (process.env.FS_EXIT_AFTER_LOAD === '1') { console.log('FRAME_STUDIO_ELECTRON_READY ' + origin); }
});
app.on('window-all-closed', async () => { await host?.close(); app.quit(); });

import { BrowserWindow } from 'electron';
import path from 'node:path';
import { appState } from './state';

export async function createWindow(baseUrl: string): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (!appState.isQuitting) { e.preventDefault(); win.hide(); }
  });
  await win.loadURL(baseUrl);
  return win;
}

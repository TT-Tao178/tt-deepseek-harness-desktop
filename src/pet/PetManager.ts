import { BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';
import { readAppSettings, updatePetPos } from '../settings';

/** v6.1 §2.8 桌宠窗口管理器（主进程）。 */
export class PetManager {
  private win: BrowserWindow | null = null;
  private mainWin: BrowserWindow | null = null;
  absorbed = false;

  create(): void {
    if (this.win && !this.win.isDestroyed()) { this.win.show(); return; }
    const pos = readAppSettings().pet?.pos;
    this.win = new BrowserWindow({
      width: 320, height: 360,
      ...(pos ?? {}),
      transparent: true, frame: false, resizable: false, hasShadow: false,
      skipTaskbar: true, show: false, alwaysOnTop: true, minimizable: false, fullscreenable: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'pet-preload.js') },
    });
    this.win.setAlwaysOnTop(true, 'floating');
    void this.win.loadFile(path.join(__dirname, 'pet', 'index.html'));
    this.win.once('ready-to-show', () => this.win?.show());
    this.win.on('moved', () => {
      if (!this.win) return;
      const [x, y] = this.win.getPosition();
      updatePetPos(x, y);
    });
    this.win.on('closed', () => { this.win = null; });
    this.registerIpc();
  }

  private registerIpc(): void {
    ipcMain.handle('pet:move', (_e, x: number, y: number) => {
      this.win?.setPosition(Math.round(x), Math.round(y));
    });
    ipcMain.handle('pet:getBounds', () => this.win?.getBounds() ?? null);
    ipcMain.handle('pet:toggle', () => {
      if (this.mainWin) { if (this.absorbed) this.release(this.mainWin); else this.absorb(this.mainWin); }
    });
    ipcMain.handle('pet:screen', () => {
      const b = this.win?.getBounds();
      if (!b) return null;
      return screen.getDisplayMatching(b).workArea;
    });
  }

  absorb(mainWin: BrowserWindow): void {
    if (this.absorbed) return;
    this.absorbed = true;
    mainWin.hide();
    this.win?.webContents.send('pet:event', { type: 'absorb' });
  }
  release(mainWin: BrowserWindow): void {
    mainWin.show(); mainWin.focus();
    if (this.absorbed) {
      this.absorbed = false;
      this.win?.webContents.send('pet:event', { type: 'release' });
    }
  }
  attachMainWindow(win: BrowserWindow): void { this.mainWin = win; }
  setAlwaysOnTop(v: boolean): void { this.win?.setAlwaysOnTop(v, 'floating'); }
  setIgnoreMouseEvents(ignore: boolean): void {
    this.win?.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
    if (ignore) this.win?.setAlwaysOnTop(false);
  }
  emitTask(ev: string, payload?: any): void {
    this.win?.webContents.send('pet:event', { type: ev, payload });
  }
  get bounds() { return this.win?.getBounds() ?? null; }
}

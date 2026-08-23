import { app, BrowserWindow, ipcMain, Notification, screen } from 'electron';
import path from 'node:path';
import { readAppSettings, updatePetPos, setPetTheme } from '../settings';
import { appendFileSync, mkdirSync } from 'node:fs';
import { scanSkins, resolveSkin, activeSkinId, skinAssetUrl, SkinInfo } from './skins';

const petLog = () => path.join(app.getPath('userData'), 'logs', 'pet.log');
function plog(msg: string) {
  try { mkdirSync(path.dirname(petLog()), { recursive: true }); appendFileSync(petLog(), `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

/** v6.1 §2.8 桌宠窗口管理器（主进程）。 */
export class PetManager {
  private win: BrowserWindow | null = null;
  private mainWin: BrowserWindow | null = null;
  private ipcRegistered = false;
  absorbed = false;

  create(anchor?: { x: number; y: number; width: number; height: number }): void {
    const saved = readAppSettings().pet?.pos;
    // 已有窗口：仅显示（位置以用户记忆为准）
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      return;
    }
    // 默认位置：右侧垂直居中（v6.4.2-3 用户要求）；用户拖动后记忆覆盖
    let pos = saved;
    if (!pos) {
      const wa = screen.getPrimaryDisplay().workArea;
      pos = { x: wa.x + wa.width - 340, y: wa.y + Math.round((wa.height - 360) / 2) };
    }
    // 越界校验：拉回主屏可见区
    try {
      const wa = screen.getPrimaryDisplay().workArea;
      pos = {
        x: Math.min(Math.max(pos.x, wa.x), wa.x + wa.width - 320),
        y: Math.min(Math.max(pos.y, wa.y), wa.y + wa.height - 360),
      };
    } catch { /* 保持原值 */ }
    this.win = new BrowserWindow({
      width: 320, height: 360,
      ...(pos ?? {}),
      transparent: true, frame: false, resizable: false, hasShadow: false,
      skipTaskbar: true, show: false, alwaysOnTop: true, minimizable: false, fullscreenable: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, '..', 'pet-preload.js') },
    });
    this.win.setAlwaysOnTop(true, 'floating');
    void this.win.loadFile(path.join(__dirname, 'index.html'));
    plog('create: pos=' + JSON.stringify(pos) + ' displays=' + JSON.stringify(screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds, workArea: d.workArea, scale: d.scaleFactor }))));
    this.win.once('ready-to-show', () => {
      plog('ready-to-show');
      this.win?.show();
      // 诊断（排错用，保留轻量日志）
      setTimeout(() => {
        const w = this.win;
        plog('post-show: visible=' + w?.isVisible() + ' bounds=' + JSON.stringify(w?.getBounds()) + ' alwaysOnTop=' + w?.isAlwaysOnTop());
      }, 3000);
    });
    this.win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => { plog('did-fail-load: ' + code + ' ' + desc + ' url=' + url + ' main=' + isMain); });
    // v6.4.2-2：渲染层 console 回传 pet.log（诊断视频/皮肤问题）
    this.win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      plog('renderer[' + level + '] ' + message + ' @' + sourceId + ':' + line);
    });
    this.win.webContents.on('did-finish-load', () => { plog('did-finish-load'); this.pushSkin(); });
    this.win.on('moved', () => {
      if (!this.win) return;
      const [x, y] = this.win.getPosition();
      updatePetPos(x, y);
    });
    this.win.on('closed', () => { this.win = null; });
    this.registerIpc();
  }

  private registerIpc(): void {
    if (this.ipcRegistered) return;   // 防重复注册（桌宠开关重建窗口时）
    this.ipcRegistered = true;
    ipcMain.handle('pet:move', (_e, x: number, y: number) => {
      this.win?.setPosition(Math.round(x), Math.round(y));
    });
    ipcMain.handle('pet:getBounds', () => this.win?.getBounds() ?? null);
    ipcMain.handle('pet:toggle', () => {
      if (this.mainWin) { if (this.absorbed) this.release(this.mainWin); else this.absorb(this.mainWin); }
    });
    ipcMain.handle('pet:setClickThrough', (_e, v: boolean) => {
      // 透明区域可点击穿透；角色区域内由渲染层再切回
      this.win?.setIgnoreMouseEvents(v, v ? { forward: true } : undefined);
    });
    ipcMain.handle('pet:screen', () => {
      const b = this.win?.getBounds();
      if (!b) return null;
      return screen.getDisplayMatching(b).workArea;
    });
    // v6.4.2-3：渲染层皮肤状态回报（applied/degraded/error）→ pet.log + 失败系统通知
    ipcMain.handle('pet:skinStatus', (_e, status: any) => {
      plog('skinStatus: ' + JSON.stringify(status));
      if (status && status.ok === false) {
        try {
          new Notification({ title: '桌宠皮肤加载失败', body: String(status.reason || status.phase || '未知原因') }).show();
        } catch { /* 通知失败不影响 */ }
      }
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
  /** 桌宠开关：关 = 销毁窗口并释放被收起的主窗口；开 = 重建。 */
  setEnabled(on: boolean): void {
    if (on) {
      if (!this.win || this.win.isDestroyed()) this.create(this.mainWin?.getBounds());
      else this.win.show();
      return;
    }
    // 关闭桌宠时若主窗口被收进桌宠 → 先释放，避免主窗口永远隐藏
    if (this.absorbed && this.mainWin) this.release(this.mainWin);
    if (this.win && !this.win.isDestroyed()) { this.win.destroy(); this.win = null; }
  }
  setIgnoreMouseEvents(ignore: boolean): void {
    this.win?.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
    if (ignore) this.win?.setAlwaysOnTop(false);
  }
  emitTask(ev: string, payload?: any): void {
    this.win?.webContents.send('pet:event', { type: ev, payload });
  }
  get bounds() { return this.win?.getBounds() ?? null; }

  // ================= v6.4.2 桌宠皮肤（目录即皮肤；dshpet 为默认） =================
  private builtinSkinDirs(): string[] {
    const base = app.isPackaged
      ? path.join(process.resourcesPath, 'pet', 'themes')
      : path.join(app.getAppPath(), 'resources', 'pet', 'themes');
    return [base];
  }
  private userSkinDir(): string {
    return path.join(app.getPath('userData'), 'themes');
  }
  activeSkinId(): string {
    return activeSkinId(this.builtinSkinDirs(), this.userSkinDir(), readAppSettings().pet?.theme);
  }
  listSkins(): SkinInfo[] {
    return scanSkins(this.builtinSkinDirs(), this.userSkinDir());
  }
  setSkin(id: string): void {
    const info = resolveSkin(this.builtinSkinDirs(), this.userSkinDir(), id);
    if (!info) { plog('setSkin: unknown skin ' + id); return; }
    setPetTheme(id);
    this.pushSkin();
  }
  /** 把当前活动皮肤推给渲染层（渲染层据此构建 css/video 引擎）。 */
  private pushSkin(): void {
    try {
      const id = this.activeSkinId();
      const info = resolveSkin(this.builtinSkinDirs(), this.userSkinDir(), id);
      if (!info) {
        plog('pushSkin: FAIL resolveSkin id=' + id + ' builtin=' + JSON.stringify(this.builtinSkinDirs()) + ' user=' + this.userSkinDir());
        return;
      }
      this.win?.webContents.send('pet:event', {
        type: 'skin',
        payload: { renderer: info.manifest.renderer, manifest: info.manifest, baseUrl: skinAssetUrl(info.dir) },
      });
      plog('pushSkin: ' + info.id + ' renderer=' + info.manifest.renderer);
    } catch (e) { plog('pushSkin error: ' + String(e)); }
  }
}

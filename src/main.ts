import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { ServiceManager } from './service/ServiceManager';
import { createWindow } from './window';
import { createTray } from './tray';
import { registerIpc } from './ipc';
import { appState } from './state';

let service: ServiceManager;
let win: BrowserWindow | null = null;

// §0.3 安全边界（v5.2）：应用数据完全隔离在 userData 下，绝不使用/写入系统 ~/.dsh
if (!process.env.DSH_HOME) {
  process.env.DSH_HOME = path.join(app.getPath('userData'), 'dsh-home');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });

  app.whenReady().then(async () => {
    service = new ServiceManager();
    service.on('ready', (baseUrl: string) => {
      void (async () => {
        if (win && !win.isDestroyed()) {      // P1-A：重启恢复复用窗口，不重复建窗
          await win.loadURL(baseUrl);
          win.show();
        } else {
          win = await createWindow(baseUrl);
        }
      })();
    });
    service.on('exhausted', () => { /* 弹窗：重置 profile */ });
    await service.start();
    createTray();
    registerIpc(service);
  });

  app.on('before-quit', () => {
    appState.isQuitting = true;
    service?.stop();
  });
  app.on('window-all-closed', () => { /* 常驻托盘 */ });
  app.on('activate', () => { if (win && !win.isDestroyed()) win.show(); });
}

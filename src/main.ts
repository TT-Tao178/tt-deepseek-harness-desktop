import { app, BrowserWindow, Menu, globalShortcut } from 'electron';
import path from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { ServiceManager } from './service/ServiceManager';
import { createWindow } from './window';
import { createTray } from './tray';
import { registerIpc } from './ipc';
import { appState } from './state';
import { readAppSettings } from './settings';
import { PetManager } from './pet/PetManager';
import { AgentEventBridge } from './pet/AgentEventBridge';
import { KernelLogTailSource } from './pet/KernelLogTailSource';
import { KernelManager } from './pet/KernelManager';
import { registerPetMenuIpc } from './ipc/pet';

let service: ServiceManager;
let win: BrowserWindow | null = null;
const pet = new PetManager();
const kernelUpdater = new KernelManager();
const eventBridge = new AgentEventBridge();

// bugfix：全局异常捕获——写日志、不弹原生错误框
const mainLog = () => path.join(app.getPath('userData'), 'logs', 'main.log');
function logError(tag: string, err: unknown) {
  try {
    mkdirSync(path.dirname(mainLog()), { recursive: true });
    appendFileSync(mainLog(), `[${new Date().toISOString()}] ${tag}: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  } catch { /* 日志失败不影响运行 */ }
}
process.on('uncaughtException', (e) => { logError('uncaughtException', e); });
process.on('unhandledRejection', (e) => { logError('unhandledRejection', e); });

// §0.3 安全边界：应用数据完全隔离在 userData 下，绝不使用/写入系统 ~/.dsh
if (!process.env.DSH_HOME) {
  process.env.DSH_HOME = path.join(app.getPath('userData'), 'dsh-home');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (pet.absorbed) pet.release(win);
      else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    }
  });

  app.whenReady().then(async () => {
    // V6-S0: 移除 File/Edit 菜单栏
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

    kernelUpdater.init();
    kernelUpdater.onNotify = (msg) => console.log('[kernel-update]', msg);
    if (readAppSettings().pet?.enabled ?? true) {
      try { pet.create(); } catch (e) { logError('pet.create', e); }
    }
    registerPetMenuIpc(pet, () => win);

    // v6.1 §2.5 快捷键（必须 app ready 后注册）
    try {
      globalShortcut.register('Ctrl+Alt+P', () => { if (win) pet.absorbed ? pet.release(win) : pet.absorb(win); });
    } catch (e) { logError('globalShortcut', e); }

    service = new ServiceManager();
    service.on('ready', (baseUrl: string) => {
      void (async () => {
        try {
          if (win && !win.isDestroyed()) {      // P1-A：重启恢复复用窗口
            await win.loadURL(baseUrl);
            win.show();
          } else {
            win = await createWindow(baseUrl);
          }
          pet.attachMainWindow(win);
          pet.create(win.getBounds());   // 锚定主窗口：桌宠默认出现在主窗口右下
        } catch (e) { logError('createWindow/loadURL', e); }
      })();
    });
    service.on('exhausted', () => { /* 弹窗：重置 profile */ });

    // v6.1 §2.6 任务联动（规则由 V6-S4 探针固化；异常降级不崩）
    try {
      const rulesPath = app.isPackaged
        ? path.join(process.resourcesPath, 'task-events.json')
        : path.join(path.dirname(__dirname), 'resources', 'task-events.json');
      const rules = JSON.parse(require('node:fs').readFileSync(rulesPath, 'utf8')).map((r: any) => ({ re: new RegExp(r.re), ev: r.ev }));
      eventBridge.attach(new KernelLogTailSource(path.join(app.getPath('userData'), 'logs', 'kernel.log'), rules));
      void eventBridge.start();
      eventBridge.on('taskStarted', (p) => pet.emitTask('taskStarted', p));
      eventBridge.on('taskProgress', (p) => pet.emitTask('taskProgress', p));
      eventBridge.on('taskDone', (p) => pet.emitTask('taskDone', p));
      eventBridge.on('taskError', (p) => pet.emitTask('taskError', p));
    } catch (e) { logError('task-events', e); }

    await service.start();
    createTray({
      absorb: () => { if (win) pet.absorb(win); },
      onTogglePet: (enabled) => { try { pet.setEnabled(enabled); } catch (e) { logError('pet.setEnabled', e); } },
    });
    registerIpc(service);
  });

  app.on('will-quit', () => { globalShortcut.unregisterAll(); kernelUpdater.dispose(); eventBridge.stop(); });
  app.on('before-quit', () => {
    appState.isQuitting = true;
    service?.stop();
  });
  app.on('window-all-closed', () => { /* 常驻托盘 */ });
  app.on('activate', () => { if (win && !win.isDestroyed()) win.show(); });
}

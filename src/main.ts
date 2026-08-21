import { app, BrowserWindow, Menu, globalShortcut } from 'electron';
import path from 'node:path';
import { ServiceManager } from './service/ServiceManager';
import { createWindow } from './window';
import { createTray } from './tray';
import { registerIpc } from './ipc';
import { appState } from './state';
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

// §0.3 安全边界（v5.2）：应用数据完全隔离在 userData 下，绝不使用/写入系统 ~/.dsh
if (!process.env.DSH_HOME) {
  process.env.DSH_HOME = path.join(app.getPath('userData'), 'dsh-home');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (pet.absorbed) pet.release(win);          // v6.1 O7：被收进桌宠时一并放出
      else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    }
  });

  app.whenReady().then(async () => {
    // V6-S0: 移除 File/Edit 菜单栏（Windows）；macOS 保留系统必需菜单（P1 细化）
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    kernelUpdater.init();
    kernelUpdater.onNotify = (msg) => console.log('[kernel-update]', msg);
    pet.create();
    registerPetMenuIpc(pet, () => win);
    service = new ServiceManager();
    service.on('ready', (baseUrl: string) => {
      void (async () => {
        if (win && !win.isDestroyed()) {      // P1-A：重启恢复复用窗口，不重复建窗
          await win.loadURL(baseUrl);
          win.show();
        } else {
          win = await createWindow(baseUrl);
        }
        pet.attachMainWindow(win);
      })();
    });
    service.on('exhausted', () => { /* 弹窗：重置 profile */ });
    // v6.1 §2.6 任务联动：内核日志尾部事件源（规则由 V6-S4 探针固化）
    try {
      const rules = JSON.parse(require('node:fs').readFileSync(require('node:path').join(require('node:path').dirname(require.resolve('./service/ServiceManager.js')), '../../resources/task-events.json'), 'utf8')).map((r: any) => ({ re: new RegExp(r.re), ev: r.ev }));
      eventBridge.attach(new KernelLogTailSource(require('node:path').join(app.getPath('userData'), 'logs', 'kernel.log'), rules));
      void eventBridge.start();
      eventBridge.on('taskStarted', (p) => pet.emitTask('taskStarted', p));
      eventBridge.on('taskProgress', (p) => pet.emitTask('taskProgress', p));
      eventBridge.on('taskDone', (p) => pet.emitTask('taskDone', p));
      eventBridge.on('taskError', (p) => pet.emitTask('taskError', p));
    } catch { /* 规则为空/日志未就绪：桌宠保持 idle（降级不崩） */ }
    await service.start();
    createTray({ absorb: () => { if (win) pet.absorb(win); } });
    registerIpc(service);
  });

  // v6.1 §2.5 快捷键生命周期
  if (process.platform !== 'darwin') {
    globalShortcut.register('Ctrl+Alt+P', () => { if (win) pet.absorbed ? pet.release(win) : pet.absorb(win); });
  }
  app.on('will-quit', () => { globalShortcut.unregisterAll(); kernelUpdater.dispose(); eventBridge.stop(); });

  app.on('before-quit', () => {
    appState.isQuitting = true;
    service?.stop();
  });
  app.on('window-all-closed', () => { /* 常驻托盘 */ });
  app.on('activate', () => { if (win && !win.isDestroyed()) win.show(); });
}

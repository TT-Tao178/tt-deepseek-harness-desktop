import { app, BrowserWindow, Menu, globalShortcut } from 'electron';
import path from 'node:path';
import { appendFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
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
import { injectUiPanel } from './ui-inject';
import { registerBgSchemes, registerBackground } from './bg';

// v6.4.2-4：ttbg:// 协议特权（必须在 app ready 前注册）
registerBgSchemes();

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

/**
 * v6.5.2-2：确保内核能从 userData dsh-home 解析 tt-bg 插件。
 * cordis 从 profile 目录向上查找 node_modules——userData 在项目外，向上到不了项目根，
 * 因此必须在 dsh-home/node_modules 下建 tt-bg junction（幂等；源目录 dev=项目 plugins，
 * packaged=app 内 plugins）。
 */
function ensureKernelPluginLink(): void {
  try {
    const srcCandidates = [
      path.join(app.getAppPath(), 'plugins', 'tt-bg'),
      path.join(app.getAppPath(), 'node_modules', 'tt-bg'),
      path.join(process.resourcesPath, 'tt-bg'),
    ];
    const src = srcCandidates.find((p) => existsSync(path.join(p, 'package.json')));
    if (!src) { logError('ensureKernelPluginLink', new Error('tt-bg 包目录未找到')); return; }
    const homeModules = path.join(app.getPath('userData'), 'dsh-home', 'node_modules');
    const target = path.join(homeModules, 'tt-bg');
    if (existsSync(target)) return;
    mkdirSync(homeModules, { recursive: true });
    symlinkSync(src, target, 'junction');
  } catch (e) { logError('ensureKernelPluginLink', e); }
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

    ensureKernelPluginLink();   // v6.5.2-2：tt-bg 插件链接（内核解析必需，先于内核启动）

    kernelUpdater.init();
    kernelUpdater.onNotify = (msg) => console.log('[kernel-update]', msg);
    if (readAppSettings().pet?.enabled ?? true) {
      try { await pet.ensureAssets(); pet.create(); } catch (e) { logError('pet.create', e); }
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
          // v6.4.2：向 DSH 页面注入「主题与桌宠」面板（幂等；内核重启后随导航重新注入）
          win.webContents.on('did-finish-load', () => injectUiPanel(win!));
          injectUiPanel(win);
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
    registerIpc(service, pet);
    registerBackground(() => win);   // v6.4.2-4：背景上传/透明度/ttbg 协议
  });

  app.on('will-quit', () => { globalShortcut.unregisterAll(); kernelUpdater.dispose(); eventBridge.stop(); });
  app.on('before-quit', () => {
    appState.isQuitting = true;
    service?.stop();
  });
  app.on('window-all-closed', () => { /* 常驻托盘 */ });
  app.on('activate', () => { if (win && !win.isDestroyed()) win.show(); });
}

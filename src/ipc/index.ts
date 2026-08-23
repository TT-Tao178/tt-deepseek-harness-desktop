import { BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { ServiceManager } from '../service/ServiceManager';
import { probeLocal } from '../provider/probe';
import { OpenAICompatibleAdapter } from '../provider/adapters';
import { ProviderConfig } from '../provider/types';
import { listProviders, loadProvider, saveProvider, removeProvider } from '../provider/store';
import { getTheme, setTheme, listCustom } from '../theme/themeManager';
import { syncProvidersToDsh } from '../provider/dshSync';
import { readAppSettings, setPetEnabled, setCloseBehavior } from '../settings';
import type { PetManager } from '../pet/PetManager';
import { C } from './channels';

export function registerIpc(service: ServiceManager, pet?: PetManager) {
  ipcMain.handle(C.serviceGetStatus, () => ({ state: service.state, baseUrl: service.baseUrl }));
  ipcMain.handle(C.serviceRestart, () => service.restart());

  ipcMain.handle(C.providerList, () => listProviders().map(({ apiKey, ...rest }) => ({ ...rest, hasKey: !!apiKey })));

  function loadProviderSafe(id: string): ProviderConfig | null {
    try { return loadProvider(id); } catch { return null; }
  }

  ipcMain.handle(C.providerSave, (_e, cfg: ProviderConfig) => {
    const hadKey = !!loadProviderSafe(cfg.id);
    saveProvider(cfg);
    syncProvidersToDsh();                       // §12.2：直写 DSH settings，热重载生效
    if (cfg.apiKey || hadKey) void service.restart();  // Key 变更 → 重启内核注入新 env
  });
  ipcMain.handle(C.providerRemove, (_e, id: string) => {
    const hadKey = !!loadProviderSafe(id);
    removeProvider(id);
    syncProvidersToDsh();
    if (hadKey) void service.restart();
  });
  ipcMain.handle(C.providerTest, (_e, id: string) => new OpenAICompatibleAdapter().health(loadProvider(id)));
  ipcMain.handle(C.providerListModels, (_e, id: string) => new OpenAICompatibleAdapter().listModels(loadProvider(id)));
  ipcMain.handle(C.providerProbeLocal, () => probeLocal());

  ipcMain.handle(C.themeGet, () => getTheme());
  ipcMain.handle(C.themeSet, (_e, mode: any) => setTheme(mode));
  ipcMain.handle(C.themeListCustom, () => listCustom());

  // v6.4.2：DSH 界面"主题与桌宠"面板 —— 桌宠开关（持久化 + 窗口操作，与托盘双入口同源）
  ipcMain.handle(C.petGetEnabled, () => readAppSettings().pet?.enabled ?? true);
  ipcMain.handle(C.petSetEnabled, (_e, v: boolean) => {
    setPetEnabled(!!v);
    pet?.setEnabled(!!v);
  });

  // v6.5.2-3：关闭窗口行为（从托盘移入 ⚙ 设置面板）
  ipcMain.handle(C.closeGet, () => readAppSettings().closeBehavior);
  ipcMain.handle(C.closeSet, (_e, v: any) => {
    if (['ask', 'tray', 'quit'].includes(v)) setCloseBehavior(v);
  });

  ipcMain.handle(C.notify, (_e, title: string, body?: string) => { new Notification({ title, body }).show(); });

  ipcMain.handle(C.dialogOpenDirectory, (_e, opts?: any) =>
    dialog.showOpenDialog({ properties: ['openDirectory'], ...opts }).then(r => r.canceled ? null : r.filePaths[0]));
  ipcMain.handle(C.dialogOpenFile, (_e, opts?: any) =>
    dialog.showOpenDialog({ properties: ['openFile'], ...opts }).then(r => r.canceled ? null : r.filePaths[0]));
  ipcMain.handle(C.dialogSaveFile, (_e, opts?: any) =>
    dialog.showSaveDialog(opts ?? {}).then(r => r.canceled ? null : r.filePath));

  ipcMain.handle(C.shellOpenExternal, (_e, url: string) => shell.openExternal(url));
  ipcMain.handle(C.shellShowItem, (_e, p: string) => shell.showItemInFolder(p));

  ipcMain.handle(C.windowMinimize, () => BrowserWindow.getFocusedWindow()?.minimize());
  ipcMain.handle(C.windowMaximize, () => BrowserWindow.getFocusedWindow()?.maximize());
}

import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';
import { readAppSettings, setPetEnabled } from './settings';

/** v6.4.2 修复：托盘空图标（原 createEmpty 占位）。直接用应用图标 icon.ico（与任务栏一致），失败兜底 createEmpty。 */
function trayIcon(): Electron.NativeImage {
  const p = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(app.getAppPath(), 'resources', 'icon.ico');
  try {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img;   // 原图直接给 Tray（Windows 自动选择合适尺寸）
  } catch { /* 兜底 */ }
  return nativeImage.createEmpty();
}

export function createTray(opts?: { absorb?: () => void; onTogglePet?: (enabled: boolean) => void }) {
  const tray = new Tray(trayIcon());
  tray.setToolTip('TT DeepSeek Harness');
  const show = () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { w.show(); w.focus(); } };

  const buildMenu = (): void => {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: show },
      ...(opts?.absorb ? [{ label: '收进桌宠', click: opts.absorb }, { type: 'separator' } as const] : []),
      { type: 'separator' },
      {
        label: '桌宠',
        type: 'checkbox',
        checked: readAppSettings().pet?.enabled ?? true,
        click: (item) => {
          setPetEnabled(item.checked);
          opts?.onTogglePet?.(item.checked);
          buildMenu();
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]));
  };
  buildMenu();
  tray.on('click', show);
}

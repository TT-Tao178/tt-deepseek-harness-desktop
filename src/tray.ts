import { app, BrowserWindow, Menu, MenuItemConstructorOptions, Tray, nativeImage } from 'electron';
import path from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { readAppSettings, setCloseBehavior, setPetEnabled, CloseBehavior } from './settings';

/** v6.5.2-3：托盘操作日志（写 main.log）。 */
function logTray(msg: string): void {
  try {
    const p = path.join(app.getPath('userData'), 'logs', 'main.log');
    mkdirSync(path.dirname(p), { recursive: true });
    appendFileSync(p, `[${new Date().toISOString()}] [tray] ${msg}\n`);
  } catch { /* 忽略 */ }
}

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
    const current = readAppSettings().closeBehavior;
    const item = (label: string, value: CloseBehavior): MenuItemConstructorOptions => ({
      label, type: 'radio' as const, checked: current === value,
      click: () => { setCloseBehavior(value); logTray('closeBehavior -> ' + value); buildMenu(); },   // 改设置后重建菜单刷新选中态
    });
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: show },
      ...(opts?.absorb ? [{ label: '收进桌宠', click: opts.absorb }, { type: 'separator' } as const] : []),
      { type: 'separator' },
      { label: '关闭窗口行为', enabled: false },
      item('每次询问', 'ask'),
      item('最小化到托盘', 'tray'),
      item('直接退出', 'quit'),
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

import { app, BrowserWindow, Menu, MenuItemConstructorOptions, Tray, nativeImage } from 'electron';
import { readAppSettings, setCloseBehavior, CloseBehavior } from './settings';

export function createTray(opts?: { absorb?: () => void }) {
  const tray = new Tray(nativeImage.createEmpty());   // 占位；后续换 resources/icons/tray.png
  tray.setToolTip('TT DeepSeek Harness');
  const show = () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { w.show(); w.focus(); } };

  const buildMenu = (): void => {
    const current = readAppSettings().closeBehavior;
    const item = (label: string, value: CloseBehavior): MenuItemConstructorOptions => ({
      label, type: 'radio' as const, checked: current === value,
      click: () => { setCloseBehavior(value); buildMenu(); },   // 改设置后重建菜单刷新选中态
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
      { label: '退出', click: () => app.quit() },
    ]));
  };
  buildMenu();
  tray.on('click', show);
}

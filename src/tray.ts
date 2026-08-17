import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';

export function createTray() {
  const tray = new Tray(nativeImage.createEmpty());   // 占位；后续换 resources/icons/tray.png
  tray.setToolTip('TT DeepSeek Harness');
  const show = () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { w.show(); w.focus(); } };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: show },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', show);
}

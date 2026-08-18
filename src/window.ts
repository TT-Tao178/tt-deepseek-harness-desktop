import { BrowserWindow, dialog, app } from 'electron';
import path from 'node:path';
import { appState } from './state';
import { readAppSettings, setCloseBehavior } from './settings';

export async function createWindow(baseUrl: string): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (appState.isQuitting) return;                 // 真正退出时放行
    e.preventDefault();
    const { closeBehavior } = readAppSettings();
    if (closeBehavior === 'tray') { win.hide(); return; }
    if (closeBehavior === 'quit') { app.quit(); return; }
    // 'ask'：弹窗询问（可选记住选择）
    void (async () => {
      const r = await dialog.showMessageBox(win, {
        type: 'question',
        title: 'TT DeepSeek Harness Desktop',
        message: '关闭窗口后要做什么？',
        detail: '可以最小化到系统托盘继续运行，或直接退出应用。',
        buttons: ['最小化到托盘', '退出'],
        defaultId: 0,
        cancelId: 0,
        checkboxLabel: '记住我的选择，下次不再询问',
        checkboxChecked: false,
      });
      if (r.checkboxChecked) setCloseBehavior(r.response === 0 ? 'tray' : 'quit');
      if (r.response === 1) app.quit();
      else win.hide();
    })();
  });
  await win.loadURL(baseUrl);
  return win;
}

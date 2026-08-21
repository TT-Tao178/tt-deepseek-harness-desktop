import { app, Menu, ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import type { PetManager } from '../pet/PetManager';

/** v6.1 §2.4-5 桌宠右键菜单（主进程构建）。 */
export function registerPetMenuIpc(pet: PetManager, getMainWin: () => BrowserWindow | null) {
  ipcMain.handle('pet:menu', () => {
    const mainWin = getMainWin();
    const menu = Menu.buildFromTemplate([
      { label: '打开主界面', click: () => { if (mainWin) pet.release(mainWin); } },
      { label: '收进桌宠', click: () => { if (mainWin) pet.absorb(mainWin); } },
      { type: 'separator' },
      { label: '常驻置顶', type: 'checkbox', checked: true, click: (item) => pet.setAlwaysOnTop(item.checked) },
      { label: '穿透模式（鼠标可点穿）', click: () => pet.setIgnoreMouseEvents(true) },
      { type: 'separator' },
      { label: '退出应用', click: () => app.quit() },
    ]);
    menu.popup();
  });
}

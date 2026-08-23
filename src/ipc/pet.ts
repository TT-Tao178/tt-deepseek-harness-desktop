import { app, Menu, ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import type { PetManager } from '../pet/PetManager';

/** v6.1 §2.4-5 桌宠右键菜单（主进程构建）。v6.4.2：新增「更换皮肤」子菜单。 */
export function registerPetMenuIpc(pet: PetManager, getMainWin: () => BrowserWindow | null) {
  ipcMain.handle('pet:menu', () => {
    const mainWin = getMainWin();
    const skins = pet.listSkins();
    const active = pet.activeSkinId();
    const menu = Menu.buildFromTemplate([
      { label: '打开主界面', click: () => { if (mainWin) pet.release(mainWin); } },
      { label: '收进桌宠', click: () => { if (mainWin) pet.absorb(mainWin); } },
      { type: 'separator' },
      {
        label: '更换皮肤',
        submenu: skins.length
          ? skins.map((s) => ({
              label: s.name + (s.renderer === 'video' ? '（视频）' : s.renderer === 'css' ? '（默认）' : ''),
              type: 'checkbox',
              checked: s.id === active,
              click: () => pet.setSkin(s.id),
            }))
          : [{ label: '（无可用皮肤）', enabled: false }],
      },
      { type: 'separator' },
      { label: '常驻置顶', type: 'checkbox', checked: true, click: (item) => pet.setAlwaysOnTop(item.checked) },
      { label: '穿透模式（鼠标可点穿）', click: () => pet.setIgnoreMouseEvents(true) },
      { type: 'separator' },
      { label: '退出应用', click: () => app.quit() },
    ]);
    menu.popup();
  });
}

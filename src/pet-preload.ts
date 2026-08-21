import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('petApi', {
  move: (x: number, y: number) => ipcRenderer.invoke('pet:move', x, y),
  menu: () => ipcRenderer.invoke('pet:menu'),
  getBounds: () => ipcRenderer.invoke('pet:getBounds'),
  screen: () => ipcRenderer.invoke('pet:screen'),
  toggle: () => ipcRenderer.invoke('pet:toggle'),
  onEvent: (cb: (e: any) => void) => {
    const h = (_e: any, ev: any) => cb(ev);
    ipcRenderer.on('pet:event', h);
    return () => ipcRenderer.removeListener('pet:event', h);
  },
});

// v6.4.2-4：背景上传小窗口 preload（sandbox 白名单，字符串内联）
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bgApi', {
  pick: () => ipcRenderer.invoke('bg:pick'),
  apply: (p: string) => ipcRenderer.invoke('bg:apply', p),
  cancel: () => ipcRenderer.invoke('bg:cancel'),
});

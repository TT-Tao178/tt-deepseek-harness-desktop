import { contextBridge, ipcRenderer } from 'electron';

const invoke = (ch: string) => (payload?: unknown) => ipcRenderer.invoke(ch, payload);

contextBridge.exposeInMainWorld('dshDesktop', {
  service: { getStatus: invoke('service:getStatus'), restart: invoke('service:restart') },
  provider: {
    list: invoke('provider:list'),
    save: (cfg: unknown) => ipcRenderer.invoke('provider:save', cfg),
    remove: (id: string) => ipcRenderer.invoke('provider:remove', id),
    test: (id: string) => ipcRenderer.invoke('provider:test', id),
    probeLocal: invoke('provider:probeLocal'),
    listModels: (id: string) => ipcRenderer.invoke('provider:listModels', id),
  },
  theme: {
    get: invoke('theme:get'),
    set: (mode: string) => ipcRenderer.invoke('theme:set', mode),
    listCustom: invoke('theme:listCustom'),
  },
  notify: (title: string, body?: string) => ipcRenderer.invoke('notify', title, body),
  dialog: {
    openDirectory: (opts?: unknown) => ipcRenderer.invoke('dialog:openDirectory', opts),
    openFile: (opts?: unknown) => ipcRenderer.invoke('dialog:openFile', opts),
    saveFile: (opts?: unknown) => ipcRenderer.invoke('dialog:saveFile', opts),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    showItemInFolder: (p: string) => ipcRenderer.invoke('shell:showItemInFolder', p),
  },
  window: { minimize: invoke('window:minimize'), maximize: invoke('window:maximize') },
});

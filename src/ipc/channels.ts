export const C = {
  serviceGetStatus: 'service:getStatus', serviceRestart: 'service:restart',
  providerList: 'provider:list', providerSave: 'provider:save', providerRemove: 'provider:remove',
  providerTest: 'provider:test', providerProbeLocal: 'provider:probeLocal', providerListModels: 'provider:listModels',
  themeGet: 'theme:get', themeSet: 'theme:set', themeListCustom: 'theme:listCustom',
  notify: 'notify',
  dialogOpenDirectory: 'dialog:openDirectory', dialogOpenFile: 'dialog:openFile', dialogSaveFile: 'dialog:saveFile',
  shellOpenExternal: 'shell:openExternal', shellShowItem: 'shell:showItemInFolder',
  windowMinimize: 'window:minimize', windowMaximize: 'window:maximize',
} as const;

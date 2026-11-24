'use strict';

/**
 * 预加载脚本：渲染进程唯一能接触主进程的窗口。
 * 只暴露白名单方法，不放 ipcRenderer 本身，也不开 nodeIntegration。
 */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('app:init'),

  addTask: (input) => ipcRenderer.invoke('tasks:add', input),
  toggleTask: (id) => ipcRenderer.invoke('tasks:toggle', id),
  updateTask: (id, patch) => ipcRenderer.invoke('tasks:update', { id, patch }),
  removeTask: (id) => ipcRenderer.invoke('tasks:remove', id),
  reorder: (ids) => ipcRenderer.invoke('tasks:reorder', ids),

  runPlan: (options) => ipcRenderer.invoke('plan:run', options || {}),
  clearPlan: () => ipcRenderer.invoke('plan:clear'),

  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  testAI: (draft) => ipcRenderer.invoke('ai:test', draft),

  hide: () => ipcRenderer.invoke('app:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  contextMenu: () => ipcRenderer.invoke('app:contextMenu'),

  onState: (handler) => subscribe('state:changed', handler),
  onFocusCapture: (handler) => subscribe('focus:capture', handler),
  onPlanRequest: (handler) => subscribe('plan:request', handler),
  onOpenSettings: (handler) => subscribe('open:settings', handler),
});

'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFiles: () => ipcRenderer.invoke('dialog:pick-files'),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  startCompression: (config) => ipcRenderer.invoke('compress:start', config),
  cancelCompression: () => ipcRenderer.send('compress:cancel'),
  openFolder: (p) => ipcRenderer.invoke('shell:open-folder', p),
  getPreview: (p) => ipcRenderer.invoke('image:preview', p),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  onEvent: (callback) => {
    const listener = (_e, ev) => callback(ev);
    ipcRenderer.on('compress:event', listener);
    return () => ipcRenderer.removeListener('compress:event', listener);
  },
  platform: process.platform,
});

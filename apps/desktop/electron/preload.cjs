// Sandboxed preload: exposes exactly two functions. No Node, no ipcRenderer, no generic channel.
const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('frameStudio', Object.freeze({
  pickMedia: () => ipcRenderer.invoke('fs:pickMedia'),
  pathForFile: (file) => webUtils.getPathForFile(file),
}));

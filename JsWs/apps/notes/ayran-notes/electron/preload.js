const { contextBridge, ipcRenderer } = require('electron');

/**
 * Expose a safe filesystem bridge to the renderer process.
 * This allows the web app (running in Electron) to access the local filesystem
 * via IPC without exposing Node.js APIs directly.
 */
contextBridge.exposeInMainWorld('electronFS', {
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', filePath, content),
  readFileBytes: (filePath) => ipcRenderer.invoke('fs:readFileBytes', filePath),
  writeFileBytes: (filePath, bytes) => ipcRenderer.invoke('fs:writeFileBytes', filePath, bytes),
  deleteFile: (filePath) => ipcRenderer.invoke('fs:deleteFile', filePath),
  listDir: (dirPath) => ipcRenderer.invoke('fs:listDir', dirPath),
  createDir: (dirPath) => ipcRenderer.invoke('fs:createDir', dirPath),
  deleteDir: (dirPath) => ipcRenderer.invoke('fs:deleteDir', dirPath),
  moveFile: (src, dest) => ipcRenderer.invoke('fs:moveFile', src, dest),
  copyFile: (src, dest) => ipcRenderer.invoke('fs:copyFile', src, dest),
  exists: (filePath) => ipcRenderer.invoke('fs:exists', filePath),
  stat: (filePath) => ipcRenderer.invoke('fs:stat', filePath),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  printToPdf: (html) => ipcRenderer.invoke('print:toPdf', html),
  isElectron: true,
});

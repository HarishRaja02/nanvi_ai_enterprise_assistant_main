const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  platform: process.platform,
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  listFolderFiles: (folderPath) => ipcRenderer.invoke('fs:listFolderFiles', folderPath),
  approveAndListFolderFiles: (folderPath) => ipcRenderer.invoke('fs:approveAndListFolderFiles', folderPath),
  connectFolderFast: (folderPath) => ipcRenderer.invoke('fs:connectFolderFast', folderPath),
  searchDesktopFolder: (folderPath, query, topChunksLimit, topFilesLimit, options) =>
    ipcRenderer.invoke('fs:searchFolder', folderPath, query, topChunksLimit, topFilesLimit, options),
  getSearchSidecarStatus: (folderPath) => ipcRenderer.invoke('fs:getSearchStatus', folderPath),
  getPersistedDesktopFolder: () => ipcRenderer.invoke('fs:getPersistedDesktopFolder'),
  savePersistedDesktopFolder: (meta) => ipcRenderer.invoke('fs:savePersistedDesktopFolder', meta),
  onFolderCountUpdated: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('fs:folderCountUpdated', handler);
    return () => ipcRenderer.removeListener('fs:folderCountUpdated', handler);
  },
  revokeApprovedFolder: (folderPath) => ipcRenderer.invoke('fs:revokeApprovedFolder', folderPath),
  readFileBytes: (filePath) => ipcRenderer.invoke('fs:readFileBytes', filePath),
  showNotification: (title, body) => ipcRenderer.invoke('app:notification', { title, body }),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
  getMicAccessStatus: () => ipcRenderer.invoke('voice:getMicAccessStatus'),
  requestMicAccess: () => ipcRenderer.invoke('voice:requestMicAccess'),
  openMicSettings: () => ipcRenderer.invoke('voice:openMicSettings'),
  onAccountBlocked: (callback) => {
    ipcRenderer.on('account-blocked', () => callback());
  },
  onOAuthCallback: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('oauth:callback-received', handler);
    return () => ipcRenderer.removeListener('oauth:callback-received', handler);
  },
});


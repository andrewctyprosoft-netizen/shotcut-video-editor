// Preload bridge (CommonJS: sandboxed preloads cannot be ES modules). Exposes a small, typed API as window.api.
const { contextBridge, ipcRenderer } = require('electron');

/** Subscribe to a main-process event; returns an unsubscribe function. */
function on(channel, cb) {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (next) => ipcRenderer.invoke('settings:set', next),
  toolStatus: () => ipcRenderer.invoke('tools:status'),
  pickMedia: () => ipcRenderer.invoke('media:pick'),
  openProject: () => ipcRenderer.invoke('project:open'),
  saveProject: (args) => ipcRenderer.invoke('project:save', args),
  pickTranscript: () => ipcRenderer.invoke('transcript:pick'),
  saveCaptions: (args) => ipcRenderer.invoke('captions:save', args),
  pickExportPath: (args) => ipcRenderer.invoke('export:pick', args),
  exportEncoder: () => ipcRenderer.invoke('export:encoder'),
  showItem: (path) => ipcRenderer.invoke('shell:showItem', path),
  startJob: (kind, label, payload) => ipcRenderer.invoke('job:start', { kind, label, payload }),
  cancelJob: (id) => ipcRenderer.invoke('job:cancel', id),
  onJob: (cb) => on('job:update', cb),
  onProjectLoaded: (cb) => on('project:loaded', cb),
});

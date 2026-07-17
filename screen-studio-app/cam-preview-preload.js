const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("camPreview", {
  onFrame: (cb) => ipcRenderer.on("cam-preview-frame", (e, dataURL) => cb(dataURL)),
});

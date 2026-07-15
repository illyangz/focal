const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  done: (rect) => ipcRenderer.send("overlay-done", rect),
  cancel: () => ipcRenderer.send("overlay-cancel"),
});

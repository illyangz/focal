const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("studio", {
  getSources: () => ipcRenderer.invoke("get-sources"),
  selectSource: (id) => ipcRenderer.send("select-source", id),
  screenPerm: () => ipcRenderer.invoke("screen-perm"),
  openScreenSettings: () => ipcRenderer.send("open-screen-settings"),
  trackStart: () => ipcRenderer.invoke("track-start"),
  trackStop: () => ipcRenderer.invoke("track-stop"),
  winTracking: () => ipcRenderer.invoke("win-tracking"),
  selectRegion: (bounds) => ipcRenderer.invoke("select-region", bounds),
  shareUpload: (buf, name) => ipcRenderer.invoke("share-upload", buf, name),
  recoverySave: (name, buf) => ipcRenderer.invoke("recovery-save", name, buf),
  recoveryCheck: () => ipcRenderer.invoke("recovery-check"),
  recoveryLoad: () => ipcRenderer.invoke("recovery-load"),
  minimize: () => ipcRenderer.send("win-minimize"),
  restore: () => ipcRenderer.send("win-restore"),
  onHotkeyStop: (cb) => ipcRenderer.on("hotkey-stop", cb),
});

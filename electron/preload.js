// preload.js — secure bridge between the renderer (UI) and the main process.
// Exposes a tiny `window.csb` API backed by IPC. contextIsolation stays on;
// the renderer never touches Node directly.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("csb", {
  listSessions: (refresh) => ipcRenderer.invoke("csb:list", refresh),
  loadSession: (id) => ipcRenderer.invoke("csb:session", id),
  resume: (id) => ipcRenderer.invoke("csb:resume", id),
});

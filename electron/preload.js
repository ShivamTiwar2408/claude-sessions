// preload.js — secure bridge between the renderer (UI) and the main process.
// Exposes a tiny `window.csb` API backed by IPC. contextIsolation stays on;
// the renderer never touches Node directly.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("csb", {
  listSessions: (refresh) => ipcRenderer.invoke("csb:list", refresh),
  loadSession: (id) => ipcRenderer.invoke("csb:session", id),
  search: (query) => ipcRenderer.invoke("csb:search", query),
  aiSearch: (query) => ipcRenderer.invoke("csb:aisearch", query),
  resume: (id) => ipcRenderer.invoke("csb:resume", id),

  // Streaming chat. startChat returns an unsubscribe fn; `onEvent` fires for
  // each streamed payload ({type:"delta"|"tool"|"status"|"error"|"done", ...}).
  startChat: (turnId, id, message, onEvent) => {
    const channel = `csb:chat:${turnId}`;
    const listener = (_e, payload) => onEvent(payload);
    ipcRenderer.on(channel, listener);
    ipcRenderer.invoke("csb:chat", { turnId, id, message });
    return () => ipcRenderer.removeListener(channel, listener);
  },
  stopChat: (turnId) => ipcRenderer.invoke("csb:chat:stop", turnId),
});

// Electron main process for Claude Sessions — pure Node, no Python sidecar.
//
// On launch it:
//   1. Builds the session index in-process (parser.js, plain Node fs).
//   2. Loads index.html directly into a native window.
//   3. Answers the UI's requests over IPC (list / session / resume).
//
// One process. No HTTP server, no localhost port, no Python. The app does the
// work itself; when you quit, everything goes with it.

const { app, BrowserWindow, shell, nativeImage, ipcMain } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const parser = require("./parser");

// Identify as "Claude Sessions" (affects the app menu in dev; the dock
// tooltip comes from the packaged bundle's Info.plist — see `npm run dist`).
app.setName("Claude Sessions");

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 760,
    minHeight: 480,
    title: "Claude Sessions",
    backgroundColor: "#faf7f2",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---- IPC handlers (the "server", now in-process) -------------------------

ipcMain.handle("csb:list", (_evt, refresh) => {
  try {
    return parser.listSessions(!!refresh);
  } catch (e) {
    return { sessions: [], projects: [], error: String(e) };
  }
});

ipcMain.handle("csb:session", (_evt, id) => {
  try {
    return parser.loadTranscript(id);
  } catch (e) {
    return { error: String(e) };
  }
});

ipcMain.handle("csb:resume", (_evt, id) => {
  return resumeSession(id);
});

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
function applescriptEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function resumeSession(id) {
  const sessions = parser.getIndex();
  const match = sessions.find((s) => s.id === id);
  if (!match) return Promise.resolve({ ok: false, error: "session not found" });
  const cwd = match.cwd;
  const cmd = `cd ${shellQuote(cwd)} && claude --resume ${shellQuote(id)}`;

  if (process.platform !== "darwin") {
    return Promise.resolve({ ok: false, error: "auto-launch only on macOS", cmd, cwd });
  }
  const osa = `tell application "Terminal"\n  do script "${applescriptEscape(cmd)}"\n  activate\nend tell`;
  return new Promise((resolve) => {
    execFile("osascript", ["-e", osa], { timeout: 10000 }, (err) => {
      if (err) resolve({ ok: false, error: String(err), cmd, cwd });
      else resolve({ ok: true, launched: true, cmd, cwd });
    });
  });
}

// ---- lifecycle -----------------------------------------------------------

app.whenReady().then(() => {
  try {
    const iconPath = path.join(__dirname, "icon.png");
    if (fs.existsSync(iconPath) && app.dock) {
      app.dock.setIcon(nativeImage.createFromPath(iconPath));
    }
  } catch (_) {}

  // warm the index so the first UI request is instant
  try {
    parser.getIndex();
  } catch (_) {}

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

# Claude Sessions

A native desktop app to **browse, search, view, and resume your Claude Code conversations**.

Claude Code stores every conversation as a `.jsonl` file under `~/.claude/projects/`.
Over time those pile up and become impossible to navigate. **Claude Sessions** reads
them locally and gives you a clean, fast UI to find old threads and jump back into them.

![Claude Sessions](electron/icon.png)

## Features

- **Browse every session** across all your projects, sorted by latest activity
- **Two search modes** (⌘K to focus):
  - **🔍 Keyword** — fast, offline full-text search over *every message body* (not just titles). Type naturally — filler words are stripped, so "the chat where I set up react query" matches on the meaningful terms. Searches as you type.
  - **✨ Ask AI** — describe the conversation in plain English ("where I was looking for my previous CRs and quips") and Claude ranks sessions by *meaning*, understanding synonyms and intent. Each result shows why it matched. **No API key needed** — it reuses your local `claude` CLI (see [AI search](#ai-search)).
- **Auto-generated titles & summaries** — uses Claude Code's own `ai-title`/`last-prompt`
- **Full transcript view** with rich, collapsible **tool-call cards** — see the exact
  Bash command, file edits, search queries, and their complete output
- **Sub-agents as leaves** 🌿 — sub-agents spawned by a session appear as expandable
  branches at the exact point in the conversation where they were launched, so you can
  read what each one did. Your top-level list stays clean (main conversations only).
- **One-click resume** — opens your terminal and runs `claude --resume <id>` in the
  right directory (macOS)

## How it works

100% local. One process. No servers, no network, no telemetry.

```
~/.claude/projects/*.jsonl  →  parser.js (Node fs)  →  Electron window (IPC)  →  claude --resume
```

- **`parser.js`** — reads and parses the session files (pure Node, no dependencies)
- **`main.js`** — Electron main process; serves data to the UI over IPC
- **`preload.js`** — secure `contextIsolation` bridge (`window.csb`)
- **`index.html`** — the UI

It only ever **reads** your session files. The single write-action is "Resume",
which launches your terminal.

## Running from source

Requires [Node.js](https://nodejs.org) 18+.

```bash
cd electron
npm install
npm start
```

## Building a desktop app

```bash
cd electron
npm run dist          # produces dist/mac-arm64/Claude Sessions.app
```

Then drag `Claude Sessions.app` to `/Applications`.

> **Note:** the build is unsigned. On first launch macOS may warn about an
> unidentified developer — right-click the app → **Open**, or run
> `xattr -dr com.apple.quarantine "/Applications/Claude Sessions.app"`.

## Platform support

| Platform | Browse / search / view | One-click resume |
|----------|:---:|:---:|
| macOS    | ✅ | ✅ (Terminal.app) |
| Windows  | ✅ | ⚠️ copy command |
| Linux    | ✅ | ⚠️ copy command |

Resume currently auto-launches a terminal on macOS only; other platforms show the
command to copy. Contributions welcome.

## AI search

Both search modes work out of the box — **no API key required.**

**Ask AI** reuses the `claude` CLI already installed and authenticated on your
machine (the same one that powers Claude Code). It runs `claude` in headless
mode (`claude -p`) under the hood, so whatever auth that CLI uses — Bedrock, a
subscription, an API key — is reused transparently. If `claude` isn't on your
PATH, Ask AI shows a friendly message and Keyword search still works.

How it works: the app builds a compact catalog of every session (title +
summary + a short body excerpt) and asks Claude to return the ids matching your
query's intent as JSON. Only short excerpts are sent — never full transcripts.

### The full-text index

Keyword search is backed by an incremental, on-disk index at
`~/.claude/.claude-sessions-index.json`. On launch the app compares each session
file's modification time against the cached entry and **re-reads only what
changed** — new sessions, edited sessions, and removals. If 4 of 100
conversations changed since last launch, only those 4 are re-parsed. The index
stores a searchable text blob per session (capped), so search stays instant.

## Developer guide

### Architecture

Claude Sessions is a single Electron application split across Electron's two
process types. There is **no HTTP server and no separate backend** — the UI
talks to the data layer over Electron's built-in **IPC** (inter-process
communication) channel.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Claude Sessions (one app)                            │
│                                                                           │
│   ┌──────────────────────────┐         ┌──────────────────────────────┐  │
│   │   Renderer process        │        │   Main process                │  │
│   │   (Chromium window)       │        │   (Node.js runtime)           │  │
│   │                           │        │                               │  │
│   │   index.html  ── UI ──┐   │        │   ┌────────────────────────┐  │  │
│   │                       │   │        │   │ main.js                │  │  │
│   │   window.csb.*  calls │   │        │   │  • ipcMain.handle(...) │  │  │
│   │        │              │   │        │   │  • window lifecycle    │  │  │
│   │        ▼              │   │        │   │  • resume (osascript)  │  │  │
│   │   ┌──────────────┐    │   │        │   └───────────┬────────────┘  │  │
│   │   │  preload.js  │    │   │        │               │ calls         │  │
│   │   │ contextBridge│    │   │        │               ▼               │  │
│   │   └──────┬───────┘    │   │        │   ┌────────────────────────┐  │  │
│   │          │            │   │        │   │ parser.js (pure Node)  │  │  │
│   └──────────┼────────────┘   │        │   │  • buildIndex()        │  │  │
│              │                │        │   │  • loadTranscript()    │  │  │
│              │   ipcRenderer  │ IPC    │   │  • parseSubagents()    │  │  │
│              └────.invoke()───┼───────►│   └───────────┬────────────┘  │  │
│                               │ channel│               │ fs.readFile   │  │
│              ◄────Promise─────┼────────│               ▼               │  │
│                  (JS object)  │        │      ~/.claude/projects/*.jsonl│  │
│                               │        │                               │  │
│   └───────────────────────────┘        └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                                          │  resume only
                                                          ▼
                                              Terminal.app → claude --resume
```

### Communication between processes

The renderer is sandboxed (`contextIsolation: true`, `nodeIntegration: false`),
so it cannot touch the filesystem or Node APIs directly. All communication flows
through one secure channel:

| Layer | Technology | Role |
|-------|-----------|------|
| Renderer → bridge | **`contextBridge`** (`preload.js`) | Exposes a minimal, safe `window.csb` API to page JS — no Node leaks into the DOM |
| Bridge → Main | **`ipcRenderer.invoke()`** | Sends an async request over Electron's IPC channel and awaits a `Promise` |
| Main (listener) | **`ipcMain.handle()`** | Receives the request, runs the work, returns a plain JS object (auto-serialized back to the renderer) |
| Data | **Node `fs`** (`parser.js`) | Reads and parses `~/.claude/projects/*.jsonl` synchronously in-process |
| Resume | **`child_process.execFile`** → `osascript` | Launches Terminal.app and runs `claude --resume <id>` |

There are exactly three IPC routes:

| `window.csb` method | IPC channel | Main-process handler |
|---------------------|-------------|----------------------|
| `listSessions(refresh)` | `csb:list` | `parser.listSessions()` — builds/returns the session index |
| `loadSession(id)` | `csb:session` | `parser.loadTranscript()` — full transcript + sub-agents |
| `resume(id)` | `csb:resume` | launches the terminal via AppleScript |

Because the call returns a structured JS object directly over IPC (no JSON-over-
HTTP, no port, no serialization round-trip you manage yourself), a transcript
load typically completes in a few milliseconds.

### Source layout

| File | Process | Responsibility |
|------|---------|----------------|
| `electron/main.js` | Main | App lifecycle, window creation, IPC handlers, resume |
| `electron/parser.js` | Main | All file reading + parsing (index, transcripts, tool cards, sub-agent linking). Zero dependencies. |
| `electron/preload.js` | Bridge | `contextBridge` exposing `window.csb` |
| `electron/index.html` | Renderer | The full UI (markup, styles, render logic) |
| `electron/package.json` | — | Electron + electron-builder config |

### Data model notes

- A **session** is one `~/.claude/projects/<encoded-cwd>/<id>.jsonl` file.
- Each line is a JSON record; titles come from Claude Code's own `ai-title`
  records, summaries from `last-prompt`.
- **Sub-agents** live in `<id>/subagents/agent-*.jsonl` with a `.meta.json`
  sidecar whose `toolUseId` links each sub-agent back to the exact `Task`
  tool-call in the parent transcript — that linkage is what renders them as
  inline leaf-branches.

## License

MIT — see [LICENSE](LICENSE).

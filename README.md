# Claude Sessions

A native desktop app to **browse, search, view, and resume your Claude Code conversations**.

Claude Code stores every conversation as a `.jsonl` file under `~/.claude/projects/`.
Over time those pile up and become impossible to navigate. **Claude Sessions** reads
them locally and gives you a clean, fast UI to find old threads and jump back into them.

![Claude Sessions](electron/icon.png)

## Features

- **Browse every session** across all your projects, sorted by latest activity
- **Search** titles, summaries, prompts, paths, and git branches (⌘K)
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

## License

MIT — see [LICENSE](LICENSE).

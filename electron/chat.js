// chat.js — stream a resumed Claude conversation to the UI.
//
// Spawns the local `claude` CLI in headless streaming mode:
//   claude -p "<message>" --resume <sessionId>
//          --output-format stream-json --include-partial-messages --verbose
//
// It parses the stream-json events and forwards a simplified set to the
// renderer over a per-turn IPC channel, so the UI can render tokens as they
// arrive (ChatGPT-style). No API key — reuses the same auth the CLI already has.
//
// One turn = one `claude` invocation. Because --resume appends to the session
// on disk, the next message simply resumes the (now-updated) session id. New
// turns persist and show up in the transcript on reload.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Reuse the same binary-resolution logic as aisearch.
function findClaude() {
  const candidates = [
    path.join(os.homedir(), ".toolbox", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return "claude";
}

// Track running turns so we can abort them.
const running = new Map(); // turnId -> child process

// Start a streaming turn.
//   webContents : the BrowserWindow's webContents to send events to
//   turnId      : unique id for this turn (channel namespacing)
//   sessionId   : the claude session to resume
//   cwd         : working directory to run in (the session's project dir)
//   message     : the user's new message
function startChat(webContents, turnId, sessionId, cwd, message, opts) {
  opts = opts || {};
  const channel = `csb:chat:${turnId}`;
  const send = (payload) => {
    try {
      if (!webContents.isDestroyed()) webContents.send(channel, payload);
    } catch (_) {}
  };

  const bin = findClaude();
  const args = [
    "-p",
    message,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
  ];
  // resume existing or start new (new = use --session-id without --resume)
  if (opts.newSession) {
    args.push("--session-id", sessionId);
  } else {
    args.push("--resume", sessionId);
  }
  // optional model override (alias like "opus"/"sonnet" or full id)
  if (opts.model) args.push("--model", String(opts.model));
  // optional agent override (run the turn as a specific sub-agent persona)
  if (opts.agent) args.push("--agent", String(opts.agent));

  let proc;
  try {
    proc = spawn(bin, args, {
      cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    send({ type: "error", error: `Couldn't launch claude: ${e}` });
    send({ type: "done", ok: false });
    return;
  }

  running.set(turnId, proc);

  let buf = "";
  let sawText = false;
  let stderr = "";

  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch (_) {
        continue; // ignore non-JSON noise
      }
      handleEvent(evt, send, () => (sawText = true));
    }
  });

  proc.stderr.on("data", (d) => (stderr += d.toString()));

  proc.on("error", (e) => {
    if (e && e.code === "ENOENT")
      send({
        type: "error",
        error: "The `claude` CLI wasn't found on PATH; chat needs it to resume sessions.",
      });
    else send({ type: "error", error: `claude process error: ${e}` });
    running.delete(turnId);
    send({ type: "done", ok: false });
  });

  proc.on("close", (code) => {
    running.delete(turnId);
    if (code !== 0 && !sawText) {
      send({
        type: "error",
        error: `claude exited with code ${code}.` + (stderr ? " " + stderr.slice(0, 300) : ""),
      });
      send({ type: "done", ok: false });
    } else {
      send({ type: "done", ok: true });
    }
  });

  return turnId;
}

// Translate a stream-json event into a small UI-facing message.
function handleEvent(evt, send, markText) {
  const t = evt.type;

  if (t === "system" && evt.subtype === "init") {
    send({ type: "status", text: "thinking" });
    return;
  }

  if (t === "stream_event" && evt.event) {
    const e = evt.event;
    if (e.type === "content_block_start" && e.content_block) {
      if (e.content_block.type === "thinking") send({ type: "status", text: "thinking" });
      else if (e.content_block.type === "tool_use")
        send({ type: "tool", name: e.content_block.name || "tool" });
      else if (e.content_block.type === "text") send({ type: "status", text: "responding" });
      return;
    }
    if (e.type === "content_block_delta" && e.delta) {
      if (e.delta.type === "text_delta" && e.delta.text) {
        markText();
        send({ type: "delta", text: e.delta.text });
      }
      // thinking_delta intentionally not streamed as visible text
      return;
    }
    return;
  }

  // The CLI also emits assistant/result summary messages; we can surface a
  // final result text if no streaming text was produced (fallback).
  if (t === "assistant" && evt.message && Array.isArray(evt.message.content)) {
    // ignore here — deltas already covered streaming text
    return;
  }

  if (t === "result") {
    if (evt.subtype && evt.subtype !== "success" && evt.is_error) {
      send({ type: "error", error: evt.result || "claude returned an error." });
    }
    return;
  }
}

function stopChat(turnId) {
  const proc = running.get(turnId);
  if (proc) {
    try {
      proc.kill("SIGTERM");
    } catch (_) {}
    running.delete(turnId);
    return true;
  }
  return false;
}

module.exports = { startChat, stopChat };

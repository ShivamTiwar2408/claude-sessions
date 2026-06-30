// parser.js — pure-Node port of the session parsing logic (was server.py).
// No external deps; uses only Node's fs/path/os. Runs in the Electron main
// process and is called directly via IPC — no HTTP server, no Python.

const fs = require("fs");
const path = require("path");
const os = require("os");

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const MAX_RESULT_CHARS = 20000;

const NOISE_RE = /^<(ide_opened_file|system-reminder|command-name|local-command|command-message)/i;

// in-memory index cache
let INDEX = null;

function decodeProjectDir(name) {
  if (name.startsWith("-")) return "/" + name.slice(1).replace(/-/g, "/");
  return name.replace(/-/g, "/");
}

// read a .jsonl file -> array of parsed records (bad lines skipped)
function iterRecords(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (_) {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch (_) {
      /* skip malformed */
    }
  }
  return out;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (b && typeof b === "object" && b.type === "text" && b.text) parts.push(b.text);
    }
    return parts.join("\n");
  }
  return "";
}

function resultToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (b && typeof b === "object") {
        if (b.type === "text" && b.text != null) parts.push(String(b.text));
        else if (b.type === "image") parts.push("[image]");
        else if (b.type === "tool_reference") parts.push(`[tool: ${b.tool_name || "?"}]`);
      } else if (typeof b === "string") {
        parts.push(b);
      }
    }
    return parts.join("\n");
  }
  if (typeof content === "object") return resultToText(content.content);
  return String(content);
}

function toolHeadline(name, inp) {
  if (!inp || typeof inp !== "object") return "";
  const n = (name || "").toLowerCase();
  const first = (...keys) => {
    for (const k of keys) {
      const v = inp[k];
      if (v) return String(v);
    }
    return "";
  };
  if (n === "bash") return first("command");
  if (["read", "edit", "write", "notebookedit"].includes(n))
    return first("file_path", "notebook_path", "path");
  if (n === "grep") {
    const pat = first("pattern");
    const p = first("path", "glob");
    return pat + (p ? `  in ${p}` : "");
  }
  if (n === "glob") return first("pattern", "path");
  if (["task", "agent"].includes(n)) return first("description", "subagent_type", "prompt");
  if (["webfetch", "websearch"].includes(n)) return first("url", "query");
  if (n === "toolsearch") return first("query");
  if (n === "skill") return first("skill", "command");
  if (n === "askuserquestion") {
    const qs = inp.questions;
    if (Array.isArray(qs) && qs.length && qs[0] && typeof qs[0] === "object")
      return qs[0].question || "(question)";
    return "(question)";
  }
  return first("query", "description", "prompt", "name", "documentId", "url");
}

function formatToolInput(name, inp) {
  if (typeof inp === "string") return inp;
  if (!inp || typeof inp !== "object") return "";
  const n = (name || "").toLowerCase();
  if (n === "bash") return inp.command || "";
  if (n === "edit")
    return `${inp.file_path || ""}\n\n--- old ---\n${inp.old_string || ""}\n\n--- new ---\n${inp.new_string || ""}`;
  if (n === "write") return `${inp.file_path || ""}\n\n${inp.content || ""}`;
  try {
    return JSON.stringify(inp, null, 2);
  } catch (_) {
    return String(inp);
  }
}

function clip(s) {
  if (s == null) return ["", false];
  if (s.length > MAX_RESULT_CHARS) return [s.slice(0, MAX_RESULT_CHARS), true];
  return [s, false];
}

function isoFromMtime(ms) {
  try {
    return new Date(ms).toISOString();
  } catch (_) {
    return "";
  }
}

// ---- index ---------------------------------------------------------------

function parseSession(file, projectName) {
  const records = iterRecords(file);
  let aiTitle = null,
    lastPrompt = null,
    firstUserText = null,
    cwd = null,
    gitBranch = null,
    version = null,
    firstTs = null,
    lastTs = null,
    userMsgs = 0,
    assistantMsgs = 0;

  for (const rec of records) {
    const rtype = rec.type;
    if (rtype === "ai-title") {
      aiTitle = rec.aiTitle || aiTitle;
      continue;
    }
    if (rtype === "last-prompt") {
      lastPrompt = rec.lastPrompt || lastPrompt;
      continue;
    }
    const ts = rec.timestamp;
    if (ts) {
      if (firstTs == null || ts < firstTs) firstTs = ts;
      if (lastTs == null || ts > lastTs) lastTs = ts;
    }
    if (cwd == null && rec.cwd) cwd = rec.cwd;
    if (gitBranch == null && rec.gitBranch) gitBranch = rec.gitBranch;
    if (version == null && rec.version) version = rec.version;

    if (rtype === "user") {
      const text = textFromContent((rec.message || {}).content);
      if (text) {
        userMsgs++;
        if (firstUserText == null) {
          let candidate = null;
          for (const chunk of text.split(/\n(?=<)/)) {
            const c = chunk.trim();
            if (c && !NOISE_RE.test(c)) {
              candidate = c;
              break;
            }
          }
          if (candidate == null) candidate = text.replace(NOISE_RE, "").trim();
          if (candidate) firstUserText = candidate;
        }
      }
    } else if (rtype === "assistant") {
      if (textFromContent((rec.message || {}).content)) assistantMsgs++;
    }
  }

  let mtime = 0,
    size = 0;
  try {
    const st = fs.statSync(file);
    mtime = st.mtimeMs;
    size = st.size;
  } catch (_) {}

  // cheap sub-agent count
  let subCount = 0;
  const base = path.basename(file, ".jsonl");
  const subDir = path.join(path.dirname(file), base, "subagents");
  try {
    if (fs.statSync(subDir).isDirectory()) {
      subCount = fs.readdirSync(subDir).filter((f) => /^agent-.*\.jsonl$/.test(f)).length;
    }
  } catch (_) {}

  let title = aiTitle || firstUserText || lastPrompt || "(untitled session)";
  title = title.trim().replace(/\n/g, " ");
  if (title.length > 120) title = title.slice(0, 117) + "...";

  let summary = lastPrompt || firstUserText || "";
  summary = summary.trim().replace(/\n/g, " ");
  if (summary.length > 240) summary = summary.slice(0, 237) + "...";

  return {
    id: base,
    file,
    project_dir: projectName,
    cwd: cwd || decodeProjectDir(projectName),
    git_branch: gitBranch,
    version,
    title,
    summary,
    first_prompt: (firstUserText || "").trim().replace(/\n/g, " ").slice(0, 240),
    user_msgs: userMsgs,
    assistant_msgs: assistantMsgs,
    created: firstTs,
    updated: lastTs || isoFromMtime(mtime),
    mtime,
    size,
    has_ai_title: aiTitle != null,
    sub_count: subCount,
  };
}

function buildIndex() {
  const sessions = [];
  let projects;
  try {
    projects = fs.readdirSync(PROJECTS_DIR);
  } catch (_) {
    INDEX = [];
    return [];
  }
  for (const proj of projects.sort()) {
    const projPath = path.join(PROJECTS_DIR, proj);
    let stat;
    try {
      stat = fs.statSync(projPath);
    } catch (_) {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let files;
    try {
      files = fs.readdirSync(projPath);
    } catch (_) {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const file = path.join(projPath, f);
      try {
        sessions.push(parseSession(file, proj));
      } catch (e) {
        sessions.push({
          id: path.basename(f, ".jsonl"),
          file,
          project_dir: proj,
          cwd: decodeProjectDir(proj),
          git_branch: null,
          version: null,
          title: `(parse error: ${e})`,
          summary: "",
          first_prompt: "",
          user_msgs: 0,
          assistant_msgs: 0,
          created: null,
          updated: "",
          mtime: 0,
          size: 0,
          has_ai_title: false,
          sub_count: 0,
        });
      }
    }
  }
  sessions.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  INDEX = sessions;
  return sessions;
}

function getIndex() {
  if (!INDEX) return buildIndex();
  return INDEX;
}

// ---- transcript ----------------------------------------------------------

function collectToolResults(records) {
  const results = {};
  for (const rec of records) {
    if (rec.type !== "user") continue;
    const content = (rec.message || {}).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "tool_result") {
        const tid = block.tool_use_id;
        if (!tid) continue;
        results[tid] = {
          output: resultToText(block.content),
          is_error: !!block.is_error,
        };
      }
    }
  }
  return results;
}

function buildMessages(records, results, byTool, attached) {
  byTool = byTool || {};
  const messages = [];
  for (const rec of records) {
    const rtype = rec.type;
    if (rtype !== "user" && rtype !== "assistant") continue;
    const msg = rec.message || {};
    const role = msg.role || rtype;
    const content = msg.content;
    const blocks = [];
    const toolNames = [];
    const spawned = [];

    if (typeof content === "string") {
      if (content.trim()) blocks.push({ kind: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && block.text) {
          blocks.push({ kind: "text", text: block.text });
        } else if (block.type === "tool_use") {
          const name = block.name || "tool";
          const tid = block.id;
          const inp = block.input;
          const res = (tid && results[tid]) || {};
          const [outText, outTrunc] = clip(res.output || "");
          const [inText, inTrunc] = clip(formatToolInput(name, inp));
          toolNames.push(name);
          const toolBlock = {
            kind: "tool",
            name,
            headline: toolHeadline(name, inp).slice(0, 400),
            input: inText,
            input_truncated: inTrunc,
            output: outText,
            output_truncated: outTrunc,
            is_error: res.is_error || false,
            subagent: null,
          };
          if (tid && byTool[tid]) {
            let agent = byTool[tid];
            if (inp && typeof inp === "object" && inp.description)
              agent = { ...agent, description: inp.description };
            toolBlock.subagent = agent;
            spawned.push(agent);
            if (attached) attached.add(tid);
          }
          blocks.push(toolBlock);
        }
      }
    }

    if (!blocks.length) continue;
    if (role === "user") {
      const visible = blocks.filter((b) => b.kind === "text" && !NOISE_RE.test(b.text.trim()));
      if (!visible.length && !blocks.some((b) => b.kind === "tool")) continue;
    }

    messages.push({
      role,
      timestamp: rec.timestamp,
      blocks,
      tools: toolNames,
      subagents: spawned,
    });
  }
  return messages;
}

function parseSubagents(sessionDir) {
  const subDir = path.join(sessionDir, "subagents");
  const byTool = {};
  const orphans = [];
  let files;
  try {
    if (!fs.statSync(subDir).isDirectory()) return { byTool, orphans };
    files = fs.readdirSync(subDir);
  } catch (_) {
    return { byTool, orphans };
  }

  for (const fname of files.sort()) {
    if (!/^agent-.*\.jsonl$/.test(fname)) continue;
    const jf = path.join(subDir, fname);
    const metaPath = jf.replace(/\.jsonl$/, ".meta.json");
    let agentType = null,
      description = null,
      toolUseId = null;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      agentType = meta.agentType;
      description = meta.description;
      toolUseId = meta.toolUseId;
    } catch (_) {}

    const records = iterRecords(jf);
    const results = collectToolResults(records);
    const messages = buildMessages(records, results);
    let firstTs = null,
      lastTs = null;
    for (const m of messages) if (m.timestamp) { firstTs = m.timestamp; break; }
    for (let i = messages.length - 1; i >= 0; i--)
      if (messages[i].timestamp) { lastTs = messages[i].timestamp; break; }
    let firstPrompt = null;
    outer: for (const m of messages) {
      if (m.role === "user") {
        for (const b of m.blocks) {
          if (b.kind === "text") {
            const fp = b.text.replace(NOISE_RE, "").trim();
            if (fp) { firstPrompt = fp.slice(0, 200); break outer; }
          }
        }
      }
    }

    const agent = {
      agent_id: path.basename(jf, ".jsonl"),
      agent_type: agentType || "subagent",
      description: description || firstPrompt || "(sub-agent)",
      tool_use_id: toolUseId,
      messages,
      msg_count: messages.length,
      created: firstTs,
      updated: lastTs,
    };
    if (toolUseId) byTool[toolUseId] = agent;
    else orphans.push(agent);
  }
  return { byTool, orphans };
}

function loadTranscript(sessionId) {
  const sessions = getIndex();
  const match = sessions.find((s) => s.id === sessionId);
  if (!match) return { error: "not found" };
  if (!fs.existsSync(match.file)) return { error: "file missing" };

  const sessionDir = path.join(path.dirname(match.file), match.id);
  const { byTool, orphans: subOrphans } = parseSubagents(sessionDir);
  const attached = new Set();

  const records = iterRecords(match.file).filter((r) => !r.isSidechain);
  const results = collectToolResults(records);
  const messages = buildMessages(records, results, byTool, attached);

  const orphans = [...subOrphans];
  for (const tid of Object.keys(byTool)) {
    if (!attached.has(tid)) orphans.push(byTool[tid]);
  }

  const totalSub = Object.keys(byTool).length + subOrphans.length;
  return {
    session: match,
    messages,
    orphan_subagents: orphans,
    subagent_count: totalSub,
  };
}

function listSessions(refresh) {
  const sessions = refresh ? buildIndex() : getIndex();
  const projects = {};
  for (const s of sessions) projects[s.cwd] = (projects[s.cwd] || 0) + 1;
  return {
    sessions,
    projects: Object.entries(projects)
      .map(([cwd, count]) => ({ cwd, count }))
      .sort((a, b) => b.count - a.count),
    built_at: Date.now(),
  };
}

// ---- full-text search index --------------------------------------------
// Helpers the search index needs to extract body text. Kept here so all the
// JSONL knowledge lives in one place.
const searchindex = require("./searchindex");
const SEARCH_HELPERS = {
  iterRecords,
  textFromContent,
  toolHeadline,
};

// Build/refresh the body index incrementally (mtime-based). Call after the
// metadata index exists. Returns { scanned, reindexed, removed }.
function syncSearchIndex() {
  searchindex.loadCache();
  return searchindex.syncIndex(getIndex(), SEARCH_HELPERS);
}

// Full-text keyword search across transcript bodies. Returns sessions
// (full metadata) ordered by relevance, each with a `_snippet` + `_score`.
function searchSessions(query) {
  const { terms, results } = searchindex.search(query);
  const sessions = getIndex();
  const byId = {};
  for (const s of sessions) byId[s.id] = s;
  const out = [];
  for (const r of results) {
    const s = byId[r.id];
    if (s) out.push({ ...s, _snippet: r.snippet, _score: r.score, _hits: r.hits });
  }
  return { terms, results: out };
}

module.exports = {
  listSessions,
  loadTranscript,
  getIndex,
  buildIndex,
  syncSearchIndex,
  searchSessions,
  PROJECTS_DIR,
  // re-exported for the AI search layer
  _searchindex: searchindex,
};

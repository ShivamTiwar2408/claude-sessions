// searchindex.js — full-text body index with incremental, mtime-based caching.
//
// On startup we load a cached index from disk (~/.claude/.claude-sessions-index.json).
// For each session we compare its file mtime against the cached entry:
//   • unchanged  -> reuse the cached searchable text (no re-parse)
//   • changed    -> re-extract its body text
//   • new        -> extract fresh
//   • deleted    -> drop from the index
// Only changed/new sessions are re-read, so a refresh that touches 4 of 100
// sessions only parses those 4.
//
// "Smart" keyword search: strips filler/stop-words from a natural-language
// query so "find the conversation where I looked for my CRs and quips" reduces
// to the meaningful terms [conversation, looked, crs, quips] and matches the
// full transcript body — not just the title.

const fs = require("fs");
const path = require("path");
const os = require("os");

const INDEX_PATH = path.join(os.homedir(), ".claude", ".claude-sessions-index.json");
const INDEX_VERSION = 1;
const MAX_BODY_CHARS = 200000; // cap stored text per session to keep the index sane

// Common English filler words to drop from queries (so natural-language
// questions reduce to their meaningful terms). Kept deliberately small.
const STOP_WORDS = new Set(
  ("a an and the of to in on at for with from by is are was were be been being " +
    "i me my mine we us our you your he she it they them their this that these " +
    "those do does did doing done have has had having will would shall should " +
    "can could may might must not no nor so than then there here where when " +
    "which who whom whose what why how all any both each few more most other " +
    "some such only own same too very just about above after again against " +
    "out up down off over under find show get give tell looking look searched " +
    "search conversation conversations chat session sessions thread threads " +
    "previous earlier old want need please").split(/\s+/)
);

let BODY = {}; // { sessionId: { mtime, text, title } }

function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
    if (raw && raw.version === INDEX_VERSION && raw.body) {
      BODY = raw.body;
      return true;
    }
  } catch (_) {}
  BODY = {};
  return false;
}

function saveCache() {
  try {
    fs.writeFileSync(
      INDEX_PATH,
      JSON.stringify({ version: INDEX_VERSION, body: BODY }),
      "utf8"
    );
  } catch (_) {
    /* best-effort; search still works in-memory this session */
  }
}

// Extract a flat, lowercased searchable string from a session's records.
// We pull text from user + assistant messages, and the Bash commands /
// tool inputs (so "git commit" or a file path is searchable too).
function extractBody(records, helpers) {
  const { textFromContent, toolHeadline } = helpers;
  const parts = [];
  for (const rec of records) {
    const rtype = rec.type;
    if (rtype !== "user" && rtype !== "assistant") continue;
    const content = (rec.message || {}).content;
    const text = textFromContent(content);
    if (text) parts.push(text);
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && typeof b === "object" && b.type === "tool_use") {
          const hl = toolHeadline(b.name, b.input);
          if (hl) parts.push(hl);
        }
      }
    }
  }
  let joined = parts.join("\n").toLowerCase();
  if (joined.length > MAX_BODY_CHARS) joined = joined.slice(0, MAX_BODY_CHARS);
  return joined;
}

// Rebuild the body index incrementally against the current session list.
// `sessions` is the metadata index from parser.buildIndex().
// `helpers` provides { iterRecords, textFromContent, toolHeadline }.
// Returns { scanned, reindexed, removed }.
function syncIndex(sessions, helpers) {
  const { iterRecords } = helpers;
  const seen = new Set();
  let reindexed = 0;

  for (const s of sessions) {
    seen.add(s.id);
    const cached = BODY[s.id];
    // reuse if mtime matches exactly (unchanged since last index)
    if (cached && cached.mtime === s.mtime) {
      cached.title = s.title; // keep title fresh for cheap title-only matches
      continue;
    }
    // new or changed -> re-extract
    let records = [];
    try {
      records = iterRecords(s.file).filter((r) => !r.isSidechain);
    } catch (_) {}
    BODY[s.id] = {
      mtime: s.mtime,
      title: s.title,
      text: extractBody(records, helpers),
    };
    reindexed++;
  }

  // drop deleted sessions
  let removed = 0;
  for (const id of Object.keys(BODY)) {
    if (!seen.has(id)) {
      delete BODY[id];
      removed++;
    }
  }

  if (reindexed || removed) saveCache();
  return { scanned: sessions.length, reindexed, removed };
}

// Reduce a natural-language query to meaningful lowercased terms.
function queryTerms(q) {
  return (q || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s/._-]/gu, " ") // keep letters/digits and path-ish chars
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

// Score a session against query terms. Returns {score, hits, snippet} or null.
// Title hits weigh more; we also produce a snippet around the first body hit.
function scoreSession(id, terms) {
  const entry = BODY[id];
  if (!entry) return null;
  const title = (entry.title || "").toLowerCase();
  const text = entry.text || "";
  let score = 0;
  let matched = 0;
  let firstIdx = -1;

  for (const t of terms) {
    let termHit = false;
    if (title.includes(t)) {
      score += 5;
      termHit = true;
    }
    const idx = text.indexOf(t);
    if (idx !== -1) {
      // count occurrences (capped) for a mild frequency boost
      let occ = 0;
      let from = idx;
      while (from !== -1 && occ < 10) {
        occ++;
        from = text.indexOf(t, from + t.length);
      }
      score += 1 + Math.min(occ, 10) * 0.3;
      termHit = true;
      if (firstIdx === -1 || idx < firstIdx) firstIdx = idx;
    }
    if (termHit) matched++;
  }

  if (matched === 0) return null;
  // require ALL meaningful terms to appear somewhere (AND), but be lenient:
  // if 1 term, must match; if many, allow missing at most ~1/3.
  const need = terms.length <= 2 ? terms.length : Math.ceil(terms.length * 0.67);
  if (matched < need) return null;

  let snippet = "";
  if (firstIdx !== -1) {
    const start = Math.max(0, firstIdx - 60);
    snippet = text.slice(start, firstIdx + 120).replace(/\s+/g, " ").trim();
    if (start > 0) snippet = "…" + snippet;
  }
  return { score, hits: matched, snippet };
}

// Full-text search over the body index. Returns ordered
// [{ id, score, hits, snippet }] for sessions that match.
function search(q) {
  const terms = queryTerms(q);
  if (!terms.length) return { terms, results: [] };
  const results = [];
  for (const id of Object.keys(BODY)) {
    const r = scoreSession(id, terms);
    if (r) results.push({ id, ...r });
  }
  results.sort((a, b) => b.score - a.score);
  return { terms, results };
}

// expose the raw body text for a session (used by the AI search to send
// snippets to the model)
function getBody(id) {
  const e = BODY[id];
  return e ? e.text : "";
}

module.exports = {
  loadCache,
  syncIndex,
  search,
  queryTerms,
  getBody,
  INDEX_PATH,
};

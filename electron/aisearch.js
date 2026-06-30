// aisearch.js — semantic search over sessions using the local `claude` CLI.
//
// No API key required. It shells out to the `claude` binary already installed
// and authenticated on this machine (the same one that powers Claude Code),
// running it in headless print mode (`claude -p`). Whatever auth that CLI uses
// — Bedrock, a subscription, an API key, etc. — is reused transparently.
//
// Unlike keyword search (searchindex.js), this understands intent and synonyms
// ("my CRs and quips" → a session about Amazon code reviews and Quip docs).
//
// Approach: build a compact catalog of every session (title + summary + a short
// body snippet) and ask Claude to return the most relevant ids as JSON.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const MAX_CATALOG = 250; // cap sessions sent per query to bound prompt size
const SNIPPET_CHARS = 240; // body snippet per session in the catalog
const TIMEOUT_MS = 120000;

// Candidate locations for the claude binary. PATH is unreliable for apps
// launched from the macOS dock, so we also probe known install dirs.
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
  return "claude"; // fall back to PATH
}

// Build the catalog string the model ranks against.
function buildCatalog(sessions, getBody) {
  const used = sessions.slice(0, MAX_CATALOG);
  const lines = used.map((s) => {
    const snippet = (getBody(s.id) || "")
      .slice(0, SNIPPET_CHARS)
      .replace(/\s+/g, " ")
      .trim();
    const summary = (s.summary || "").replace(/\s+/g, " ").trim();
    const parts = [`id: ${s.id}`, `title: ${s.title}`];
    if (summary) parts.push(`summary: ${summary}`);
    if (snippet) parts.push(`excerpt: ${snippet}`);
    return parts.join("\n");
  });
  return {
    text: lines.join("\n---\n"),
    truncated: sessions.length > used.length,
    count: used.length,
  };
}

function buildPrompt(query, catalog, count, truncated) {
  return [
    "You are a search engine over a user's past Claude Code conversations.",
    "Given a natural-language query describing a conversation the user is trying to find,",
    "return the sessions that best match the user's INTENT — reason about meaning and",
    "synonyms, not just literal keyword overlap (e.g. 'CR' means a code review, 'quip' is",
    "a Quip doc). Only include genuinely relevant sessions; it's fine to return few or none.",
    "Order by relevance, most relevant first. Copy each id exactly as given.",
    "",
    "Respond with ONLY a JSON object, no markdown, no prose, in exactly this shape:",
    '{"results":[{"id":"<session id>","reason":"<one short sentence on why it matches>"}]}',
    "",
    `Query: ${query}`,
    "",
    `Here are ${count} sessions${truncated ? " (most recent; older ones omitted)" : ""}:`,
    "",
    catalog,
  ].join("\n");
}

// Extract the first JSON object from the model's text output.
function extractJson(text) {
  if (!text) return null;
  // strip ```json fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

// Run the claude CLI headlessly with the prompt on stdin.
function runClaude(prompt) {
  return new Promise((resolve) => {
    const bin = findClaude();
    let proc;
    try {
      proc = spawn(bin, ["-p", "--output-format", "text"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
    } catch (e) {
      resolve({ error: `Couldn't launch the claude CLI: ${e}` });
      return;
    }
    let out = "",
      err = "";
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch (_) {}
      resolve({ error: "AI search timed out." });
    }, TIMEOUT_MS);

    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", (e) => {
      clearTimeout(timer);
      if (e && e.code === "ENOENT")
        resolve({
          error:
            "The `claude` CLI wasn't found. AI search reuses your local Claude Code install — " +
            "make sure `claude` is on your PATH.",
        });
      else resolve({ error: `claude CLI error: ${e}` });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim())
        resolve({ error: `claude exited with code ${code}. ${err.slice(0, 300)}` });
      else resolve({ out });
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// Main entry. `sessions` is the metadata index; `getBody(id)` returns body text.
// Returns { results: [{id, reason}], error? }.
async function aiRank(query, sessions, getBody) {
  if (!query || !query.trim()) return { results: [] };

  const { text: catalog, truncated, count } = buildCatalog(sessions, getBody);
  const prompt = buildPrompt(query, catalog, count, truncated);

  const { out, error } = await runClaude(prompt);
  if (error) return { results: [], error };

  const parsed = extractJson(out);
  if (!parsed || !Array.isArray(parsed.results))
    return { results: [], error: "Couldn't parse the AI response." };

  const valid = new Set(sessions.map((s) => s.id));
  const results = parsed.results.filter((r) => r && valid.has(r.id));
  return { results, truncated };
}

module.exports = { aiRank };

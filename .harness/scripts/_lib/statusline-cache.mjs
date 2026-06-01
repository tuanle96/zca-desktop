// statusline-cache.mjs — tiny file-based memo for statusLine segments.
//
// Why this exists: Claude Code re-spawns the statusLine command on every
// refresh, so in-process memoization is useless — each invocation is a
// fresh node process. File-based cache keyed on `session_id` (stable per
// Claude Code session) is the documented pattern.
//
// The cache lives under $TMPDIR. Each key gets a separate file with mtime
// as the freshness signal. Reads bypass the file when stale; writes are
// best-effort (failure to write = next call recomputes, no error surfaced).
//
// Usage:
//   import { cached } from "./statusline-cache.mjs";
//   const branch = cached(
//     { sessionId, key: "git-branch", ttlMs: 5000 },
//     () => spawnSync("git", ["branch", "--show-current"], ...).stdout.trim(),
//   );

import { readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CACHE_DIR = join(tmpdir(), "ahk-statusline");

function ensureDir() {
  try { mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* exists */ }
}

function cachePath(sessionId, key) {
  // session_id can contain anything → sanitize. No path separator survives.
  const safeSession = String(sessionId || "no-session").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  const safeKey = String(key).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
  return join(CACHE_DIR, `${safeSession}-${safeKey}.cache`);
}

// Synchronous because statusline.mjs runs as a one-shot command and the
// upstream caller blocks on its output anyway. async would add no value.
export function cached({ sessionId, key, ttlMs }, fetchFn) {
  ensureDir();
  const file = cachePath(sessionId, key);
  try {
    const st = statSync(file);
    if (Date.now() - st.mtimeMs < ttlMs) {
      return readFileSync(file, "utf8");
    }
  } catch { /* miss */ }
  let value;
  try {
    value = fetchFn();
  } catch {
    value = "";
  }
  if (value == null) value = "";
  const s = String(value);
  try { writeFileSync(file, s); } catch { /* best-effort */ }
  return s;
}

#!/usr/bin/env node
// scan-paths.mjs — deterministic step for /doc-drift-scan.
// Walks .harness/docs/ + CLAUDE.md, extracts backtick paths, checks existsSync.
// Output JSON: { stats, drift }.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PATH_IN_BACKTICKS = /`([^`\s][^`]*?)`/g;
const PATH_LIKE = /^[^|&;$][\w./@-]+\/[\w./@-]+/;

function walkText() {
  const out = [];
  if (existsSync(join(ROOT, "CLAUDE.md"))) out.push(join(ROOT, "CLAUDE.md"));
  if (existsSync(join(ROOT, ".harness/docs"))) {
    for (const f of walkRecursive(join(ROOT, ".harness/docs"))) {
      if (/\.(md|markdown|mdx)$/i.test(f)) out.push(f);
    }
  }
  return out;
}
function* walkRecursive(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) yield* walkRecursive(p);
    else yield p;
  }
}
function extractPaths(body) {
  const found = new Set();
  let m;
  while ((m = PATH_IN_BACKTICKS.exec(body)) !== null) {
    const candidate = m[1].trim();
    if (!PATH_LIKE.test(candidate)) continue;
    if (/^https?:\/\//.test(candidate)) continue;
    found.add(candidate);
  }
  return [...found];
}
function fileExistsRelative(p) {
  const clean = p.replace(/:\d+(-\d+)?$/, "");
  return existsSync(resolve(ROOT, clean));
}

function main() {
  const files = walkText();
  const drift = [];
  const stats = { docs_scanned: files.length, refs_found: 0, refs_missing: 0 };
  for (const doc of files) {
    let body;
    try { body = readFileSync(doc, "utf8"); } catch { continue; }
    for (const ref of extractPaths(body)) {
      stats.refs_found++;
      if (!fileExistsRelative(ref)) {
        stats.refs_missing++;
        drift.push({ doc: relative(ROOT, doc), ref });
      }
    }
  }
  process.stdout.write(JSON.stringify({ stats, drift }, null, 2) + "\n");
}

main();

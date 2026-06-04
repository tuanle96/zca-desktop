#!/usr/bin/env node
// module-summary.mjs — deterministic step for /inspect-module.
// Bundles exports + outbound + inbound + layer + recent commits in JSON.
// Prefer ripgrep, fallback grep -rE.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function bail(msg) {
  console.error("module-summary: " + msg);
  process.exit(2);
}

// Walk a path (file or directory) and yield matching source files. Skip
// node_modules, .git, dist, build — folders that contain mountains of
// irrelevant exports and blow up the result set.
const SOURCE_EXTS = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|swift|kt|kts)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", ".harness", "dist", "build", "target", ".next"]);

function* walkSources(absPath) {
  let st;
  try { st = statSync(absPath); } catch { return; }
  if (st.isFile()) {
    if (SOURCE_EXTS.test(absPath)) yield absPath;
    return;
  }
  if (!st.isDirectory()) return;
  for (const entry of readdirSync(absPath, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== "." && entry.name !== "..") {
      if (SKIP_DIRS.has(entry.name)) continue;
    }
    if (SKIP_DIRS.has(entry.name)) continue;
    yield* walkSources(join(absPath, entry.name));
  }
}

// scan: read each file line-by-line, run the regex, collect matches with
// per-line annotation `path:line: content`. Pure Node — no external grep
// dependency, so the script works the same on macOS local, Linux CI,
// minimal Alpine, etc. (Previous shell-out to grep failed on CI with an
// empty result set; root cause: spawn-time differences between BSD and
// GNU grep when the target argument is a single file. Node fs is the
// portable answer.)
function scan(target, regex) {
  const lines = [];
  const absTarget = resolve(ROOT, target);
  for (const file of walkSources(absTarget)) {
    let body;
    try { body = readFileSync(file, "utf8"); } catch { continue; }
    const rel = relative(ROOT, file);
    const fileLines = body.split("\n");
    for (let i = 0; i < fileLines.length; i++) {
      if (regex.test(fileLines[i])) {
        lines.push(`${rel}:${i + 1}: ${fileLines[i]}`);
      }
    }
  }
  return lines;
}

function listExports(target) {
  const out = new Set();
  for (const line of scan(target, /^export /)) {
    const m = line.match(/^([^:]+):(\d+):\s*export\s+(.*)$/);
    if (m) out.add(`${m[3].slice(0, 80)}  (${m[1]}:${m[2]})`);
  }
  for (const line of scan(target, /^(def |class )/)) {
    const m = line.match(/^([^:]+):(\d+):\s*(def|class)\s+(\w+)/);
    if (m) out.add(`${m[3]} ${m[4]}  (${m[1]}:${m[2]})`);
  }
  return [...out].slice(0, 50);
}

function outboundDeps(target) {
  const out = new Set();
  for (const line of scan(target, /^(import |from |use crate)/)) {
    const m = line.match(/^[^:]+:\d+:\s*(.+)$/);
    if (m) out.add(m[1].trim().slice(0, 100));
  }
  return [...out].slice(0, 50);
}

function inboundDeps(target, cfg) {
  const relTarget = relative(ROOT, resolve(ROOT, target));
  const name = relTarget.split("/").pop().replace(/\.[a-z]+$/i, "");
  if (!name) return [];
  const seen = new Set();
  const patterns = [];

  // Standard pattern: import/from/require referencing the directory name.
  // Works for TS/JS/Python where the import path mirrors the dir name.
  patterns.push(
    new RegExp(`(import|from|require\\().*['"][^'"]*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );

  // Rust workspace pattern: when domain has `useIdentPattern` (e.g.
  // "unibot_{layer}"), the crate is `use`d under its layer-derived ident
  // — NOT the dir name. For `crates/unibot-types/` with pattern
  // "unibot_{layer}", we should also match `use unibot_types::`. Without
  // this branch the inbound list silently misses every workspace caller.
  const layerInfo = whichLayer(target, cfg);
  if (layerInfo) {
    const domain = (cfg?.domains || []).find((d) => (d.name || "default") === layerInfo.domain);
    if (domain?.useIdentPattern) {
      const ident = domain.useIdentPattern.replace("{layer}", layerInfo.layer);
      const escaped = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      patterns.push(new RegExp(`\\b(?:pub\\s+)?use\\s+${escaped}\\b`));
    }
  }

  // Search the whole project root for references back to the target
  // module. Filter out self-references.
  for (const re of patterns) {
    for (const line of scan(".", re)) {
      const m = line.match(/^([^:]+):\d+:/);
      if (m && m[1] !== relTarget && !m[1].startsWith(`${relTarget}/`)) seen.add(m[1]);
    }
  }
  return [...seen].slice(0, 30);
}

function readLayers() {
  for (const path of [".harness/config.json", "harness.config.json"]) {
    try { return JSON.parse(readFileSync(resolve(ROOT, path), "utf8")); }
    catch {}
  }
  return null;
}

// Resolve the layer for a module path. Honors `layerDirPattern` on the
// domain so workspaces that prefix layer directories (e.g. Rust workspace
// `crates/unibot-types/` with `layerDirPattern: "unibot-{layer}"`) match
// correctly. Without this, paths with custom prefixes would silently fail
// to match and return layer:null — the bug that ships /inspect-module's
// most useful columns blank.
function whichLayer(target, cfg) {
  if (!cfg?.domains) return null;
  const rel = relative(ROOT, resolve(ROOT, target));
  for (const d of cfg.domains) {
    if (!d?.layers || !d.root) continue;
    const pattern = d.layerDirPattern || "{layer}";
    for (const layer of d.layers) {
      const dirName = pattern.replace("{layer}", layer);
      const prefix = `${d.root}/${dirName}/`;
      if (rel.startsWith(prefix) || rel === `${d.root}/${dirName}`) {
        return { domain: d.name || "default", layer };
      }
    }
  }
  return null;
}

function targetKind(target, cfg) {
  const rel = relative(ROOT, resolve(ROOT, target));
  if (rel === "") return "workspace";
  if (whichLayer(target, cfg)) return "module";
  return "unlayered";
}

function workspaceOverview(cfg) {
  return {
    domains: (cfg?.domains || []).map((d) => ({
      name: d.name || "default",
      root: d.root,
      layers: d.layers || [],
    })),
  };
}

function recentCommits(target) {
  const r = spawnSync("git", ["log", "--oneline", "-5", "--", target], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) return [];
  return (r.stdout || "").split("\n").filter(Boolean);
}

function main() {
  const target = process.argv[2];
  if (!target) bail("missing target path argument");
  const abs = resolve(ROOT, target);
  if (!existsSync(abs)) bail(`target not found: ${target}`);
  const cfg = readLayers();
  const kind = targetKind(target, cfg);
  const layer = whichLayer(target, cfg);
  const out = kind === "workspace"
    ? {
        module: relative(ROOT, abs),
        targetKind: kind,
        layer,
        workspace: workspaceOverview(cfg),
        recent: recentCommits("."),
      }
    : {
        module: relative(ROOT, abs),
        targetKind: kind,
        layer,
        exports: listExports(target),
        outbound: outboundDeps(target),
        inbound: inboundDeps(target, cfg),
        recent: recentCommits(target),
      };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main();

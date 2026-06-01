#!/usr/bin/env node
// pr-review-driver.mjs — deterministic driver for /review-this-pr.
// Gathers diff, runs structural-test, diffs baseline, emits markdown report.
//
// Usage:
//   pr-review-driver.mjs --base <sha> [--out report.md]
//
// Output:
//   stdout markdown + trailing JSON tail line (machine-readable).

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function parseArgs(argv) {
  const out = { base: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") out.base = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
  }
  if (!out.base) {
    console.error("usage: pr-review-driver.mjs --base <sha> [--out report.md]");
    process.exit(2);
  }
  return out;
}

function git(args) {
  return spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function changedFiles(base) {
  const r = git(["diff", "--name-only", `${base}...HEAD`]);
  if (r.status !== 0) return [];
  return (r.stdout || "").split("\n").filter(Boolean);
}

function whichLayer(file, cfg) {
  if (!cfg?.domains) return null;
  for (const d of cfg.domains) {
    if (!d.layers || !d.root) continue;
    for (const layer of d.layers) {
      const prefix = `${d.root}/${layer}/`;
      if (file.startsWith(prefix)) return { domain: d.name || "default", layer };
    }
  }
  return null;
}

function loadJSON(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function runStructuralTest() {
  // Prefer node .harness/runners/structural-check.mjs (polyglot adapters); fallback to
  // npm run harness:check. Capture full output (stdout+stderr); never throws.
  if (existsSync(resolve(ROOT, ".harness/runners/structural-check.mjs"))) {
    const r = spawnSync("node", [".harness/runners/structural-check.mjs"], {
      cwd: ROOT, encoding: "utf8",
    });
    return {
      ok: r.status === 0,
      output: ((r.stdout || "") + (r.stderr || "")).split("\n").slice(0, 80).join("\n"),
    };
  }
  if (existsSync(resolve(ROOT, "package.json"))) {
    const pj = loadJSON(resolve(ROOT, "package.json"));
    if (pj?.scripts?.["harness:check"]) {
      const r = spawnSync("npm", ["run", "--silent", "harness:check"], {
        cwd: ROOT, encoding: "utf8",
      });
      return {
        ok: r.status === 0,
        output: ((r.stdout || "") + (r.stderr || "")).split("\n").slice(0, 80).join("\n"),
      };
    }
  }
  return { ok: true, output: "(no structural-test entry point — skipped)" };
}

function baselineDelta(base) {
  const baselinePath = ".harness/structural-baseline.json";
  const headRaw = existsSync(resolve(ROOT, baselinePath))
    ? readFileSync(resolve(ROOT, baselinePath), "utf8") : "[]";
  const baseR = git(["show", `${base}:${baselinePath}`]);
  const baseRaw = baseR.status === 0 ? baseR.stdout : "[]";
  let headArr, baseArr;
  try { headArr = JSON.parse(headRaw); } catch { headArr = []; }
  try { baseArr = JSON.parse(baseRaw); } catch { baseArr = []; }
  const headSet = new Set(headArr.map((x) => typeof x === "string" ? x : JSON.stringify(x)));
  const baseSet = new Set(baseArr.map((x) => typeof x === "string" ? x : JSON.stringify(x)));
  const added = [];
  for (const e of headSet) if (!baseSet.has(e)) added.push(e);
  return { added_count: added.length, head_count: headArr.length, base_count: baseArr.length };
}

function buildReport({ base, changed, perFile, structural, baseline }) {
  const violations = structural.ok ? 0 : structural.output.split("\n")
    .filter((l) => /violat|error|FAIL/i.test(l)).length;
  const passed = structural.ok && baseline.added_count === 0;

  const md = [];
  md.push(`# /review-this-pr report`);
  md.push(``);
  md.push(`- base: \`${base}\``);
  md.push(`- changed files: ${changed.length}`);
  md.push(`- structural-test: ${structural.ok ? "PASS" : "FAIL"}`);
  md.push(`- baseline delta: ${baseline.added_count} new entries (head=${baseline.head_count}, base=${baseline.base_count})`);
  md.push(`- overall: ${passed ? "PASS" : "FAIL"}`);
  md.push(``);
  md.push(`## Changed files (by layer)`);
  md.push(``);
  for (const row of perFile) {
    const tag = row.layer ? `${row.layer.domain}/${row.layer.layer}` : "(unlayered)";
    md.push(`- \`${row.file}\` → ${tag}`);
  }
  md.push(``);
  md.push(`## Structural-test output (head 80 lines)`);
  md.push("```");
  md.push(structural.output);
  md.push("```");
  md.push(``);
  md.push(`## Hand-off`);
  md.push(``);
  md.push(`Recommended reviewer subagents based on touched layers:`);
  const layers = new Set(perFile.map((r) => r.layer?.layer).filter(Boolean));
  if (layers.has("service") || layers.has("repository")) md.push(`- /api-consistency-reviewer (service/repo touched)`);
  if (changed.some((f) => /auth|secret|crypto|cookie/i.test(f))) md.push(`- /security-reviewer (security-flavoured files touched)`);
  if (changed.some((f) => /\.sql$|migrations\//i.test(f))) md.push(`- /reliability-reviewer (data-layer touched)`);
  if (changed.length >= 10) md.push(`- /architecture-reviewer (>=10 files changed)`);
  md.push(``);
  const tail = { base, changed_files: changed.length, violations, baseline_delta: baseline.added_count, passed };
  md.push(`<!-- machine-tail: ${JSON.stringify(tail)} -->`);
  return { md: md.join("\n") + "\n", tail };
}

function main() {
  const { base, out } = parseArgs(process.argv.slice(2));
  const cfg = loadJSON(resolve(ROOT, ".harness/config.json"));
  const changed = changedFiles(base);
  const perFile = changed.map((f) => ({ file: f, layer: whichLayer(f, cfg) }));
  const structural = runStructuralTest();
  const baseline = baselineDelta(base);
  const { md, tail } = buildReport({ base, changed, perFile, structural, baseline });
  if (out) writeFileSync(resolve(ROOT, out), md);
  else process.stdout.write(md);
  if (!tail.passed) process.exit(2);
}

main();

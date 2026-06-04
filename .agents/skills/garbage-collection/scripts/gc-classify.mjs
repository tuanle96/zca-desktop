#!/usr/bin/env node
// gc-classify.mjs — deterministic scoring step for /garbage-collection.
// Replaces "LLM-scored risk/cost/benefit" turn with mechanical rubric.
//
// Usage:
//   gc-classify.mjs --baseline <gc-snapshot.json> [--history <hist.json>] [--out <file>]
//
// Rubric:
//   risk    = 1 + ceil(touched_files / 3)            capped at 5
//   cost    = 1 + ceil(lines_to_change / 30)         capped at 5
//   benefit = recurrenceCount(class) from gc-history capped at 5

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function loadJSON(p, fallback = null) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
}

function parseArgs(argv) {
  const out = { baseline: null, history: ".harness/gc-history.json", out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--baseline") out.baseline = argv[++i];
    else if (argv[i] === "--history") out.history = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
  }
  if (!out.baseline) {
    console.error("usage: gc-classify.mjs --baseline <gc-snapshot.json> [--history <hist.json>] [--out <file>]");
    process.exit(2);
  }
  return out;
}

function recurrenceCount(history, klass) {
  if (!history?.runs) return 1;
  let n = 0;
  for (const run of history.runs) {
    if (Array.isArray(run.classes_seen) && run.classes_seen.includes(klass)) n++;
  }
  return n;
}

function cap5(n) { return Math.max(1, Math.min(5, n)); }

function classify(baseline, history) {
  const violations = Array.isArray(baseline?.violations) ? baseline.violations : [];
  return violations.map((v) => {
    const touched = Number(v.files_touched) || 1;
    const lines = Number(v.lines_estimate) || 5;
    return {
      class: v.class || "unknown",
      path: v.path || "(unspecified)",
      summary: v.summary || `${v.class} at ${v.path || "(unspecified)"}`,
      risk: cap5(1 + Math.ceil(touched / 3)),
      cost: cap5(1 + Math.ceil(lines / 30)),
      benefit: cap5(recurrenceCount(history, v.class)),
    };
  });
}

function main() {
  const { baseline, history: histPath, out } = parseArgs(process.argv.slice(2));
  const base = loadJSON(resolve(baseline));
  if (!base) {
    console.error(`gc-classify: cannot read baseline at ${baseline}`);
    process.exit(2);
  }
  const hist = existsSync(resolve(histPath)) ? loadJSON(resolve(histPath), { runs: [] }) : { runs: [] };
  const scored = classify(base, hist);
  scored.sort((a, b) => b.benefit - a.benefit || a.cost - b.cost || a.risk - b.risk);
  const payload = { total: scored.length, candidates: scored };
  const text = JSON.stringify(payload, null, 2);
  if (out) writeFileSync(resolve(out), text + "\n");
  else process.stdout.write(text + "\n");
}

main();

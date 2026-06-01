#!/usr/bin/env node
// report-baseline-burn-down.mjs - render an HTML dashboard for the structural
// baseline burn-down: current count, recent trend, top offending files, and
// progress against the configured burnDownRate target.
//
// Reads .harness/config.json (or harness.config.json) for:
//   structuralBaseline.baselinePath
//   structuralBaseline.maxEntries
//   structuralBaseline.burnDownRate
//   structuralBaseline.burnDownRef
//   structuralBaseline.reportPath  (defaults to .harness/reports/baseline-debt.html)
//
// Usage:
//   node .harness/scripts/report-baseline-burn-down.mjs [--cwd=<dir>] [--out=<path>] [--trend=<n>] [--json]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  DEFAULT_BASELINE_PATH,
  analyzeStructuralBaseline,
  readStructuralBaselineConfig,
} from "./_lib/structural-baseline.mjs";

const DEFAULT_REPORT_PATH = ".harness/reports/baseline-debt.html";
const DEFAULT_TREND_DEPTH = 12;

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), out: null, trend: DEFAULT_TREND_DEPTH, json: false };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--out=")) opts.out = arg.slice("--out=".length);
    else if (arg.startsWith("--trend=")) {
      const value = Number(arg.slice("--trend=".length));
      if (Number.isFinite(value) && value > 0) opts.trend = Math.floor(value);
    }
  }
  return opts;
}

function rel(root, path) {
  return relative(root, path).split("\\").join("/") || ".";
}

function insideRoot(root, path) {
  const r = relative(root, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

function gitLog(root, baselineRel, depth) {
  const result = spawnSync(
    "git",
    ["log", `-n`, String(depth), "--format=%H%x09%cI%x09%s", "--", baselineRel],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, iso, ...subjectParts] = line.split("\t");
      return { hash, iso, subject: subjectParts.join("\t") };
    });
}

function gitShowCount(root, ref, baselineRel) {
  const result = spawnSync("git", ["show", `${ref}:${baselineRel}`], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

function topOffendingFiles(entries, limit = 10) {
  const counts = new Map();
  for (const entry of entries) {
    // Baseline entries look like "<rule>::<file>::<line>::<text>" or
    // "<file>::<imp>". Pull the first path-shaped segment as the file.
    const parts = String(entry).split("::");
    const file = parts.find((p) => p.includes("/")) || parts[0] || "(unknown)";
    counts.set(file, (counts.get(file) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([file, count]) => ({ file, count }));
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderTrendBars(trend, max) {
  if (trend.length === 0 || max <= 0) {
    return '<p class="muted">No history available for this baseline file.</p>';
  }
  const bars = trend
    .map((point) => {
      const height = Math.max(2, Math.round((point.count / max) * 120));
      const label = `${point.count} on ${point.iso.slice(0, 10)}`;
      return `<div class="bar" title="${escapeHtml(label)}" style="height:${height}px"><span>${point.count}</span></div>`;
    })
    .join("");
  return `<div class="trend">${bars}</div>`;
}

function renderHtml({ payload, generatedAt }) {
  const { current, target, trend, top, comparison, burnDown } = payload;
  const max = Math.max(current.count, ...trend.map((p) => p.count), 1);
  const overTarget = target.maxEntries !== null && current.count > target.maxEntries;
  const onTrack = burnDown.enabled
    ? burnDown.onTrack === true
    : comparison.exists
      ? comparison.delta <= 0
      : true;
  const statusClass = overTarget ? "fail" : onTrack ? "ok" : "warn";
  const statusLabel = overTarget ? "Over target" : onTrack ? "On track" : "Behind target";
  const topRows = top.length === 0
    ? '<tr><td colspan="2" class="muted">Baseline is empty.</td></tr>'
    : top
        .map(
          (row) => `<tr><td><code>${escapeHtml(row.file)}</code></td><td class="num">${row.count}</td></tr>`,
        )
        .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Structural baseline burn-down</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.4 system-ui, sans-serif; margin: 24px; max-width: 880px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #666; margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .card { border: 1px solid #ddd; border-radius: 6px; padding: 12px; }
  .card .label { color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
  .status { padding: 4px 10px; border-radius: 999px; font-weight: 600; font-size: 12px; }
  .status.ok { background: #d1fae5; color: #065f46; }
  .status.warn { background: #fef3c7; color: #92400e; }
  .status.fail { background: #fee2e2; color: #991b1b; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border-bottom: 1px solid #eee; padding: 6px 8px; text-align: left; }
  th { font-size: 12px; text-transform: uppercase; color: #666; letter-spacing: 0.05em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #777; }
  .trend { display: flex; align-items: flex-end; gap: 4px; height: 140px; padding: 8px; border: 1px solid #eee; border-radius: 6px; }
  .bar { flex: 1; background: #4f46e5; color: #fff; font-size: 10px; text-align: center; min-width: 16px; display: flex; align-items: flex-start; justify-content: center; padding-top: 2px; border-radius: 3px 3px 0 0; }
  code { font-size: 12px; }
  section { margin-bottom: 24px; }
</style>
</head>
<body>
  <h1>Structural baseline burn-down</h1>
  <p class="meta">
    Generated <time>${escapeHtml(generatedAt)}</time> for
    <code>${escapeHtml(current.path)}</code>
  </p>
  <section class="grid">
    <div class="card">
      <div class="label">Current</div>
      <div class="value">${current.count}</div>
    </div>
    <div class="card">
      <div class="label">Max allowed</div>
      <div class="value">${target.maxEntries ?? "&infin;"}</div>
    </div>
    <div class="card">
      <div class="label">Target / period</div>
      <div class="value">${burnDown.enabled ? burnDown.rate : "&mdash;"}</div>
    </div>
    <div class="card">
      <div class="label">Status</div>
      <div class="value"><span class="status ${statusClass}">${escapeHtml(statusLabel)}</span></div>
    </div>
  </section>
  <section>
    <h2>Trend (last ${trend.length} commits touching the baseline)</h2>
    ${renderTrendBars(trend, max)}
  </section>
  <section>
    <h2>Burn-down progress</h2>
    ${
      burnDown.enabled
        ? `<p>Reduced <strong>${burnDown.reduction ?? 0}</strong> entries vs <code>${escapeHtml(burnDown.ref)}</code> (target ${burnDown.rate} per period).</p>`
        : '<p class="muted">Burn-down rate not configured. Set <code>structuralBaseline.burnDownRate</code> to enable.</p>'
    }
  </section>
  <section>
    <h2>Top offending files</h2>
    <table>
      <thead><tr><th>File</th><th class="num">Entries</th></tr></thead>
      <tbody>${topRows}</tbody>
    </table>
  </section>
</body>
</html>
`;
}

const opts = parseArgs(process.argv.slice(2));
const root = resolve(opts.cwd);
const config = readStructuralBaselineConfig(root);
const baselineRel = config.baselinePath || DEFAULT_BASELINE_PATH;
const baselineAbs = resolve(root, baselineRel);
const reportRel = opts.out || config.reportPath || DEFAULT_REPORT_PATH;
const reportAbs = resolve(root, reportRel);

if (!insideRoot(root, baselineAbs)) {
  console.error(`baselinePath must stay inside the project root: ${baselineRel}`);
  process.exit(1);
}
if (!insideRoot(root, reportAbs)) {
  console.error(`reportPath must stay inside the project root: ${reportRel}`);
  process.exit(1);
}

const analysis = analyzeStructuralBaseline({ cwd: root });
const trendCommits = gitLog(root, rel(root, baselineAbs), opts.trend);
const trend = trendCommits
  .map((c) => ({ ...c, count: gitShowCount(root, c.hash, rel(root, baselineAbs)) }))
  .filter((c) => Number.isFinite(c.count))
  .reverse();

const payload = {
  generatedAt: new Date().toISOString(),
  current: { path: rel(root, baselineAbs), count: analysis.count },
  target: { maxEntries: analysis.maxEntries },
  comparison: analysis.comparison,
  burnDown: analysis.burnDown,
  trend,
  top: topOffendingFiles(analysis.entries),
  status: analysis.status,
};

if (opts.json) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

mkdirSync(dirname(reportAbs), { recursive: true });
const html = renderHtml({ payload, generatedAt: payload.generatedAt });
writeFileSync(reportAbs, html, "utf8");
console.log(`baseline burn-down report: ${rel(root, reportAbs)} (${analysis.count} entries, status=${analysis.status})`);

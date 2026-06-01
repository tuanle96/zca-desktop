#!/usr/bin/env node
/**
 * verify-ui.mjs — Browser validation for agent-harness-kit projects.
 *
 * Runs golden-path UI checks with Playwright when available and writes
 * screenshot, console/network logs, JSON summary, and HTML report artifacts.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DEFAULT_OUT = '.harness/ui-validation';

const opts = {
  url: process.env.UI_URL || '',
  command: '',
  outDir: DEFAULT_OUT,
  timeoutMs: 30_000,
  mock: false,
  allowMockExitZero: false,
  headless: true,
};

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--url=')) opts.url = arg.slice('--url='.length);
  else if (arg.startsWith('--command=')) opts.command = arg.slice('--command='.length);
  else if (arg.startsWith('--out-dir=')) opts.outDir = arg.slice('--out-dir='.length);
  else if (arg.startsWith('--timeout-ms=')) opts.timeoutMs = Number(arg.slice('--timeout-ms='.length));
  else if (arg === '--mock') opts.mock = true;
  else if (arg === '--allow-mock-exit-zero') opts.allowMockExitZero = true;
  else if (arg === '--headed') opts.headless = false;
}

function ts() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function rel(path) { return path.replace(ROOT + '/', ''); }
function sha256(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function routeFromUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.pathname || '/'}${parsed.search || ''}`;
  } catch {
    return value || '';
  }
}
function assertionsFromChecks(checks) {
  return checks.map(check => ({
    name: check.name,
    passed: Boolean(check.passed),
    detail: check.detail || '',
  }));
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function startServer() {
  if (!opts.command) return null;
  const proc = spawn(opts.command, { cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  proc.stdout.on('data', chunk => logs.push({ stream: 'stdout', text: String(chunk) }));
  proc.stderr.on('data', chunk => logs.push({ stream: 'stderr', text: String(chunk) }));
  await new Promise(resolve => setTimeout(resolve, 2_000));
  return { proc, logs };
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    throw new Error('Playwright is not installed. Run `npm install -D playwright` and `npx playwright install chromium`, or pass --mock for report smoke tests.');
  }
}

async function runMockValidation(runDir) {
  const markerPath = join(runDir, 'MOCK_ONLY_NOT_EVIDENCE.txt');
  await writeFile(
    markerPath,
    [
      'Mock UI validation does not prove browser behavior.',
      'Use Playwright mode without --mock for task evidence.',
      '',
    ].join('\n'),
  );
  return {
    passed: false,
    evidenceKind: 'mock',
    evidenceUsable: false,
    url: opts.url || 'mock://ui',
    route: routeFromUrl(opts.url || 'mock://ui'),
    durationMs: 1,
    checks: [
      { name: 'real-browser-evidence', passed: false, detail: '--mock does not launch a browser and cannot satisfy UI evidence' },
      { name: 'report-generation', passed: true, detail: 'mock report artifact generated' },
      { name: 'console-errors', passed: true, detail: '0 errors' },
      { name: 'network-failures', passed: true, detail: '0 failed requests' },
    ],
    console: [],
    networkFailures: [],
    screenshots: [],
    assertions: [],
    artifacts: [rel(markerPath)],
  };
}

async function runBrowserValidation(runDir) {
  if (!opts.url) throw new Error('Missing --url. Provide an existing app URL or combine --command="npm run dev" with --url=http://localhost:3000.');
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: opts.headless });
  const page = await browser.newPage();
  const consoleEvents = [];
  const networkFailures = [];
  const started = Date.now();

  page.on('console', msg => {
    consoleEvents.push({ type: msg.type(), text: msg.text(), location: msg.location() });
  });
  page.on('requestfailed', req => {
    networkFailures.push({ url: req.url(), method: req.method(), failure: req.failure()?.errorText || 'unknown' });
  });
  page.on('response', res => {
    if (res.status() >= 400) networkFailures.push({ url: res.url(), method: res.request().method(), status: res.status() });
  });

  const checks = [];
  const screenshotPath = join(runDir, 'screenshots', 'home.png');
  const domSnapshotPath = join(runDir, 'dom.html');
  let domSnapshotHash = '';
  await mkdir(join(runDir, 'screenshots'), { recursive: true });

  try {
    const response = await page.goto(opts.url, { waitUntil: 'networkidle', timeout: opts.timeoutMs });
    checks.push({ name: 'page-load', passed: Boolean(response && response.ok()), detail: response ? `${response.status()} ${response.url()}` : 'no response' });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    checks.push({ name: 'screenshot', passed: true, detail: rel(screenshotPath) });
    const domSnapshot = await page.content();
    await writeFile(domSnapshotPath, domSnapshot);
    domSnapshotHash = sha256(domSnapshot);
  } catch (error) {
    checks.push({ name: 'page-load', passed: false, detail: error.message });
  } finally {
    await browser.close();
  }

  const severeConsole = consoleEvents.filter(e => e.type === 'error');
  checks.push({ name: 'console-errors', passed: severeConsole.length === 0, detail: `${severeConsole.length} errors` });
  checks.push({ name: 'network-failures', passed: networkFailures.length === 0, detail: `${networkFailures.length} failures` });

  return {
    passed: checks.every(c => c.passed),
    evidenceKind: 'browser',
    evidenceUsable: checks.every(c => c.passed),
    url: opts.url,
    route: routeFromUrl(opts.url),
    durationMs: Date.now() - started,
    checks,
    assertions: assertionsFromChecks(checks),
    console: consoleEvents,
    networkFailures,
    screenshots: existsSync(screenshotPath) ? [rel(screenshotPath)] : [],
    domSnapshotPath: existsSync(domSnapshotPath) ? rel(domSnapshotPath) : '',
    domSnapshotHash,
  };
}

function htmlReport(summary) {
  const status = summary.passed ? 'PASS' : 'FAIL';
  const color = summary.passed ? '#16a34a' : '#dc2626';
  const checks = summary.checks.map(c => `<tr><td>${escapeHtml(c.name)}</td><td>${c.passed ? 'PASS' : 'FAIL'}</td><td>${escapeHtml(c.detail)}</td></tr>`).join('\n');
  const consoleRows = summary.console.map(e => `<tr><td>${escapeHtml(e.type)}</td><td>${escapeHtml(e.text)}</td></tr>`).join('\n') || '<tr><td colspan="2">None</td></tr>';
  const networkRows = summary.networkFailures.map(e => `<tr><td>${escapeHtml(e.method || '')}</td><td>${escapeHtml(e.status || e.failure || '')}</td><td>${escapeHtml(e.url)}</td></tr>`).join('\n') || '<tr><td colspan="3">None</td></tr>';
  const screenshots = summary.screenshots.map(s => s.endsWith('.png') ? `<img src="${escapeHtml(s.split('/').pop())}" alt="${escapeHtml(s)}">` : `<pre>${escapeHtml(s)}</pre>`).join('\n') || '<p>None</p>';
  const artifacts = (summary.artifacts || []).map(s => `<li><code>${escapeHtml(s)}</code></li>`).join('\n') || '<li>None</li>';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>UI Validation Report</title><style>
body{font-family:Inter,system-ui,sans-serif;margin:32px;background:#0f172a;color:#e2e8f0} .card{background:#111827;border:1px solid #334155;border-radius:14px;padding:20px;margin:16px 0} h1{margin:0}.status{color:${color};font-weight:800} table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #334155;padding:8px;text-align:left} img{max-width:100%;border:1px solid #334155;border-radius:10px;background:white}
</style></head><body>
<h1>Browser Validation: <span class="status">${status}</span></h1>
<p>URL: ${escapeHtml(summary.url)} · Duration: ${summary.durationMs}ms · Run: ${escapeHtml(summary.runId)} · Evidence: ${escapeHtml(summary.evidenceKind || 'unknown')} · Usable: ${summary.evidenceUsable ? 'yes' : 'no'}</p>
<div class="card"><h2>Golden Path Checks</h2><table><tr><th>Check</th><th>Status</th><th>Detail</th></tr>${checks}</table></div>
<div class="card"><h2>Console</h2><table><tr><th>Type</th><th>Text</th></tr>${consoleRows}</table></div>
<div class="card"><h2>Network Failures</h2><table><tr><th>Method</th><th>Status/Failure</th><th>URL</th></tr>${networkRows}</table></div>
<div class="card"><h2>Screenshots</h2>${screenshots}</div>
<div class="card"><h2>Artifacts</h2><ul>${artifacts}</ul></div>
</body></html>`;
}

async function main() {
  const runId = ts();
  const runDir = resolve(ROOT, opts.outDir, runId);
  await mkdir(runDir, { recursive: true });

  const server = await startServer();
  let summary;
  try {
    summary = opts.mock ? await runMockValidation(runDir) : await runBrowserValidation(runDir);
  } finally {
    if (server) server.proc.kill('SIGTERM');
  }

  summary.runId = runId;
  summary.artifactDir = rel(runDir);
  summary.serverLogs = server?.logs || [];
  await writeFile(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(join(runDir, 'report.html'), htmlReport(summary));

  const latest = resolve(ROOT, opts.outDir, 'latest.json');
  await writeFile(latest, JSON.stringify(summary, null, 2));

  console.log(JSON.stringify({
    passed: summary.passed,
    evidenceKind: summary.evidenceKind,
    evidenceUsable: summary.evidenceUsable,
    runId,
    artifactDir: summary.artifactDir,
    report: rel(join(runDir, 'report.html')),
    screenshots: summary.screenshots,
  }, null, 2));
  if (!summary.passed && !(opts.mock && opts.allowMockExitZero)) process.exit(1);
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

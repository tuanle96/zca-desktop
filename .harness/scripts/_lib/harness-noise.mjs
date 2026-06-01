import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { bypassRecordFingerprint } from "./bypass-audit.mjs";
import { telemetryEventName } from "./telemetry-schema.mjs";

const DEFAULT_WINDOW_DAYS = 7;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const BLOCK_EVENTS = new Set([
  "precompletion_block",
  "permission_denied",
  "userprompt_block",
  "structural_test_fail",
]);
const REMEDIATION_EVENTS = new Set(["block_remediated", "remediation"]);

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const [idx, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object" && !Array.isArray(row)) out.push({ ...row, _line: idx + 1 });
    } catch {
      // Noise reporting should not block on a partial historical row.
    }
  }
  return out;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function readRequests(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(dir, entry.name);
    const request = readJson(path);
    if (request) out.push({ ...request, _path: path });
  }
  return out;
}

function inWindow(row, windowDays, nowMs) {
  if (!windowDays) return true;
  const raw = row.ts || row.createdAt || row.reviewedAt || row.expiresAt || row._ts;
  const time = Date.parse(raw || "");
  if (!Number.isFinite(time)) return false;
  return nowMs - time <= windowDays * ONE_DAY_MS;
}

function labelForBlock(row) {
  const event = telemetryEventName(row);
  return String(row.rule || row.source || row.hook || row.type || row.tool_name || event || "unknown");
}

function labelForBypass(row) {
  return String(row.rule || row.hook || row.tool || row.bypass || "bypass");
}

function taskFor(row) {
  return String(row.task_id || row.taskId || row.activeTask || row.task || "");
}

function isBlockRow(row) {
  const event = telemetryEventName(row);
  return (
    BLOCK_EVENTS.has(event) ||
    row.type === "tool_blocked" ||
    row.decision === "block" ||
    (event === "notification" && /block|denied|failed/i.test(`${row.type || ""} ${row.title || ""} ${row.body || ""}`))
  );
}

function isLoopGuardRow(row) {
  const event = telemetryEventName(row);
  return event === "precompletion_loop_guard" || /stop_hook_active|loop.?guard/i.test(`${row.type || ""} ${row.title || ""} ${row.body || ""} ${row.reason || ""}`);
}

function isRemediationRow(row) {
  return REMEDIATION_EVENTS.has(telemetryEventName(row));
}

function increment(map, key, by = 1) {
  const normalized = key || "(unspecified)";
  map.set(normalized, (map.get(normalized) || 0) + by);
}

function topCounts(map, limit = 10) {
  return [...map.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function average(values) {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function msToMinutes(ms) {
  return ms === null ? null : Math.round((ms / 60000) * 10) / 10;
}

function ruleStats({ blockRows, bypassRows, falsePositiveRows, acknowledgementRows }) {
  const stats = new Map();
  const ensure = (rule) => {
    const id = rule || "(unspecified)";
    if (!stats.has(id)) {
      stats.set(id, { id, blocks: 0, bypasses: 0, falsePositives: 0, overrides: 0, score: 0 });
    }
    return stats.get(id);
  };
  for (const row of blockRows) ensure(labelForBlock(row)).blocks += 1;
  for (const row of bypassRows) ensure(labelForBypass(row)).bypasses += 1;
  for (const row of falsePositiveRows) ensure(row._rule || "(unspecified)").falsePositives += 1;
  for (const row of acknowledgementRows) ensure(row._rule || "(unspecified)").overrides += 1;
  for (const stat of stats.values()) {
    stat.score = stat.blocks + stat.bypasses * 2 + stat.falsePositives * 3 + stat.overrides;
  }
  return [...stats.values()]
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.falsePositives - a.falsePositives || a.id.localeCompare(b.id))
    .slice(0, 10);
}

export function buildHarnessNoiseReport({
  cwd = process.cwd(),
  windowDays = DEFAULT_WINDOW_DAYS,
  telemetryPath = ".harness/telemetry.jsonl",
  bypassLogPath = ".harness/bypass.log",
  bypassAuditPath = ".harness/bypass-audit.json",
  bypassRequestsDir = ".harness/bypass-requests",
  now = Date.now(),
} = {}) {
  const root = resolve(cwd);
  const rel = (path) => relative(root, path).replaceAll("\\", "/") || ".";
  const telemetryAbs = resolve(root, telemetryPath);
  const bypassAbs = resolve(root, bypassLogPath);
  const auditAbs = resolve(root, bypassAuditPath);
  const requestsAbs = resolve(root, bypassRequestsDir);

  const telemetryRows = readJsonl(telemetryAbs).filter((row) => inWindow(row, windowDays, now));
  const bypassRows = readJsonl(bypassAbs)
    .map((row) => ({ ...row, _fingerprint: bypassRecordFingerprint(stripPrivate(row)) }))
    .filter((row) => inWindow(row, windowDays, now));
  const ack = readJson(auditAbs);
  const allAcknowledgements = Array.isArray(ack?.acknowledged) ? ack.acknowledged : [];
  const bypassByFingerprint = new Map(bypassRows.map((row) => [row._fingerprint, row]));
  const acknowledgementRows = allAcknowledgements
    .map((entry) => {
      const bypass = bypassByFingerprint.get(entry.fingerprint);
      return {
        ...entry,
        _bypass: bypass || null,
        _rule: bypass ? labelForBypass(bypass) : "(missing-bypass-record)",
        _ts: entry.reviewedAt,
      };
    })
    .filter((row) => inWindow(row, windowDays, now));
  const requestRows = readRequests(requestsAbs).filter((row) => inWindow(row, windowDays, now));

  const blockRows = telemetryRows.filter(isBlockRow);
  const remediationRows = telemetryRows.filter(isRemediationRow);
  const loopGuardRows = telemetryRows.filter(isLoopGuardRow);
  const falsePositiveRows = acknowledgementRows.filter((row) => row.disposition === "false-positive");
  const convertedRows = acknowledgementRows.filter((row) => row.disposition === "converted-to-failure-record");
  const acceptedRows = acknowledgementRows.filter((row) => row.disposition === "accepted");
  const supersededRows = acknowledgementRows.filter((row) => row.disposition === "superseded");

  const blocksByRule = new Map();
  const bypassesByRule = new Map();
  const repeatedByRuleTask = new Map();
  const falsePositivesByRule = new Map();
  const overridesByRule = new Map();
  for (const row of blockRows) {
    const rule = labelForBlock(row);
    increment(blocksByRule, rule);
    increment(repeatedByRuleTask, `${rule}::${taskFor(row) || "(no-task)"}`);
  }
  for (const row of bypassRows) increment(bypassesByRule, labelForBypass(row));
  for (const row of falsePositiveRows) increment(falsePositivesByRule, row._rule);
  for (const row of acknowledgementRows) increment(overridesByRule, row._rule);

  const reviewLatenciesMs = [];
  for (const row of acknowledgementRows) {
    const bypassTs = Date.parse(row._bypass?.ts || "");
    const reviewedAt = Date.parse(row.reviewedAt || "");
    if (Number.isFinite(bypassTs) && Number.isFinite(reviewedAt) && reviewedAt >= bypassTs) {
      reviewLatenciesMs.push(reviewedAt - bypassTs);
    }
  }

  const approvedRequests = requestRows.filter((row) => String(row.approvedBy || "").trim());
  const expiredRequests = requestRows.filter((row) => Number.isFinite(Date.parse(row.expiresAt || "")) && Date.parse(row.expiresAt) <= now);
  const repeatedBlocks = topCounts(
    new Map([...repeatedByRuleTask.entries()].filter(([, count]) => count > 1)),
    10,
  );
  const reasons = [];
  if (blockRows.length > 0) reasons.push(`${blockRows.length} hook block event(s)`);
  if (falsePositiveRows.length > 0) reasons.push(`${falsePositiveRows.length} acknowledged false-positive bypass(es)`);
  if (repeatedBlocks.length > 0) reasons.push(`${repeatedBlocks.length} repeated block pattern(s)`);
  if (bypassRows.length > 0) reasons.push(`${bypassRows.length} bypass record(s) in the window`);
  if (loopGuardRows.length > 0) reasons.push(`${loopGuardRows.length} Stop hook loop-guard activation(s)`);

  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    windowDays,
    status: reasons.length > 0 ? "warn" : "pass",
    reasons,
    paths: {
      telemetry: rel(telemetryAbs),
      bypassLog: rel(bypassAbs),
      bypassAudit: rel(auditAbs),
      bypassRequests: rel(requestsAbs),
    },
    totals: {
      telemetryRows: telemetryRows.length,
      hookBlocks: blockRows.length,
      bypasses: bypassRows.length,
      acknowledgements: acknowledgementRows.length,
      humanOverrides: acknowledgementRows.length + approvedRequests.length,
      falsePositives: falsePositiveRows.length,
      remediations: remediationRows.length + acknowledgementRows.length,
      loopGuardActivations: loopGuardRows.length,
    },
    blocksByRule: topCounts(blocksByRule),
    repeatedBlocks,
    bypassesByRule: topCounts(bypassesByRule),
    falsePositivesByRule: topCounts(falsePositivesByRule),
    overridesByRule: topCounts(overridesByRule),
    noisyRules: ruleStats({ blockRows, bypassRows, falsePositiveRows, acknowledgementRows }),
    acknowledgements: {
      accepted: acceptedRows.length,
      falsePositive: falsePositiveRows.length,
      convertedToFailureRecord: convertedRows.length,
      superseded: supersededRows.length,
      averageReviewLatencyMs: average(reviewLatenciesMs),
      averageReviewLatencyMinutes: msToMinutes(average(reviewLatenciesMs)),
    },
    requests: {
      total: requestRows.length,
      approved: approvedRequests.length,
      expired: expiredRequests.length,
    },
  };
}

function stripPrivate(row) {
  const clean = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (!key.startsWith("_")) clean[key] = value;
  }
  return clean;
}

export function renderHarnessNoiseText(report) {
  const lines = ["=== harness noise report ==="];
  lines.push(`window: last ${report.windowDays} day(s)`);
  lines.push(`status: ${report.status.toUpperCase()}`);
  lines.push(
    `totals: blocks ${report.totals.hookBlocks}, bypasses ${report.totals.bypasses}, false positives ${report.totals.falsePositives}, human overrides ${report.totals.humanOverrides}`,
  );
  if (report.acknowledgements.averageReviewLatencyMinutes !== null) {
    lines.push(`average review latency: ${report.acknowledgements.averageReviewLatencyMinutes} min`);
  }
  appendList(lines, "top noisy rules", report.noisyRules.map((row) => `${row.id} score=${row.score} blocks=${row.blocks} bypasses=${row.bypasses} falsePositive=${row.falsePositives}`));
  appendList(lines, "repeated blocks", report.repeatedBlocks.map((row) => `${row.id} x${row.count}`));
  appendList(lines, "bypasses by rule", report.bypassesByRule.map((row) => `${row.id} x${row.count}`));
  appendList(lines, "reasons", report.reasons);
  return `${lines.join("\n")}\n`;
}

function appendList(lines, label, items) {
  if (!items || items.length === 0) return;
  lines.push(`${label}:`);
  for (const item of items.slice(0, 8)) lines.push(`  - ${item}`);
  if (items.length > 8) lines.push(`  ...and ${items.length - 8} more`);
}

export function parseHarnessNoiseArgs(argv = []) {
  const opts = { cwd: process.cwd(), json: false, windowDays: DEFAULT_WINDOW_DAYS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--cwd") opts.cwd = resolve(argv[++i] || "");
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg === "--last") opts.windowDays = parseWindowDays(argv[++i]);
    else if (arg.startsWith("--last=")) opts.windowDays = parseWindowDays(arg.slice("--last=".length));
    else if (arg === "--window-days") opts.windowDays = Number(argv[++i]);
    else if (arg.startsWith("--window-days=")) opts.windowDays = Number(arg.slice("--window-days=".length));
  }
  if (!Number.isFinite(opts.windowDays) || opts.windowDays < 1) opts.windowDays = DEFAULT_WINDOW_DAYS;
  return opts;
}

function parseWindowDays(value) {
  const text = String(value || "").trim().toLowerCase();
  if (/^\d+d$/.test(text)) return Number(text.slice(0, -1));
  if (/^\d+$/.test(text)) return Number(text);
  return DEFAULT_WINDOW_DAYS;
}

export async function runHarnessNoiseCli(argv = [], { exit = true } = {}) {
  const opts = parseHarnessNoiseArgs(argv);
  const report = buildHarnessNoiseReport(opts);
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(renderHarnessNoiseText(report));
  if (exit) process.exit(0);
  return { report, exitCode: 0 };
}

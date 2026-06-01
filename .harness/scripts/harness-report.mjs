#!/usr/bin/env node
// harness:report — aggregate eval results + skill telemetry into a per-skill
// summary. Reads .harness/eval/results/*.jsonl and .harness/telemetry.jsonl.
//
// Output:
//   ### Eval results (last 7 days)
//   <per-task: pass/fail counts, avg tokens>
//   ### Skill invocations (last 7 days)
//   <per-skill: invocation count, sessions, last seen>
//   ### Drift signals
//   <skills that haven't been invoked in N days; tasks that have started failing>
//
// No external deps — pure Node stdlib.

import { readdir, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, join, relative, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { auditBypassRecords } from "./_lib/bypass-audit.mjs";
import { concreteCommand } from "./_lib/command-policy.mjs";
import { buildHarnessNoiseReport } from "./_lib/harness-noise.mjs";
import { analyzeHookIntegrity } from "./_lib/hook-integrity.mjs";
import { overbroadSensitiveBashPermission } from "./_lib/permission-matching.mjs";
import { analyzeStructuralBaseline } from "./_lib/structural-baseline.mjs";
import { isSkillInvocationRecord } from "./_lib/telemetry-schema.mjs";

const ROOT = process.cwd();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(ROOT, ".harness/eval/results");
const TELEMETRY = resolve(ROOT, ".harness/telemetry.jsonl");
const SKILLS_DIR = resolve(ROOT, ".claude/skills");
const TASK_CONTRACTS_DIR = resolve(ROOT, ".harness/task-contracts");
const EVIDENCE_DIR = resolve(ROOT, ".harness/evidence");
const REVIEW_DECISIONS_DIR = resolve(ROOT, ".harness/reviews");
const FAILURE_RECORDS_DIR = resolve(ROOT, ".harness/failures/records");
const ORCHESTRATION_RUNS_DIR = resolve(ROOT, ".harness/orchestration");
const ORCHESTRATION_CONTRACTS_DIR = resolve(ROOT, ".harness/orchestration/contracts");
const SESSION_MANIFESTS_DIR = resolve(ROOT, ".harness/sessions");
const FEATURE_LIST = resolve(ROOT, ".harness/feature_list.json");
const SKILL_REGISTRY = resolve(ROOT, ".harness/skill-registry.json");
const PERMISSIONS_POLICY = resolve(ROOT, ".harness/permissions.json");
const NOW = Date.now();
const ONE_DAY = 24 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * ONE_DAY;
const FOURTEEN_DAYS = 14 * ONE_DAY;
const FAILURE_RECORD_STALE_DAYS = 14;
const VERIFY_UI_COMMAND_RE = /(^|[\s;&|])(?:node\s+)?(?:\.harness\/scripts\/|scripts\/)?verify-ui\.mjs(?:\s|$)/i;
const MOCK_VERIFY_UI_RE = /(^|[\s;&|])(?:node\s+)?(?:\.harness\/scripts\/|scripts\/)?verify-ui\.mjs(?:\s+[^\n;&|]*)?--mock(?:\s|$)/i;
const UI_CHECK_RE = /\b(ui|verify-ui|playwright|browser)\b/i;
const REQUIRED_VERIFY_UI_CHECKS = ["page-load", "screenshot", "console-errors", "network-failures"];

function parseArgs(argv) {
  const opts = { json: false, html: false, out: null, failOn: null, reviewPromotion: null };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--html") opts.html = true;
    else if (arg.startsWith("--out=")) opts.out = arg.slice("--out=".length);
    else if (arg.startsWith("--fail-on=")) {
      const value = arg.slice("--fail-on=".length);
      if (value === "warn" || value === "fail") opts.failOn = value;
    } else if (arg.startsWith("--review-promotion=")) {
      const value = arg.slice("--review-promotion=".length);
      if (value === "warn" || value === "fail") opts.reviewPromotion = value;
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

async function readJsonl(path) {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

async function loadJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const out = [];
  for (const f of files.sort()) {
    if (!f.endsWith(".json")) continue;
    const path = join(dir, f);
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        value._path = rel(path);
        out.push(value);
      } else {
        out.push({ _path: rel(path), _invalid: true });
      }
    } catch {
      out.push({ _path: rel(path), _invalid: true });
    }
  }
  return out;
}

async function loadJsonFilesRecursive(dir, { skipDirs = new Set() } = {}) {
  if (!existsSync(dir)) return [];
  const out = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) await walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const value = JSON.parse(await readFile(path, "utf8"));
        if (value && typeof value === "object" && !Array.isArray(value)) {
          value._path = rel(path);
          out.push(value);
        } else {
          out.push({ _path: rel(path), _invalid: true });
        }
      } catch {
        out.push({ _path: rel(path), _invalid: true });
      }
    }
  }
  await walk(dir);
  return out;
}

async function loadOrchestrationRuns(runsDir) {
  if (!existsSync(runsDir)) return [];
  const entries = await readdir(runsDir, { withFileTypes: true });
  const runs = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name === "contracts") continue;
    const dir = join(runsDir, entry.name);
    const manifest = await readJsonFile(join(dir, "manifest.json"));
    const summary = await readJsonFile(join(dir, "summary.json"));
    if (!manifest && !summary) continue;
    runs.push({
      _path: rel(dir),
      runId: summary?.runId || manifest?.runId || entry.name,
      manifest,
      summary,
      _invalid: Boolean(manifest?._invalid || summary?._invalid),
    });
  }
  return runs;
}

async function readJsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { _invalid: true };
  }
}

function rel(path) {
  return relative(ROOT, path).split("\\").join("/") || ".";
}

async function loadEvalResults() {
  if (!existsSync(RESULTS_DIR)) return [];
  const files = await readdir(RESULTS_DIR);
  const all = [];
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const path = join(RESULTS_DIR, f);
    const st = await stat(path);
    const rows = await readJsonl(path);
    for (const r of rows) {
      r._mtime = st.mtimeMs;
      all.push(r);
    }
  }
  return all;
}

function recent(rows, key = "ts") {
  return rows.filter((r) => {
    const t = r[key] ? new Date(r[key]).getTime() : r._mtime ?? 0;
    return NOW - t <= SEVEN_DAYS;
  });
}

async function loadKnownSkills() {
  if (!existsSync(SKILLS_DIR)) return [];
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// Rows aged 7–14 days. Used as the comparator for week-over-week deltas
// so users can spot drift instead of staring at a single-week snapshot.
function priorWeek(rows, key = "ts") {
  return rows.filter((r) => {
    const t = r[key] ? new Date(r[key]).getTime() : r._mtime ?? 0;
    const age = NOW - t;
    return age > SEVEN_DAYS && age <= FOURTEEN_DAYS;
  });
}

function tokensOf(row) {
  return (row.grades ?? [])
    .filter((g) => g.dim === "efficiency")
    .reduce((sum, g) => {
      const m = g.info?.match(/^(\d+) tokens/);
      return sum + (m ? parseInt(m[1], 10) : 0);
    }, 0);
}

function fmtPct(num, total) {
  if (total === 0) return "n/a";
  return `${Math.round((num / total) * 100)}%`;
}

function sameSet(a = [], b = []) {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return JSON.stringify(left) === JSON.stringify(right);
}

function statusFrom({ fail = false, warn = false } = {}) {
  if (fail) return "fail";
  if (warn) return "warn";
  return "pass";
}

function worstStatus(statuses) {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  return "pass";
}

function ageDaysSince(value) {
  const t = Date.parse(value || "");
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((NOW - t) / ONE_DAY));
}

function statusMeets(status, threshold) {
  if (!threshold) return false;
  const order = { pass: 0, warn: 1, fail: 2 };
  return order[status] >= order[threshold];
}

function reviewPromotionPolicy(config) {
  const configured = config && !config._invalid ? config.readiness?.reviewPromotion : null;
  return opts.reviewPromotion || (configured === "fail" ? "fail" : "warn");
}

function evalSummary(rows) {
  const byTask = new Map();
  for (const r of rows) {
    const cur = byTask.get(r.taskId) ?? { taskId: r.taskId, passed: 0, total: 0, tokens: 0 };
    cur.total++;
    if (r.passed) cur.passed++;
    cur.tokens += tokensOf(r);
    byTask.set(r.taskId, cur);
  }
  const tasks = [...byTask.values()]
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
    .map((task) => ({
      taskId: task.taskId,
      passed: task.passed,
      total: task.total,
      passRate: task.total > 0 ? Math.round((task.passed / task.total) * 100) : null,
      avgTokens: task.total > 0 ? Math.round(task.tokens / task.total) : 0,
    }));

  const latest = new Map();
  for (const r of rows.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""))) {
    latest.set(r.taskId, r);
  }
  const latestFailingTasks = [...latest.values()]
    .filter((r) => !r.passed)
    .map((r) => r.taskId)
    .sort();
  const reasons = [];
  if (rows.length === 0) reasons.push("no recent eval runs");
  if (latestFailingTasks.length > 0) reasons.push(`latest failing tasks: ${latestFailingTasks.join(", ")}`);
  return {
    status: statusFrom({ fail: latestFailingTasks.length > 0, warn: rows.length === 0 }),
    reasons,
    runs: rows.length,
    tasks,
    latestFailingTasks,
  };
}

function telemetrySummary(rows) {
  const bySkill = new Map();
  for (const r of rows) {
    const cur = bySkill.get(r.skill) ?? { skill: r.skill, invocations: 0, lastSeen: null };
    cur.invocations++;
    if (!cur.lastSeen || (r.ts || "") > cur.lastSeen) cur.lastSeen = r.ts || null;
    bySkill.set(r.skill, cur);
  }
  return {
    status: statusFrom({ warn: rows.length === 0 }),
    reasons: rows.length === 0 ? ["no recent skill telemetry"] : [],
    events: rows.length,
    skills: [...bySkill.values()].sort((a, b) => b.invocations - a.invocations || a.skill.localeCompare(b.skill)),
  };
}

function evidenceRiskSummary(evidence) {
  const summary = {
    total: 0,
    mitigated: 0,
    accepted: 0,
    open: 0,
    unstructured: 0,
    openInPass: 0,
    expiredAccepted: 0,
    missingAcceptedExpiry: 0,
    highCriticalAccepted: 0,
    examples: [],
  };

  for (const item of evidence) {
    if (item._invalid || item.knownRisks === undefined) continue;
    if (!Array.isArray(item.knownRisks)) {
      summary.unstructured += 1;
      summary.examples.push(`${item._path || item.taskId || "unknown"}: knownRisks is not an array`);
      continue;
    }
    for (const [idx, risk] of item.knownRisks.entries()) {
      summary.total += 1;
      const label = `${item.taskId || item._path || "unknown"}:${risk?.id || `knownRisks[${idx}]`}`;
      if (!risk || typeof risk !== "object" || Array.isArray(risk)) {
        summary.unstructured += 1;
        summary.examples.push(`${label}: unstructured`);
        continue;
      }
      if (risk.disposition === "mitigated") summary.mitigated += 1;
      else if (risk.disposition === "accepted") summary.accepted += 1;
      else if (risk.disposition === "open") summary.open += 1;

      if (item.status === "pass" && risk.disposition === "open") {
        summary.openInPass += 1;
        summary.examples.push(`${label}: open in pass evidence`);
      }
      const highCritical = risk.severity === "critical" || risk.severity === "high";
      if (risk.disposition === "accepted" && highCritical) {
        summary.highCriticalAccepted += 1;
        if (!risk.acceptedUntil) {
          summary.missingAcceptedExpiry += 1;
          summary.examples.push(`${label}: accepted ${risk.severity} risk missing acceptedUntil`);
        }
      }
      if (risk.disposition === "accepted" && risk.acceptedUntil) {
        const t = Date.parse(risk.acceptedUntil);
        if (Number.isFinite(t) && t < NOW) {
          summary.expiredAccepted += 1;
          summary.examples.push(`${label}: acceptance expired ${risk.acceptedUntil}`);
        }
      }
    }
  }
  summary.examples = summary.examples.slice(0, 8);
  return summary;
}

function isUiEvidenceCheck(check) {
  return UI_CHECK_RE.test(`${check?.name || ""} ${check?.command || ""}`);
}

function safeLocalArtifactPath(value) {
  const raw = String(value || "").trim();
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const resolved = resolve(ROOT, raw);
  const relPath = rel(resolved);
  if (relPath === ".." || relPath.startsWith("../")) return null;
  return resolved;
}

function verifyUiSummaryCore(summary) {
  const checks = Array.isArray(summary?.checks) ? summary.checks : [];
  const passed = new Set(
    checks
      .filter((check) => check && check.passed === true)
      .map((check) => String(check.name || "").trim()),
  );
  return REQUIRED_VERIFY_UI_CHECKS.filter((name) => !passed.has(name));
}

function uiEvidenceSummary(evidence) {
  const summary = {
    total: 0,
    browserUsable: 0,
    customArtifact: 0,
    mock: 0,
    unusable: 0,
    missingArtifact: 0,
    invalidArtifact: 0,
    missingCoreChecks: 0,
    missingScreenshots: 0,
    examples: [],
  };

  function note(kind, label, detail) {
    summary[kind] += 1;
    if (summary.examples.length < 8) summary.examples.push(`${label}: ${detail}`);
  }

  for (const item of evidence) {
    if (item._invalid || !Array.isArray(item.checks)) continue;
    const label = item.taskId || item.featureId || item._path || "(unknown evidence)";
    for (const check of item.checks) {
      if (check?.status !== "pass" || !isUiEvidenceCheck(check)) continue;
      summary.total += 1;
      const command = String(check.command || "");
      const artifact = String(check.artifact || "").trim();
      if (!artifact) {
        note("missingArtifact", label, `${check.name || "ui"} check has no artifact`);
        continue;
      }
      const isVerifyUi = VERIFY_UI_COMMAND_RE.test(command);
      if (MOCK_VERIFY_UI_RE.test(command)) {
        note("mock", label, `${check.name || "ui"} check uses verify-ui --mock`);
        continue;
      }
      if (!isVerifyUi) {
        summary.customArtifact += 1;
        continue;
      }
      const artifactPath = safeLocalArtifactPath(artifact);
      if (!artifactPath || !artifact.endsWith(".json") || !existsSync(artifactPath)) {
        note("invalidArtifact", label, `${check.name || "ui"} verify-ui artifact is not a readable repo-local JSON summary`);
        continue;
      }
      let verifySummary;
      try {
        verifySummary = JSON.parse(readFileSync(artifactPath, "utf8"));
      } catch (err) {
        note("invalidArtifact", label, `${check.name || "ui"} verify-ui summary is invalid JSON: ${err.message}`);
        continue;
      }
      if (verifySummary.evidenceKind === "mock") {
        note("mock", label, `${check.name || "ui"} summary is mock evidence`);
        continue;
      }
      if (verifySummary.passed !== true || verifySummary.evidenceKind !== "browser" || verifySummary.evidenceUsable !== true) {
        note("unusable", label, `${check.name || "ui"} summary is not usable browser evidence`);
        continue;
      }
      const missing = verifyUiSummaryCore(verifySummary);
      if (missing.length > 0) {
        note("missingCoreChecks", label, `${check.name || "ui"} summary missing passing checks: ${missing.join(", ")}`);
        continue;
      }
      if (!Array.isArray(verifySummary.screenshots) || verifySummary.screenshots.length === 0) {
        note("missingScreenshots", label, `${check.name || "ui"} summary has no screenshot paths`);
        continue;
      }
      summary.browserUsable += 1;
    }
  }

  return summary;
}

function evidenceDiffSummary(evidence) {
  const summary = {
    passTotal: 0,
    missingInPass: 0,
    invalidType: 0,
    examples: [],
  };

  for (const item of evidence) {
    if (item._invalid) continue;
    const label = item.taskId || item.featureId || item._path || "(unknown evidence)";
    if (item.diffSummary !== undefined && typeof item.diffSummary !== "string") {
      summary.invalidType += 1;
      if (summary.examples.length < 8) summary.examples.push(`${label}: diffSummary is not a string`);
      continue;
    }
    if (item.status !== "pass") continue;
    summary.passTotal += 1;
    if (!concreteCommand(item.diffSummary)) {
      summary.missingInPass += 1;
      if (summary.examples.length < 8) summary.examples.push(`${label}: pass evidence missing concrete diffSummary`);
    }
  }

  return summary;
}

function normalizedLocalPath(value) {
  const path = safeLocalArtifactPath(value);
  return path ? rel(path) : "";
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function reviewPromotionSummary(reviewDecisions, failureRecords, { severity = "warn" } = {}) {
  const reviewEvidencePaths = new Set();
  for (const record of failureRecords) {
    if (record._invalid || record.source !== "review" || !Array.isArray(record.evidence)) continue;
    for (const item of record.evidence) {
      const path = normalizedLocalPath(item);
      if (path && path.startsWith(".harness/reviews/") && path.endsWith(".json")) {
        reviewEvidencePaths.add(path);
      }
    }
  }

  const actionable = [];
  for (const decision of reviewDecisions) {
    if (decision._invalid || !decision._path) continue;
    const findings = Array.isArray(decision.findings) ? decision.findings : [];
    const isActionableBlock = decision.decision === "block" && findings.some((finding) => finding?.blocking === true);
    const isActionableHuman = decision.decision === "needs-human" && findings.length > 0;
    if (!isActionableBlock && !isActionableHuman) continue;
    actionable.push({
      path: decision._path,
      reviewer: decision.reviewer || "(unknown reviewer)",
      decision: decision.decision,
      taskId: decision.taskId || decision.featureId || "(unknown task)",
    });
  }

  const actionablePaths = new Set(actionable.map((item) => item.path));
  const promoted = actionable.filter((item) => reviewEvidencePaths.has(item.path));
  const unpromoted = actionable.filter((item) => !reviewEvidencePaths.has(item.path));
  const staleRecords = [...reviewEvidencePaths].filter((path) => !actionablePaths.has(path));
  const examples = [
    ...unpromoted.map((item) => `${item.path}: ${item.decision} review has no failure record`),
    ...staleRecords.map((path) => `${path}: review-sourced failure record no longer points at an actionable review`),
  ].slice(0, 8);
  const reasons = [];
  if (unpromoted.length > 0) reasons.push(`${unpromoted.length} actionable review decision artifact(s) missing failure records`);
  if (staleRecords.length > 0) reasons.push(`${staleRecords.length} review-sourced failure record(s) point at non-actionable review artifacts`);

  const hasPromotionDebt = unpromoted.length > 0 || staleRecords.length > 0;
  const effectiveSeverity = severity === "fail" ? "fail" : "warn";
  const repairCommands = [];
  if (unpromoted.length > 0) {
    repairCommands.push("node .harness/scripts/record-review-failures.mjs");
    for (const item of unpromoted.slice(0, 4)) {
      repairCommands.push(`node .harness/scripts/record-review-failures.mjs --review=${shellQuote(item.path)}`);
    }
    repairCommands.push("node .harness/scripts/check-failure-records.mjs");
  }

  return {
    status: statusFrom({
      fail: hasPromotionDebt && effectiveSeverity === "fail",
      warn: hasPromotionDebt,
    }),
    severity: effectiveSeverity,
    actionable: actionable.length,
    promoted: promoted.length,
    unpromoted: unpromoted.length,
    staleRecords: staleRecords.length,
    promotedPaths: promoted.map((item) => item.path).sort(),
    unpromotedPaths: unpromoted.map((item) => item.path).sort(),
    staleRecordEvidence: staleRecords.sort(),
    repairCommands,
    examples,
    reasons,
  };
}

function reviewDecisionSummary(reviewDecisions, failureRecords = [], options = {}) {
  const summary = {
    total: reviewDecisions.length,
    counts: {
      pass: 0,
      block: 0,
      needsHuman: 0,
      invalid: 0,
      unknown: 0,
    },
    passMissingBinding: 0,
    passMissingCheckedFiles: 0,
    passBlockingFindings: 0,
    blockMissingFinding: 0,
    blockMissingBlockingFinding: 0,
    needsHumanMissingFinding: 0,
    concreteIssues: 0,
    unsafePaths: 0,
    promotion: reviewPromotionSummary(reviewDecisions, failureRecords, { severity: options.reviewPromotion }),
    examples: [],
    reasons: [],
  };

  function note(kind, label, detail) {
    summary[kind] += 1;
    if (summary.examples.length < 8) summary.examples.push(`${label}: ${detail}`);
  }

  for (const decision of reviewDecisions) {
    const label = decision._path || decision.reviewer || "(unknown review)";
    if (decision._invalid) {
      summary.counts.invalid += 1;
      if (summary.examples.length < 8) summary.examples.push(`${label}: invalid JSON`);
      continue;
    }

    if (decision.decision === "pass") summary.counts.pass += 1;
    else if (decision.decision === "block") summary.counts.block += 1;
    else if (decision.decision === "needs-human") summary.counts.needsHuman += 1;
    else {
      summary.counts.unknown += 1;
      if (summary.examples.length < 8) summary.examples.push(`${label}: unknown decision "${decision.decision || ""}"`);
      continue;
    }

    const findings = Array.isArray(decision.findings) ? decision.findings : [];
    if (!concreteCommand(decision.summary)) note("concreteIssues", label, "summary is not concrete");

    if (Array.isArray(decision.checkedFiles)) {
      for (const [idx, file] of decision.checkedFiles.entries()) {
        if (typeof file !== "string" || !safeLocalArtifactPath(file)) {
          note("unsafePaths", label, `checkedFiles[${idx}] is not repo-local`);
        }
      }
    }

    for (const [idx, finding] of findings.entries()) {
      if (!concreteCommand(finding?.evidence)) note("concreteIssues", label, `findings[${idx}].evidence is not concrete`);
      if (!concreteCommand(finding?.fix)) note("concreteIssues", label, `findings[${idx}].fix is not concrete`);
      if (finding?.file !== undefined && (typeof finding.file !== "string" || !safeLocalArtifactPath(finding.file))) {
        note("unsafePaths", label, `findings[${idx}].file is not repo-local`);
      }
    }

    if (decision.decision === "pass") {
      if (!decision.taskId || !decision.featureId) note("passMissingBinding", label, "pass missing taskId or featureId");
      if (!Array.isArray(decision.checkedFiles) || decision.checkedFiles.length === 0) {
        note("passMissingCheckedFiles", label, "pass missing checkedFiles");
      }
      if (findings.some((finding) => finding?.blocking === true)) {
        note("passBlockingFindings", label, "pass includes blocking finding");
      }
    }

    if (decision.decision === "block") {
      if (findings.length === 0) note("blockMissingFinding", label, "block missing finding");
      else if (!findings.some((finding) => finding?.blocking === true)) {
        note("blockMissingBlockingFinding", label, "block missing blocking finding");
      }
    }

    if (decision.decision === "needs-human" && findings.length === 0) {
      note("needsHumanMissingFinding", label, "needs-human missing escalation finding");
    }
  }

  const hardIssues =
    summary.counts.invalid +
    summary.counts.unknown +
    summary.passMissingBinding +
    summary.passMissingCheckedFiles +
    summary.passBlockingFindings +
    summary.blockMissingFinding +
    summary.blockMissingBlockingFinding +
    summary.needsHumanMissingFinding +
    summary.concreteIssues +
    summary.unsafePaths;

  if (summary.counts.invalid > 0) summary.reasons.push(`${summary.counts.invalid} invalid review decision artifact(s)`);
  if (summary.counts.unknown > 0) summary.reasons.push(`${summary.counts.unknown} review decision artifact(s) with unknown decision`);
  if (summary.passMissingBinding > 0) summary.reasons.push(`${summary.passMissingBinding} pass review decision(s) missing task/feature binding`);
  if (summary.passMissingCheckedFiles > 0) summary.reasons.push(`${summary.passMissingCheckedFiles} pass review decision(s) missing checkedFiles`);
  if (summary.passBlockingFindings > 0) summary.reasons.push(`${summary.passBlockingFindings} pass review decision(s) include blocking findings`);
  if (summary.blockMissingFinding > 0) summary.reasons.push(`${summary.blockMissingFinding} block review decision(s) missing findings`);
  if (summary.blockMissingBlockingFinding > 0) summary.reasons.push(`${summary.blockMissingBlockingFinding} block review decision(s) missing blocking findings`);
  if (summary.needsHumanMissingFinding > 0) summary.reasons.push(`${summary.needsHumanMissingFinding} needs-human review decision(s) missing escalation findings`);
  if (summary.concreteIssues > 0) summary.reasons.push(`${summary.concreteIssues} review decision summary/finding placeholder issue(s)`);
  if (summary.unsafePaths > 0) summary.reasons.push(`${summary.unsafePaths} review decision path issue(s)`);
  if (summary.counts.block > 0) summary.reasons.push(`${summary.counts.block} blocking review decision(s) need resolution`);
  if (summary.counts.needsHuman > 0) summary.reasons.push(`${summary.counts.needsHuman} review decision(s) need human resolution`);
  summary.reasons.push(...summary.promotion.reasons);

  return {
    status: statusFrom({
      fail: hardIssues > 0 || summary.promotion.status === "fail",
      warn: summary.counts.block > 0 || summary.counts.needsHuman > 0 || summary.promotion.status === "warn",
    }),
    ...summary,
  };
}

function taskEvidenceSummary({ contracts, evidence, featureList }) {
  const features = Array.isArray(featureList?.features) ? featureList.features : [];
  const evidenceByTask = new Map();
  const evidenceByFeature = new Map();
  for (const item of evidence) {
    if (item._invalid) continue;
    if (item.taskId) evidenceByTask.set(item.taskId, item);
    if (item.featureId) evidenceByFeature.set(item.featureId, item);
  }

  const evidenceStatuses = { pass: 0, partial: 0, blocked: 0, fail: 0, invalid: 0 };
  for (const item of evidence) {
    if (item._invalid) evidenceStatuses.invalid += 1;
    else if (evidenceStatuses[item.status] !== undefined) evidenceStatuses[item.status] += 1;
  }

  const doneFeatures = features.filter((feature) => feature.passes === true);
  const missingDoneEvidence = [];
  for (const feature of doneFeatures) {
    const evidenceForFeature = evidenceByFeature.get(feature.id) || evidenceByTask.get(feature.id);
    if (!evidenceForFeature || evidenceForFeature.status !== "pass") {
      missingDoneEvidence.push(feature.id || "(missing id)");
    }
  }

  const highRisk = contracts.filter((contract) => contract.riskTier === "high-risk").length;
  const reviewGated = contracts.filter((contract) => (contract.requiredReviewers || []).length > 0).length;
  const risks = evidenceRiskSummary(evidence);
  const ui = uiEvidenceSummary(evidence);
  const diffs = evidenceDiffSummary(evidence);
  const reasons = [];
  if (evidenceStatuses.invalid > 0) reasons.push(`${evidenceStatuses.invalid} invalid evidence bundle(s)`);
  if (evidenceStatuses.fail > 0) reasons.push(`${evidenceStatuses.fail} failed evidence bundle(s)`);
  if (missingDoneEvidence.length > 0) reasons.push(`done features missing pass evidence: ${missingDoneEvidence.join(", ")}`);
  if (evidenceStatuses.partial > 0 || evidenceStatuses.blocked > 0) {
    reasons.push(`${evidenceStatuses.partial + evidenceStatuses.blocked} incomplete evidence bundle(s)`);
  }
  if (diffs.missingInPass > 0) reasons.push(`${diffs.missingInPass} pass evidence bundle(s) missing concrete diffSummary`);
  if (diffs.invalidType > 0) reasons.push(`${diffs.invalidType} evidence bundle(s) have invalid diffSummary`);
  if (risks.unstructured > 0) reasons.push(`${risks.unstructured} unstructured known risk entry(s)`);
  if (risks.openInPass > 0) reasons.push(`${risks.openInPass} open risk(s) in pass evidence`);
  if (risks.expiredAccepted > 0) reasons.push(`${risks.expiredAccepted} accepted risk(s) past expiry`);
  if (risks.missingAcceptedExpiry > 0) reasons.push(`${risks.missingAcceptedExpiry} accepted critical/high risk(s) missing expiry`);
  if (risks.open > 0 && risks.openInPass === 0) reasons.push(`${risks.open} open risk(s) in incomplete evidence`);
  if (risks.accepted > 0) reasons.push(`${risks.accepted} accepted risk(s) need follow-up tracking`);
  const weakUiEvidence = ui.mock + ui.unusable + ui.missingArtifact + ui.invalidArtifact + ui.missingCoreChecks + ui.missingScreenshots;
  if (weakUiEvidence > 0) reasons.push(`${weakUiEvidence} weak passing UI evidence check(s)`);

  return {
    status: statusFrom({
      fail:
        evidenceStatuses.invalid > 0 ||
        evidenceStatuses.fail > 0 ||
        missingDoneEvidence.length > 0 ||
        diffs.missingInPass > 0 ||
        diffs.invalidType > 0 ||
        risks.unstructured > 0 ||
        risks.openInPass > 0 ||
        risks.expiredAccepted > 0 ||
        risks.missingAcceptedExpiry > 0 ||
        weakUiEvidence > 0,
      warn: evidenceStatuses.partial > 0 || evidenceStatuses.blocked > 0 || risks.open > 0 || risks.accepted > 0,
    }),
    reasons,
    contracts: {
      total: contracts.length,
      highRisk,
      reviewGated,
    },
    evidence: {
      total: evidence.length,
      statuses: evidenceStatuses,
    },
    features: {
      total: features.length,
      done: doneFeatures.length,
      missingDoneEvidence,
    },
    risks,
    ui,
    diffs,
  };
}

function failureLearningSummary(records) {
  const statusCounts = { proposed: 0, applied: 0, verified: 0, rejected: 0, invalid: 0 };
  const classCounts = {};
  const targetCounts = {};
  for (const record of records) {
    if (record._invalid) {
      statusCounts.invalid += 1;
      continue;
    }
    statusCounts[record.promotionStatus] = (statusCounts[record.promotionStatus] || 0) + 1;
    classCounts[record.primaryClass] = (classCounts[record.primaryClass] || 0) + 1;
    targetCounts[record.preventionTarget] = (targetCounts[record.preventionTarget] || 0) + 1;
  }
  const needsPromotion = records
    .filter((record) => !record._invalid && record.promotionStatus !== "verified" && record.promotionStatus !== "rejected")
    .sort((a, b) => (b.observedAt || "").localeCompare(a.observedAt || ""))
    .map((record) => ({
      id: record.id,
      primaryClass: record.primaryClass,
      promotionStatus: record.promotionStatus,
      preventionTarget: record.preventionTarget,
      observedAt: record.observedAt,
    }));
  const appliedAwaitingVerification = records
    .filter((record) => !record._invalid && record.promotionStatus === "applied")
    .sort((a, b) => (b.observedAt || "").localeCompare(a.observedAt || ""))
    .map((record) => ({
      id: record.id,
      primaryClass: record.primaryClass,
      preventionTarget: record.preventionTarget,
      preventionPath: record.proposedPrevention?.path || null,
      observedAt: record.observedAt,
    }));
  const staleProposed = records
    .filter((record) => !record._invalid && record.promotionStatus === "proposed")
    .map((record) => ({
      id: record.id,
      primaryClass: record.primaryClass,
      preventionTarget: record.preventionTarget,
      observedAt: record.observedAt,
      ageDays: ageDaysSince(record.observedAt),
    }))
    .filter((record) => record.ageDays !== null && record.ageDays > FAILURE_RECORD_STALE_DAYS)
    .sort((a, b) => b.ageDays - a.ageDays || a.id.localeCompare(b.id));
  const appliedMissingVerificationPlan = records
    .filter((record) =>
      !record._invalid &&
      record.promotionStatus === "applied" &&
      !concreteCommand(record.proposedPrevention?.verificationCommand),
    )
    .sort((a, b) => (b.observedAt || "").localeCompare(a.observedAt || ""))
    .map((record) => ({
      id: record.id,
      primaryClass: record.primaryClass,
      preventionTarget: record.preventionTarget,
      preventionPath: record.proposedPrevention?.path || null,
      observedAt: record.observedAt,
    }));
  const reasons = [];
  if (statusCounts.invalid > 0) reasons.push(`${statusCounts.invalid} invalid failure record(s)`);
  if (needsPromotion.length > 0) reasons.push(`${needsPromotion.length} failure record(s) still need promotion`);
  if (staleProposed.length > 0) reasons.push(`${staleProposed.length} proposed failure record(s) older than ${FAILURE_RECORD_STALE_DAYS} days`);
  if (appliedAwaitingVerification.length > 0) {
    reasons.push(`${appliedAwaitingVerification.length} applied prevention(s) need verification`);
  }
  if (appliedMissingVerificationPlan.length > 0) {
    reasons.push(`${appliedMissingVerificationPlan.length} applied prevention(s) missing verification command`);
  }
  return {
    status: statusFrom({
      fail: statusCounts.invalid > 0,
      warn: needsPromotion.length > 0 || staleProposed.length > 0 || appliedMissingVerificationPlan.length > 0,
    }),
    reasons,
    records: records.length,
    statusCounts,
    classCounts,
    targetCounts,
    needsPromotion,
    staleProposed,
    appliedAwaitingVerification,
    appliedMissingVerificationPlan,
  };
}

function permissionCompilerSummary(compiler) {
  if (!compiler || compiler.available === false) {
    return {
      available: false,
      status: "warn",
      reasons: compiler?.errors || ["permission compiler unavailable"],
      runtime: "",
      command: "",
      skills: 0,
      tasks: 0,
      highRiskTasks: [],
      taskContractsDir: "",
      errors: compiler?.errors || [],
    };
  }
  const compiled = compiler.compiled && typeof compiler.compiled === "object" ? compiler.compiled : {};
  const policySkills = compiled.policy?.skills && typeof compiled.policy.skills === "object"
    ? compiled.policy.skills
    : {};
  const tasks = compiled.tasks && typeof compiled.tasks === "object" ? Object.values(compiled.tasks) : [];
  const highRiskTasks = tasks
    .filter((task) => task?.riskTier === "high-risk")
    .map((task) => task.id || "(missing id)")
    .sort();
  const errors = Array.isArray(compiler.errors) ? compiler.errors : [];
  const failed = compiler.status === "failed" || (compiler.exitCode ?? 0) !== 0;
  return {
    available: true,
    status: statusFrom({ fail: failed }),
    reasons: failed ? errors : [],
    runtime: compiler.runtime || compiled.runtime || "",
    command: compiler.command || "",
    skills: Object.keys(policySkills).length,
    tasks: tasks.length,
    highRiskTasks,
    taskContractsDir: compiled.source?.taskContractsDir || "",
    errors,
  };
}

function skillPermissionSummary({ registry, permissions, compiler }) {
  if (!registry || registry._invalid) {
    return {
      status: "warn",
      reasons: ["skill registry not found or invalid"],
      compiler: permissionCompilerSummary(compiler),
      registrySkills: 0,
      policyEntries: 0,
      mutationCapable: [],
      mutationDenied: [],
      missingPolicy: [],
      extraPolicy: [],
      drift: [],
      overbroadSensitiveGrants: [],
    };
  }

  const skills = Array.isArray(registry.skills) ? registry.skills : [];
  const policy = permissions && !permissions._invalid && permissions.skills && typeof permissions.skills === "object"
    ? permissions.skills
    : {};
  const policyEntries = Object.keys(policy);
  const missingPolicy = [];
  const drift = [];
  const overbroad = [];
  const mutationCapable = [];
  const mutationDenied = [];

  for (const skill of skills) {
    const id = skill.id || "(missing id)";
    const skillPermissions = skill.permissions || {};
    const skillPolicy = policy[id];
    if (!skillPolicy) {
      missingPolicy.push(id);
    } else {
      if (!sameSet(skillPolicy.allow || [], skillPermissions.allow || [])) drift.push(`${id}.allow`);
      if (!sameSet(skillPolicy.deny || [], skillPermissions.deny || [])) drift.push(`${id}.deny`);
    }
    for (const permission of skillPermissions.allow || []) {
      if (overbroadSensitiveBashPermission(permission)) overbroad.push(`${id}:${permission}`);
    }
    const allow = new Set(skillPermissions.allow || []);
    const deny = new Set(skillPermissions.deny || []);
    if (allow.has("Edit") || allow.has("Write") || allow.has("MultiEdit")) mutationCapable.push(id);
    if (deny.has("Edit") || deny.has("Write") || deny.has("MultiEdit")) mutationDenied.push(id);
  }

  const extraPolicy = policyEntries.filter((id) => !skills.some((skill) => skill.id === id)).sort();
  const compilerSummary = permissionCompilerSummary(compiler);
  const reasons = [];
  if (missingPolicy.length > 0) reasons.push(`missing policy: ${missingPolicy.join(", ")}`);
  if (extraPolicy.length > 0) reasons.push(`extra policy: ${extraPolicy.join(", ")}`);
  if (drift.length > 0) reasons.push(`policy drift: ${drift.join(", ")}`);
  if (overbroad.length > 0) reasons.push(`overbroad sensitive grants: ${overbroad.join(", ")}`);
  if (compilerSummary.status === "fail") {
    for (const error of compilerSummary.errors.slice(0, 8)) reasons.push(`compiler: ${error}`);
  } else if (compilerSummary.status === "warn") {
    for (const reason of compilerSummary.reasons.slice(0, 3)) reasons.push(`compiler: ${reason}`);
  }
  return {
    status: statusFrom({
      fail: reasons.some((reason) => !reason.startsWith("compiler: permission compiler unavailable")),
      warn: compilerSummary.status === "warn",
    }),
    reasons,
    compiler: compilerSummary,
    registrySkills: skills.length,
    policyEntries: policyEntries.length,
    mutationCapable,
    mutationDenied,
    missingPolicy,
    extraPolicy,
    drift,
    overbroadSensitiveGrants: overbroad,
  };
}

function modelRoutingSummary(providerCalls, config) {
  if (!config?.modelRouting) {
    return {
      status: "warn",
      reasons: ["model routing config not found"],
      configured: false,
      providerCalls: providerCalls.length,
      lanes: [],
      observedModels: {},
    };
  }
  const modelCounts = {};
  for (const call of providerCalls) {
    const model = call.model || "(missing)";
    modelCounts[model] = (modelCounts[model] || 0) + 1;
  }
  return {
    status: statusFrom({ warn: providerCalls.length === 0 }),
    reasons: providerCalls.length === 0 ? ["no provider calls found in telemetry"] : [],
    configured: true,
    providerCalls: providerCalls.length,
    lanes: (config.modelRouting.lanes || []).map((lane) => ({
      id: lane.id,
      expectedModel: lane.expectedModel,
    })),
    observedModels: modelCounts,
  };
}

function permissionToolName(entry) {
  if (typeof entry === "string") return entry.split("(")[0];
  if (entry && typeof entry === "object" && typeof entry.tool === "string") return entry.tool.split("(")[0];
  return "";
}

function contractGrantsMutation(contract) {
  const allow = contract?.permissions?.allow;
  if (!Array.isArray(allow)) return false;
  return allow.some((entry) => ["Edit", "Write", "MultiEdit", "apply_patch"].includes(permissionToolName(entry)));
}

function taskIsolationReasons(contract, config) {
  const cfg = config?.sessionIsolation || {};
  const riskTiers = cfg.requireForRiskTiers || ["high-risk"];
  const reasons = [];
  if (contract?.sessionIsolation?.required === true || contract?.isolation?.required === true) {
    reasons.push("contract-required");
  }
  if (riskTiers.includes(contract?.riskTier)) reasons.push(`risk:${contract.riskTier}`);
  if (cfg.requireForMutationTargets !== false && contractGrantsMutation(contract)) {
    reasons.push("mutating-permissions");
  }
  return reasons;
}

function sessionIsolationSummary({ contracts, sessions, config }) {
  const cfg = config?.sessionIsolation || {};
  if (cfg.enabled === false) {
    return {
      status: "pass",
      reasons: [],
      enabled: false,
      manifests: sessions.length,
      requiredTasks: [],
      missingSessionTasks: [],
      staleSessions: [],
      invalidSessions: sessions.filter((session) => session._invalid).map((session) => session._path),
    };
  }

  const validContracts = contracts.filter((contract) => !contract._invalid);
  const requiredTasks = validContracts
    .map((contract) => ({
      id: contract.id,
      riskTier: contract.riskTier || null,
      reasons: taskIsolationReasons(contract, config),
    }))
    .filter((item) => item.id && item.reasons.length > 0);
  const sessionsByTask = new Map();
  const staleSessions = [];
  const invalidSessions = sessions.filter((session) => session._invalid).map((session) => session._path);
  for (const session of sessions) {
    if (session._invalid) continue;
    if (session.taskId) {
      const list = sessionsByTask.get(session.taskId) || [];
      list.push(session);
      sessionsByTask.set(session.taskId, list);
    }
    if (session.worktreePath && !existsSync(session.worktreePath)) {
      staleSessions.push({
        sessionId: session.sessionId || session._path,
        taskId: session.taskId || null,
        worktreePath: session.worktreePath,
      });
    }
  }
  const missingSessionTasks = requiredTasks
    .filter((task) => !sessionsByTask.has(task.id))
    .map((task) => task.id);
  const reasons = [];
  if (invalidSessions.length > 0) reasons.push(`${invalidSessions.length} invalid session manifest(s)`);
  if (staleSessions.length > 0) reasons.push(`${staleSessions.length} stale session manifest(s)`);
  if (missingSessionTasks.length > 0) reasons.push(`${missingSessionTasks.length} isolation-required task(s) lack session manifest`);

  return {
    status: statusFrom({ fail: invalidSessions.length > 0, warn: staleSessions.length > 0 || missingSessionTasks.length > 0 }),
    reasons,
    enabled: true,
    activeTaskEnv: cfg.activeTaskEnv || "AHK_ACTIVE_TASK",
    manifests: sessions.length,
    requiredTasks,
    missingSessionTasks,
    staleSessions,
    invalidSessions,
    branchPrefixes: cfg.branchPrefixes || ["agent/", "codex/"],
    requireLinkedWorktree: cfg.requireLinkedWorktree !== false,
  };
}

function orchestrationHealthSummary({ contracts, runs }) {
  const invalidContracts = contracts.filter((contract) => contract._invalid).map((contract) => contract._path);
  const invalidRuns = runs.filter((run) => run._invalid).map((run) => run._path);
  const validContracts = contracts.filter((contract) => !contract._invalid);
  const reviewGatedContracts = validContracts.filter((contract) => (contract.requiredReviewers || []).length > 0);
  const mutatingContracts = validContracts.filter((contract) =>
    (contract.lanes || []).some((lane) => lane?.toolPolicy === "mutating"),
  );
  const runStatusCounts = { passed: 0, failed: 0, cancelled: 0, unknown: 0 };
  const uncontractedTaskRuns = [];
  const taskBoundRuns = [];
  for (const run of runs) {
    const summary = run.summary && !run.summary._invalid ? run.summary : null;
    const manifest = run.manifest && !run.manifest._invalid ? run.manifest : null;
    const status = summary?.status;
    if (status === "passed" || status === "failed" || status === "cancelled") runStatusCounts[status] += 1;
    else runStatusCounts.unknown += 1;
    const taskId = summary?.taskId || manifest?.taskId || null;
    const contractId = summary?.contractId || manifest?.contractId || null;
    if (taskId) taskBoundRuns.push({ runId: run.runId, taskId, contractId, status: status || "unknown" });
    if (taskId && !contractId) uncontractedTaskRuns.push(run.runId);
  }
  const reasons = [];
  if (invalidContracts.length > 0) reasons.push(`${invalidContracts.length} invalid orchestration contract(s)`);
  if (invalidRuns.length > 0) reasons.push(`${invalidRuns.length} invalid orchestration run(s)`);
  if (runStatusCounts.failed > 0) reasons.push(`${runStatusCounts.failed} failed orchestration run(s)`);
  if (runStatusCounts.cancelled > 0) reasons.push(`${runStatusCounts.cancelled} cancelled orchestration run(s)`);
  if (uncontractedTaskRuns.length > 0) reasons.push(`${uncontractedTaskRuns.length} task-bound run(s) lack orchestration contract`);

  return {
    status: statusFrom({
      fail: invalidContracts.length > 0 || invalidRuns.length > 0,
      warn: runStatusCounts.failed > 0 || runStatusCounts.cancelled > 0 || uncontractedTaskRuns.length > 0,
    }),
    reasons,
    contracts: {
      total: contracts.length,
      invalid: invalidContracts.length,
      reviewGated: reviewGatedContracts.length,
      mutating: mutatingContracts.length,
    },
    runs: {
      total: runs.length,
      statuses: runStatusCounts,
      taskBound: taskBoundRuns.length,
      uncontractedTaskRuns,
    },
    invalidContracts,
    invalidRuns,
    taskBoundRuns,
  };
}

function bypassAuditSummary(payload) {
  const reasons = [];
  if (payload.errors.length > 0) reasons.push(`${payload.errors.length} bypass audit error(s)`);
  if (payload.unacknowledged.length > 0) {
    reasons.push(`${payload.unacknowledged.length} bypass record(s) require review in ${payload.ackPath}`);
  }
  return {
    status: payload.status === "passed" ? "pass" : "fail",
    reasons,
    logPath: payload.logPath,
    ackPath: payload.ackPath,
    total: payload.total,
    acknowledged: payload.acknowledged,
    unacknowledged: payload.unacknowledged,
    errors: payload.errors,
  };
}

function harnessNoiseSummary(payload) {
  return {
    status: payload.status,
    reasons: payload.reasons,
    totals: payload.totals,
    noisyRules: payload.noisyRules,
    repeatedBlocks: payload.repeatedBlocks,
    falsePositivesByRule: payload.falsePositivesByRule,
    acknowledgements: payload.acknowledgements,
  };
}

function structuralBaselineSummary(payload) {
  return {
    status: payload.status,
    reasons: payload.reasons,
    baselinePath: payload.baselinePath,
    exists: payload.exists,
    count: payload.count,
    maxEntries: payload.maxEntries,
    comparison: payload.comparison,
    duplicateEntries: payload.duplicateEntries,
    errors: payload.errors,
    warnings: payload.warnings,
  };
}

function hookIntegritySummary(payload) {
  return {
    status: payload.status,
    reasons: payload.reasons,
    surfaces: payload.surfaces.map((surface) => ({
      runtime: surface.runtime,
      enabled: surface.enabled,
      status: surface.status,
      hooksPath: surface.hooksPath,
      registeredEvents: surface.registeredEvents,
      errors: surface.errors,
      warnings: surface.warnings,
    })),
    errors: payload.errors,
    warnings: payload.warnings,
  };
}

function driftSummary(evalRows, telemetryRows, knownSkills) {
  const seen = new Set(telemetryRows.map((r) => r.skill));
  const unseenSkills = knownSkills.filter((s) => !seen.has(s));
  const latest = new Map();
  for (const r of evalRows.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""))) {
    latest.set(r.taskId, r);
  }
  const regressingTasks = [...latest.values()]
    .filter((r) => !r.passed)
    .map((r) => r.taskId)
    .sort();
  const reasons = [];
  if (unseenSkills.length > 0) reasons.push(`skills not invoked: ${unseenSkills.join(", ")}`);
  if (regressingTasks.length > 0) reasons.push(`latest failing tasks: ${regressingTasks.join(", ")}`);
  return {
    status: statusFrom({ fail: regressingTasks.length > 0, warn: unseenSkills.length > 0 }),
    reasons,
    unseenSkills,
    regressingTasks,
  };
}

function weekOverWeekSummary(evalRecent, evalPrior, telRecent, telPrior) {
  const aRecent = aggregateEvals(evalRecent);
  const aPrior = aggregateEvals(evalPrior);
  const taskIds = new Set([...aRecent.keys(), ...aPrior.keys()]);
  const tasks = [...taskIds].sort().map((taskId) => {
    const now = aRecent.get(taskId);
    const prior = aPrior.get(taskId);
    const nowRate = now ? Math.round((now.passed / now.total) * 100) : null;
    const priorRate = prior ? Math.round((prior.passed / prior.total) * 100) : null;
    const nowAvgTokens = now && now.total > 0 ? Math.round(now.tokens / now.total) : 0;
    const priorAvgTokens = prior && prior.total > 0 ? Math.round(prior.tokens / prior.total) : 0;
    return {
      taskId,
      passRateNow: nowRate,
      passRatePrior: priorRate,
      passRateDelta: nowRate !== null && priorRate !== null ? nowRate - priorRate : null,
      avgTokensNow: nowAvgTokens,
      avgTokensPrior: priorAvgTokens,
      avgTokensDelta: now && prior ? nowAvgTokens - priorAvgTokens : null,
    };
  });

  const recentBySkill = new Map();
  for (const r of telRecent) recentBySkill.set(r.skill, (recentBySkill.get(r.skill) ?? 0) + 1);
  const priorBySkill = new Map();
  for (const r of telPrior) priorBySkill.set(r.skill, (priorBySkill.get(r.skill) ?? 0) + 1);
  const allSkills = new Set([...recentBySkill.keys(), ...priorBySkill.keys()]);
  const skills = [...allSkills].sort().map((skill) => {
    const now = recentBySkill.get(skill) ?? 0;
    const prior = priorBySkill.get(skill) ?? 0;
    return { skill, invocationsNow: now, invocationsPrior: prior, invocationsDelta: now - prior };
  });

  return {
    status: statusFrom({ warn: tasks.some((task) => task.passRateDelta !== null && task.passRateDelta < 0) }),
    reasons: tasks
      .filter((task) => task.passRateDelta !== null && task.passRateDelta < 0)
      .map((task) => `${task.taskId} pass rate dropped ${Math.abs(task.passRateDelta)} points`),
    tasks,
    skills,
  };
}

function summarizeEvals(rows) {
  const byTask = new Map();
  for (const r of rows) {
    const arr = byTask.get(r.taskId) ?? [];
    arr.push(r);
    byTask.set(r.taskId, arr);
  }
  console.log(`\n### Eval results (last 7 days, ${rows.length} runs)`);
  if (rows.length === 0) {
    console.log("  (no recent runs — try `npm run harness:eval -- --quick --transport=mock`)");
    return;
  }
  console.log(
    "  task                    pass-rate    runs   avg-tokens",
  );
  console.log(
    "  ----------------------  ----------   -----  ----------",
  );
  for (const [taskId, taskRows] of [...byTask.entries()].sort()) {
    const passed = taskRows.filter((r) => r.passed).length;
    const tokens = taskRows.reduce((s, r) => s + tokensOf(r), 0);
    const avgTokens = taskRows.length > 0 ? Math.round(tokens / taskRows.length) : 0;
    const pct = fmtPct(passed, taskRows.length);
    console.log(
      `  ${taskId.padEnd(22)}  ${pct.padStart(8)}     ${String(taskRows.length).padStart(3)}    ${String(avgTokens).padStart(8)}`,
    );
  }
}

function summarizeTelemetry(rows) {
  console.log(`\n### Skill invocations (last 7 days, ${rows.length} events)`);
  if (rows.length === 0) {
    console.log(
      "  (no skill invocations recorded — telemetry hook may not be installed)",
    );
    console.log(
      "  Verify `.claude/hooks/hooks.json` includes the Skill matcher.",
    );
    return;
  }
  const bySkill = new Map();
  for (const r of rows) {
    const arr = bySkill.get(r.skill) ?? [];
    arr.push(r);
    bySkill.set(r.skill, arr);
  }
  console.log("  skill                          invocations   last-seen");
  console.log("  -----------------------------  -----------   --------------------");
  for (const [skill, events] of [...bySkill.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    const last = events
      .map((e) => e.ts)
      .sort()
      .at(-1);
    console.log(
      `  ${skill.padEnd(29)}  ${String(events.length).padStart(8)}      ${last ?? "?"}`,
    );
  }
}

function summarizeTaskEvidence({ contracts, evidence, featureList }) {
  console.log(`\n### Task/evidence health`);
  const features = Array.isArray(featureList?.features) ? featureList.features : [];
  if (contracts.length === 0 && evidence.length === 0 && features.length === 0) {
    console.log("  (no task contracts, evidence bundles, or feature list found yet)");
    return;
  }

  const evidenceByTask = new Map();
  const evidenceByFeature = new Map();
  for (const item of evidence) {
    if (item._invalid) continue;
    if (item.taskId) evidenceByTask.set(item.taskId, item);
    if (item.featureId) evidenceByFeature.set(item.featureId, item);
  }

  const statusCounts = { pass: 0, partial: 0, blocked: 0, fail: 0, invalid: 0 };
  for (const item of evidence) {
    if (item._invalid) statusCounts.invalid += 1;
    else if (statusCounts[item.status] !== undefined) statusCounts[item.status] += 1;
  }
  const doneFeatures = features.filter((feature) => feature.passes === true);
  const missingDoneEvidence = [];
  for (const feature of doneFeatures) {
    const evidenceForFeature = evidenceByFeature.get(feature.id) || evidenceByTask.get(feature.id);
    if (!evidenceForFeature || evidenceForFeature.status !== "pass") {
      missingDoneEvidence.push(feature.id || "(missing id)");
    }
  }
  const highRisk = contracts.filter((contract) => contract.riskTier === "high-risk").length;
  const reviewGated = contracts.filter((contract) => (contract.requiredReviewers || []).length > 0).length;

  console.log(`  contracts: ${contracts.length} (${highRisk} high-risk, ${reviewGated} review-gated)`);
  console.log(
    `  evidence bundles: ${evidence.length} ` +
      `(pass ${statusCounts.pass}, partial ${statusCounts.partial}, blocked ${statusCounts.blocked}, fail ${statusCounts.fail}, invalid ${statusCounts.invalid})`,
  );
  const risks = evidenceRiskSummary(evidence);
  if (risks.total > 0 || risks.unstructured > 0) {
    console.log(
      `  known risks: ${risks.total} ` +
        `(open ${risks.open}, accepted ${risks.accepted}, mitigated ${risks.mitigated}, ` +
        `expired ${risks.expiredAccepted}, unstructured ${risks.unstructured})`,
    );
    if (risks.examples.length > 0) {
      console.log(`  known risk attention: ${risks.examples.slice(0, 4).join("; ")}`);
    }
  } else {
    console.log("  known risks: none");
  }
  const diffs = evidenceDiffSummary(evidence);
  if (diffs.passTotal > 0 || diffs.invalidType > 0) {
    console.log(
      `  diff summaries: ${diffs.passTotal} pass bundle(s) ` +
        `(missing ${diffs.missingInPass}, invalid ${diffs.invalidType})`,
    );
    if (diffs.examples.length > 0) console.log(`  diff summary attention: ${diffs.examples.slice(0, 4).join("; ")}`);
  } else {
    console.log("  diff summaries: none");
  }
  const ui = uiEvidenceSummary(evidence);
  if (ui.total > 0) {
    console.log(
      `  ui evidence: ${ui.total} checks ` +
        `(browser usable ${ui.browserUsable}, custom ${ui.customArtifact}, mock ${ui.mock}, ` +
        `unusable ${ui.unusable}, missing artifact ${ui.missingArtifact}, invalid artifact ${ui.invalidArtifact}, ` +
        `missing core ${ui.missingCoreChecks}, missing screenshots ${ui.missingScreenshots})`,
    );
    if (ui.examples.length > 0) console.log(`  ui evidence attention: ${ui.examples.slice(0, 4).join("; ")}`);
  } else {
    console.log("  ui evidence: none");
  }
  if (features.length > 0) {
    console.log(`  features marked done: ${doneFeatures.length}/${features.length}`);
  }
  if (missingDoneEvidence.length > 0) {
    console.log(`  missing pass evidence for done features: ${missingDoneEvidence.slice(0, 8).join(", ")}`);
    if (missingDoneEvidence.length > 8) console.log(`  ...and ${missingDoneEvidence.length - 8} more`);
  } else {
    console.log("  missing pass evidence for done features: none");
  }
}

function summarizeReviewDecisions(reviewDecisions, failureRecords = [], options = {}) {
  console.log(`\n### Review decision health`);
  if (reviewDecisions.length === 0) {
    console.log("  (no review decision artifacts found yet)");
    return;
  }
  const summary = reviewDecisionSummary(reviewDecisions, failureRecords, options);
  console.log(
    `  review decisions: ${summary.total} ` +
      `(pass ${summary.counts.pass}, block ${summary.counts.block}, ` +
      `needs-human ${summary.counts.needsHuman}, invalid ${summary.counts.invalid}, unknown ${summary.counts.unknown})`,
  );
  console.log(
    `  pass proof issues: binding ${summary.passMissingBinding}, checkedFiles ${summary.passMissingCheckedFiles}, ` +
      `blocking findings ${summary.passBlockingFindings}`,
  );
  console.log(
    `  non-pass proof issues: block missing finding ${summary.blockMissingFinding}, ` +
      `block missing blocking ${summary.blockMissingBlockingFinding}, ` +
      `needs-human missing finding ${summary.needsHumanMissingFinding}`,
  );
  console.log(`  artifact quality issues: placeholders ${summary.concreteIssues}, unsafe paths ${summary.unsafePaths}`);
  console.log(
    `  review failure promotion: ${summary.promotion.actionable} actionable ` +
      `(promoted ${summary.promotion.promoted}, unpromoted ${summary.promotion.unpromoted}, stale ${summary.promotion.staleRecords})`,
  );
  console.log(`  review promotion policy: ${summary.promotion.severity}`);
  if (summary.examples.length > 0) console.log(`  review decision attention: ${summary.examples.slice(0, 4).join("; ")}`);
  if (summary.promotion.examples.length > 0) {
    console.log(`  review promotion attention: ${summary.promotion.examples.slice(0, 4).join("; ")}`);
  }
  if (summary.promotion.repairCommands.length > 0) {
    console.log(`  review promotion repair: ${summary.promotion.repairCommands.slice(0, 3).join(" && ")}`);
  }
}

function summarizeFailureLearning(records) {
  console.log(`\n### Failure learning`);
  if (records.length === 0) {
    console.log("  (no failure records yet — use `node .harness/scripts/record-failure.mjs ...` after the next durable miss)");
    return;
  }
  const statusCounts = new Map();
  const classCounts = new Map();
  const invalid = records.filter((record) => record._invalid).length;
  for (const record of records) {
    if (record._invalid) continue;
    statusCounts.set(record.promotionStatus, (statusCounts.get(record.promotionStatus) || 0) + 1);
    classCounts.set(record.primaryClass, (classCounts.get(record.primaryClass) || 0) + 1);
  }
  const statusLine = ["proposed", "applied", "verified", "rejected"]
    .map((status) => `${status} ${statusCounts.get(status) || 0}`)
    .join(", ");
  const classLine = [...classCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cls, count]) => `${cls}=${count}`)
    .join(", ") || "none";
  const targetCounts = new Map();
  for (const record of records) {
    if (record._invalid) continue;
    targetCounts.set(record.preventionTarget, (targetCounts.get(record.preventionTarget) || 0) + 1);
  }
  const targetLine = [...targetCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([target, count]) => `${target}=${count}`)
    .join(", ") || "none";

  console.log(`  records: ${records.length} (${statusLine}, invalid ${invalid})`);
  console.log(`  by class: ${classLine}`);
  console.log(`  by prevention target: ${targetLine}`);

  const unresolved = records
    .filter((record) => !record._invalid && record.promotionStatus !== "verified" && record.promotionStatus !== "rejected")
    .sort((a, b) => (b.observedAt || "").localeCompare(a.observedAt || ""))
    .slice(0, 5);
  if (unresolved.length > 0) {
    console.log("  needs promotion:");
    for (const record of unresolved) {
      console.log(`    - ${record.id} (${record.primaryClass}, ${record.promotionStatus}) -> ${record.preventionTarget}`);
    }
  } else {
    console.log("  needs promotion: none");
  }

  const staleProposed = records
    .filter((record) => !record._invalid && record.promotionStatus === "proposed")
    .map((record) => ({ ...record, ageDays: ageDaysSince(record.observedAt) }))
    .filter((record) => record.ageDays !== null && record.ageDays > FAILURE_RECORD_STALE_DAYS)
    .sort((a, b) => b.ageDays - a.ageDays || a.id.localeCompare(b.id))
    .slice(0, 5);
  if (staleProposed.length > 0) {
    console.log(`  stale proposed (>${FAILURE_RECORD_STALE_DAYS}d):`);
    for (const record of staleProposed) {
      console.log(`    - ${record.id} (${record.primaryClass}, ${record.ageDays}d) -> ${record.preventionTarget}`);
    }
  } else {
    console.log(`  stale proposed (>${FAILURE_RECORD_STALE_DAYS}d): none`);
  }

  const appliedAwaitingVerification = records
    .filter((record) => !record._invalid && record.promotionStatus === "applied")
    .sort((a, b) => (b.observedAt || "").localeCompare(a.observedAt || ""))
    .slice(0, 5);
  if (appliedAwaitingVerification.length > 0) {
    console.log("  applied awaiting verification:");
    for (const record of appliedAwaitingVerification) {
      const path = record.proposedPrevention?.path ? ` -> ${record.proposedPrevention.path}` : "";
      console.log(`    - ${record.id} (${record.primaryClass})${path}`);
    }
  } else {
    console.log("  applied awaiting verification: none");
  }

  const appliedMissingVerificationPlan = records
    .filter((record) =>
      !record._invalid &&
      record.promotionStatus === "applied" &&
      !concreteCommand(record.proposedPrevention?.verificationCommand),
    )
    .sort((a, b) => (b.observedAt || "").localeCompare(a.observedAt || ""))
    .slice(0, 5);
  if (appliedMissingVerificationPlan.length > 0) {
    console.log("  applied missing verification command:");
    for (const record of appliedMissingVerificationPlan) {
      const path = record.proposedPrevention?.path ? ` -> ${record.proposedPrevention.path}` : "";
      console.log(`    - ${record.id} (${record.primaryClass})${path}`);
    }
  } else {
    console.log("  applied missing verification command: none");
  }
}

function summarizeSkillPermissionHealth({ registry, permissions, compiler }) {
  console.log(`\n### Skill permission health`);
  if (!registry || registry._invalid) {
    console.log("  (skill registry not found or invalid)");
    return;
  }
  const summary = skillPermissionSummary({ registry, permissions, compiler });
  const skills = Array.isArray(registry.skills) ? registry.skills : [];
  const compilerSummary = summary.compiler || permissionCompilerSummary(compiler);
  console.log(`  registry skills: ${summary.registrySkills}`);
  console.log(`  policy entries: ${summary.policyEntries}/${skills.length}`);
  console.log(`  compiler status: ${compilerSummary.available ? compilerSummary.status : "unavailable"}`);
  console.log(`  compiler runtime: ${compilerSummary.runtime || "n/a"}`);
  console.log(`  compiled skills: ${compilerSummary.skills}`);
  console.log(`  compiled task contracts: ${compilerSummary.tasks}`);
  console.log(`  high-risk task contracts: ${compilerSummary.highRiskTasks.length}`);
  if (compilerSummary.taskContractsDir) console.log(`  task contracts dir: ${compilerSummary.taskContractsDir}`);
  console.log(`  mutation-capable skills: ${summary.mutationCapable.length}`);
  console.log(`  mutation-denied skills: ${summary.mutationDenied.length}`);
  console.log(`  missing policy: ${summary.missingPolicy.length ? summary.missingPolicy.slice(0, 8).join(", ") : "none"}`);
  if (summary.missingPolicy.length > 8) console.log(`  ...and ${summary.missingPolicy.length - 8} more missing policy entries`);
  console.log(`  extra policy: ${summary.extraPolicy.length ? summary.extraPolicy.slice(0, 8).join(", ") : "none"}`);
  if (summary.extraPolicy.length > 8) console.log(`  ...and ${summary.extraPolicy.length - 8} more extra policy entries`);
  console.log(`  policy drift: ${summary.drift.length ? summary.drift.slice(0, 8).join(", ") : "none"}`);
  if (summary.drift.length > 8) console.log(`  ...and ${summary.drift.length - 8} more drift entries`);
  console.log(`  overbroad sensitive grants: ${summary.overbroadSensitiveGrants.length ? summary.overbroadSensitiveGrants.slice(0, 8).join(", ") : "none"}`);
  if (summary.overbroadSensitiveGrants.length > 8) console.log(`  ...and ${summary.overbroadSensitiveGrants.length - 8} more overbroad grants`);
  if (compilerSummary.errors.length > 0) {
    console.log(`  compiler errors: ${compilerSummary.errors.slice(0, 5).join(" | ")}`);
    if (compilerSummary.errors.length > 5) console.log(`  ...and ${compilerSummary.errors.length - 5} more compiler errors`);
  } else {
    console.log("  compiler errors: none");
  }
}

function summarizeModelRouting(providerCalls, config) {
  console.log(`\n### Model routing`);
  if (!config?.modelRouting) {
    console.log("  (model routing config not found)");
    return;
  }
  if (providerCalls.length === 0) {
    console.log("  (no provider calls found in telemetry)");
    return;
  }
  const modelCounts = new Map();
  for (const call of providerCalls) {
    const model = call.model || "(missing)";
    modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
  }
  const lanes = (config.modelRouting.lanes || [])
    .map((lane) => `${lane.id}:${lane.expectedModel}`)
    .join(", ");
  const models = [...modelCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([model, count]) => `${model}=${count}`)
    .join(", ");
  console.log(`  configured lanes: ${lanes || "(none)"}`);
  console.log(`  observed models: ${models || "(none)"}`);
  console.log("  detail: run `node .harness/scripts/model-routing-report.mjs`");
}

function summarizeBypassAudit(payload) {
  console.log(`\n### Bypass audit`);
  console.log(`  records: ${payload.total}`);
  console.log(`  acknowledged: ${payload.acknowledged}`);
  if (payload.errors.length > 0) {
    console.log(`  errors: ${payload.errors.slice(0, 5).join("; ")}`);
    if (payload.errors.length > 5) console.log(`  ...and ${payload.errors.length - 5} more errors`);
  }
  if (payload.unacknowledged.length > 0) {
    console.log(`  unacknowledged: ${payload.unacknowledged.length} (review in ${payload.ackPath})`);
    for (const row of payload.unacknowledged.slice(0, 5)) {
      const label = row.rule || row.hook || row.hook_event_name || row.tool || "bypass";
      const reason = row.reason || row.prompt || row.command || row.file || "";
      console.log(`    - ${row.fingerprint} line ${row.line}: ${label}${reason ? ` — ${String(reason).slice(0, 120)}` : ""}`);
    }
    if (payload.unacknowledged.length > 5) console.log(`    ...and ${payload.unacknowledged.length - 5} more`);
  } else {
    console.log("  unacknowledged: none");
  }
}

function summarizeHarnessNoise(payload) {
  console.log(`\n### Harness noise`);
  console.log(`  window: ${payload.windowDays} day(s)`);
  console.log(
    `  blocks: ${payload.totals.hookBlocks}; bypasses: ${payload.totals.bypasses}; ` +
      `false positives: ${payload.totals.falsePositives}; human overrides: ${payload.totals.humanOverrides}`,
  );
  if (payload.acknowledgements.averageReviewLatencyMinutes !== null) {
    console.log(`  average review latency: ${payload.acknowledgements.averageReviewLatencyMinutes} min`);
  }
  if (payload.noisyRules.length > 0) {
    console.log("  top noisy rules:");
    for (const row of payload.noisyRules.slice(0, 5)) {
      console.log(`    - ${row.id}: score ${row.score} (blocks ${row.blocks}, bypasses ${row.bypasses}, false positives ${row.falsePositives})`);
    }
  } else {
    console.log("  top noisy rules: none");
  }
  if (payload.repeatedBlocks.length > 0) {
    console.log(`  repeated block patterns: ${payload.repeatedBlocks.length}`);
  }
}

function summarizeStructuralBaseline(payload) {
  console.log(`\n### Structural baseline debt`);
  console.log(`  path: ${payload.baselinePath}`);
  console.log(`  baseline entries: ${payload.count}`);
  if (payload.maxEntries !== null) console.log(`  max entries: ${payload.maxEntries}`);
  if (payload.comparison.exists) {
    console.log(
      `  ${payload.comparison.ref}: ${payload.comparison.count} ` +
        `(delta ${payload.comparison.delta >= 0 ? "+" : ""}${payload.comparison.delta})`,
    );
  } else if (payload.comparison.enabled) {
    console.log(`  ${payload.comparison.ref}: no baseline to compare`);
  }
  if (payload.duplicateEntries.length > 0) {
    console.log(`  duplicate entries: ${payload.duplicateEntries.slice(0, 5).join(", ")}`);
  }
  if (payload.errors.length > 0) {
    console.log(`  errors: ${payload.errors.slice(0, 5).join("; ")}`);
  }
  if (payload.warnings.length > 0) {
    console.log(`  warnings: ${payload.warnings.slice(0, 5).join("; ")}`);
  }
}

function summarizeHookIntegrity(payload) {
  console.log(`\n### Hook integrity`);
  for (const surface of payload.surfaces) {
    const enabled = surface.enabled ? "enabled" : "disabled";
    console.log(`  ${surface.runtime}: ${surface.status} (${enabled}, ${surface.hooksPath})`);
    if (surface.enabled) {
      console.log(`    events: ${surface.registeredEvents.length ? surface.registeredEvents.join(", ") : "none"}`);
    }
    for (const error of (surface.errors || []).slice(0, 3)) console.log(`    error: ${error}`);
    for (const warning of (surface.warnings || []).slice(0, 3)) console.log(`    warning: ${warning}`);
  }
}

function summarizeOrchestrationHealth({ contracts, runs }) {
  console.log(`\n### Orchestration health`);
  if (contracts.length === 0 && runs.length === 0) {
    console.log("  (no orchestration contracts or runtime runs found yet)");
    return;
  }
  const summary = orchestrationHealthSummary({ contracts, runs });
  const statuses = summary.runs.statuses;
  console.log(
    `  contracts: ${summary.contracts.total} ` +
      `(review-gated ${summary.contracts.reviewGated}, mutating ${summary.contracts.mutating}, invalid ${summary.contracts.invalid})`,
  );
  console.log(
    `  runs: ${summary.runs.total} ` +
      `(passed ${statuses.passed}, failed ${statuses.failed}, cancelled ${statuses.cancelled}, unknown ${statuses.unknown})`,
  );
  console.log(`  task-bound runs: ${summary.runs.taskBound}`);
  console.log(
    `  task-bound runs without contract: ${
      summary.runs.uncontractedTaskRuns.length ? summary.runs.uncontractedTaskRuns.slice(0, 8).join(", ") : "none"
    }`,
  );
  if (summary.invalidContracts.length > 0) console.log(`  invalid contracts: ${summary.invalidContracts.slice(0, 8).join(", ")}`);
  if (summary.invalidRuns.length > 0) console.log(`  invalid runs: ${summary.invalidRuns.slice(0, 8).join(", ")}`);
}

function summarizeSessionIsolation({ contracts, sessions, config }) {
  console.log(`\n### Session isolation`);
  const summary = sessionIsolationSummary({ contracts, sessions, config });
  if (!summary.enabled) {
    console.log("  disabled");
    return;
  }
  console.log(`  active task env: ${summary.activeTaskEnv}`);
  console.log(`  linked worktree required: ${summary.requireLinkedWorktree ? "yes" : "no"}`);
  console.log(`  allowed branch prefixes: ${summary.branchPrefixes.join(", ")}`);
  console.log(`  session manifests: ${summary.manifests}`);
  console.log(`  isolation-required tasks: ${summary.requiredTasks.length}`);
  if (summary.requiredTasks.length > 0) {
    const examples = summary.requiredTasks
      .slice(0, 5)
      .map((task) => `${task.id} (${task.reasons.join("+")})`)
      .join(", ");
    console.log(`  required task examples: ${examples}`);
  }
  console.log(
    `  missing session manifests: ${
      summary.missingSessionTasks.length ? summary.missingSessionTasks.slice(0, 8).join(", ") : "none"
    }`,
  );
  if (summary.staleSessions.length > 0) {
    console.log("  stale session manifests:");
    for (const session of summary.staleSessions.slice(0, 5)) {
      console.log(`    - ${session.sessionId} (${session.taskId || "no task"}) -> ${session.worktreePath}`);
    }
  } else {
    console.log("  stale session manifests: none");
  }
}

function driftSignals(evalRows, telemetryRows, knownSkills) {
  console.log(`\n### Drift signals`);
  const seen = new Set(telemetryRows.map((r) => r.skill));
  const unseen = knownSkills.filter((s) => !seen.has(s));
  if (unseen.length > 0) {
    console.log(`  skills not invoked in 7 days: ${unseen.join(", ")}`);
  }
  // Tasks failing in their most recent run.
  const latest = new Map();
  for (const r of evalRows.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""))) {
    latest.set(r.taskId, r);
  }
  const regressing = [...latest.values()].filter((r) => !r.passed);
  if (regressing.length > 0) {
    console.log(
      `  tasks failing in their latest run: ${regressing.map((r) => r.taskId).join(", ")}`,
    );
  }
  if (unseen.length === 0 && regressing.length === 0) {
    console.log("  (none)");
  }
}

// Aggregate eval rows by task into { passed, total, tokens }.
function aggregateEvals(rows) {
  const byTask = new Map();
  for (const r of rows) {
    const cur = byTask.get(r.taskId) ?? { passed: 0, total: 0, tokens: 0 };
    cur.total++;
    if (r.passed) cur.passed++;
    cur.tokens += tokensOf(r);
    byTask.set(r.taskId, cur);
  }
  return byTask;
}

// Render a single delta line. signMode controls icon meaning — for pass-rate,
// up is good; for tokens, up is bad; for skill invocations, neutral.
function fmtDelta(now, then, signMode = "neutral", unit = "") {
  if (then === undefined) return `(new) ${now}${unit}`;
  const diff = now - then;
  if (diff === 0) return `${now}${unit} → ${then}${unit}  (=)`;
  let arrow = diff > 0 ? "↑" : "↓";
  // Color the arrow by "is this a regression?"
  let marker = " ";
  if (signMode === "good-up") marker = diff > 0 ? "+" : "-";
  else if (signMode === "good-down") marker = diff > 0 ? "-" : "+";
  return `${now}${unit} ← ${then}${unit}  (${arrow}${marker} ${Math.abs(diff)}${unit})`;
}

function weekOverWeek(evalRecent, evalPrior, telRecent, telPrior) {
  console.log(`\n### Week-over-week (last 7d vs prior 7d)`);
  const aRecent = aggregateEvals(evalRecent);
  const aPrior = aggregateEvals(evalPrior);

  if (aRecent.size === 0 && aPrior.size === 0) {
    console.log("  (no eval data in either window — run `npm run harness:eval`)");
  } else {
    console.log("  task                    pass-rate (now ← prior)        avg-tokens (now ← prior)");
    console.log("  ----------------------  ----------------------------   --------------------------");
    const taskIds = new Set([...aRecent.keys(), ...aPrior.keys()]);
    for (const t of [...taskIds].sort()) {
      const now = aRecent.get(t);
      const prior = aPrior.get(t);
      const nowRate = now ? Math.round((now.passed / now.total) * 100) : null;
      const priorRate = prior ? Math.round((prior.passed / prior.total) * 100) : null;
      const nowTok = now && now.total > 0 ? Math.round(now.tokens / now.total) : 0;
      const priorTok = prior && prior.total > 0 ? Math.round(prior.tokens / prior.total) : 0;
      const rateCell = nowRate === null
        ? "(absent now)"
        : priorRate === null
          ? `${nowRate}% (new)`
          : `${nowRate}% ← ${priorRate}%  (${nowRate - priorRate >= 0 ? "+" : ""}${nowRate - priorRate})`;
      const tokCell = nowTok === 0 && priorTok === 0
        ? "—"
        : `${nowTok} ← ${priorTok}  (${nowTok - priorTok >= 0 ? "+" : ""}${nowTok - priorTok})`;
      console.log(
        `  ${t.padEnd(22)}  ${rateCell.padEnd(30)} ${tokCell}`,
      );
    }
  }

  // Skill invocation deltas.
  const recentBySkill = new Map();
  for (const r of telRecent) recentBySkill.set(r.skill, (recentBySkill.get(r.skill) ?? 0) + 1);
  const priorBySkill = new Map();
  for (const r of telPrior) priorBySkill.set(r.skill, (priorBySkill.get(r.skill) ?? 0) + 1);

  const allSkills = new Set([...recentBySkill.keys(), ...priorBySkill.keys()]);
  if (allSkills.size > 0) {
    console.log("\n  skill                          invocations (now ← prior)");
    console.log("  -----------------------------  -------------------------------");
    for (const s of [...allSkills].sort()) {
      const n = recentBySkill.get(s) ?? 0;
      const p = priorBySkill.get(s) ?? 0;
      const d = n - p;
      const cell = p === 0 ? `${n}  (new)` : `${n} ← ${p}  (${d >= 0 ? "+" : ""}${d})`;
      console.log(`  ${s.padEnd(29)}  ${cell}`);
    }
  }
}

function normalizeStatus(value) {
  const status = String(value || "").toLowerCase();
  if (status === "passed") return "pass";
  if (status === "failed") return "fail";
  if (status === "attention") return "warn";
  if (status === "unavailable") return "warn";
  if (status === "pass" || status === "warn" || status === "fail") return status;
  return "warn";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function badge(status) {
  const normalized = normalizeStatus(status);
  return `<span class="badge ${normalized}">${escapeHtml(normalized.toUpperCase())}</span>`;
}

function compact(value, fallback = "n/a") {
  if (value === null || value === undefined || value === "") return fallback;
  if (Array.isArray(value)) return value.length ? value.join(", ") : fallback;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function repoLocalPath(value, fallback) {
  const text = String(value || "").trim();
  if (!text) return fallback;
  const absolute = resolve(ROOT, text);
  const root = ROOT.replace(/\\/g, "/");
  const target = absolute.replace(/\\/g, "/");
  return target === root || target.startsWith(`${root}/`) ? absolute : fallback;
}

function htmlList(items, empty = "None") {
  const values = (items || []).filter(Boolean);
  if (values.length === 0) return `<p class="muted">${escapeHtml(empty)}</p>`;
  return `<ul>${values.slice(0, 12).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function htmlTable(headers, rows, empty = "No data") {
  if (!rows || rows.length === 0) return `<p class="muted">${escapeHtml(empty)}</p>`;
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function runJsonSibling(scriptName, args = []) {
  const script = resolve(SCRIPT_DIR, scriptName);
  if (!existsSync(script)) {
    return { available: false, status: "unavailable", errors: [`${scriptName} not found`] };
  }
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = String(result.stdout || "").trim();
  try {
    const parsed = JSON.parse(stdout || "{}");
    return {
      available: true,
      exitCode: result.status ?? 0,
      ...parsed,
      _stderr: String(result.stderr || "").trim(),
    };
  } catch {
    return {
      available: false,
      status: "unavailable",
      exitCode: result.status ?? 1,
      errors: [`${scriptName} did not emit JSON`],
      stdout: stdout.slice(0, 1000),
      stderr: String(result.stderr || "").trim().slice(0, 1000),
    };
  }
}

function baselineAgeDays() {
  const path = resolve(ROOT, ".harness/structural-baseline.json");
  if (!existsSync(path)) return null;
  try {
    return Math.max(0, Math.floor((NOW - statSync(path).mtimeMs) / ONE_DAY));
  } catch {
    return null;
  }
}

function dashboardInventory({ contracts, evidence, reviewDecisions }) {
  const evidenceByTask = new Map();
  for (const item of evidence) {
    if (item._invalid) continue;
    if (item.taskId) evidenceByTask.set(item.taskId, item);
  }
  const passReviewersByTask = new Map();
  for (const decision of reviewDecisions) {
    if (decision._invalid || decision.decision !== "pass" || !decision.taskId || !decision.reviewer) continue;
    const reviewers = passReviewersByTask.get(decision.taskId) || new Set();
    reviewers.add(decision.reviewer);
    passReviewersByTask.set(decision.taskId, reviewers);
  }

  const activeContracts = [];
  const missingReviewers = [];
  for (const contract of contracts) {
    if (contract._invalid || !contract.id) continue;
    const evidenceForTask = evidenceByTask.get(contract.id);
    if (!evidenceForTask || evidenceForTask.status !== "pass") {
      activeContracts.push({
        id: contract.id,
        type: contract.type || "",
        riskTier: contract.riskTier || "",
        evidenceStatus: evidenceForTask?.status || "missing",
        evidencePath: contract.evidencePath || "",
      });
    }
    const required = Array.isArray(contract.requiredReviewers) ? contract.requiredReviewers : [];
    const passed = passReviewersByTask.get(contract.id) || new Set();
    const missing = required.filter((reviewer) => !passed.has(reviewer));
    if (missing.length > 0) {
      missingReviewers.push({ taskId: contract.id, missing });
    }
  }

  const evidenceRows = evidence.map((item) => ({
    taskId: item.taskId || item.featureId || item._path || "(unknown)",
    status: item._invalid ? "invalid" : item.status || "(missing)",
    checks: Array.isArray(item.checks) ? item.checks.length : 0,
    path: item._path || "",
  }));
  const openRisks = [];
  for (const item of evidence) {
    if (item._invalid || !Array.isArray(item.knownRisks)) continue;
    for (const risk of item.knownRisks) {
      if (!risk || risk.disposition !== "open") continue;
      openRisks.push({
        taskId: item.taskId || item.featureId || item._path || "(unknown)",
        id: risk.id || "(risk)",
        severity: risk.severity || "",
        summary: risk.summary || risk.description || "",
      });
    }
  }
  return { activeContracts, missingReviewers, evidenceRows, openRisks };
}

async function buildDashboardExtras({ contracts, evidence, reviewDecisions }) {
  return {
    readiness: runJsonSibling("harness-readiness.mjs", ["--json", "--strict"]),
    runtimeParity: runJsonSibling("runtime-parity-report.mjs", ["--json"]),
    architectureFitness: runJsonSibling("check-architecture-fitness.mjs", ["--json", "--strict"]),
    modelRouting: runJsonSibling("model-routing-report.mjs", ["--json"]),
    baselineAgeDays: baselineAgeDays(),
    inventory: dashboardInventory({ contracts, evidence, reviewDecisions }),
  };
}

function renderDashboardHtml(payload, dashboard) {
  const sections = payload.sections;
  const reasons = Object.entries(sections)
    .flatMap(([name, section]) => (section.reasons || []).map((reason) => `${name}: ${reason}`));
  const readinessResults = Array.isArray(dashboard.readiness?.results) ? dashboard.readiness.results : [];
  const fitness = dashboard.architectureFitness || {};
  const modelRouting = dashboard.modelRouting || {};
  const runtime = dashboard.runtimeParity || {};
  const inventory = dashboard.inventory || {};
  const fitnessFindings = Array.isArray(fitness.findings) ? fitness.findings : [];
  const activeContracts = inventory.activeContracts || [];
  const evidenceRows = inventory.evidenceRows || [];
  const missingReviewers = inventory.missingReviewers || [];
  const openRisks = inventory.openRisks || [];
  const permissionCompiler = sections.skillPermissions.compiler || {};
  const cards = [
    ["Overall", payload.status, `Generated ${payload.generatedAt}`],
    ["Readiness", dashboard.readiness?.status || "unavailable", `${readinessResults.length} gate(s)`],
    ["Runtime parity", runtime.status || "unavailable", runtime.scores ? `Claude ${runtime.scores.claude.percent}% / Codex ${runtime.scores.codex.percent}%` : "not available"],
    ["Architecture fitness", fitness.status || "unavailable", `${fitnessFindings.length} finding(s)`],
    ["Permissions", sections.skillPermissions.status, `compiler ${permissionCompiler.status || "n/a"} / ${permissionCompiler.tasks ?? 0} task(s)`],
    ["Evidence", sections.taskEvidence.status, `${sections.taskEvidence.evidence.total} bundle(s)`],
    ["Reviews", sections.reviewDecisions.status, `${sections.reviewDecisions.total} decision(s)`],
    ["Bypass audit", sections.bypassAudit.status, `${sections.bypassAudit.unacknowledged.length} unreviewed`],
    ["Harness noise", sections.harnessNoise.status, `${sections.harnessNoise.totals.hookBlocks} block(s)`],
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>agent-harness-kit dashboard</title>
  <style>
    :root { color-scheme: light; --bg:#f7f8fa; --panel:#fff; --text:#18202a; --muted:#667085; --line:#d9dee7; --pass:#137333; --warn:#b56a00; --fail:#b42318; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { padding: 28px 32px 16px; border-bottom: 1px solid var(--line); background: #fff; }
    main { padding: 24px 32px 48px; max-width: 1440px; margin: 0 auto; }
    h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: 0; }
    h2 { margin: 0 0 12px; font-size: 18px; letter-spacing: 0; }
    p { margin: 0 0 10px; }
    .muted { color: var(--muted); }
    .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); margin-bottom: 20px; }
    .card, section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .card strong { display: block; font-size: 13px; color: var(--muted); margin-bottom: 8px; }
    .card .detail { margin-top: 8px; color: var(--muted); font-size: 13px; }
    section { margin-top: 16px; overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; min-width: 720px; }
    th, td { border-bottom: 1px solid var(--line); padding: 9px 10px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0; background: #fafbfc; }
    tr:last-child td { border-bottom: 0; }
    ul { margin: 0; padding-left: 18px; }
    code { background: #f0f2f5; border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; }
    .badge { display: inline-block; min-width: 54px; padding: 3px 7px; border-radius: 999px; font-size: 12px; font-weight: 700; text-align: center; }
    .badge.pass { color: var(--pass); background: #e6f4ea; }
    .badge.warn { color: var(--warn); background: #fff4e5; }
    .badge.fail { color: var(--fail); background: #fcebea; }
    footer { color: var(--muted); padding-top: 22px; font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <h1>agent-harness-kit dashboard</h1>
    <p class="muted">Static harness control-plane snapshot. Generated ${escapeHtml(payload.generatedAt)}.</p>
  </header>
  <main>
    <div class="grid">
      ${cards.map(([title, status, detail]) => `<div class="card"><strong>${escapeHtml(title)}</strong>${badge(status)}<div class="detail">${escapeHtml(detail)}</div></div>`).join("")}
    </div>

    <section>
      <h2>Current Signals</h2>
      ${htmlList(reasons, "No warning or failure signals.")}
    </section>

    <section>
      <h2>Readiness Gates</h2>
      ${htmlTable(["Gate", "Status", "Required", "Command", "Summary"], readinessResults.map((gate) => [
        escapeHtml(gate.id),
        badge(gate.status),
        escapeHtml(gate.required ? "yes" : "no"),
        `<code>${escapeHtml(gate.command || "")}</code>`,
        escapeHtml((gate.summary || gate.stderr || gate.stdout || "").slice(0, 220)),
      ]))}
    </section>

    <section>
      <h2>Runtime Parity</h2>
      ${runtime.scores ? htmlTable(["Runtime", "Score", "Possible", "Percent"], [
        ["Claude", escapeHtml(runtime.scores.claude.score), escapeHtml(runtime.scores.claude.possible), escapeHtml(`${runtime.scores.claude.percent}%`)],
        ["Codex", escapeHtml(runtime.scores.codex.score), escapeHtml(runtime.scores.codex.possible), escapeHtml(`${runtime.scores.codex.percent}%`)],
      ]) : `<p class="muted">${escapeHtml((runtime.errors || ["runtime parity report unavailable"]).join("; "))}</p>`}
    </section>

    <section>
      <h2>Active Task Contracts</h2>
      ${htmlTable(["Task", "Type", "Risk", "Evidence", "Evidence path"], activeContracts.map((task) => [
        escapeHtml(task.id),
        escapeHtml(task.type),
        escapeHtml(task.riskTier),
        badge(task.evidenceStatus === "missing" ? "warn" : task.evidenceStatus),
        `<code>${escapeHtml(task.evidencePath)}</code>`,
      ]), "No active contracts without pass evidence.")}
    </section>

    <section>
      <h2>Evidence Status</h2>
      <p class="muted">Bundles: ${escapeHtml(sections.taskEvidence.evidence.total)}. Pass ${escapeHtml(sections.taskEvidence.evidence.statuses.pass)}, partial ${escapeHtml(sections.taskEvidence.evidence.statuses.partial)}, blocked ${escapeHtml(sections.taskEvidence.evidence.statuses.blocked)}, fail ${escapeHtml(sections.taskEvidence.evidence.statuses.fail)}, invalid ${escapeHtml(sections.taskEvidence.evidence.statuses.invalid)}.</p>
      ${htmlTable(["Task", "Status", "Checks", "Path"], evidenceRows.map((item) => [
        escapeHtml(item.taskId),
        badge(item.status),
        escapeHtml(item.checks),
        `<code>${escapeHtml(item.path)}</code>`,
      ]), "No evidence bundles found.")}
    </section>

    <section>
      <h2>Missing Reviewers</h2>
      ${htmlTable(["Task", "Missing reviewer pass decisions"], missingReviewers.map((item) => [
        escapeHtml(item.taskId),
        escapeHtml(item.missing.join(", ")),
      ]), "No missing required reviewer pass decisions.")}
    </section>

    <section>
      <h2>Open Known Risks</h2>
      ${htmlTable(["Task", "Risk", "Severity", "Summary"], openRisks.map((risk) => [
        escapeHtml(risk.taskId),
        escapeHtml(risk.id),
        escapeHtml(risk.severity),
        escapeHtml(risk.summary),
      ]), "No open known risks in evidence bundles.")}
    </section>

    <section>
      <h2>Architecture Fitness</h2>
      <p class="muted">Rules: ${escapeHtml(fitness.rules ?? "n/a")}; files scanned: ${escapeHtml(fitness.filesScanned ?? "n/a")}; examples: ${escapeHtml(fitness.examples ?? "n/a")}.</p>
      ${htmlTable(["Rule", "Severity", "Owner", "File", "Line", "Message"], fitnessFindings.map((finding) => [
        escapeHtml(finding.ruleId),
        badge(finding.severity),
        escapeHtml(finding.owner),
        `<code>${escapeHtml(finding.file)}</code>`,
        escapeHtml(finding.line),
        escapeHtml(finding.message),
      ]), "No architecture fitness findings.")}
    </section>

    <section>
      <h2>Permission Compiler</h2>
      <p class="muted">Runtime: ${escapeHtml(permissionCompiler.runtime || "n/a")}; skills: ${escapeHtml(permissionCompiler.skills ?? 0)}; task contracts: ${escapeHtml(permissionCompiler.tasks ?? 0)}; high-risk tasks: ${escapeHtml((permissionCompiler.highRiskTasks || []).length)}.</p>
      ${htmlList(permissionCompiler.errors || [], "No permission compiler errors.")}
    </section>

    <section>
      <h2>Structural Baseline</h2>
      <p>Entries: ${escapeHtml(sections.structuralBaseline.count)}. Baseline age: ${escapeHtml(dashboard.baselineAgeDays === null ? "n/a" : `${dashboard.baselineAgeDays} day(s)`)}.</p>
      ${htmlList([...(sections.structuralBaseline.errors || []), ...(sections.structuralBaseline.warnings || [])], "No baseline warnings or errors.")}
    </section>

    <section>
      <h2>Failure Records</h2>
      <p>Records: ${escapeHtml(sections.failureLearning.records)}. Proposed ${escapeHtml(sections.failureLearning.statusCounts.proposed)}, applied ${escapeHtml(sections.failureLearning.statusCounts.applied)}, verified ${escapeHtml(sections.failureLearning.statusCounts.verified)}, rejected ${escapeHtml(sections.failureLearning.statusCounts.rejected)}, invalid ${escapeHtml(sections.failureLearning.statusCounts.invalid)}.</p>
      ${htmlTable(["Record", "Class", "Status", "Prevention"], (sections.failureLearning.needsPromotion || []).slice(0, 20).map((record) => [
        escapeHtml(record.id),
        escapeHtml(record.primaryClass),
        escapeHtml(record.promotionStatus),
        escapeHtml(record.preventionTarget),
      ]), "No failure records need promotion.")}
    </section>

    <section>
      <h2>Bypass Audit</h2>
      <p>Records: ${escapeHtml(sections.bypassAudit.total)}. Acknowledged ${escapeHtml(sections.bypassAudit.acknowledged)}. Unacknowledged ${escapeHtml(sections.bypassAudit.unacknowledged.length)}.</p>
      ${htmlList(sections.bypassAudit.errors, "No bypass audit errors.")}
    </section>

    <section>
      <h2>Harness Noise</h2>
      <p>Blocks: ${escapeHtml(sections.harnessNoise.totals.hookBlocks)}; bypasses: ${escapeHtml(sections.harnessNoise.totals.bypasses)}; false positives: ${escapeHtml(sections.harnessNoise.totals.falsePositives)}; human overrides: ${escapeHtml(sections.harnessNoise.totals.humanOverrides)}.</p>
      ${htmlTable(["Rule", "Score", "Blocks", "Bypasses", "False positives"], (sections.harnessNoise.noisyRules || []).slice(0, 10).map((rule) => [
        escapeHtml(rule.id),
        escapeHtml(rule.score),
        escapeHtml(rule.blocks),
        escapeHtml(rule.bypasses),
        escapeHtml(rule.falsePositives),
      ]), "No noisy rules.")}
    </section>

    <section>
      <h2>Eval Trend</h2>
      ${htmlTable(["Task", "Pass rate now", "Pass rate prior", "Delta", "Avg tokens now", "Avg tokens prior"], (sections.weekOverWeek.tasks || []).map((task) => [
        escapeHtml(task.taskId),
        escapeHtml(task.passRateNow === null ? "n/a" : `${task.passRateNow}%`),
        escapeHtml(task.passRatePrior === null ? "n/a" : `${task.passRatePrior}%`),
        escapeHtml(task.passRateDelta === null ? "n/a" : task.passRateDelta),
        escapeHtml(task.avgTokensNow),
        escapeHtml(task.avgTokensPrior),
      ]), "No eval trend data.")}
    </section>

    <section>
      <h2>Model Routing &amp; Cost</h2>
      <p class="muted">Provider calls: ${escapeHtml(modelRouting.totalCalls ?? sections.modelRouting.providerCalls)}.</p>
      ${htmlTable(["Lane", "Expected model", "Calls", "Cost", "Tokens", "Models"], (modelRouting.lanes || []).map((lane) => [
        escapeHtml(lane.id),
        escapeHtml(lane.expectedModel || ""),
        escapeHtml(lane.calls),
        escapeHtml(lane.totalCost === undefined ? "n/a" : `$${Number(lane.totalCost).toFixed(4)}`),
        escapeHtml(lane.totalTokens ?? "n/a"),
        escapeHtml(Object.entries(lane.modelCounts || {}).map(([model, count]) => `${model}:${count}`).join(", ") || "(missing)"),
      ]), "No model routing telemetry.")}
    </section>

    <footer>Generated as static HTML with inline CSS and escaped repo data only.</footer>
  </main>
</body>
</html>`;
}

async function writeDashboard(payload, dashboard) {
  const out = resolve(ROOT, opts.out || ".harness/reports/harness-dashboard.html");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, renderDashboardHtml(payload, dashboard), "utf8");
  return rel(out);
}

async function main() {
  const evalAll = await loadEvalResults();
  const telemetryAll = await readJsonl(TELEMETRY);
  const skillTelemetryAll = telemetryAll.filter(isSkillInvocationRecord);
  const providerCalls = telemetryAll.filter((row) => row.event === "provider_call");
  const knownSkills = await loadKnownSkills();
  const config = await readJsonFile(resolve(ROOT, ".harness/config.json"));
  const taskContracts = await loadJsonFiles(TASK_CONTRACTS_DIR);
  const evidenceBundles = await loadJsonFiles(EVIDENCE_DIR);
  const reviewDecisions = await loadJsonFilesRecursive(REVIEW_DECISIONS_DIR);
  const failureRecords = await loadJsonFiles(FAILURE_RECORDS_DIR);
  const orchestrationContracts = await loadJsonFiles(
    config?.orchestration?.contractsDir ? resolve(ROOT, config.orchestration.contractsDir) : ORCHESTRATION_CONTRACTS_DIR,
  );
  const orchestrationRuns = await loadOrchestrationRuns(
    config?.orchestration?.runsDir ? resolve(ROOT, config.orchestration.runsDir) : ORCHESTRATION_RUNS_DIR,
  );
  const sessionManifests = await loadJsonFilesRecursive(
    config?.sessionIsolation?.manifestDir ? resolve(ROOT, config.sessionIsolation.manifestDir) : SESSION_MANIFESTS_DIR,
  );
  const featureList = await readJsonFile(FEATURE_LIST);
  const skillRegistry = await readJsonFile(SKILL_REGISTRY);
  const permissionsCompiler = runJsonSibling("permissions-compile.mjs", ["diff", "--json"]);
  const permissionsPolicy = await readJsonFile(repoLocalPath(permissionsCompiler.policyPath, PERMISSIONS_POLICY));
  const bypassAudit = auditBypassRecords({ cwd: ROOT });
  const harnessNoise = buildHarnessNoiseReport({ cwd: ROOT, windowDays: 7 });
  const structuralBaseline = analyzeStructuralBaseline({ cwd: ROOT });
  const hookIntegrity = analyzeHookIntegrity({ cwd: ROOT });
  const reviewPromotion = reviewPromotionPolicy(config);
  const evalRows = recent(evalAll);
  const evalPrior = priorWeek(evalAll);
  const telemetryRows = recent(skillTelemetryAll);
  const telemetryPrior = priorWeek(skillTelemetryAll);
  const sections = {
    evals: evalSummary(evalRows),
    telemetry: telemetrySummary(telemetryRows),
    weekOverWeek: weekOverWeekSummary(evalRows, evalPrior, telemetryRows, telemetryPrior),
    taskEvidence: taskEvidenceSummary({ contracts: taskContracts, evidence: evidenceBundles, featureList }),
    reviewDecisions: reviewDecisionSummary(reviewDecisions, failureRecords, { reviewPromotion }),
    failureLearning: failureLearningSummary(failureRecords),
    orchestration: orchestrationHealthSummary({ contracts: orchestrationContracts, runs: orchestrationRuns }),
    sessionIsolation: sessionIsolationSummary({ contracts: taskContracts, sessions: sessionManifests, config }),
    skillPermissions: skillPermissionSummary({ registry: skillRegistry, permissions: permissionsPolicy, compiler: permissionsCompiler }),
    modelRouting: modelRoutingSummary(providerCalls, featureList?._invalid ? null : config),
    bypassAudit: bypassAuditSummary(bypassAudit),
    harnessNoise: harnessNoiseSummary(harnessNoise),
    structuralBaseline: structuralBaselineSummary(structuralBaseline),
    hookIntegrity: hookIntegritySummary(hookIntegrity),
    drift: driftSummary(evalRows, telemetryRows, knownSkills),
  };
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    window: {
      recentDays: 7,
      priorDays: 7,
    },
    status: worstStatus(Object.values(sections).map((section) => section.status)),
    sections,
  };

  if (opts.html) {
    const dashboard = await buildDashboardExtras({
      contracts: taskContracts,
      evidence: evidenceBundles,
      reviewDecisions,
    });
    const out = await writeDashboard(payload, dashboard);
    console.log(out);
    return payload;
  }

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  console.log("=== agent-harness-kit report ===");
  console.log(`Generated: ${payload.generatedAt}`);
  console.log(`Status: ${payload.status.toUpperCase()}`);
  const reasons = Object.entries(payload.sections)
    .flatMap(([name, section]) => (section.reasons || []).map((reason) => `${name}: ${reason}`));
  if (reasons.length > 0) {
    console.log("Signals:");
    for (const reason of reasons.slice(0, 8)) console.log(`  - ${reason}`);
    if (reasons.length > 8) console.log(`  ...and ${reasons.length - 8} more`);
  }
  summarizeEvals(evalRows);
  summarizeTelemetry(telemetryRows);
  weekOverWeek(evalRows, evalPrior, telemetryRows, telemetryPrior);
  summarizeTaskEvidence({ contracts: taskContracts, evidence: evidenceBundles, featureList });
  summarizeReviewDecisions(reviewDecisions, failureRecords, { reviewPromotion });
  summarizeFailureLearning(failureRecords);
  summarizeOrchestrationHealth({ contracts: orchestrationContracts, runs: orchestrationRuns });
  summarizeSessionIsolation({ contracts: taskContracts, sessions: sessionManifests, config });
  summarizeSkillPermissionHealth({ registry: skillRegistry, permissions: permissionsPolicy, compiler: permissionsCompiler });
  summarizeModelRouting(providerCalls, featureList?._invalid ? null : config);
  summarizeBypassAudit(bypassAudit);
  summarizeHarnessNoise(harnessNoise);
  summarizeStructuralBaseline(structuralBaseline);
  summarizeHookIntegrity(hookIntegrity);
  driftSignals(evalRows, telemetryRows, knownSkills);
  console.log("");
  return payload;
}

const payload = await main();
if (statusMeets(payload.status, opts.failOn)) process.exitCode = 1;

#!/usr/bin/env node
// project-memory.mjs - repo-local Project Operating Memory.
//
// Telemetry answers "what happened at machine level?". This ledger answers
// "what should future humans and agents remember?". It intentionally stores
// semantic events with pointers to artifacts instead of raw transcripts/diffs.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeStructuralBaseline } from "./_lib/structural-baseline.mjs";

export const DEFAULT_STATE_PATH = ".harness/project/state.json";
export const DEFAULT_LEDGER_PATH = ".harness/memory/ledger.jsonl";
export const DEFAULT_SUMMARY_PATH = ".harness/memory/current-summary.md";
export const DEFAULT_HANDOFF_PATH = ".harness/project/handoff.json";
export const DEFAULT_CONFIG_PATH = ".harness/config.json";
export const DEFAULT_TASK_CONTRACTS_DIR = ".harness/task-contracts";
export const DEFAULT_ORCHESTRATION_CONTRACTS_DIR = ".harness/orchestration/contracts";
export const DEFAULT_ORCHESTRATION_RUNS_DIR = ".harness/orchestration";
export const DEFAULT_SESSION_MANIFESTS_DIR = ".harness/sessions";

const SEMANTIC_TYPES = new Set([
  "decision",
  "action",
  "feature_created",
  "feature_status_change",
  "risk",
  "handoff",
  "scope_change",
  "session_summary",
  "external_reference",
]);

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function safeReadJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function relPath(cwd, path) {
  return relative(cwd, path).split("\\").join("/") || ".";
}

function readTaggedJson(cwd, path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { _path: relPath(cwd, path), _invalid: true };
    }
    return { ...value, _path: relPath(cwd, path) };
  } catch {
    return { _path: relPath(cwd, path), _invalid: true };
  }
}

function listJsonObjects(cwd, dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => readTaggedJson(cwd, join(dir, entry)));
}

function listRunDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry !== "contracts")
    .sort()
    .map((entry) => join(dir, entry))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
}

function loadOrchestrationRuns(cwd, runsDir) {
  return listRunDirs(runsDir)
    .map((dir) => {
      const manifestPath = join(dir, "manifest.json");
      const summaryPath = join(dir, "summary.json");
      const manifest = existsSync(manifestPath) ? readTaggedJson(cwd, manifestPath) : null;
      const summary = existsSync(summaryPath) ? readTaggedJson(cwd, summaryPath) : null;
      if (!manifest && !summary) return null;
      return {
        _path: relPath(cwd, dir),
        runId: summary?.runId || manifest?.runId || basename(dir),
        manifest,
        summary,
        _invalid: Boolean(manifest?._invalid || summary?._invalid),
      };
    })
    .filter(Boolean);
}

function readHarnessConfig(cwd) {
  return safeReadJson(resolve(cwd, DEFAULT_CONFIG_PATH))
    || safeReadJson(resolve(cwd, "harness.config.json"))
    || {};
}

function writeJson(path, value) {
  ensureDir(path);
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      opts._.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? null : body.slice(eq + 1);
    let value = inline;
    if (value === null) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }
    if (opts[key] === undefined) {
      opts[key] = value;
    } else if (Array.isArray(opts[key])) {
      opts[key].push(value);
    } else {
      opts[key] = [opts[key], value];
    }
  }
  return opts;
}

function readStdinIfPiped() {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function projectNameFromCwd(cwd) {
  const featureList = safeReadJson(resolve(cwd, ".harness/feature_list.json"));
  if (featureList && !Array.isArray(featureList) && typeof featureList.project === "string") {
    return featureList.project;
  }
  const pkg = safeReadJson(resolve(cwd, "package.json"));
  if (pkg?.name) return pkg.name;
  return basename(cwd);
}

export function defaultProjectState(cwd = process.cwd(), ts = nowIso()) {
  return {
    schemaVersion: "1",
    project: {
      name: projectNameFromCwd(cwd),
      mode: "solo-dev",
    },
    currentPhase: "mvp",
    phases: [
      {
        id: "discovery",
        title: "Discovery",
        status: "planned",
        goals: ["Clarify target user", "Confirm core problem"],
        exitCriteria: ["Problem statement and success signal are explicit"],
      },
      {
        id: "mvp",
        title: "MVP",
        status: "active",
        scope: { in: [], out: [] },
        milestones: [
          { id: "mvp-vertical-slice", title: "Usable vertical slice", status: "active" },
        ],
        checklists: [
          {
            id: "mvp-release",
            title: "MVP release gate",
            items: [
              { id: "scope-reviewed", title: "Scope reviewed", done: false },
              { id: "tests-pass", title: "Relevant tests pass", done: false },
              { id: "status-report", title: "Project status report generated", done: false },
            ],
          },
        ],
      },
      {
        id: "hardening",
        title: "Hardening",
        status: "planned",
        goals: ["Close release blockers", "Reduce operational risk"],
        exitCriteria: ["No open P0/P1 risks"],
      },
      {
        id: "release",
        title: "Release",
        status: "planned",
        goals: ["Publish verified build", "Capture handoff context"],
        exitCriteria: ["Release evidence is recorded"],
      },
    ],
    features: [],
    risks: [],
    decisions: [],
    updatedAt: ts,
  };
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeState(raw, cwd) {
  const base = defaultProjectState(cwd);
  const state = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...base, ...raw } : base;
  state.project = { ...base.project, ...(state.project ?? {}) };
  state.phases = normalizeArray(state.phases).length > 0 ? state.phases : base.phases;
  state.features = normalizeArray(state.features);
  state.risks = normalizeArray(state.risks);
  state.decisions = normalizeArray(state.decisions);
  if (!state.currentPhase) state.currentPhase = base.currentPhase;
  if (!state.schemaVersion) state.schemaVersion = "1";
  return state;
}

export function ensureProjectState(cwd = process.cwd(), options = {}) {
  const statePath = resolve(cwd, options.statePath ?? DEFAULT_STATE_PATH);
  const raw = safeReadJson(statePath);
  const state = normalizeState(raw, cwd);
  if (!existsSync(statePath)) writeJson(statePath, state);

  const ledgerPath = resolve(cwd, options.ledgerPath ?? DEFAULT_LEDGER_PATH);
  if (!existsSync(ledgerPath)) {
    ensureDir(ledgerPath);
    writeFileSync(ledgerPath, "");
  }
  return state;
}

function readFeatureList(cwd) {
  const path = resolve(cwd, ".harness/feature_list.json");
  const parsed = safeReadJson(path);
  if (!parsed) return [];
  return Array.isArray(parsed) ? parsed : normalizeArray(parsed.features);
}

function statusFrom({ fail = false, warn = false } = {}) {
  if (fail) return "fail";
  if (warn) return "warn";
  return "pass";
}

function permissionToolName(entry) {
  if (typeof entry === "string") return entry.split("(")[0];
  if (entry && typeof entry === "object" && typeof entry.tool === "string") {
    return entry.tool.split("(")[0];
  }
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

function summarizeOrchestrationHealth(contracts, runs) {
  const invalidContracts = contracts.filter((contract) => contract._invalid).map((contract) => contract._path);
  const invalidRuns = runs.filter((run) => run._invalid).map((run) => run._path);
  const validContracts = contracts.filter((contract) => !contract._invalid);
  const reviewGated = validContracts.filter((contract) => (contract.requiredReviewers || []).length > 0).length;
  const mutating = validContracts.filter((contract) =>
    (contract.lanes || []).some((lane) => lane?.toolPolicy === "mutating"),
  ).length;
  const runStatuses = { passed: 0, failed: 0, cancelled: 0, unknown: 0 };
  const taskBoundRuns = [];
  const uncontractedTaskRuns = [];
  for (const run of runs) {
    const summary = run.summary && !run.summary._invalid ? run.summary : null;
    const manifest = run.manifest && !run.manifest._invalid ? run.manifest : null;
    const status = summary?.status;
    if (status === "passed" || status === "failed" || status === "cancelled") {
      runStatuses[status] += 1;
    } else {
      runStatuses.unknown += 1;
    }
    const taskId = summary?.taskId || manifest?.taskId || null;
    const contractId = summary?.contractId || manifest?.contractId || null;
    if (taskId) taskBoundRuns.push({ runId: run.runId, taskId, contractId, status: status || "unknown" });
    if (taskId && !contractId) uncontractedTaskRuns.push(run.runId);
  }
  const reasons = [];
  if (invalidContracts.length > 0) reasons.push(`${invalidContracts.length} invalid orchestration contract(s)`);
  if (invalidRuns.length > 0) reasons.push(`${invalidRuns.length} invalid orchestration run(s)`);
  if (runStatuses.failed > 0) reasons.push(`${runStatuses.failed} failed orchestration run(s)`);
  if (runStatuses.cancelled > 0) reasons.push(`${runStatuses.cancelled} cancelled orchestration run(s)`);
  if (uncontractedTaskRuns.length > 0) reasons.push(`${uncontractedTaskRuns.length} task-bound run(s) lack orchestration contract`);
  return {
    status: statusFrom({
      fail: invalidContracts.length > 0 || invalidRuns.length > 0,
      warn: runStatuses.failed > 0 || runStatuses.cancelled > 0 || uncontractedTaskRuns.length > 0,
    }),
    reasons,
    contracts: {
      total: contracts.length,
      invalid: invalidContracts.length,
      reviewGated,
      mutating,
    },
    runs: {
      total: runs.length,
      statuses: runStatuses,
      taskBound: taskBoundRuns.length,
      uncontractedTaskRuns,
    },
    invalidContracts,
    invalidRuns,
    taskBoundRuns,
  };
}

function summarizeSessionIsolation(taskContracts, sessions, config) {
  const cfg = config?.sessionIsolation || {};
  const invalidSessions = sessions.filter((session) => session._invalid).map((session) => session._path);
  if (cfg.enabled === false) {
    return {
      status: "pass",
      enabled: false,
      reasons: [],
      manifests: sessions.length,
      requiredTasks: [],
      missingSessionTasks: [],
      staleSessions: [],
      invalidSessions,
      activeTaskEnv: cfg.activeTaskEnv || "AHK_ACTIVE_TASK",
      branchPrefixes: cfg.branchPrefixes || ["agent/", "codex/"],
      requireLinkedWorktree: cfg.requireLinkedWorktree !== false,
    };
  }

  const validContracts = taskContracts.filter((contract) => !contract._invalid);
  const requiredTasks = validContracts
    .map((contract) => ({
      id: contract.id,
      riskTier: contract.riskTier || null,
      reasons: taskIsolationReasons(contract, config),
    }))
    .filter((task) => task.id && task.reasons.length > 0);
  const sessionsByTask = new Set();
  const staleSessions = [];
  for (const session of sessions) {
    if (session._invalid) continue;
    if (session.taskId) sessionsByTask.add(session.taskId);
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
    status: statusFrom({
      fail: invalidSessions.length > 0,
      warn: staleSessions.length > 0 || missingSessionTasks.length > 0,
    }),
    enabled: true,
    reasons,
    manifests: sessions.length,
    requiredTasks,
    missingSessionTasks,
    staleSessions,
    invalidSessions,
    activeTaskEnv: cfg.activeTaskEnv || "AHK_ACTIVE_TASK",
    branchPrefixes: cfg.branchPrefixes || ["agent/", "codex/"],
    requireLinkedWorktree: cfg.requireLinkedWorktree !== false,
  };
}

function summarizeStructuralBaseline(cwd) {
  const payload = analyzeStructuralBaseline({ cwd });
  return {
    status: payload.status,
    reasons: payload.reasons,
    baselinePath: payload.baselinePath,
    count: payload.count,
    maxEntries: payload.maxEntries,
    comparison: payload.comparison,
    errors: payload.errors,
    warnings: payload.warnings,
  };
}

function collectHarnessHealth(cwd) {
  const config = readHarnessConfig(cwd);
  const taskContractsDir = resolve(cwd, config.taskContracts?.contractsDir || DEFAULT_TASK_CONTRACTS_DIR);
  const orchestrationContractsDir = resolve(
    cwd,
    config.orchestration?.contractsDir || DEFAULT_ORCHESTRATION_CONTRACTS_DIR,
  );
  const orchestrationRunsDir = resolve(cwd, config.orchestration?.runsDir || DEFAULT_ORCHESTRATION_RUNS_DIR);
  const sessionManifestDir = resolve(cwd, config.sessionIsolation?.manifestDir || DEFAULT_SESSION_MANIFESTS_DIR);
  const taskContracts = listJsonObjects(cwd, taskContractsDir);
  const orchestrationContracts = listJsonObjects(cwd, orchestrationContractsDir);
  const orchestrationRuns = loadOrchestrationRuns(cwd, orchestrationRunsDir);
  const sessions = listJsonObjects(cwd, sessionManifestDir);
  return {
    structuralBaseline: summarizeStructuralBaseline(cwd),
    orchestration: summarizeOrchestrationHealth(orchestrationContracts, orchestrationRuns),
    sessionIsolation: summarizeSessionIsolation(taskContracts, sessions, config),
  };
}

function sanitizeFeature(feature) {
  if (!feature || typeof feature !== "object") return null;
  return {
    id: String(feature.id ?? "").trim(),
    title: String(feature.title ?? feature.id ?? "").trim(),
    status: feature.status ?? (feature.passes === true ? "done" : "open"),
    passes: feature.passes === true,
    classification: feature.classification,
    storyPath: feature.storyPath,
    adrPath: feature.adrPath,
    assignedReviewer: feature.assignedReviewer,
    updatedAt: feature.updatedAt,
  };
}

function mergeFeature(state, feature) {
  const clean = sanitizeFeature(feature);
  if (!clean?.id) return;
  const idx = state.features.findIndex((item) => item.id === clean.id);
  if (idx === -1) state.features.push(clean);
  else state.features[idx] = { ...state.features[idx], ...clean };
}

function redactString(input) {
  return String(input)
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr|xoxb|xoxp|xoxa|xoxr)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*["']?[^"',\s}]+/gi, (match) => {
      const key = match.split(/[:=]/)[0].trim();
      return `${key}: [REDACTED]`;
    });
}

function redactValue(value) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, redactValue(val)]));
  }
  return value;
}

function toArray(value) {
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function parseArtifacts(values) {
  return toArray(values).map((raw) => {
    const text = String(raw);
    const idx = text.indexOf(":");
    if (idx === -1) return { type: "note", value: text };
    return { type: text.slice(0, idx), value: text.slice(idx + 1) };
  });
}

export function readLedger(cwd = process.cwd(), options = {}) {
  const path = resolve(cwd, options.ledgerPath ?? DEFAULT_LEDGER_PATH);
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Ledger is append-only; ignore corrupt historical rows instead of blocking hooks.
    }
  }
  return out;
}

function nextEventId(type, ts) {
  const compact = ts.replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `mem_${compact}_${type}_${rand}`;
}

function updateStateFromEvent(cwd, event, options = {}) {
  const statePath = resolve(cwd, options.statePath ?? DEFAULT_STATE_PATH);
  const state = normalizeState(safeReadJson(statePath), cwd);

  if (event.eventType === "decision") {
    state.decisions.unshift({
      id: event.id,
      ts: event.ts,
      summary: event.summary,
      why: event.why,
      scope: event.scope,
      artifacts: event.artifacts ?? [],
    });
    state.decisions = state.decisions.slice(0, 50);
  }

  if (event.eventType === "risk") {
    const risk = {
      id: event.id,
      ts: event.ts,
      title: event.summary,
      status: event.status ?? "open",
      severity: event.severity ?? "medium",
      scope: event.scope,
    };
    const existing = state.risks.findIndex((item) => item.title === risk.title);
    if (existing === -1) state.risks.push(risk);
    else state.risks[existing] = { ...state.risks[existing], ...risk };
  }

  if (event.eventType === "feature_created" || event.eventType === "feature_status_change") {
    mergeFeature(state, {
      id: event.scope?.featureId ?? event.featureId,
      title: event.title ?? event.summary,
      status: event.status ?? (event.eventType === "feature_created" ? "story-draft" : "updated"),
      passes: event.passes === true,
      classification: event.classification,
      storyPath: event.storyPath,
      adrPath: event.adrPath,
      assignedReviewer: event.assignedReviewer,
      updatedAt: event.ts,
    });
  }

  if (event.eventType === "scope_change" && event.phaseId) {
    const phase = state.phases.find((item) => item.id === event.phaseId);
    if (phase) {
      phase.scope = phase.scope ?? { in: [], out: [] };
      for (const item of toArray(event.scopeIn)) {
        if (!phase.scope.in.includes(item)) phase.scope.in.push(item);
      }
      for (const item of toArray(event.scopeOut)) {
        if (!phase.scope.out.includes(item)) phase.scope.out.push(item);
      }
    }
  }

  state.lastMemoryEventAt = event.ts;
  state.updatedAt = event.ts;
  writeJson(statePath, state);
  return state;
}

export function appendMemoryEvent(cwd = process.cwd(), event = {}, options = {}) {
  if (process.env.AHK_DISABLE_MEMORY === "1") {
    return { skipped: true, reason: "AHK_DISABLE_MEMORY=1" };
  }
  const ts = event.ts ?? nowIso();
  const eventType = event.eventType ?? event.type ?? "action";
  const record = redactValue({
    schemaVersion: "1",
    id: event.id ?? nextEventId(eventType, ts),
    ts,
    actor: event.actor ?? {
      type: event.actorType ?? "agent",
      name: event.actorName ?? "unknown",
    },
    eventType,
    scope: event.scope ?? {
      phaseId: event.phaseId,
      featureId: event.featureId,
    },
    summary: event.summary ?? "",
    why: event.why,
    status: event.status,
    severity: event.severity,
    title: event.title,
    classification: event.classification,
    storyPath: event.storyPath,
    adrPath: event.adrPath,
    assignedReviewer: event.assignedReviewer,
    passes: event.passes,
    artifacts: event.artifacts ?? [],
    sensitivity: event.sensitivity ?? "normal",
    tags: event.tags ?? [],
    source: event.source ?? "project-memory",
  });

  if (!record.summary) {
    throw new Error("memory event requires summary");
  }

  const ledgerPath = resolve(cwd, options.ledgerPath ?? DEFAULT_LEDGER_PATH);
  ensureDir(ledgerPath);
  appendFileSync(ledgerPath, JSON.stringify(record) + "\n");

  if (SEMANTIC_TYPES.has(record.eventType)) {
    updateStateFromEvent(cwd, record, options);
  } else {
    ensureProjectState(cwd, options);
  }
  refreshMemorySummary(cwd, options);
  return record;
}

function eventFromRememberArgs(opts, stdinText) {
  const summary = opts.summary || opts._.join(" ") || stdinText.trim();
  return {
    eventType: opts.type || "decision",
    summary,
    why: opts.why,
    phaseId: opts.phase || opts.phaseId || opts["phase-id"],
    featureId: opts.feature || opts.featureId || opts["feature-id"],
    actor: {
      type: opts.actorType || opts["actor-type"] || "human",
      name: opts.actor || opts.actorName || opts["actor-name"] || "user",
    },
    sensitivity: opts.sensitivity || "normal",
    tags: toArray(opts.tag),
    artifacts: parseArtifacts(opts.artifact),
    source: "remember-project",
  };
}

function eventFromSessionEnd(cwd, opts, stdinText) {
  let input = {};
  if (stdinText.trim()) {
    try {
      input = JSON.parse(stdinText);
    } catch {
      input = {};
    }
  }
  const reason = opts.reason || opts.endReason || input.end_reason || input.reason || "unknown";
  const sessionId = opts.sessionId || opts["session-id"] || opts.session_id || input.session_id || "";
  return {
    eventType: "session_summary",
    summary: `Session ended: reason=${reason}${sessionId ? `, session=${sessionId}` : ""}`,
    phaseId: opts.phase || opts.phaseId || opts["phase-id"],
    actor: { type: "agent", name: "session-end" },
    source: "SessionEnd",
    artifacts: [
      ...(opts.branch ? [{ type: "git-branch", value: opts.branch }] : []),
      ...(opts.sha ? [{ type: "git-sha", value: opts.sha }] : []),
      { type: "file", value: ".harness/PROGRESS.md" },
      { type: "file", value: ".harness/telemetry.jsonl" },
    ],
    tags: ["session"],
  };
}

export function buildMemorySummary(cwd = process.cwd(), options = {}) {
  const state = ensureProjectState(cwd, options);
  const ledger = readLedger(cwd, options);
  const features = [...state.features];
  for (const feature of readFeatureList(cwd)) mergeFeature({ features }, feature);

  const activePhase = state.phases.find((phase) => phase.id === state.currentPhase) ?? state.phases[0];
  const openFeatures = features.filter((feature) =>
    feature.passes !== true && !["done", "shipped", "cancelled"].includes(String(feature.status ?? "")),
  );
  const openRisks = state.risks.filter((risk) => String(risk.status ?? "open") !== "closed");
  const maxEvents = Number(options.maxEvents ?? 5);
  const recent = ledger
    .filter((event) => SEMANTIC_TYPES.has(event.eventType))
    .slice(-maxEvents)
    .reverse();

  const lines = [];
  lines.push(`[harness] project: phase=${state.currentPhase}, open_features=${openFeatures.length}, open_risks=${openRisks.length}`);
  if (activePhase?.scope?.in?.length) {
    lines.push(`[harness] scope-in: ${activePhase.scope.in.slice(0, 5).join(", ")}`);
  }
  if (activePhase?.scope?.out?.length) {
    lines.push(`[harness] scope-out: ${activePhase.scope.out.slice(0, 5).join(", ")}`);
  }
  const latestDecision = state.decisions[0];
  if (latestDecision?.summary) {
    lines.push(`[harness] latest decision: ${latestDecision.summary}`);
  }
  if (recent.length > 0) {
    lines.push("[harness] recent project memory:");
    for (const event of recent) {
      lines.push(`  - ${event.eventType}: ${event.summary}`);
    }
  }
  return lines.join("\n");
}

export function refreshMemorySummary(cwd = process.cwd(), options = {}) {
  if (process.env.AHK_DISABLE_MEMORY === "1") return "";
  const summary = buildMemorySummary(cwd, options);
  const summaryPath = resolve(cwd, options.summaryPath ?? DEFAULT_SUMMARY_PATH);
  ensureDir(summaryPath);
  writeFileSync(summaryPath, summary + "\n");
  return summary;
}

export function collectProjectStatus(cwd = process.cwd(), options = {}) {
  const state = ensureProjectState(cwd, options);
  const ledger = readLedger(cwd, options);
  const featureList = readFeatureList(cwd).map(sanitizeFeature).filter(Boolean);
  const mergedFeatures = [...state.features];
  for (const feature of featureList) mergeFeature({ features: mergedFeatures }, feature);
  const openFeatures = mergedFeatures.filter((feature) =>
    feature.passes !== true && !["done", "shipped", "cancelled"].includes(String(feature.status ?? "")),
  );
  const openRisks = state.risks.filter((risk) => String(risk.status ?? "open") !== "closed");
  return {
    generatedAt: nowIso(),
    state,
    ledger,
    features: mergedFeatures,
    openFeatures,
    openRisks,
    recentEvents: ledger.slice(-20).reverse(),
    harnessHealth: collectHarnessHealth(cwd),
  };
}

function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function rows(items, mapper, emptyCols = 1) {
  if (!items.length) return `<tr><td colspan="${emptyCols}">None recorded.</td></tr>`;
  return items.map(mapper).join("\n");
}

export function renderProjectStatusHtml(data) {
  const activePhase = data.state.phases.find((phase) => phase.id === data.state.currentPhase) ?? data.state.phases[0];
  const doneFeatures = data.features.filter((feature) => feature.passes === true || feature.status === "done").length;
  const events = data.ledger.length;
  const orchestration = data.harnessHealth?.orchestration ?? summarizeOrchestrationHealth([], []);
  const sessionIsolation = data.harnessHealth?.sessionIsolation ?? summarizeSessionIsolation([], [], {});
  const structuralBaseline = data.harnessHealth?.structuralBaseline ?? summarizeStructuralBaseline(process.cwd());
  const orchestrationStatuses = orchestration.runs.statuses;
  const reasons = (items) => items?.length ? htmlEscape(items.join("; ")) : "none";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(data.state.project.name)} - Project Status</title>
  <style>
    :root{--bg:#f7f8fa;--ink:#17202a;--muted:#5b6472;--panel:#fff;--line:#d9dee7;--accent:#0f766e;--warn:#b45309}
    body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.55}
    header{background:#0b1320;color:#fff;padding:36px 24px;border-bottom:5px solid var(--accent)}
    main{max-width:1120px;margin:0 auto;padding:24px}
    h1,h2,h3{margin:0;line-height:1.2} h1{font-size:38px} h2{margin-top:30px;margin-bottom:12px;font-size:24px}
    .muted{color:var(--muted)} .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
    .card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px;box-shadow:0 1px 2px rgba(15,23,42,.05)}
    .stat{font-size:34px;font-weight:800;margin-top:4px}.pill{display:inline-block;padding:3px 8px;border-radius:999px;background:#e7f6f2;color:#0f766e;font-size:13px;font-weight:650}
    .status-pass{background:#e7f6f2;color:#0f766e}.status-warn{background:#fff7ed;color:#b45309}.status-fail{background:#fee2e2;color:#b91c1c}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden} th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top} th{background:#eef2f7;font-size:12px;text-transform:uppercase;letter-spacing:.02em} tr:last-child td{border-bottom:0}
    code{background:#eef2f7;border-radius:4px;padding:1px 4px}.event{border-left:4px solid var(--accent);padding:10px 12px;background:#fff;border-radius:6px;margin:8px 0}.warn{border-left-color:var(--warn)}
    @media(max-width:900px){.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <header>
    <h1>${htmlEscape(data.state.project.name)} - Project Status</h1>
    <p class="muted">Generated ${htmlEscape(data.generatedAt)} from <code>.harness/project/state.json</code> and <code>.harness/memory/ledger.jsonl</code>.</p>
  </header>
  <main>
    <section class="grid">
      <article class="card"><span class="pill">Phase</span><div class="stat">${htmlEscape(data.state.currentPhase)}</div><p>${htmlEscape(activePhase?.title ?? "")}</p></article>
      <article class="card"><span class="pill">Features</span><div class="stat">${doneFeatures}/${data.features.length}</div><p class="muted">done / total</p></article>
      <article class="card"><span class="pill">Open risks</span><div class="stat">${data.openRisks.length}</div><p class="muted">tracked in project state</p></article>
      <article class="card"><span class="pill">Memory events</span><div class="stat">${events}</div><p class="muted">semantic ledger rows</p></article>
      <article class="card"><span class="pill status-${htmlEscape(structuralBaseline.status)}">Structural baseline</span><div class="stat">${htmlEscape(structuralBaseline.status)}</div><p class="muted">${structuralBaseline.count} baseline entries</p></article>
      <article class="card"><span class="pill status-${htmlEscape(orchestration.status)}">Orchestration</span><div class="stat">${htmlEscape(orchestration.status)}</div><p class="muted">${orchestration.contracts.total} contracts / ${orchestration.runs.total} runs</p></article>
      <article class="card"><span class="pill status-${htmlEscape(sessionIsolation.status)}">Session isolation</span><div class="stat">${htmlEscape(sessionIsolation.status)}</div><p class="muted">${sessionIsolation.requiredTasks.length} isolation-required tasks</p></article>
    </section>

    <h2>Harness Control Plane</h2>
    <table>
      <thead><tr><th>Surface</th><th>Status</th><th>Counts</th><th>Reasons</th></tr></thead>
      <tbody>
        <tr>
          <td>Structural baseline</td>
          <td><span class="pill status-${htmlEscape(structuralBaseline.status)}">${htmlEscape(structuralBaseline.status)}</span></td>
          <td>${structuralBaseline.count} entries${structuralBaseline.comparison.exists ? `; ${htmlEscape(structuralBaseline.comparison.ref)} ${structuralBaseline.comparison.count}; delta ${structuralBaseline.comparison.delta >= 0 ? "+" : ""}${structuralBaseline.comparison.delta}` : ""}</td>
          <td>${reasons(structuralBaseline.reasons)}</td>
        </tr>
        <tr>
          <td>Orchestration</td>
          <td><span class="pill status-${htmlEscape(orchestration.status)}">${htmlEscape(orchestration.status)}</span></td>
          <td>${orchestration.contracts.total} contracts; ${orchestration.contracts.reviewGated} review-gated; ${orchestration.contracts.mutating} mutating; ${orchestration.runs.total} runs (${orchestrationStatuses.passed} passed, ${orchestrationStatuses.failed} failed, ${orchestrationStatuses.cancelled} cancelled, ${orchestrationStatuses.unknown} unknown)</td>
          <td>${reasons(orchestration.reasons)}</td>
        </tr>
        <tr>
          <td>Session isolation</td>
          <td><span class="pill status-${htmlEscape(sessionIsolation.status)}">${htmlEscape(sessionIsolation.status)}</span></td>
          <td>${sessionIsolation.manifests} manifests; ${sessionIsolation.requiredTasks.length} required tasks; ${sessionIsolation.missingSessionTasks.length} missing; ${sessionIsolation.staleSessions.length} stale</td>
          <td>${reasons(sessionIsolation.reasons)}</td>
        </tr>
      </tbody>
    </table>

    <h3>Isolation Required Tasks</h3>
    <table>
      <thead><tr><th>Task</th><th>Risk</th><th>Reasons</th><th>Session</th></tr></thead>
      <tbody>
        ${rows(sessionIsolation.requiredTasks, (task) => `<tr><td><code>${htmlEscape(task.id)}</code></td><td>${htmlEscape(task.riskTier ?? "")}</td><td>${htmlEscape(task.reasons.join(", "))}</td><td>${sessionIsolation.missingSessionTasks.includes(task.id) ? "missing" : "recorded"}</td></tr>`, 4)}
      </tbody>
    </table>

    <h2>Phases</h2>
    <table>
      <thead><tr><th>ID</th><th>Status</th><th>Goals</th><th>Exit criteria</th></tr></thead>
      <tbody>
        ${rows(data.state.phases, (phase) => `<tr><td><code>${htmlEscape(phase.id)}</code></td><td>${htmlEscape(phase.status)}</td><td>${htmlEscape((phase.goals ?? []).join(", "))}</td><td>${htmlEscape((phase.exitCriteria ?? []).join(", "))}</td></tr>`, 4)}
      </tbody>
    </table>

    <h2>Features</h2>
    <table>
      <thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Story</th></tr></thead>
      <tbody>
        ${rows(data.features, (feature) => `<tr><td><code>${htmlEscape(feature.id)}</code></td><td>${htmlEscape(feature.title)}</td><td>${htmlEscape(feature.status ?? (feature.passes ? "done" : "open"))}</td><td>${feature.storyPath ? `<code>${htmlEscape(feature.storyPath)}</code>` : ""}</td></tr>`, 4)}
      </tbody>
    </table>

    <h2>Open Risks</h2>
    <table>
      <thead><tr><th>Risk</th><th>Severity</th><th>Status</th></tr></thead>
      <tbody>
        ${rows(data.openRisks, (risk) => `<tr><td>${htmlEscape(risk.title)}</td><td>${htmlEscape(risk.severity)}</td><td>${htmlEscape(risk.status)}</td></tr>`, 3)}
      </tbody>
    </table>

    <h2>Recent Project Memory</h2>
    ${data.recentEvents.length ? data.recentEvents.map((event) => `<div class="event ${event.eventType === "risk" ? "warn" : ""}"><strong>${htmlEscape(event.eventType)}</strong> <span class="muted">${htmlEscape(event.ts)}</span><br>${htmlEscape(event.summary)}</div>`).join("\n") : "<p>No memory events recorded yet.</p>"}
  </main>
</body>
</html>
`;
}

export function exportHandoff(cwd = process.cwd(), options = {}) {
  const outPath = resolve(cwd, options.out ?? DEFAULT_HANDOFF_PATH);
  const status = collectProjectStatus(cwd, options);
  const payload = {
    schemaVersion: "1",
    exportedAt: nowIso(),
    project: status.state.project,
    currentPhase: status.state.currentPhase,
    state: status.state,
    harnessHealth: status.harnessHealth,
    recentMemory: status.recentEvents,
  };
  writeJson(outPath, payload);
  return { outPath, payload };
}

function printUsage() {
  console.error(`Usage:
  node .harness/scripts/project-memory.mjs init
  node .harness/scripts/project-memory.mjs remember --summary "..." [--type decision|risk|action] [--why "..."]
  node .harness/scripts/project-memory.mjs feature-created --feature-id F --title "..." [--story-path path]
  node .harness/scripts/project-memory.mjs session-end --reason clear [--session-id id] [--branch main] [--sha abc123]
  node .harness/scripts/project-memory.mjs summarize
  node .harness/scripts/project-memory.mjs status-json
  node .harness/scripts/project-memory.mjs export --out .harness/project/handoff.json`);
}

function main(argv) {
  const [cmd = "summarize", ...rest] = argv;
  const opts = parseArgs(rest);
  const cwd = process.cwd();
  const stdinText = readStdinIfPiped();

  if (cmd === "init") {
    ensureProjectState(cwd);
    const summary = refreshMemorySummary(cwd);
    console.log(JSON.stringify({ status: "ok", summaryPath: DEFAULT_SUMMARY_PATH, summary }, null, 2));
    return;
  }

  if (cmd === "remember") {
    const event = appendMemoryEvent(cwd, eventFromRememberArgs(opts, stdinText));
    console.log(JSON.stringify(event, null, 2));
    return;
  }

  if (cmd === "feature-created") {
    const event = appendMemoryEvent(cwd, {
      eventType: "feature_created",
      featureId: opts.featureId || opts["feature-id"] || opts.feature || opts.id,
      title: opts.title,
      summary: opts.summary || `Feature created: ${opts.title || opts.featureId || opts["feature-id"] || opts.id}`,
      classification: opts.classification,
      storyPath: opts.storyPath || opts["story-path"],
      adrPath: opts.adrPath || opts["adr-path"],
      assignedReviewer: opts.reviewer || opts.assignedReviewer,
      status: opts.status || "story-draft",
      actor: { type: "agent", name: "create-story" },
      source: "create-story",
      artifacts: parseArtifacts(opts.artifact),
      tags: ["feature", "project-management"],
    });
    console.log(JSON.stringify(event, null, 2));
    return;
  }

  if (cmd === "session-end") {
    const event = appendMemoryEvent(cwd, eventFromSessionEnd(cwd, opts, stdinText));
    console.log(JSON.stringify(event, null, 2));
    return;
  }

  if (cmd === "summarize" || cmd === "summary") {
    process.stdout.write(buildMemorySummary(cwd, { maxEvents: opts.maxEvents }) + "\n");
    return;
  }

  if (cmd === "status-json") {
    console.log(JSON.stringify(collectProjectStatus(cwd), null, 2));
    return;
  }

  if (cmd === "export") {
    const result = exportHandoff(cwd, { out: opts.out });
    console.log(JSON.stringify({ status: "created", out: result.outPath }, null, 2));
    return;
  }

  printUsage();
  process.exit(2);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exit(2);
  }
}

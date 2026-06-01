#!/usr/bin/env node
// check-trace-corpus.mjs - validate sanitized harness trace corpus entries.
//
// The public trace corpus is intentionally small and deterministic. It gives
// eval tasks and model-routing reports realistic task outcomes without leaking
// private paths, hosts, users, secrets, or repository content.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const DEFAULT_REQUIRED_TRACE_CASES = [
  "success-tiny",
  "success-normal",
  "success-high-risk",
  "false-done",
  "overbroad-edit",
  "missing-reviewer",
  "evidence-replay-failure",
  "bypass-approval-flow",
  "runtime-parity-failure",
];

const TRACE_CASES = new Set(DEFAULT_REQUIRED_TRACE_CASES);
const SOURCE_VALUES = new Set(["sanitized-real-pattern", "synthetic-regression-pattern"]);
const RUNTIME_VALUES = new Set(["claude", "codex", "dual"]);
const TASK_TYPES = new Set(["feature", "bugfix", "refactor", "release", "docs", "harness"]);
const RISK_TIERS = new Set(["tiny", "normal", "high-risk"]);
const OUTCOME_STATUS = new Set(["pass", "blocked", "failed", "needs-human"]);
const FAILURE_CLASSES = new Set([
  null,
  "context-miss",
  "false-done",
  "architecture-drift",
  "test-gap",
  "doc-drift",
  "tool-misuse",
  "permission-gap",
  "runtime-gap",
  "eval-gap",
  "cost-spike",
  "model-behavior",
]);
const EVAL_KINDS = new Set(["command", "artifact", "review", "gate", "telemetry"]);
const EVAL_STATUS = new Set(["pass", "fail", "blocked", "warning"]);
const ACTORS = new Set(["user", "agent", "harness", "reviewer", "runtime"]);
const REDACTION_KINDS = new Set(["repo", "path", "user", "host", "secret", "content"]);
const STABLE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const REDACTION_RE = /^[a-z]+:\/\/[a-z0-9._-]+$|^<redacted-[a-z0-9._-]+>$/;

const LEAK_PATTERNS = [
  { id: "absolute-user-path", re: /\/Users\/[A-Za-z0-9._-]+/ },
  { id: "absolute-home-path", re: /\/home\/[A-Za-z0-9._-]+/ },
  { id: "absolute-var-path", re: /\/var\/(?:folders|www|log|tmp)\b/ },
  { id: "windows-user-path", re: /\b[A-Za-z]:\\Users\\/ },
  { id: "email-address", re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
  { id: "http-url", re: /https?:\/\//i },
  { id: "openai-secret", re: /\bsk-[A-Za-z0-9_-]{12,}\b/ },
  { id: "github-token", re: /\bghp_[A-Za-z0-9_]{12,}\b/ },
  { id: "aws-access-key", re: /\bAKIA[0-9A-Z]{12,}\b/ },
  { id: "private-key", re: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/ },
  { id: "api-key-env", re: /\b(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|DATABASE_URL)\b/ },
];

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    json: false,
    corpusDir: "",
    case: "",
  };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--corpus-dir=")) opts.corpusDir = arg.slice("--corpus-dir=".length);
    else if (arg.startsWith("--case=")) opts.case = arg.slice("--case=".length).trim();
  }
  opts.cwd = resolve(opts.cwd);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const ROOT = opts.cwd;

function rel(path) {
  return relative(ROOT, path).replaceAll("\\", "/") || ".";
}

function isRepoLocal(path) {
  const r = relative(ROOT, path);
  return r === "" || (!r.startsWith("..") && !resolve(r).startsWith(".."));
}

function readJson(path, errors = []) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${rel(path)}: invalid JSON (${error.message})`);
    return null;
  }
}

function readConfig() {
  for (const candidate of [".harness/config.json", "harness.config.json", "src/templates/harness.config.json.hbs"]) {
    const path = resolve(ROOT, candidate);
    if (!existsSync(path)) continue;
    const errors = [];
    const parsed = readJson(path, errors);
    if (parsed) return parsed;
  }
  return {};
}

function chooseCorpusDir(config) {
  if (opts.corpusDir) return resolve(ROOT, opts.corpusDir);
  const configured = config.traceCorpus?.corpusDir;
  if (typeof configured === "string" && configured.trim()) {
    const configuredPath = resolve(ROOT, configured);
    if (existsSync(configuredPath)) return configuredPath;
  }
  for (const candidate of ["src/templates/.harness/trace-corpus", ".harness/trace-corpus"]) {
    const path = resolve(ROOT, candidate);
    if (existsSync(path)) return path;
  }
  return resolve(ROOT, typeof configured === "string" && configured.trim() ? configured : ".harness/trace-corpus");
}

function requiredCases(config) {
  if (opts.case) return [opts.case];
  const configured = config.traceCorpus?.requiredCases;
  if (Array.isArray(configured) && configured.length > 0) return configured;
  return DEFAULT_REQUIRED_TRACE_CASES;
}

function addShapeError(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function expectStableId(value, path, errors) {
  if (!STABLE_ID_RE.test(String(value || ""))) addShapeError(errors, path, "must be a stable lowercase id");
}

function expectString(value, path, errors, minLength = 1) {
  if (typeof value !== "string" || value.trim().length < minLength) {
    addShapeError(errors, path, `must be a string with at least ${minLength} character(s)`);
  }
}

function expectArray(value, path, errors, minItems = 0) {
  if (!Array.isArray(value)) {
    addShapeError(errors, path, "must be an array");
    return [];
  }
  if (value.length < minItems) addShapeError(errors, path, `must contain at least ${minItems} item(s)`);
  return value;
}

function expectOneOf(value, values, path, errors) {
  if (!values.has(value)) addShapeError(errors, path, `must be one of ${[...values].join(", ")}`);
}

function validateNoUnknownKeys(value, allowed, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    addShapeError(errors, path, "must be an object");
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) addShapeError(errors, `${path}.${key}`, "is not supported");
  }
}

function validateLeakScan(raw, file, errors) {
  for (const pattern of LEAK_PATTERNS) {
    if (pattern.re.test(raw)) errors.push(`${rel(file)}: possible unsanitized ${pattern.id}`);
  }
}

function validateEntry(entry, file, raw, errors) {
  validateLeakScan(raw, file, errors);
  validateNoUnknownKeys(entry, [
    "schemaVersion",
    "id",
    "case",
    "title",
    "sanitized",
    "source",
    "runtime",
    "task",
    "outcome",
    "modelRouting",
    "evalSignals",
    "events",
    "redactions",
  ], rel(file), errors);

  if (entry.schemaVersion !== 1) addShapeError(errors, `${rel(file)}.schemaVersion`, "must be 1");
  expectStableId(entry.id, `${rel(file)}.id`, errors);
  expectOneOf(entry.case, TRACE_CASES, `${rel(file)}.case`, errors);
  expectString(entry.title, `${rel(file)}.title`, errors, 12);
  if (entry.sanitized !== true) addShapeError(errors, `${rel(file)}.sanitized`, "must be true");
  expectOneOf(entry.source, SOURCE_VALUES, `${rel(file)}.source`, errors);
  expectOneOf(entry.runtime, RUNTIME_VALUES, `${rel(file)}.runtime`, errors);

  validateNoUnknownKeys(entry.task, ["id", "type", "riskTier", "acceptance"], `${rel(file)}.task`, errors);
  expectStableId(entry.task?.id, `${rel(file)}.task.id`, errors);
  expectOneOf(entry.task?.type, TASK_TYPES, `${rel(file)}.task.type`, errors);
  expectOneOf(entry.task?.riskTier, RISK_TIERS, `${rel(file)}.task.riskTier`, errors);
  for (const [idx, acceptance] of expectArray(entry.task?.acceptance, `${rel(file)}.task.acceptance`, errors, 1).entries()) {
    expectStableId(acceptance, `${rel(file)}.task.acceptance[${idx}]`, errors);
  }

  validateNoUnknownKeys(entry.outcome, ["status", "failureClass", "blockedBy"], `${rel(file)}.outcome`, errors);
  expectOneOf(entry.outcome?.status, OUTCOME_STATUS, `${rel(file)}.outcome.status`, errors);
  expectOneOf(entry.outcome?.failureClass ?? null, FAILURE_CLASSES, `${rel(file)}.outcome.failureClass`, errors);
  const blockedBy = expectArray(entry.outcome?.blockedBy, `${rel(file)}.outcome.blockedBy`, errors, 0);
  for (const [idx, blocker] of blockedBy.entries()) {
    expectStableId(blocker, `${rel(file)}.outcome.blockedBy[${idx}]`, errors);
  }

  validateNoUnknownKeys(entry.modelRouting, [
    "lane",
    "model",
    "expectedModel",
    "success",
    "costUsd",
    "inputTokens",
    "outputTokens",
  ], `${rel(file)}.modelRouting`, errors);
  expectStableId(entry.modelRouting?.lane, `${rel(file)}.modelRouting.lane`, errors);
  expectString(entry.modelRouting?.model, `${rel(file)}.modelRouting.model`, errors, 3);
  expectString(entry.modelRouting?.expectedModel, `${rel(file)}.modelRouting.expectedModel`, errors, 3);
  if (typeof entry.modelRouting?.success !== "boolean") addShapeError(errors, `${rel(file)}.modelRouting.success`, "must be boolean");
  if (typeof entry.modelRouting?.costUsd !== "number" || entry.modelRouting.costUsd < 0) {
    addShapeError(errors, `${rel(file)}.modelRouting.costUsd`, "must be a nonnegative number");
  }
  for (const key of ["inputTokens", "outputTokens"]) {
    if (!Number.isInteger(entry.modelRouting?.[key]) || entry.modelRouting[key] < 0) {
      addShapeError(errors, `${rel(file)}.modelRouting.${key}`, "must be a nonnegative integer");
    }
  }

  const evalSignals = expectArray(entry.evalSignals, `${rel(file)}.evalSignals`, errors, 1);
  for (const [idx, signal] of evalSignals.entries()) {
    const path = `${rel(file)}.evalSignals[${idx}]`;
    validateNoUnknownKeys(signal, ["id", "kind", "status", "summary"], path, errors);
    expectStableId(signal?.id, `${path}.id`, errors);
    expectOneOf(signal?.kind, EVAL_KINDS, `${path}.kind`, errors);
    expectOneOf(signal?.status, EVAL_STATUS, `${path}.status`, errors);
    expectString(signal?.summary, `${path}.summary`, errors, 8);
  }

  const events = expectArray(entry.events, `${rel(file)}.events`, errors, 2);
  for (const [idx, event] of events.entries()) {
    const path = `${rel(file)}.events[${idx}]`;
    validateNoUnknownKeys(event, ["step", "actor", "event", "summary"], path, errors);
    if (event?.step !== idx + 1) addShapeError(errors, `${path}.step`, `must be ${idx + 1}`);
    expectOneOf(event?.actor, ACTORS, `${path}.actor`, errors);
    expectStableId(event?.event, `${path}.event`, errors);
    expectString(event?.summary, `${path}.summary`, errors, 8);
  }

  const redactions = expectArray(entry.redactions, `${rel(file)}.redactions`, errors, 1);
  for (const [idx, redaction] of redactions.entries()) {
    const path = `${rel(file)}.redactions[${idx}]`;
    validateNoUnknownKeys(redaction, ["kind", "replacement"], path, errors);
    expectOneOf(redaction?.kind, REDACTION_KINDS, `${path}.kind`, errors);
    if (!REDACTION_RE.test(String(redaction?.replacement || ""))) {
      addShapeError(errors, `${path}.replacement`, "must be a stable redaction token");
    }
  }

  if (entry.outcome?.status === "pass") {
    if (entry.outcome.failureClass !== null) addShapeError(errors, `${rel(file)}.outcome.failureClass`, "passing entries must use null");
    if (blockedBy.length > 0) addShapeError(errors, `${rel(file)}.outcome.blockedBy`, "passing entries cannot be blocked");
    if (entry.modelRouting?.success !== true) addShapeError(errors, `${rel(file)}.modelRouting.success`, "passing entries must set success=true");
    for (const [idx, signal] of evalSignals.entries()) {
      if (signal.status === "fail" || signal.status === "blocked") {
        addShapeError(errors, `${rel(file)}.evalSignals[${idx}].status`, "passing entries cannot include failed or blocked signals");
      }
    }
  } else {
    if (entry.modelRouting?.success !== false) addShapeError(errors, `${rel(file)}.modelRouting.success`, "non-passing entries must set success=false");
    if (entry.outcome?.failureClass === null && blockedBy.length === 0) {
      addShapeError(errors, `${rel(file)}.outcome`, "non-passing entries need failureClass or blockedBy");
    }
  }

  return entry;
}

function listCorpusFiles(corpusDir) {
  if (!existsSync(corpusDir)) return [];
  return readdirSync(corpusDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(corpusDir, entry.name))
    .sort();
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function summarizeModelRouting(entries) {
  const byLane = {};
  for (const entry of entries) {
    const lane = entry.modelRouting?.lane || "unknown";
    const current = byLane[lane] || {
      entries: 0,
      passes: 0,
      failures: 0,
      totalCost: 0,
      totalTokens: 0,
      models: {},
      cases: {},
    };
    current.entries += 1;
    if (entry.outcome?.status === "pass") current.passes += 1;
    else current.failures += 1;
    current.totalCost += entry.modelRouting?.costUsd || 0;
    current.totalTokens += (entry.modelRouting?.inputTokens || 0) + (entry.modelRouting?.outputTokens || 0);
    increment(current.models, entry.modelRouting?.model || "unknown");
    increment(current.cases, entry.case || "unknown");
    byLane[lane] = current;
  }
  return {
    lanes: Object.keys(byLane).sort(),
    byLane,
  };
}

function main() {
  const config = readConfig();
  const corpusDir = chooseCorpusDir(config);
  const errors = [];
  const warnings = [];
  const required = requiredCases(config);

  for (const caseId of required) {
    if (!TRACE_CASES.has(caseId)) errors.push(`traceCorpus.requiredCases: unsupported case "${caseId}"`);
  }
  if (!isRepoLocal(corpusDir)) errors.push(`${corpusDir}: corpus dir must be inside the repository`);
  if (!existsSync(corpusDir)) errors.push(`${rel(corpusDir)}: trace corpus directory not found`);

  const entries = [];
  const files = listCorpusFiles(corpusDir);
  if (files.length === 0 && existsSync(corpusDir)) errors.push(`${rel(corpusDir)}: no .json corpus entries found`);
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const entry = readJson(file, errors);
    if (!entry) continue;
    entries.push(validateEntry(entry, file, raw, errors));
  }

  const cases = {};
  const outcomes = {};
  const runtimes = {};
  for (const entry of entries) {
    increment(cases, entry.case);
    increment(outcomes, entry.outcome?.status || "unknown");
    increment(runtimes, entry.runtime || "unknown");
  }
  for (const caseId of required) {
    if (!cases[caseId]) errors.push(`${rel(corpusDir)}: required trace case "${caseId}" is missing`);
  }

  const payload = {
    status: errors.length === 0 ? "passed" : "failed",
    corpusDir: rel(corpusDir),
    entries: entries.length,
    cases,
    outcomes,
    runtimes,
    modelRouting: summarizeModelRouting(entries),
    errors,
    warnings,
  };

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (payload.status === "passed") {
    console.log(`trace corpus: OK (${payload.entries} entries, ${Object.keys(payload.cases).length} cases)`);
  } else {
    console.error("trace corpus: FAILED");
    for (const error of errors) console.error(`- ${error}`);
    for (const warning of warnings) console.warn(`warning: ${warning}`);
  }

  process.exit(payload.status === "passed" ? 0 : 1);
}

main();

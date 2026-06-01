#!/usr/bin/env node
// check-evidence-attestation.mjs - strict attestation gate for passing evidence.
// It reuses task-evidence-check for schema/hash/replay-plan validation, then
// enforces that pass evidence has complete command attestations.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const STABLE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    evidenceDir: "",
    task: "",
    json: false,
    strict: false,
  };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--evidence-dir=")) opts.evidenceDir = arg.slice("--evidence-dir=".length).trim();
    else if (arg.startsWith("--task=")) opts.task = arg.slice("--task=".length).trim();
  }
  opts.cwd = resolve(opts.cwd);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const ROOT = opts.cwd;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const errors = [];
const warnings = [];

function rel(path) {
  return relative(ROOT, path).replaceAll("\\", "/") || ".";
}

function normalizeRel(path) {
  return String(path || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function insideRoot(path) {
  const root = ROOT.endsWith("/") ? ROOT : `${ROOT}/`;
  return path === ROOT || path.startsWith(root);
}

function isSafeLocalPath(value) {
  const text = String(value || "").trim();
  if (!text || text.startsWith("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return false;
  const normalized = normalizeRel(text);
  if (normalized.split("/").includes("..")) return false;
  return insideRoot(resolve(ROOT, text));
}

function readJson(path, label = rel(path)) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${label}: invalid JSON (${error.message})`);
    return null;
  }
}

function readConfig() {
  for (const candidate of [".harness/config.json", "harness.config.json"]) {
    const path = resolve(ROOT, candidate);
    if (!existsSync(path)) continue;
    const parsed = readJson(path, rel(path));
    return parsed && typeof parsed === "object" ? parsed : {};
  }
  return {};
}

function defaultEvidenceDir(config) {
  if (opts.evidenceDir) return opts.evidenceDir;
  return config.taskContracts?.evidenceDir || ".harness/evidence";
}

function sha256File(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function discoverEvidenceFiles(evidenceDir) {
  const absDir = resolve(ROOT, evidenceDir);
  if (!existsSync(absDir)) {
    warnings.push(`${evidenceDir}: evidence directory not found; no attestations to validate`);
    return [];
  }
  return readdirSync(absDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(absDir, entry.name))
    .filter((path) => !opts.task || path === resolve(absDir, `${opts.task}.json`))
    .sort();
}

function validateHashPair({ evidencePath, check, idx, stream }) {
  const pathKey = `${stream}Path`;
  const hashKey = `${stream}Hash`;
  const prefix = `${rel(evidencePath)}: checks[${idx}]`;
  const pathValue = check?.[pathKey];
  const hashValue = check?.[hashKey];
  let usable = true;
  if (typeof pathValue !== "string" || !pathValue.trim()) {
    errors.push(`${prefix}.${pathKey} is required for passing attested evidence`);
    usable = false;
  }
  if (typeof hashValue !== "string" || !SHA256_RE.test(hashValue)) {
    errors.push(`${prefix}.${hashKey} must be sha256:<64 lowercase hex chars>`);
    usable = false;
  }
  if (!usable) return;
  if (!isSafeLocalPath(pathValue)) {
    errors.push(`${prefix}.${pathKey} must be a safe repo-local path`);
    return;
  }
  const absPath = resolve(ROOT, pathValue);
  if (!existsSync(absPath)) {
    errors.push(`${prefix}.${pathKey} not found: ${pathValue}`);
    return;
  }
  const actual = sha256File(absPath);
  if (actual !== hashValue) errors.push(`${prefix}.${hashKey} does not match ${pathKey} (${actual})`);
}

function validateAttestedPassCheck({ evidencePath, evidence, check, idx }) {
  const prefix = `${rel(evidencePath)}: checks[${idx}]`;
  if (!STABLE_ID_RE.test(String(check?.name || ""))) errors.push(`${prefix}.name must be a stable lowercase id`);
  for (const field of ["command", "cwd", "startedAt", "finishedAt", "gitHead", "workingTreeHash"]) {
    if (typeof check?.[field] !== "string" || !check[field].trim()) {
      errors.push(`${prefix}.${field} is required for passing attested evidence`);
    }
  }
  if (!Number.isInteger(check?.exitCode)) errors.push(`${prefix}.exitCode must be an integer`);
  else if (check.exitCode !== 0) errors.push(`${prefix}.exitCode must be 0 for passing attested evidence`);
  if (check?.workingTreeHash && !SHA256_RE.test(check.workingTreeHash)) {
    errors.push(`${prefix}.workingTreeHash must be sha256:<64 lowercase hex chars>`);
  }
  validateHashPair({ evidencePath, check, idx, stream: "stdout" });
  validateHashPair({ evidencePath, check, idx, stream: "stderr" });
  if (!Array.isArray(check?.artifactPaths) || check.artifactPaths.length === 0) {
    errors.push(`${prefix}.artifactPaths must include attestation sidecars`);
  }
  if (check?.taskId && check.taskId !== evidence.taskId) {
    errors.push(`${prefix}.taskId must match evidence taskId ${evidence.taskId}`);
  }
}

function validateEvidenceFile(path) {
  const evidence = readJson(path, rel(path));
  if (!evidence) return null;
  if (!STABLE_ID_RE.test(String(evidence.taskId || ""))) {
    errors.push(`${rel(path)}: taskId must be a stable lowercase id`);
  }
  if (evidence.status !== "pass") return { taskId: evidence.taskId || "", passingChecks: 0 };
  if (!Array.isArray(evidence.checks) || evidence.checks.length === 0) {
    errors.push(`${rel(path)}: status=pass requires attested checks`);
    return { taskId: evidence.taskId || "", passingChecks: 0 };
  }
  let passingChecks = 0;
  for (const [idx, check] of evidence.checks.entries()) {
    if (check?.status !== "pass") continue;
    passingChecks += 1;
    validateAttestedPassCheck({ evidencePath: path, evidence, check, idx });
  }
  if (passingChecks === 0) errors.push(`${rel(path)}: status=pass requires at least one passing attested check`);
  return { taskId: evidence.taskId || "", passingChecks };
}

function runTaskEvidenceCheck() {
  const checker = resolve(SCRIPT_DIR, "task-evidence-check.mjs");
  if (!existsSync(checker)) {
    errors.push(`${rel(checker)}: task evidence checker not found`);
    return null;
  }
  const args = [checker, `--cwd=${ROOT}`, "--verify-hashes", "--replay-plan", "--json"];
  if (opts.strict) args.push("--strict");
  if (opts.task) args.push(`--task=${opts.task}`);
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
  });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout || "{}");
  } catch {
    payload = null;
  }
  if (result.status !== 0) {
    errors.push("task-evidence-check --verify-hashes --replay-plan failed");
    for (const error of payload?.errors || []) errors.push(error);
    if (result.stderr.trim()) errors.push(result.stderr.trim());
  }
  for (const warning of payload?.warnings || []) warnings.push(warning);
  return {
    status: result.status === 0 ? "pass" : "fail",
    exitCode: result.status,
    replayPlan: payload?.replayPlan || [],
  };
}

function main() {
  const config = readConfig();
  const evidenceDir = defaultEvidenceDir(config);
  if (!isSafeLocalPath(evidenceDir)) errors.push(`evidenceDir must be a safe repo-local path: ${evidenceDir}`);
  if (opts.task && !STABLE_ID_RE.test(opts.task)) errors.push(`--task must be a stable lowercase id: ${opts.task}`);
  const files = errors.length === 0 ? discoverEvidenceFiles(evidenceDir) : [];
  const evidence = [];
  for (const path of files) {
    const result = validateEvidenceFile(path);
    if (result) evidence.push({ path: rel(path), ...result });
  }
  const taskEvidence = errors.length === 0 ? runTaskEvidenceCheck() : null;
  const replayPlan = taskEvidence?.replayPlan || [];
  if (opts.strict && errors.length === 0) {
    const passingCheckCount = evidence.reduce((sum, item) => sum + item.passingChecks, 0);
    if (files.length > 0 && passingCheckCount > 0 && replayPlan.length === 0) {
      errors.push("strict attestation requires a non-empty replay plan for passing evidence");
    }
  }

  const payload = {
    status: errors.length === 0 ? "pass" : "fail",
    evidenceDir,
    evidence,
    taskEvidence,
    replayPlan,
    errors,
    warnings,
  };
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (payload.status === "pass") {
    console.log(`evidence attestation: OK (${evidence.length} evidence bundle(s), ${replayPlan.length} replay item(s))`);
    for (const warning of warnings) console.error(`warning: ${warning}`);
  } else {
    console.error("evidence attestation: FAILED");
    for (const error of errors) console.error(`- ${error}`);
    for (const warning of warnings) console.error(`warning: ${warning}`);
  }
  process.exit(payload.status === "pass" ? 0 : 1);
}

main();

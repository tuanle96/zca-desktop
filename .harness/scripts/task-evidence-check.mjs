#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { concreteCommand, validateProofCommand } from "./_lib/command-policy.mjs";
import { normalizePermission, overbroadSensitiveBashPermission } from "./_lib/permission-matching.mjs";

const DONE_REQUIRES = new Set(["structural", "lint", "tests", "smoke", "ui", "review", "evidence-bundle"]);
const RISK_TIERS = new Set(["tiny", "normal", "high-risk"]);
const TASK_TYPES = new Set(["feature", "bugfix", "refactor", "release", "docs", "harness"]);
const REVIEW_DECISIONS = new Set(["pass", "block", "needs-human"]);
const EVIDENCE_REVIEW_DECISIONS = new Set([...REVIEW_DECISIONS, "not-required"]);
const FINDING_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const KNOWN_RISK_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const KNOWN_RISK_DISPOSITIONS = new Set(["mitigated", "accepted", "open"]);
const TOOL_PERMISSION_RE = /^(Read|Edit|Write|MultiEdit|Grep|Glob|LS|TodoWrite|apply_patch|Bash\(.+\)|\*)$/;
const CHECK_ALIASES = {
  structural: ["structural", "structural-test", "harness:check"],
  lint: ["lint", "ruff", "clippy", "go vet", "detekt"],
  tests: ["tests", "test", "unit", "integration", "e2e"],
  smoke: ["smoke", "smoke-test"],
  ui: ["ui", "verify-ui", "ui-verification", "playwright"],
};
const MOCK_VERIFY_UI_RE = /(^|[\s;&|])(?:node\s+)?(?:\.harness\/scripts\/|scripts\/)?verify-ui\.mjs(?:\s+[^\n;&|]*)?--mock(?:\s|$)/i;
const VERIFY_UI_COMMAND_RE = /(^|[\s;&|])(?:node\s+)?(?:\.harness\/scripts\/|scripts\/)?verify-ui\.mjs(?:\s|$)/i;
const REQUIRED_VERIFY_UI_CHECKS = ["page-load", "screenshot", "console-errors", "network-failures"];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const REVIEW_REQUIRED_GATES = new Set(Object.keys(CHECK_ALIASES));

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    json: false,
    strict: false,
    verifyHashes: false,
    replayPlan: false,
    taskId: null,
    activeTask: null,
    activeTaskFrom: null,
    completionTranscript: null,
    completionIntent: false,
    stopMode: "off",
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "--json") opts.json = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg === "--verify-hashes") opts.verifyHashes = true;
    else if (arg === "--replay-plan") opts.replayPlan = true;
    else if (arg === "--task") opts.taskId = String(argv[++idx] || "").trim() || null;
    else if (arg.startsWith("--task=")) opts.taskId = arg.slice("--task=".length).trim() || null;
    else if (arg === "--active-task") opts.activeTaskFrom = ".harness/state/active-task.txt";
    else if (arg.startsWith("--active-task=")) opts.activeTask = arg.slice("--active-task=".length);
    else if (arg.startsWith("--active-task-from=")) opts.activeTaskFrom = arg.slice("--active-task-from=".length);
    else if (arg.startsWith("--completion-transcript=")) opts.completionTranscript = arg.slice("--completion-transcript=".length);
    else if (arg === "--completion-intent") opts.completionIntent = true;
    else if (arg.startsWith("--stop-mode=")) opts.stopMode = arg.slice("--stop-mode=".length);
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
  }
  if (!["off", "on-claim", "always"].includes(opts.stopMode)) {
    opts.stopMode = "off";
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const ROOT = resolve(opts.cwd);
const errors = [];
const warnings = [];
const reviewDecisionCache = new WeakMap();
let currentGitDiffCoverageFilesCache;
let currentGitDiffWarningEmitted = false;
const replayPlan = [];
const replayPlanKeys = new Set();

function rel(path) {
  return path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path;
}

function readJson(path, label = path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    errors.push(`${label}: invalid JSON (${err.message})`);
    return null;
  }
}

function insideRoot(path) {
  const normalizedRoot = ROOT.endsWith("/") ? ROOT : `${ROOT}/`;
  return path === ROOT || path.startsWith(normalizedRoot);
}

function readConfig() {
  const path = resolve(ROOT, ".harness/config.json");
  if (!existsSync(path)) return {};
  return readJson(path, rel(path)) || {};
}

function featureArray(doc) {
  if (Array.isArray(doc)) return doc;
  if (Array.isArray(doc?.features)) return doc.features;
  return [];
}

function validateFeatureListShape(doc, path) {
  const prefix = rel(path);
  if (Array.isArray(doc)) {
    validateFeatureItems(doc, prefix);
    return;
  }
  if (!doc || typeof doc !== "object") {
    errors.push(`${prefix}: feature list must be an object with features[] or a legacy array`);
    return;
  }
  if (doc.features !== undefined && !Array.isArray(doc.features)) {
    errors.push(`${prefix}: features must be an array`);
    return;
  }
  if (!Array.isArray(doc.features)) {
    warnings.push(`${prefix}: no features[] array found`);
    return;
  }
  if (doc.$schema && doc.$schema !== "./.harness/feature-list.schema.json") {
    warnings.push(`${prefix}: unexpected $schema "${doc.$schema}"`);
  }
  if (doc.version !== undefined && typeof doc.version !== "string") {
    errors.push(`${prefix}: version must be a string`);
  }
  if (doc.project !== undefined && typeof doc.project !== "string") {
    errors.push(`${prefix}: project must be a string`);
  }
  validateFeatureItems(doc.features, prefix);
}

function validateFeatureItems(features, prefix) {
  const seen = new Set();
  for (const [idx, feature] of features.entries()) {
    const itemPrefix = `${prefix}: features[${idx}]`;
    if (!feature || typeof feature !== "object" || Array.isArray(feature)) {
      errors.push(`${itemPrefix} must be an object`);
      continue;
    }
    const id = String(feature.id || "");
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
      errors.push(`${itemPrefix}.id must be a stable lowercase id`);
    } else if (seen.has(id)) {
      errors.push(`${prefix}: duplicate feature id "${id}"`);
    }
    seen.add(id);
    if (!feature.title || typeof feature.title !== "string") {
      errors.push(`${itemPrefix}.title is required`);
    }
    if (typeof feature.passes !== "boolean") {
      errors.push(`${itemPrefix}.passes must be boolean`);
    }
    if (feature.classification !== undefined && !RISK_TIERS.has(feature.classification)) {
      errors.push(`${itemPrefix}.classification must be tiny, normal, or high-risk`);
    }
    for (const key of ["storyPath", "taskContractPath", "evidencePath"]) {
      if (feature[key] !== undefined && typeof feature[key] !== "string") {
        errors.push(`${itemPrefix}.${key} must be a string`);
        continue;
      }
      if (feature[key] !== undefined) {
        validateProjectPath(feature[key], `${itemPrefix}.${key}`);
      }
    }
    if (feature.passes === true) {
      if (!feature.taskContractPath) errors.push(`${itemPrefix}: passes=true requires taskContractPath`);
      if (!feature.evidencePath) errors.push(`${itemPrefix}: passes=true requires evidencePath`);
    }
  }
}

function readFeatureListAtHead() {
  const result = spawnSync("git", ["show", "HEAD:.harness/feature_list.json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function readTextIfExists(path) {
  try {
    if (!path || !existsSync(path)) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readActiveTaskId() {
  if (opts.activeTask !== null) return String(opts.activeTask || "").trim();
  if (!opts.activeTaskFrom) return "";
  const activeTaskPath = resolve(ROOT, opts.activeTaskFrom);
  if (!insideRoot(activeTaskPath)) {
    errors.push(`${opts.activeTaskFrom}: active task path must stay inside the project root`);
    return "";
  }
  return readTextIfExists(activeTaskPath).trim();
}

function collectText(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  if (typeof value.text === "string") out.push(value.text);
  if (typeof value.content === "string") out.push(value.content);
  if (Array.isArray(value.content)) collectText(value.content, out);
  if (value.message) collectText(value.message, out);
  return out;
}

function isAssistantRecord(record) {
  return record?.type === "assistant"
    || record?.role === "assistant"
    || record?.message?.role === "assistant"
    || record?.event === "assistant";
}

function lastAssistantTranscriptText(path) {
  const transcriptPath = resolve(ROOT, path || "");
  if (!path) return "";
  const raw = readTextIfExists(transcriptPath);
  if (!raw.trim()) return "";
  let last = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (!isAssistantRecord(record)) continue;
      const text = collectText(record).join("\n").trim();
      if (text) last = text;
    } catch {
      // Claude transcripts are normally JSONL. If a line is not JSON, ignore it
      // rather than letting transcript formatting block a legitimate stop.
    }
  }
  return last;
}

function hasCompletionClaim(text) {
  if (!text) return false;
  const normalized = text.toLowerCase();
  const negated = /\b(not done|not complete|not completed|not finished|not ready|not yet|chưa xong|chưa hoàn thành|chưa hoàn tất|chưa sẵn sàng)\b/i;
  if (negated.test(normalized)) return false;
  const completion = /\b(done|completed|complete|finished|implemented|fixed|resolved|ready to (merge|ship|review)|all checks pass|all tests pass|task complete|feature complete)\b|passes\s*[:=]\s*true|đã\s+(xong|hoàn thành|hoàn tất|sửa xong)|\bxong rồi\b|\bhoàn thành\b|\bhoàn tất\b|\bsẵn sàng\s+(merge|ship|review)\b/i;
  return completion.test(normalized);
}

function activeEvidenceRequired() {
  if (opts.stopMode === "always") return true;
  if (opts.stopMode !== "on-claim") return false;
  return hasCompletionClaim(lastAssistantTranscriptText(opts.completionTranscript));
}

if (opts.completionIntent) {
  const required = activeEvidenceRequired();
  if (opts.json) {
    console.log(JSON.stringify({ completionIntent: required }, null, 2));
  } else {
    console.log(`completion-intent: ${required ? "true" : "false"}`);
  }
  process.exit(required ? 0 : 1);
}

function changedToPassFeatures(currentFeatures) {
  if (opts.strict) return currentFeatures.filter((feature) => feature?.passes === true);
  const previous = featureArray(readFeatureListAtHead());
  if (previous.length === 0) return currentFeatures.filter((feature) => feature?.passes === true);
  const previousById = new Map(previous.map((feature) => [String(feature?.id || ""), feature]));
  return currentFeatures.filter((feature) => {
    if (feature?.passes !== true) return false;
    return previousById.get(String(feature.id || ""))?.passes !== true;
  });
}

function validateTaskContract(contract, path, expectedId) {
  const prefix = rel(path);
  if (!contract) return null;
  if (contract.schemaVersion !== 1) errors.push(`${prefix}: schemaVersion must be 1`);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(String(contract.id || ""))) errors.push(`${prefix}: id must be a stable lowercase id`);
  if (expectedId && contract.id !== expectedId) errors.push(`${prefix}: id must match feature/task id "${expectedId}"`);
  if (!TASK_TYPES.has(contract.type)) errors.push(`${prefix}: type must be one of ${[...TASK_TYPES].join(", ")}`);
  if (!RISK_TIERS.has(contract.riskTier)) errors.push(`${prefix}: riskTier must be tiny, normal, or high-risk`);
  validateTaskScopeShape(contract.scope, prefix);
  if (!Array.isArray(contract.acceptance) || contract.acceptance.length === 0) {
    errors.push(`${prefix}: acceptance must contain at least one item`);
  } else {
    const seenAcceptanceIds = new Set();
    for (const [idx, item] of contract.acceptance.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`${prefix}: acceptance[${idx}] must be an object`);
        continue;
      }
      const id = String(item?.id || "");
      if (!id) {
        errors.push(`${prefix}: acceptance[${idx}].id is required`);
      } else {
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
          errors.push(`${prefix}: acceptance[${idx}].id must be a stable lowercase id`);
        } else if (seenAcceptanceIds.has(id)) {
          errors.push(`${prefix}: acceptance contains duplicate id "${id}"`);
        }
        seenAcceptanceIds.add(id);
      }
      if (typeof item?.description !== "string" || item.description.trim().length === 0) {
        errors.push(`${prefix}: acceptance[${idx}].description is required`);
      }
      validateAcceptanceVerificationShape(item.verification, `${prefix}: acceptance[${idx}].verification`);
    }
  }
  if (!Array.isArray(contract.doneRequires) || contract.doneRequires.length === 0) {
    errors.push(`${prefix}: doneRequires must contain at least one gate`);
  } else {
    const seenGates = new Set();
    for (const gate of contract.doneRequires) {
      if (!DONE_REQUIRES.has(gate)) errors.push(`${prefix}: unsupported doneRequires gate "${gate}"`);
      if (seenGates.has(gate)) errors.push(`${prefix}: doneRequires contains duplicate "${gate}"`);
      seenGates.add(gate);
    }
    if (!contract.doneRequires.includes("evidence-bundle")) {
      errors.push(`${prefix}: doneRequires must include evidence-bundle`);
    }
  }
  if (!contract.evidencePath) errors.push(`${prefix}: evidencePath is required`);
  else validateProjectPath(contract.evidencePath, `${prefix}: evidencePath`);
  if (contract.requiresAdr !== undefined && typeof contract.requiresAdr !== "boolean") {
    errors.push(`${prefix}: requiresAdr must be boolean`);
  }
  if (contract.requiresAdr === true && !contract.doneRequires?.includes("review")) {
    errors.push(`${prefix}: requiresAdr=true should require the review gate`);
  }
  validateRequiredReviewers(contract, prefix);
  validateTaskPermissions(contract, prefix);
  return contract;
}

function validateTaskScopeShape(scope, prefix) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    errors.push(`${prefix}: scope must be an object`);
    return;
  }
  if (typeof scope.summary !== "string" || scope.summary.trim().length === 0) {
    errors.push(`${prefix}: scope.summary is required`);
  }
  for (const key of ["goals", "nonGoals"]) {
    if (scope[key] === undefined) continue;
    if (!Array.isArray(scope[key])) {
      errors.push(`${prefix}: scope.${key} must be an array`);
      continue;
    }
    for (const [idx, item] of scope[key].entries()) {
      if (typeof item !== "string" || item.trim().length === 0) {
        errors.push(`${prefix}: scope.${key}[${idx}] must be a non-empty string`);
      }
    }
  }
}

function validateAcceptanceVerificationShape(verification, prefix) {
  if (verification === undefined) return;
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  for (const key of ["command", "artifact", "manual"]) {
    if (verification[key] === undefined) continue;
    if (typeof verification[key] !== "string" || verification[key].trim().length === 0) {
      errors.push(`${prefix}.${key} must be a non-empty string`);
    }
  }
}

function validateRequiredReviewers(contract, prefix) {
  const reviewers = contract.requiredReviewers;
  const hasReviewGate = Array.isArray(contract.doneRequires) && contract.doneRequires.includes("review");
  if (reviewers === undefined) {
    if (hasReviewGate) errors.push(`${prefix}: doneRequires includes review, so requiredReviewers must contain at least one reviewer`);
    return;
  }
  if (!Array.isArray(reviewers)) {
    errors.push(`${prefix}: requiredReviewers must be an array`);
    return;
  }
  const seen = new Set();
  for (const [idx, reviewer] of reviewers.entries()) {
    if (typeof reviewer !== "string" || reviewer.trim().length === 0) {
      errors.push(`${prefix}: requiredReviewers[${idx}] must be a non-empty string`);
      continue;
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(reviewer)) {
      errors.push(`${prefix}: requiredReviewers[${idx}] must be a stable lowercase id`);
    }
    if (seen.has(reviewer)) errors.push(`${prefix}: requiredReviewers contains duplicate "${reviewer}"`);
    seen.add(reviewer);
  }
  if (reviewers.length > 0 && !hasReviewGate) {
    errors.push(`${prefix}: requiredReviewers is non-empty, so doneRequires must include review`);
  }
  if (reviewers.length === 0 && hasReviewGate) {
    errors.push(`${prefix}: doneRequires includes review, so requiredReviewers must contain at least one reviewer`);
  }
}

function validateTaskPermissions(contract, prefix) {
  const permissions = contract.permissions;
  if (permissions === undefined) {
    if (contract.riskTier === "high-risk") {
      errors.push(`${prefix}: high-risk task contracts must declare permissions.allow`);
    } else {
      errors.push(`${prefix}: task contracts must declare permissions.allow`);
    }
    return;
  }
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    errors.push(`${prefix}: permissions must be an object`);
    return;
  }
  for (const key of ["allow", "deny"]) {
    if (permissions[key] === undefined) continue;
    if (!Array.isArray(permissions[key])) {
      errors.push(`${prefix}: permissions.${key} must be an array`);
      continue;
    }
    const seen = new Set();
    for (const [idx, item] of permissions[key].entries()) {
      if (typeof item !== "string" || item.trim().length === 0) {
        errors.push(`${prefix}: permissions.${key}[${idx}] must be a non-empty string`);
        continue;
      }
      const normalized = normalizePermission(item);
      if (!TOOL_PERMISSION_RE.test(normalized)) {
        errors.push(`${prefix}: permissions.${key}[${idx}] has unsupported tool pattern "${item}"`);
      }
      if (seen.has(normalized)) errors.push(`${prefix}: permissions.${key} contains duplicate "${normalized}"`);
      seen.add(normalized);
    }
  }
  if (!Array.isArray(permissions.allow) || permissions.allow.length === 0) {
    errors.push(`${prefix}: task contracts must have a non-empty permissions.allow list`);
  }
  if (Array.isArray(permissions.allow) && Array.isArray(permissions.deny)) {
    const denied = new Set(permissions.deny.map(normalizePermission));
    for (const item of permissions.allow) {
      const normalized = normalizePermission(item);
      if (denied.has(normalized)) {
        errors.push(`${prefix}: permissions allow and deny both contain "${normalized}"`);
      }
    }
  }
  if (contract.riskTier === "high-risk") {
    if (!Array.isArray(permissions.allow) || permissions.allow.length === 0) {
      errors.push(`${prefix}: high-risk task contracts must have a non-empty permissions.allow list`);
    }
    for (const permission of permissions.allow || []) {
      const normalized = normalizePermission(permission);
      if (normalized === "*" || normalized === "Bash(*)" || overbroadSensitiveBashPermission(normalized)) {
        errors.push(`${prefix}: high-risk task contracts must not allow wildcard tool access or overbroad sensitive Bash grants`);
      }
    }
  }
  const allowedLayers = contract.scope?.allowedLayers;
  if (contract.riskTier === "high-risk" && (!Array.isArray(allowedLayers) || allowedLayers.length === 0)) {
    errors.push(`${prefix}: high-risk task contracts must declare scope.allowedLayers`);
  }
  validateAllowedLayers(contract, prefix);
}

function configuredLayerNames() {
  const out = new Set();
  const domains = Array.isArray(config.domains) ? config.domains : [];
  for (const domain of domains) {
    for (const layer of Array.isArray(domain.layers) ? domain.layers : []) {
      if (typeof layer === "string" && layer.trim()) out.add(layer.trim());
    }
  }
  return out;
}

function validateAllowedLayers(contract, prefix) {
  const allowedLayers = contract.scope?.allowedLayers;
  if (allowedLayers === undefined) return;
  if (!Array.isArray(allowedLayers)) {
    errors.push(`${prefix}: scope.allowedLayers must be an array`);
    return;
  }
  const configured = configuredLayerNames();
  const seen = new Set();
  for (const [idx, layer] of allowedLayers.entries()) {
    if (typeof layer !== "string" || layer.trim().length === 0) {
      errors.push(`${prefix}: scope.allowedLayers[${idx}] must be a non-empty string`);
      continue;
    }
    if (seen.has(layer)) errors.push(`${prefix}: scope.allowedLayers contains duplicate "${layer}"`);
    seen.add(layer);
    if (configured.size > 0 && !configured.has(layer)) {
      errors.push(`${prefix}: scope.allowedLayers[${idx}] references unknown configured layer "${layer}"`);
    }
  }
}

function validateEvidenceShape(evidence, path) {
  const prefix = rel(path);
  if (!evidence) return null;
  if (evidence.schemaVersion !== 1) errors.push(`${prefix}: schemaVersion must be 1`);
  if (!evidence.taskId) {
    errors.push(`${prefix}: taskId is required`);
  } else if (!/^[a-z0-9][a-z0-9._-]*$/.test(String(evidence.taskId))) {
    errors.push(`${prefix}: taskId must be a stable lowercase id`);
  }
  if (evidence.featureId !== undefined && !/^[a-z0-9][a-z0-9._-]*$/.test(String(evidence.featureId))) {
    errors.push(`${prefix}: featureId must be a stable lowercase id`);
  }
  if (!["pass", "fail", "partial", "blocked"].includes(evidence.status)) errors.push(`${prefix}: status must be pass, fail, partial, or blocked`);
  const createdAt = validateTimestamp(evidence.createdAt, `${prefix}: createdAt`, { required: true });
  const updatedAt = validateTimestamp(evidence.updatedAt, `${prefix}: updatedAt`, { required: false });
  if (createdAt && updatedAt && updatedAt < createdAt) {
    errors.push(`${prefix}: updatedAt must be greater than or equal to createdAt`);
  }
  if (evidence.diffSummary !== undefined && typeof evidence.diffSummary !== "string") {
    errors.push(`${prefix}: diffSummary must be a string`);
  } else if (evidence.status === "pass" && !concrete(evidence.diffSummary)) {
    errors.push(`${prefix}: diffSummary is required for status=pass`);
  }
  if (!Array.isArray(evidence.changedFiles) || evidence.changedFiles.length === 0) {
    errors.push(`${prefix}: changedFiles must contain at least one file`);
  } else {
    const seenChangedFiles = new Set();
    for (const [idx, file] of evidence.changedFiles.entries()) {
      if (typeof file !== "string" || file.trim().length === 0) {
        errors.push(`${prefix}: changedFiles[${idx}] must be a non-empty string`);
        continue;
      }
      validateProjectPath(file, `${prefix}: changedFiles[${idx}]`);
      const normalized = normalizedProjectPath(file);
      if (normalized && seenChangedFiles.has(normalized)) {
        errors.push(`${prefix}: changedFiles contains duplicate "${normalized}"`);
      }
      if (normalized) seenChangedFiles.add(normalized);
    }
  }
  if (!Array.isArray(evidence.checks) || evidence.checks.length === 0) {
    errors.push(`${prefix}: checks must contain at least one proof command`);
  } else {
    const seenCheckNames = new Set();
    for (const [idx, check] of evidence.checks.entries()) {
      const checkName = typeof check?.name === "string" ? check.name : "";
      if (!checkName.trim()) {
        errors.push(`${prefix}: checks[${idx}].name is required`);
      } else if (!/^[a-z0-9][a-z0-9._-]*$/.test(checkName)) {
        errors.push(`${prefix}: checks[${idx}].name must be a stable lowercase id`);
      } else {
        if (seenCheckNames.has(checkName)) errors.push(`${prefix}: checks contains duplicate name "${checkName}"`);
        seenCheckNames.add(checkName);
      }
      if (typeof check?.command !== "string" || check.command.trim().length === 0) {
        errors.push(`${prefix}: checks[${idx}].command is required`);
      } else if (check.status === "pass" && !concrete(check.command)) {
        errors.push(`${prefix}: checks[${idx}].command must be concrete before status=pass`);
      } else if (check.status === "pass") {
        errors.push(...validateProofCommand(check.command, {
          prefix: `${prefix}: checks[${idx}].command`,
          requireConcrete: false,
          context: "task evidence checks",
        }));
        if (MOCK_VERIFY_UI_RE.test(check.command)) {
          errors.push(`${prefix}: checks[${idx}].command cannot use verify-ui --mock for passing UI evidence`);
        }
      }
      if (!["pass", "fail", "skipped"].includes(check?.status)) errors.push(`${prefix}: checks[${idx}].status must be pass, fail, or skipped`);
      if (check?.summary !== undefined && typeof check.summary !== "string") {
        errors.push(`${prefix}: checks[${idx}].summary must be a string`);
      } else if (check?.status === "pass" && !concrete(check.summary)) {
        errors.push(`${prefix}: checks[${idx}].summary is required for status=pass`);
      }
      const artifactInfo = validateCheckArtifact(check, idx, path);
      validateUiEvidenceCheck(check, idx, path, artifactInfo);
      validateCheckAttestation(check, idx, path, evidence.taskId);
      if (check?.acceptanceId !== undefined && typeof check.acceptanceId !== "string") {
        errors.push(`${prefix}: checks[${idx}].acceptanceId must be a string`);
      } else if (check?.acceptanceId !== undefined && !/^[a-z0-9][a-z0-9._-]*$/.test(check.acceptanceId)) {
        errors.push(`${prefix}: checks[${idx}].acceptanceId must be a stable lowercase id`);
      }
    }
  }
  if (evidence.reviewers && !Array.isArray(evidence.reviewers)) {
    errors.push(`${prefix}: reviewers must be an array`);
  } else {
    const seenReviewers = new Set();
    for (const [idx, reviewer] of (evidence.reviewers || []).entries()) {
      const reviewerName = typeof reviewer?.name === "string" ? reviewer.name : "";
      if (reviewerName && seenReviewers.has(reviewerName)) {
        errors.push(`${prefix}: reviewers contains duplicate "${reviewerName}"`);
      }
      if (reviewerName) seenReviewers.add(reviewerName);
      validateReviewerEvidenceItem(reviewer, idx, path);
    }
  }
  validateKnownRisks(evidence, path);

  // Strict validation for status=pass evidence bundles (Phase 1.3)
  if (evidence.status === "pass") {
    const checks = evidence.checks || [];
    const passChecks = checks.filter(c => c?.status === "pass");
    
    // Must have at least one passing check
    if (passChecks.length === 0) {
      errors.push(`${prefix}: status=pass requires at least one check with status=pass`);
    }
    
    // If structural check exists, it must pass
    const structuralChecks = checks.filter(c => 
      c?.name && (c.name === "structural" || c.name.includes("structural") || c.name.includes("harness"))
    );
    if (structuralChecks.length > 0 && !structuralChecks.some(c => c.status === "pass")) {
      errors.push(`${prefix}: status=pass requires structural check to pass`);
    }
    
    // If test checks exist, at least one must pass
    const testChecks = checks.filter(c => 
      c?.name && (c.name === "tests" || c.name.includes("test") || c.name === "unit" || c.name === "integration")
    );
    if (testChecks.length > 0 && !testChecks.some(c => c.status === "pass")) {
      errors.push(`${prefix}: status=pass requires at least one test check to pass`);
    }
    
    // All reviewers with decision must have decision=pass (not block)
    const reviewers = evidence.reviewers || [];
    const blockingReviewers = reviewers.filter(r => r?.decision === "block");
    if (blockingReviewers.length > 0) {
      const names = blockingReviewers.map(r => r.name).join(", ");
      errors.push(`${prefix}: status=pass cannot have blocking reviewers: ${names}`);
    }
    
    // diffSummary must not be placeholder
    const placeholders = ["TBD", "TODO", "N/A", "tbd", "todo", "n/a", "pending", "PENDING"];
    if (evidence.diffSummary && placeholders.some(p => evidence.diffSummary.includes(p))) {
      errors.push(`${prefix}: diffSummary cannot contain placeholder text (TBD, TODO, N/A) for status=pass`);
    }
  }
  return evidence;
}

function validateKnownRisks(evidence, path) {
  const prefix = rel(path);
  if (evidence.knownRisks === undefined) return;
  if (!Array.isArray(evidence.knownRisks)) {
    errors.push(`${prefix}: knownRisks must be an array`);
    return;
  }
  const seenRiskIds = new Set();
  for (const [idx, risk] of evidence.knownRisks.entries()) {
    const riskPrefix = `${prefix}: knownRisks[${idx}]`;
    if (!risk || typeof risk !== "object" || Array.isArray(risk)) {
      errors.push(`${riskPrefix} must be a structured risk object`);
      continue;
    }
    const id = typeof risk.id === "string" ? risk.id : "";
    if (!id.trim()) {
      errors.push(`${riskPrefix}.id is required`);
    } else if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
      errors.push(`${riskPrefix}.id must be a stable lowercase id`);
    } else {
      if (seenRiskIds.has(id)) errors.push(`${prefix}: knownRisks contains duplicate id "${id}"`);
      seenRiskIds.add(id);
    }
    if (!KNOWN_RISK_SEVERITIES.has(risk.severity)) {
      errors.push(`${riskPrefix}.severity must be critical, high, medium, low, or info`);
    }
    if (!concrete(risk.description)) {
      errors.push(`${riskPrefix}.description is required`);
    }
    if (!KNOWN_RISK_DISPOSITIONS.has(risk.disposition)) {
      errors.push(`${riskPrefix}.disposition must be mitigated, accepted, or open`);
    }
    if (!concrete(risk.owner)) {
      errors.push(`${riskPrefix}.owner is required`);
    }
    if (risk.disposition === "open" && evidence.status === "pass") {
      errors.push(`${riskPrefix}: pass evidence cannot include open known risks`);
    }
    if (risk.disposition === "mitigated" && !concrete(risk.mitigation)) {
      errors.push(`${riskPrefix}.mitigation is required when disposition=mitigated`);
    }
    if (risk.disposition === "accepted") {
      if (!concrete(risk.acceptedBy)) {
        errors.push(`${riskPrefix}.acceptedBy is required when disposition=accepted`);
      }
      if (!concrete(risk.acceptanceReason)) {
        errors.push(`${riskPrefix}.acceptanceReason is required when disposition=accepted`);
      }
      if (!concrete(risk.mitigation)) {
        errors.push(`${riskPrefix}.mitigation is required when disposition=accepted`);
      }
      if ((risk.severity === "critical" || risk.severity === "high") && !risk.acceptedUntil) {
        errors.push(`${riskPrefix}.acceptedUntil is required for accepted critical/high risks`);
      }
    }
    if (risk.acceptedUntil !== undefined) {
      const acceptedUntil = validateTimestamp(risk.acceptedUntil, `${riskPrefix}.acceptedUntil`, { required: false });
      if (risk.disposition === "accepted" && acceptedUntil && acceptedUntil.getTime() < Date.now()) {
        errors.push(`${riskPrefix}.acceptedUntil has expired`);
      }
    }
  }
}

function validateTimestamp(value, label, { required }) {
  if (value === undefined || value === null || value === "") {
    if (required) errors.push(`${label} must be an ISO date-time`);
    return null;
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push(`${label} must be an ISO date-time`);
    return null;
  }
  return new Date(value);
}

function validSha256(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function hashFile(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function validateOptionalProjectPath(value, prefix) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${prefix} must be a non-empty repo-local path`);
    return null;
  }
  if (!validateProjectPath(value, prefix)) return null;
  return resolve(ROOT, value);
}

function validateHashPathPair({ check, idx, evidencePath, stream }) {
  const prefix = rel(evidencePath);
  const hashKey = `${stream}Hash`;
  const pathKey = `${stream}Path`;
  const hash = check?.[hashKey];
  const sidecar = check?.[pathKey];

  if (hash !== undefined && !validSha256(hash)) {
    errors.push(`${prefix}: checks[${idx}].${hashKey} must be sha256:<64 lowercase hex chars>`);
  }
  const sidecarPath = validateOptionalProjectPath(sidecar, `${prefix}: checks[${idx}].${pathKey}`);
  if (!opts.verifyHashes && hash === undefined && sidecar === undefined) return;
  if (opts.verifyHashes && (hash !== undefined || sidecar !== undefined)) {
    if (!hash) errors.push(`${prefix}: checks[${idx}].${hashKey} is required when ${pathKey} is present`);
    if (!sidecar) errors.push(`${prefix}: checks[${idx}].${pathKey} is required when ${hashKey} is present`);
    if (sidecarPath && !existsSync(sidecarPath)) {
      errors.push(`${prefix}: checks[${idx}].${pathKey} not found: ${sidecar}`);
    } else if (sidecarPath && hash && validSha256(hash)) {
      const actual = hashFile(sidecarPath);
      if (actual !== hash) {
        errors.push(`${prefix}: checks[${idx}].${hashKey} does not match ${pathKey} (${actual})`);
      }
    }
  }
}

function validateCheckAttestation(check, idx, evidencePath, taskId) {
  const prefix = rel(evidencePath);
  if (check?.exitCode !== undefined) {
    if (!Number.isInteger(check.exitCode)) {
      errors.push(`${prefix}: checks[${idx}].exitCode must be an integer`);
    } else if (check.status === "pass" && check.exitCode !== 0) {
      errors.push(`${prefix}: checks[${idx}].exitCode must be 0 for status=pass`);
    }
  }
  if (check?.cwd !== undefined) validateOptionalProjectPath(check.cwd, `${prefix}: checks[${idx}].cwd`);
  const startedAt = validateTimestamp(check?.startedAt, `${prefix}: checks[${idx}].startedAt`, { required: false });
  const finishedAt = validateTimestamp(check?.finishedAt, `${prefix}: checks[${idx}].finishedAt`, { required: false });
  if (startedAt && finishedAt && finishedAt < startedAt) {
    errors.push(`${prefix}: checks[${idx}].finishedAt must be greater than or equal to startedAt`);
  }
  if (check?.gitHead !== undefined && (typeof check.gitHead !== "string" || check.gitHead.trim().length === 0)) {
    errors.push(`${prefix}: checks[${idx}].gitHead must be a non-empty string`);
  }
  if (check?.workingTreeHash !== undefined && !validSha256(check.workingTreeHash)) {
    errors.push(`${prefix}: checks[${idx}].workingTreeHash must be sha256:<64 lowercase hex chars>`);
  }
  validateHashPathPair({ check, idx, evidencePath, stream: "stdout" });
  validateHashPathPair({ check, idx, evidencePath, stream: "stderr" });
  if (check?.artifactPaths !== undefined) {
    if (!Array.isArray(check.artifactPaths)) {
      errors.push(`${prefix}: checks[${idx}].artifactPaths must be an array`);
    } else {
      const seen = new Set();
      for (const [artifactIdx, artifact] of check.artifactPaths.entries()) {
        const artifactPrefix = `${prefix}: checks[${idx}].artifactPaths[${artifactIdx}]`;
        if (typeof artifact !== "string" || artifact.trim().length === 0) {
          errors.push(`${artifactPrefix} must be a non-empty repo-local path`);
          continue;
        }
        validateProjectPath(artifact, artifactPrefix);
        if (seen.has(artifact)) errors.push(`${prefix}: checks[${idx}].artifactPaths contains duplicate "${artifact}"`);
        seen.add(artifact);
      }
    }
  }
  if (opts.replayPlan && typeof check?.command === "string" && check.command.trim()) {
    const replayErrors = validateProofCommand(check.command, {
      prefix: `${prefix}: checks[${idx}].command`,
      requireConcrete: true,
      context: "task evidence replay plan",
    });
    errors.push(...replayErrors);
    const item = {
      taskId: String(taskId || ""),
      check: typeof check.name === "string" && check.name ? check.name : `checks[${idx}]`,
      command: check.command,
      cwd: typeof check.cwd === "string" && check.cwd.trim() ? check.cwd : ".",
      status: check.status || "unknown",
    };
    const key = `${item.taskId}\0${item.check}\0${item.command}\0${item.cwd}`;
    if (!replayPlanKeys.has(key)) {
      replayPlanKeys.add(key);
      replayPlan.push(item);
    }
  }
}

function validateReviewDecision(decision, path, expectedReviewer) {
  const prefix = rel(path);
  if (!decision) return null;
  if (decision.schemaVersion !== 1) errors.push(`${prefix}: schemaVersion must be 1`);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(String(decision.reviewer || ""))) {
    errors.push(`${prefix}: reviewer must be a stable lowercase id`);
  }
  if (expectedReviewer && decision.reviewer !== expectedReviewer) {
    errors.push(`${prefix}: reviewer "${decision.reviewer}" must match evidence reviewer "${expectedReviewer}"`);
  }
  if (decision.taskId !== undefined && !/^[a-z0-9][a-z0-9._-]*$/.test(String(decision.taskId))) {
    errors.push(`${prefix}: taskId must be a stable lowercase id`);
  }
  if (decision.featureId !== undefined && !/^[a-z0-9][a-z0-9._-]*$/.test(String(decision.featureId))) {
    errors.push(`${prefix}: featureId must be a stable lowercase id`);
  }
  if (!REVIEW_DECISIONS.has(decision.decision)) {
    errors.push(`${prefix}: decision must be pass, block, or needs-human`);
  }
  if (!decision.createdAt || Number.isNaN(Date.parse(decision.createdAt))) {
    errors.push(`${prefix}: createdAt must be an ISO date-time`);
  }
  if (!concrete(decision.summary)) errors.push(`${prefix}: summary must be concrete`);
  if (decision.checkedFiles && !Array.isArray(decision.checkedFiles)) {
    errors.push(`${prefix}: checkedFiles must be an array`);
  } else if (Array.isArray(decision.checkedFiles)) {
    const seen = new Set();
    for (const [idx, file] of decision.checkedFiles.entries()) {
      if (typeof file !== "string" || file.trim().length === 0) {
        errors.push(`${prefix}: checkedFiles[${idx}] must be a non-empty string`);
        continue;
      }
      validateProjectPath(file, `${prefix}: checkedFiles[${idx}]`);
      if (seen.has(file)) errors.push(`${prefix}: checkedFiles contains duplicate "${file}"`);
      seen.add(file);
    }
  }
  if (decision.decision === "pass" && (!Array.isArray(decision.checkedFiles) || decision.checkedFiles.length === 0)) {
    errors.push(`${prefix}: decision=pass must include non-empty checkedFiles`);
  }
  validateReviewStringArray(decision, "checkedInvariants", prefix, { stableIds: true, paths: false });
  validateReviewDiffCoverage(decision, prefix);
  validateReviewConfidence(decision, prefix);
  validateReviewStringArray(decision, "unreviewedRiskAreas", prefix, { stableIds: true, paths: false });
  validateResolvedFindings(decision, prefix);
  if (decision.decision === "pass") {
    if (!Array.isArray(decision.checkedInvariants) || decision.checkedInvariants.length === 0) {
      errors.push(`${prefix}: decision=pass must include non-empty checkedInvariants`);
    }
    if (!decision.diffCoverage || typeof decision.diffCoverage !== "object" || Array.isArray(decision.diffCoverage)) {
      errors.push(`${prefix}: decision=pass must include diffCoverage`);
    }
    if (typeof decision.confidence !== "number" || !Number.isFinite(decision.confidence)) {
      errors.push(`${prefix}: decision=pass must include numeric confidence`);
    } else if (decision.confidence < 0.6) {
      errors.push(`${prefix}: decision=pass confidence must be at least 0.6`);
    }
    if (Array.isArray(decision.unreviewedRiskAreas) && decision.unreviewedRiskAreas.length > 0) {
      errors.push(`${prefix}: decision=pass cannot include unreviewedRiskAreas`);
    }
  }
  if (decision.decision === "pass" && !decision.featureId) {
    errors.push(`${prefix}: decision=pass must include featureId`);
  }
  if (decision.requiredGates && !Array.isArray(decision.requiredGates)) {
    errors.push(`${prefix}: requiredGates must be an array`);
  } else if (Array.isArray(decision.requiredGates)) {
    const seen = new Set();
    for (const [idx, gate] of decision.requiredGates.entries()) {
      if (typeof gate !== "string" || gate.trim().length === 0) {
        errors.push(`${prefix}: requiredGates[${idx}] must be a non-empty string`);
        continue;
      }
      if (!REVIEW_REQUIRED_GATES.has(gate)) {
        errors.push(`${prefix}: requiredGates[${idx}] must be one of ${[...REVIEW_REQUIRED_GATES].join(", ")}`);
      }
      if (seen.has(gate)) errors.push(`${prefix}: requiredGates contains duplicate "${gate}"`);
      seen.add(gate);
    }
  }
  if (!Array.isArray(decision.findings)) {
    errors.push(`${prefix}: findings must be an array`);
  } else {
    for (const [idx, finding] of decision.findings.entries()) {
      if (!FINDING_SEVERITIES.has(finding?.severity)) {
        errors.push(`${prefix}: findings[${idx}].severity must be critical, high, medium, low, or info`);
      }
      if (finding?.line !== undefined && (!Number.isInteger(finding.line) || finding.line < 1)) {
        errors.push(`${prefix}: findings[${idx}].line must be a positive integer`);
      }
      if (finding?.file !== undefined) {
        if (typeof finding.file !== "string" || finding.file.trim().length === 0) {
          errors.push(`${prefix}: findings[${idx}].file must be a non-empty string`);
        } else {
          validateProjectPath(finding.file, `${prefix}: findings[${idx}].file`);
        }
      }
      if (!concrete(finding?.evidence)) errors.push(`${prefix}: findings[${idx}].evidence must be concrete`);
      if (!concrete(finding?.fix)) errors.push(`${prefix}: findings[${idx}].fix must be concrete`);
    }
    if (decision.decision === "pass" && decision.findings.some((finding) => finding?.blocking === true)) {
      errors.push(`${prefix}: decision=pass cannot include blocking findings`);
    }
    if (decision.decision === "block") {
      if (decision.findings.length === 0) {
        errors.push(`${prefix}: decision=block must include at least one finding`);
      } else if (!decision.findings.some((finding) => finding?.blocking === true)) {
        errors.push(`${prefix}: decision=block must include at least one blocking finding`);
      }
    }
    if (decision.decision === "needs-human" && decision.findings.length === 0) {
      errors.push(`${prefix}: decision=needs-human must include at least one finding explaining the escalation`);
    }
  }
  return decision;
}

function validateReviewStringArray(decision, field, prefix, { stableIds = false, paths = false } = {}) {
  if (decision[field] === undefined) return;
  if (!Array.isArray(decision[field])) {
    errors.push(`${prefix}: ${field} must be an array`);
    return;
  }
  const seen = new Set();
  for (const [idx, item] of decision[field].entries()) {
    if (typeof item !== "string" || item.trim().length === 0) {
      errors.push(`${prefix}: ${field}[${idx}] must be a non-empty string`);
      continue;
    }
    if (stableIds && !/^[a-z0-9][a-z0-9._:-]*$/.test(item)) {
      errors.push(`${prefix}: ${field}[${idx}] must be a stable lowercase id`);
    }
    if (paths) validateProjectPath(item, `${prefix}: ${field}[${idx}]`);
    if (seen.has(item)) errors.push(`${prefix}: ${field} contains duplicate "${item}"`);
    seen.add(item);
  }
}

function validateReviewDiffCoverage(decision, prefix) {
  if (decision.diffCoverage === undefined) return;
  const coverage = decision.diffCoverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    errors.push(`${prefix}: diffCoverage must be an object`);
    return;
  }
  for (const field of ["changedFiles", "reviewedFiles", "uncoveredFiles"]) {
    if (!Array.isArray(coverage[field])) {
      errors.push(`${prefix}: diffCoverage.${field} must be an array`);
      continue;
    }
    const seen = new Set();
    for (const [idx, file] of coverage[field].entries()) {
      if (typeof file !== "string" || file.trim().length === 0) {
        errors.push(`${prefix}: diffCoverage.${field}[${idx}] must be a non-empty string`);
        continue;
      }
      validateProjectPath(file, `${prefix}: diffCoverage.${field}[${idx}]`);
      if (seen.has(file)) errors.push(`${prefix}: diffCoverage.${field} contains duplicate "${file}"`);
      seen.add(file);
    }
  }
  if (typeof coverage.coverage !== "number" || !Number.isFinite(coverage.coverage) || coverage.coverage < 0 || coverage.coverage > 1) {
    errors.push(`${prefix}: diffCoverage.coverage must be a number between 0 and 1`);
  }
  if (coverage.notes !== undefined && typeof coverage.notes !== "string") {
    errors.push(`${prefix}: diffCoverage.notes must be a string`);
  }
  if (decision.decision === "pass") {
    if (Array.isArray(coverage.changedFiles) && coverage.changedFiles.length === 0) {
      errors.push(`${prefix}: decision=pass diffCoverage.changedFiles must not be empty`);
    }
    if (Array.isArray(coverage.reviewedFiles) && coverage.reviewedFiles.length === 0) {
      errors.push(`${prefix}: decision=pass diffCoverage.reviewedFiles must not be empty`);
    }
  }
}

function validateReviewConfidence(decision, prefix) {
  if (decision.confidence === undefined) return;
  if (typeof decision.confidence !== "number" || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
    errors.push(`${prefix}: confidence must be a number between 0 and 1`);
  }
}

function validateResolvedFindings(decision, prefix) {
  if (decision.resolvedFindings === undefined) return;
  if (!Array.isArray(decision.resolvedFindings)) {
    errors.push(`${prefix}: resolvedFindings must be an array`);
    return;
  }
  const seen = new Set();
  for (const [idx, finding] of decision.resolvedFindings.entries()) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      errors.push(`${prefix}: resolvedFindings[${idx}] must be an object`);
      continue;
    }
    const id = String(finding.id || "");
    if (!/^[a-z0-9][a-z0-9._:-]*$/.test(id)) {
      errors.push(`${prefix}: resolvedFindings[${idx}].id must be a stable lowercase id`);
    } else if (seen.has(id)) {
      errors.push(`${prefix}: resolvedFindings contains duplicate "${id}"`);
    }
    seen.add(id);
    if (finding.file !== undefined) validateProjectPath(finding.file, `${prefix}: resolvedFindings[${idx}].file`);
    if (finding.line !== undefined && (!Number.isInteger(finding.line) || finding.line < 1)) {
      errors.push(`${prefix}: resolvedFindings[${idx}].line must be a positive integer`);
    }
    if (!concrete(finding.resolution)) {
      errors.push(`${prefix}: resolvedFindings[${idx}].resolution must be concrete`);
    }
  }
}

function readReviewDecisionArtifact(item, idx, evidencePath) {
  if (!item?.artifact) return null;
  const prefix = `${rel(evidencePath)}: reviewers[${idx}]`;
  if (typeof item.artifact !== "string" || item.artifact.trim().length === 0) {
    errors.push(`${prefix}.artifact must be a non-empty string`);
    return null;
  }
  const artifact = item.artifact.trim();
  if (!validateProjectPath(artifact, `${prefix}.artifact`)) return null;
  if (!artifact.endsWith(".json")) {
    errors.push(`${prefix}.artifact must point to a JSON review decision artifact`);
    return null;
  }
  const artifactPath = resolve(ROOT, artifact);
  if (!existsSync(artifactPath)) {
    errors.push(`${prefix}.artifact not found: ${artifact}`);
    return null;
  }
  const reviewerName = typeof item.name === "string" ? item.name : undefined;
  return validateReviewDecision(readJson(artifactPath, rel(artifactPath)), artifactPath, reviewerName);
}

function validateReviewerEvidenceItem(item, idx, evidencePath) {
  const prefix = `${rel(evidencePath)}: reviewers[${idx}]`;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    errors.push(`${prefix} must be an object`);
    return null;
  }
  const reviewerName = typeof item.name === "string" ? item.name : "";
  if (!reviewerName.trim()) {
    errors.push(`${prefix}.name is required`);
  } else if (!/^[a-z0-9][a-z0-9._-]*$/.test(reviewerName)) {
    errors.push(`${prefix}.name must be a stable lowercase id`);
  }
  if (!EVIDENCE_REVIEW_DECISIONS.has(item.decision)) {
    errors.push(`${prefix}.decision must be pass, block, needs-human, or not-required`);
  }
  let decision = null;
  if (item.reviewDecision) {
    decision = validateReviewDecision(item.reviewDecision, `${prefix}.reviewDecision`, reviewerName || item.name);
  }
  const artifactDecision = readReviewDecisionArtifact(item, idx, evidencePath);
  if (decision && artifactDecision) {
    if (decision.reviewer !== artifactDecision.reviewer || decision.decision !== artifactDecision.decision) {
      errors.push(`${prefix}: inline reviewDecision must match JSON artifact reviewer and decision`);
    }
  }
  decision = decision || artifactDecision;
  if (decision && item.decision !== "not-required" && item.decision !== decision.decision) {
    errors.push(`${prefix}.decision must match review decision artifact (${decision.decision})`);
  }
  if (decision) reviewDecisionCache.set(item, decision);
  return decision;
}

function normalizedCheckText(check) {
  return normalized(`${check?.name || ""} ${check?.command || ""}`);
}

function checkAliasMatches(text, alias) {
  const target = normalized(alias);
  if (!text || !target) return false;
  const pattern = new RegExp(`(^|[^a-z0-9_-])${escapeRegex(target)}(?=$|[^a-z0-9_-])`);
  return pattern.test(text);
}

function hasPassingCheck(evidence, gate) {
  return (evidence.checks || []).some((check) => check.status === "pass" && checkMatchesGate(check, gate));
}

function checkMatchesGate(check, gate) {
  const aliases = CHECK_ALIASES[gate] || [gate];
  const text = normalizedCheckText(check);
  return aliases.some((alias) => checkAliasMatches(text, alias));
}

function concrete(value) {
  return concreteCommand(value);
}

function hasUrlScheme(value) {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(value || ""));
}

function validateProjectPath(value, prefix) {
  const text = String(value || "").trim();
  if (!text) {
    errors.push(`${prefix} must be a non-empty repo-local path`);
    return false;
  }
  if (hasUrlScheme(text)) {
    errors.push(`${prefix} must be a repo-local path, not a URL`);
    return false;
  }
  const abs = resolve(ROOT, text);
  if (!insideRoot(abs)) {
    errors.push(`${prefix} must stay inside the project root`);
    return false;
  }
  return true;
}

function resolveProjectPath(value, prefix) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${prefix} must be a non-empty string`);
    return null;
  }
  if (!validateProjectPath(value, prefix)) return null;
  return resolve(ROOT, value);
}

function resolveFeaturePath(value, fallback, prefix) {
  const path = value || fallback;
  const resolved = resolveProjectPath(path, prefix);
  return resolved || resolve(ROOT, fallback);
}

function validateCheckArtifact(check, idx, evidencePath) {
  const artifact = check?.artifact;
  if (artifact === undefined) return { present: false };
  const prefix = rel(evidencePath);
  if (typeof artifact !== "string" || artifact.trim().length === 0) {
    errors.push(`${prefix}: checks[${idx}].artifact must be a non-empty string`);
    return { present: true, valid: false };
  }
  if (check.status !== "pass") return { present: true, valid: true, raw: artifact.trim() };
  const text = artifact.trim();
  if (/^file:/i.test(text)) {
    errors.push(`${prefix}: checks[${idx}].artifact file URLs are not supported; use a repo-relative path or external URL`);
    return { present: true, valid: false, raw: text };
  }
  if (hasUrlScheme(text)) return { present: true, valid: true, raw: text, external: true };
  const artifactPath = resolve(ROOT, text);
  if (!insideRoot(artifactPath)) {
    errors.push(`${prefix}: checks[${idx}].artifact must stay inside the project root`);
    return { present: true, valid: false, raw: text };
  }
  if (!existsSync(artifactPath)) {
    errors.push(`${prefix}: checks[${idx}].artifact not found: ${text}`);
    return { present: true, valid: false, raw: text, localPath: artifactPath };
  }
  const valid = validateLocalCheckArtifact(artifactPath, text, `${prefix}: checks[${idx}].artifact`);
  return { present: true, valid, raw: text, localPath: artifactPath };
}

function validateLocalCheckArtifact(artifactPath, artifact, prefix) {
  let bytes;
  try {
    bytes = readFileSync(artifactPath);
  } catch (err) {
    errors.push(`${prefix} could not be read: ${err.message}`);
    return false;
  }
  if (bytes.length === 0) {
    errors.push(`${prefix} must not be empty`);
    return false;
  }
  if (String(artifact).toLowerCase().endsWith(".json")) {
    try {
      JSON.parse(bytes.toString("utf8"));
    } catch (err) {
      errors.push(`${prefix} must be parseable JSON: ${err.message}`);
      return false;
    }
  }
  return true;
}

function validateUiEvidenceCheck(check, idx, evidencePath, artifactInfo) {
  if (check?.status !== "pass" || !checkMatchesGate(check, "ui")) return;
  const prefix = rel(evidencePath);
  if (!artifactInfo?.present) {
    errors.push(`${prefix}: checks[${idx}].artifact is required for passing UI evidence`);
    return;
  }
  if (!VERIFY_UI_COMMAND_RE.test(check.command || "")) return;
  if (artifactInfo.external) {
    errors.push(`${prefix}: checks[${idx}].artifact must be a repo-local verify-ui JSON summary, not an external URL`);
    return;
  }
  if (!String(artifactInfo.raw || "").endsWith(".json")) {
    errors.push(`${prefix}: checks[${idx}].artifact must point to a verify-ui JSON summary`);
    return;
  }
  if (!artifactInfo.localPath || !existsSync(artifactInfo.localPath)) return;

  const summary = readJson(artifactInfo.localPath, rel(artifactInfo.localPath));
  if (!summary) return;
  if (summary.passed !== true) {
    errors.push(`${prefix}: checks[${idx}].artifact verify-ui summary must have passed=true`);
  }
  if (summary.evidenceKind !== "browser") {
    errors.push(`${prefix}: checks[${idx}].artifact verify-ui summary must have evidenceKind="browser"`);
  }
  if (summary.evidenceUsable !== true) {
    errors.push(`${prefix}: checks[${idx}].artifact verify-ui summary must have evidenceUsable=true`);
  }
  validateVerifyUiSummaryChecks(summary, `${prefix}: checks[${idx}].artifact`);
  validateVerifyUiSummaryMetadata(summary, `${prefix}: checks[${idx}].artifact`);
  if (!Array.isArray(summary.screenshots) || summary.screenshots.length === 0) {
    errors.push(`${prefix}: checks[${idx}].artifact verify-ui summary must include at least one screenshot`);
    return;
  }
  for (const [shotIdx, shot] of summary.screenshots.entries()) {
    const shotPrefix = `${prefix}: checks[${idx}].artifact screenshots[${shotIdx}]`;
    if (typeof shot !== "string" || shot.trim().length === 0) {
      errors.push(`${shotPrefix} must be a non-empty repo-local path`);
      continue;
    }
    if (hasUrlScheme(shot)) {
      errors.push(`${shotPrefix} must be a repo-local path, not a URL`);
      continue;
    }
    const shotPath = resolve(ROOT, shot);
    if (!insideRoot(shotPath)) {
      errors.push(`${shotPrefix} must stay inside the project root`);
      continue;
    }
    if (!existsSync(shotPath)) {
      errors.push(`${shotPrefix} not found: ${shot}`);
      continue;
    }
    validateScreenshotBytes(shotPath, shot, shotPrefix);
  }
}

function validateVerifyUiSummaryMetadata(summary, prefix) {
  if (typeof summary.route !== "string" || summary.route.trim().length === 0) {
    errors.push(`${prefix} verify-ui summary must include route`);
  }
  if (!Array.isArray(summary.assertions) || summary.assertions.length === 0) {
    errors.push(`${prefix} verify-ui summary must include assertions array`);
  }
  const hasDomHash = validSha256(summary.domSnapshotHash);
  const hasSummaryHash = validSha256(summary.summaryHash);
  if (!hasDomHash && !hasSummaryHash) {
    errors.push(`${prefix} verify-ui summary must include domSnapshotHash or summaryHash`);
  }
  if (summary.domSnapshotHash !== undefined && !hasDomHash) {
    errors.push(`${prefix} verify-ui summary domSnapshotHash must be sha256:<64 lowercase hex chars>`);
  }
  if (summary.summaryHash !== undefined && !hasSummaryHash) {
    errors.push(`${prefix} verify-ui summary summaryHash must be sha256:<64 lowercase hex chars>`);
  }
  if (summary.domSnapshotPath !== undefined) {
    const domPath = validateOptionalProjectPath(summary.domSnapshotPath, `${prefix} verify-ui summary domSnapshotPath`);
    if (domPath && !existsSync(domPath)) {
      errors.push(`${prefix} verify-ui summary domSnapshotPath not found: ${summary.domSnapshotPath}`);
    } else if (domPath && hasDomHash) {
      const actual = hashFile(domPath);
      if (actual !== summary.domSnapshotHash) {
        errors.push(`${prefix} verify-ui summary domSnapshotHash does not match domSnapshotPath (${actual})`);
      }
    }
  }
}

function validateVerifyUiSummaryChecks(summary, prefix) {
  if (!Array.isArray(summary.checks)) {
    errors.push(`${prefix} verify-ui summary must include checks array`);
    return;
  }
  const passedChecks = new Set(
    summary.checks
      .filter((check) => check && check.passed === true)
      .map((check) => String(check.name || "").trim()),
  );
  for (const required of REQUIRED_VERIFY_UI_CHECKS) {
    if (!passedChecks.has(required)) {
      errors.push(`${prefix} verify-ui summary must include passing check "${required}"`);
    }
  }
}

function validateScreenshotBytes(shotPath, shot, prefix) {
  let bytes;
  try {
    bytes = readFileSync(shotPath);
  } catch (err) {
    errors.push(`${prefix} could not be read: ${err.message}`);
    return;
  }
  if (bytes.length === 0) {
    errors.push(`${prefix} must not be empty`);
    return;
  }
  if (String(shot).toLowerCase().endsWith(".png")) {
    const hasSignature = PNG_SIGNATURE.every((value, idx) => bytes[idx] === value);
    if (!hasSignature) errors.push(`${prefix} must have a PNG signature`);
  }
}

function normalized(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandMatchesExpected(actual, expected) {
  const actualCommand = normalized(actual);
  const expectedCommand = normalized(expected);
  if (!actualCommand || !expectedCommand) return false;
  const pattern = new RegExp(`(^|[;&|()]\\s*)${escapeRegex(expectedCommand)}(?=$|[\\s;&|()])`);
  return pattern.test(actualCommand);
}

function artifactMatchesExpected(actual, expected) {
  const actualArtifact = normalized(actual);
  const expectedArtifact = normalized(expected);
  if (!actualArtifact || !expectedArtifact) return false;
  return actualArtifact === expectedArtifact || actualArtifact.endsWith(`/${expectedArtifact}`);
}

function hasManualProofArtifact(check) {
  return Boolean(concrete(check?.artifact));
}

function hasAcceptanceProof(evidence, acceptance) {
  const id = String(acceptance?.id || "");
  const verification = acceptance?.verification || {};
  const command = concrete(verification.command);
  const artifact = concrete(verification.artifact);
  const requiresMachineMatch = Boolean(command || artifact);
  return (evidence.checks || []).some((check) => {
    if (check.status !== "pass") return false;
    if (command) {
      if (commandMatchesExpected(check.command, command)) {
        return true;
      }
    }
    if (artifact) {
      if (artifactMatchesExpected(check.artifact, artifact)) {
        return true;
      }
    }
    if (requiresMachineMatch) return false;
    if (id && check.acceptanceId === id && hasManualProofArtifact(check)) return true;
    return false;
  });
}

function validateAcceptanceEvidence({ contract, contractPath, evidence, evidencePath }) {
  const contractPrefix = rel(contractPath);
  const evidencePrefix = rel(evidencePath);
  const acceptanceIds = new Set((contract.acceptance || []).map((item) => String(item?.id || "")).filter(Boolean));
  for (const [idx, check] of (evidence.checks || []).entries()) {
    if (check?.acceptanceId !== undefined && !acceptanceIds.has(check.acceptanceId)) {
      errors.push(`${evidencePrefix}: checks[${idx}].acceptanceId "${check.acceptanceId}" does not match any task contract acceptance id`);
    }
  }
  for (const [idx, acceptance] of (contract.acceptance || []).entries()) {
    const id = String(acceptance?.id || `acceptance[${idx}]`);
    const verification = acceptance?.verification || {};
    if (verification.command !== undefined) {
      errors.push(...validateProofCommand(verification.command, {
        prefix: `${contractPrefix}: acceptance "${id}" verification.command`,
        context: "task contract acceptance verification",
      }));
    }
    const hasConcreteVerification = concrete(verification.command)
      || concrete(verification.artifact)
      || concrete(verification.manual);
    if (!hasConcreteVerification) {
      errors.push(`${contractPrefix}: acceptance "${id}" must define concrete verification before done`);
      continue;
    }
    if (!hasAcceptanceProof(evidence, acceptance)) {
      const proofKind = concrete(verification.command) || concrete(verification.artifact)
        ? "matching verification command/artifact"
        : `acceptanceId="${id}" plus artifact`;
      errors.push(`${evidencePrefix}: acceptance "${id}" requires a passing evidence check with ${proofKind}`);
    }
  }
}

function layerForChangedFile(filePath) {
  const abs = resolve(ROOT, filePath || "");
  if (!insideRoot(abs)) {
    return { outsideRoot: true, rel: String(filePath || "") };
  }
  const relPath = rel(abs).replaceAll("\\", "/");
  const domains = Array.isArray(config.domains) ? config.domains : [];
  for (const domain of domains) {
    const root = String(domain.root || "").replace(/^\/+|\/+$/g, "");
    if (!root) continue;
    if (relPath !== root && !relPath.startsWith(`${root}/`)) continue;
    const layers = Array.isArray(domain.layers) ? domain.layers : [];
    const pattern = domain.layerDirPattern || "{layer}";
    for (const layer of layers) {
      const layerDir = String(pattern).replaceAll("{layer}", layer).replace(/^\/+|\/+$/g, "");
      const prefix = `${root}/${layerDir}`;
      if (relPath === prefix || relPath.startsWith(`${prefix}/`)) {
        return { domain: domain.name || "default", layer, rel: relPath };
      }
    }
    return { domain: domain.name || "default", layer: "", rel: relPath };
  }
  return null;
}

function validateEvidenceLayerScope({ contract, evidence, evidencePath }) {
  const allowedLayers = contract.scope?.allowedLayers;
  if (!Array.isArray(allowedLayers) || allowedLayers.length === 0) return;
  const allowed = new Set(allowedLayers);
  for (const file of evidence.changedFiles || []) {
    if (typeof file !== "string" || !file.trim()) continue;
    const layer = layerForChangedFile(file);
    if (!layer) continue;
    if (layer.outsideRoot) {
      errors.push(`${rel(evidencePath)}: changed file "${layer.rel}" must stay inside the project root`);
      continue;
    }
    if (!layer.layer) {
      errors.push(`${rel(evidencePath)}: changed file "${layer.rel}" is unlayered under domain "${layer.domain}" but task scope only allows layer(s) ${allowedLayers.join(", ")}`);
      continue;
    }
    if (!allowed.has(layer.layer)) {
      errors.push(`${rel(evidencePath)}: changed file "${layer.rel}" is in layer "${layer.layer}" but task scope only allows layer(s) ${allowedLayers.join(", ")}`);
    }
  }
}

function normalizedProjectPath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const abs = resolve(ROOT, text);
  const normalized = insideRoot(abs) ? rel(abs) : text;
  return normalized.replaceAll("\\", "/").replace(/^\.\//, "");
}

function validateReviewDecisionCoverage({ reviewer, reviewDecision, evidence, evidencePath }) {
  const prefix = rel(evidencePath);
  const checkedFiles = Array.isArray(reviewDecision.checkedFiles)
    ? reviewDecision.checkedFiles.map(normalizedProjectPath).filter(Boolean)
    : [];
  if (checkedFiles.length === 0) {
    errors.push(`${prefix}: reviewer "${reviewer}" pass decision must list checkedFiles`);
    return;
  }
  const changedFiles = (Array.isArray(evidence.changedFiles) ? evidence.changedFiles : [])
    .map(normalizedProjectPath)
    .filter(Boolean);
  if (changedFiles.length === 0) return;
  const changed = new Set(changedFiles);
  if (!checkedFiles.some((file) => changed.has(file))) {
    errors.push(`${prefix}: reviewer "${reviewer}" checkedFiles must include at least one evidence changed file`);
  }
}

function validateReviewDecisionBinding({ reviewer, reviewDecision, contract, featureId, evidencePath }) {
  const prefix = rel(evidencePath);
  if (!reviewDecision.taskId) {
    errors.push(`${prefix}: reviewer "${reviewer}" pass decision must include taskId`);
  } else if (reviewDecision.taskId !== contract.id) {
    errors.push(`${prefix}: reviewer "${reviewer}" taskId "${reviewDecision.taskId}" must match contract id "${contract.id}"`);
  }
  if (!reviewDecision.featureId) {
    errors.push(`${prefix}: reviewer "${reviewer}" pass decision must include featureId`);
  } else if (reviewDecision.featureId !== featureId) {
    errors.push(`${prefix}: reviewer "${reviewer}" featureId "${reviewDecision.featureId}" must match feature id "${featureId}"`);
  }
}

function changedSourceFiles(evidence) {
  const files = [];
  const seen = new Set();
  for (const file of evidence.changedFiles || []) {
    if (typeof file !== "string" || !file.trim()) continue;
    const layer = layerForChangedFile(file);
    if (!layer || layer.outsideRoot) continue;
    const normalized = normalizedProjectPath(layer.rel);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    files.push(normalized);
  }
  return files;
}

function isHarnessProofArtifact(file) {
  return (
    file === ".harness/feature_list.json" ||
    file === ".harness/PROGRESS.md" ||
    file === ".harness/compaction-snapshot.json" ||
    file === ".harness/bypass.log" ||
    file === ".harness/bypass-audit.json" ||
    file.startsWith(".harness/bypass-requests/") ||
    file.startsWith(".harness/evidence/") ||
    file.startsWith(".harness/task-contracts/") ||
    file.startsWith(".harness/reviews/") ||
    file.startsWith(".harness/state/") ||
    file.startsWith(".harness/memory/") ||
    file.startsWith(".harness/project/") ||
    file.startsWith(".harness/failures/records/")
  );
}

function isTechnicalDiffFile(file) {
  return (
    /(^|\/)package(?:-lock)?\.json$/.test(file) ||
    /(^|\/)(pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/.test(file) ||
    /(^|\/)(tsconfig[^/]*\.json|jsconfig\.json)$/.test(file) ||
    /(^|\/)(next|vite|eslint|prettier|tailwind|postcss)\.config\.[cm]?[jt]s$/.test(file) ||
    /(^|\/)(pyproject\.toml|poetry\.lock|requirements[^/]*\.txt)$/.test(file) ||
    /(^|\/)(Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Package\.swift)$/.test(file) ||
    /(^|\/)(build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/.test(file) ||
    /(^|\/)Dockerfile[^/]*$/.test(file) ||
    /(^|\/)docker-compose[^/]*\.ya?ml$/.test(file) ||
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) ||
    /^\.harness\/config\.json$/.test(file) ||
    /^\.claude\/settings\.json$/.test(file) ||
    /^\.codex\/hooks\.json$/.test(file) ||
    /(^|\/)\.env\.(example|sample)$/.test(file)
  );
}

function shouldCoverCurrentDiffFile(file) {
  if (!file || isHarnessProofArtifact(file)) return false;
  const layer = layerForChangedFile(file);
  if (layer && !layer.outsideRoot) return true;
  return isTechnicalDiffFile(file);
}

function changedEvidenceCoveredFiles(evidence) {
  const files = [];
  const seen = new Set();
  for (const file of evidence.changedFiles || []) {
    if (typeof file !== "string" || !file.trim()) continue;
    const normalized = normalizedProjectPath(file);
    if (!normalized || !shouldCoverCurrentDiffFile(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    files.push(normalized);
  }
  return files;
}

function changedReviewCoverageFiles(evidence) {
  const files = [];
  const seen = new Set();
  for (const file of evidence.changedFiles || []) {
    if (typeof file !== "string" || !file.trim()) continue;
    const normalized = normalizedProjectPath(file);
    if (!normalized || isHarnessProofArtifact(normalized)) continue;
    const layer = layerForChangedFile(normalized);
    const mustCover = (layer && !layer.outsideRoot) || isTechnicalDiffFile(normalized);
    if (!mustCover || seen.has(normalized)) continue;
    seen.add(normalized);
    files.push(normalized);
  }
  return files.sort();
}

function currentGitDiffCoverageFiles() {
  if (currentGitDiffCoverageFilesCache !== undefined) return currentGitDiffCoverageFilesCache;
  currentGitDiffCoverageFilesCache = [];

  const tracked = spawnSync("git", ["diff", "--name-only", "HEAD", "--"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (tracked.status !== 0 || untracked.status !== 0) {
    if (!currentGitDiffWarningEmitted) {
      warnings.push("current git diff unavailable; skipping current-diff changedFiles coverage");
      currentGitDiffWarningEmitted = true;
    }
    return currentGitDiffCoverageFilesCache;
  }

  const seen = new Set();
  const files = `${tracked.stdout || ""}\n${untracked.stdout || ""}`
    .split(/\r?\n/)
    .map(normalizedProjectPath)
    .filter(Boolean);
  for (const file of files) {
    if (!shouldCoverCurrentDiffFile(file)) continue;
    const normalized = normalizedProjectPath(file);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    currentGitDiffCoverageFilesCache.push(normalized);
  }
  currentGitDiffCoverageFilesCache.sort();
  return currentGitDiffCoverageFilesCache;
}

function validateCurrentDiffSourceCoverage({ evidenceEntries, prefix }) {
  const diffSourceFiles = currentGitDiffCoverageFiles();
  if (diffSourceFiles.length === 0) return;
  const covered = new Set();
  for (const entry of evidenceEntries || []) {
    for (const file of changedEvidenceCoveredFiles(entry.evidence || entry)) {
      covered.add(file);
    }
  }
  const missing = diffSourceFiles.filter((file) => !covered.has(file));
  if (missing.length > 0) {
    errors.push(`${prefix}: evidence changedFiles must cover current git diff source/config file(s): ${missing.join(", ")}`);
  }
}

function validateRequiredReviewerSourceCoverage({ reviewDecisions, evidence, evidencePath }) {
  const sourceFiles = changedReviewCoverageFiles(evidence);
  if (sourceFiles.length === 0) return;
  const covered = new Set();
  for (const reviewDecision of reviewDecisions) {
    for (const file of Array.isArray(reviewDecision.checkedFiles) ? reviewDecision.checkedFiles : []) {
      const normalized = normalizedProjectPath(file);
      if (normalized) covered.add(normalized);
    }
  }
  const missing = sourceFiles.filter((file) => !covered.has(file));
  if (missing.length > 0) {
    errors.push(`${rel(evidencePath)}: required reviewer checkedFiles must cover changed source/config file(s): ${missing.join(", ")}`);
  }
}

const REQUIRED_ATTESTATION_FIELDS = [
  "exitCode",
  "cwd",
  "startedAt",
  "finishedAt",
  "gitHead",
  "workingTreeHash",
  "stdoutHash",
  "stderrHash",
  "stdoutPath",
  "stderrPath",
];

function validateHighRiskAttestation({ contract, evidence, evidencePath }) {
  if (!opts.strict || contract?.riskTier !== "high-risk" || evidence?.status !== "pass") return;
  const prefix = rel(evidencePath);
  for (const [idx, check] of (evidence.checks || []).entries()) {
    if (check?.status !== "pass") continue;
    const missing = REQUIRED_ATTESTATION_FIELDS.filter((field) => check?.[field] === undefined || check?.[field] === "");
    if (missing.length > 0) {
      errors.push(`${prefix}: checks[${idx}] must include attestation fields for high-risk strict evidence: ${missing.join(", ")}`);
    }
  }
}

function validateEvidenceAgainstContract({ feature, contract, contractPath, evidence, evidencePath }) {
  const featureId = String(feature?.id || contract?.id || "");
  const prefix = rel(evidencePath);
  if (!evidence || !contract) return;
  if (evidence.taskId !== contract.id) {
    errors.push(`${prefix}: taskId "${evidence.taskId}" must match contract id "${contract.id}"`);
  }
  if (evidence.featureId && evidence.featureId !== featureId) {
    errors.push(`${prefix}: featureId "${evidence.featureId}" must match feature id "${featureId}"`);
  }
  if (evidence.status !== "pass") {
    errors.push(`${prefix}: status must be pass before feature "${featureId}" can set passes=true`);
  }
  for (const check of evidence.checks || []) {
    if (evidence.status === "pass" && check.status !== "pass") {
      errors.push(`${prefix}: pass evidence cannot contain non-passing check "${check.name}"`);
    }
  }
  validateAcceptanceEvidence({ contract, contractPath, evidence, evidencePath });
  validateEvidenceLayerScope({ contract, evidence, evidencePath });
  validateHighRiskAttestation({ contract, evidence, evidencePath });
  for (const gate of contract.doneRequires || []) {
    if (gate === "evidence-bundle") continue;
    if (gate === "review") {
      const required = Array.isArray(contract.requiredReviewers) ? contract.requiredReviewers : [];
      const passedReviewDecisions = [];
      for (const reviewer of required) {
        const reviewerEntry = (evidence.reviewers || []).find((item) => item.name === reviewer);
        if (reviewerEntry?.decision !== "pass") {
          errors.push(`${prefix}: reviewer "${reviewer}" must have decision=pass for ${rel(contractPath)}`);
          continue;
        }
        const reviewDecision = reviewDecisionCache.get(reviewerEntry);
        if (!reviewDecision) {
          errors.push(`${prefix}: reviewer "${reviewer}" must include reviewDecision or a JSON artifact matching .harness/schemas/review-decision.schema.json`);
          continue;
        }
        if (reviewDecision.decision !== "pass") {
          errors.push(`${prefix}: reviewer "${reviewer}" review decision must be pass for ${rel(contractPath)}`);
        } else {
          validateReviewDecisionBinding({ reviewer, reviewDecision, contract, featureId, evidencePath });
          validateReviewDecisionCoverage({ reviewer, reviewDecision, evidence, evidencePath });
          passedReviewDecisions.push(reviewDecision);
        }
        for (const requiredGate of reviewDecision.requiredGates || []) {
          if (!REVIEW_REQUIRED_GATES.has(requiredGate)) continue;
          if (!hasPassingCheck(evidence, requiredGate)) {
            errors.push(`${prefix}: reviewer "${reviewer}" requires missing passing check "${requiredGate}"`);
          }
        }
      }
      validateRequiredReviewerSourceCoverage({ reviewDecisions: passedReviewDecisions, evidence, evidencePath });
      continue;
    }
    if (!hasPassingCheck(evidence, gate)) {
      errors.push(`${prefix}: missing passing "${gate}" check required by ${rel(contractPath)}`);
    }
  }
}

function requireFeatureEvidence(feature, { reason }) {
  const id = String(feature?.id || "");
  if (!id) {
    errors.push(`${reason}: active feature is missing id`);
    return;
  }
  const contractPath = resolveFeaturePath(
    feature.taskContractPath,
    `.harness/task-contracts/${id}.json`,
    `${reason}:${id}: taskContractPath`,
  );
  const contractEntry = existsSync(contractPath)
    ? { contract: validateTaskContract(readJson(contractPath, rel(contractPath)), contractPath, id), path: contractPath }
    : contractById.get(id);
  if (!contractEntry?.contract) {
    errors.push(`${reason}:${id}: completion requires ${rel(contractPath)}`);
    return;
  }
  const expectedEvidencePath = resolveFeaturePath(
    feature.evidencePath || contractEntry.contract.evidencePath,
    `.harness/evidence/${id}.json`,
    `${reason}:${id}: evidencePath`,
  );
  const evidenceEntry = existsSync(expectedEvidencePath)
    ? { evidence: validateEvidenceShape(readJson(expectedEvidencePath, rel(expectedEvidencePath)), expectedEvidencePath), path: expectedEvidencePath }
    : evidenceByTaskId.get(contractEntry.contract.id);
  if (!evidenceEntry?.evidence) {
    errors.push(`${reason}:${id}: completion requires ${rel(expectedEvidencePath)}`);
    return;
  }
  validateEvidenceAgainstContract({
    feature,
    contract: contractEntry.contract,
    contractPath: contractEntry.path,
    evidence: evidenceEntry.evidence,
    evidencePath: evidenceEntry.path,
  });
  if (feature?.passes !== true) {
    errors.push(`${reason}:${id}: passing evidence exists, but .harness/feature_list.json still has passes=false`);
  }
  return {
    feature,
    contract: contractEntry.contract,
    contractPath: contractEntry.path,
    evidence: evidenceEntry.evidence,
    evidencePath: evidenceEntry.path,
  };
}

function listJsonFiles(dir) {
  if (!dir || !insideRoot(dir)) return [];
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function listJsonFilesRecursive(dir) {
  if (!dir || !insideRoot(dir)) return [];
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsonFilesRecursive(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(path);
  }
  return out.sort();
}

const config = readConfig();
const taskCfg = config.taskContracts || {};
if (taskCfg.enabled === false) {
  finish();
}

const contractsDir = resolveProjectPath(taskCfg.contractsDir || ".harness/task-contracts", ".harness/config.json: taskContracts.contractsDir");
const evidenceDir = resolveProjectPath(taskCfg.evidenceDir || ".harness/evidence", ".harness/config.json: taskContracts.evidenceDir");
const reviewsDir = resolveProjectPath(taskCfg.reviewsDir || ".harness/reviews", ".harness/config.json: taskContracts.reviewsDir");
const featureListPath = resolve(ROOT, ".harness/feature_list.json");

const contractById = new Map();
for (const path of listJsonFiles(contractsDir)) {
  const doc = readJson(path, rel(path));
  if (opts.taskId && doc?.id !== opts.taskId) continue;
  const contract = validateTaskContract(doc, path);
  if (contract?.id) contractById.set(contract.id, { contract, path });
}

const evidenceByTaskId = new Map();
for (const path of listJsonFiles(evidenceDir)) {
  const doc = readJson(path, rel(path));
  if (opts.taskId && doc?.taskId !== opts.taskId) continue;
  const evidence = validateEvidenceShape(doc, path);
  if (evidence?.taskId) evidenceByTaskId.set(evidence.taskId, { evidence, path });
}

for (const path of listJsonFilesRecursive(reviewsDir)) {
  const doc = readJson(path, rel(path));
  if (opts.taskId && doc?.taskId !== opts.taskId) continue;
  validateReviewDecision(doc, path);
}

let currentFeatures = [];
const newlyPassedEvidenceEntries = [];
const newlyPassedIds = new Set();
if (existsSync(featureListPath)) {
  const featureList = readJson(featureListPath, rel(featureListPath));
  validateFeatureListShape(featureList, featureListPath);
  currentFeatures = featureArray(featureList);
  if (opts.taskId) currentFeatures = currentFeatures.filter((feature) => String(feature?.id || "") === opts.taskId);
  const newlyPassed = changedToPassFeatures(currentFeatures);
  for (const feature of newlyPassed) {
    const id = String(feature?.id || "");
    if (!id) {
      errors.push(`${rel(featureListPath)}: a passes=true feature is missing id`);
      continue;
    }
    const contractPath = resolveFeaturePath(
      feature.taskContractPath,
      `.harness/task-contracts/${id}.json`,
      `${rel(featureListPath)}:${id}: taskContractPath`,
    );
    const contractEntry = existsSync(contractPath)
      ? { contract: validateTaskContract(readJson(contractPath, rel(contractPath)), contractPath, id), path: contractPath }
      : contractById.get(id);
    if (!contractEntry?.contract) {
      errors.push(`${rel(featureListPath)}:${id}: passes=true requires ${rel(contractPath)}`);
      continue;
    }
    const expectedEvidencePath = resolveFeaturePath(
      feature.evidencePath || contractEntry.contract.evidencePath,
      `.harness/evidence/${id}.json`,
      `${rel(featureListPath)}:${id}: evidencePath`,
    );
    const evidenceEntry = existsSync(expectedEvidencePath)
      ? { evidence: validateEvidenceShape(readJson(expectedEvidencePath, rel(expectedEvidencePath)), expectedEvidencePath), path: expectedEvidencePath }
      : evidenceByTaskId.get(contractEntry.contract.id);
    if (!evidenceEntry?.evidence) {
      errors.push(`${rel(featureListPath)}:${id}: passes=true requires ${rel(expectedEvidencePath)}`);
      continue;
    }
    validateEvidenceAgainstContract({
      feature,
      contract: contractEntry.contract,
      contractPath: contractEntry.path,
      evidence: evidenceEntry.evidence,
      evidencePath: evidenceEntry.path,
    });
    newlyPassedIds.add(id);
    newlyPassedEvidenceEntries.push({
      feature,
      contract: contractEntry.contract,
      contractPath: contractEntry.path,
      evidence: evidenceEntry.evidence,
      evidencePath: evidenceEntry.path,
    });
  }
  if (newlyPassedEvidenceEntries.length > 0) {
    validateCurrentDiffSourceCoverage({
      evidenceEntries: newlyPassedEvidenceEntries,
      prefix: rel(featureListPath),
    });
  }
} else if (opts.strict && (contractById.size > 0 || evidenceByTaskId.size > 0)) {
  warnings.push(".harness/feature_list.json not found; validated contracts/evidence files only");
}

if (activeEvidenceRequired()) {
  const activeTaskId = readActiveTaskId();
  if (!activeTaskId) {
    errors.push("active-task: completion gate is active, but .harness/state/active-task.txt is empty");
  } else {
    const feature = currentFeatures.find((item) => String(item?.id || "") === activeTaskId);
    if (!feature) {
      errors.push(`active-task:${activeTaskId}: completion gate is active, but task is not present in .harness/feature_list.json`);
    } else {
      const activeEvidenceEntry = requireFeatureEvidence(feature, { reason: "active-task" });
      if (activeEvidenceEntry && !newlyPassedIds.has(activeTaskId)) {
        validateCurrentDiffSourceCoverage({
          evidenceEntries: [activeEvidenceEntry],
          prefix: `active-task:${activeTaskId}`,
        });
      }
    }
  }
}

finish();

function finish() {
  const payload = {
    status: errors.length === 0 ? "passed" : "failed",
    errors,
    warnings,
  };
  if (opts.replayPlan) payload.replayPlan = replayPlan;
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (errors.length > 0) {
    console.error("task-evidence-check: FAILED");
    for (const error of errors) console.error(`- ${error}`);
    for (const warning of warnings) console.error(`warning: ${warning}`);
  } else {
    console.log("task-evidence-check: OK");
    for (const warning of warnings) console.warn(`warning: ${warning}`);
    if (opts.replayPlan) {
      for (const item of replayPlan) console.log(`replay: ${item.taskId}:${item.check} -> ${item.command}`);
    }
  }
  process.exit(errors.length === 0 ? 0 : 1);
}

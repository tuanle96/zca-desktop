#!/usr/bin/env node
// check-orchestration-contracts.mjs - validate multi-agent workflow contracts
// and any recorded orchestration runs that claim to follow one.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";

const DEFAULT_PATTERNS = ["pipeline", "fanout", "fanin", "expert-pool", "red-team", "supervisor"];
const ROLES = new Set(["explore", "plan", "implementation", "review", "red-team", "synthesis", "supervisor"]);
const TOOL_POLICIES = new Set(["read-only", "review-only", "mutating"]);
const PERMISSION_PROFILES = new Set(["read-only", "review-only", "mixed", "mutation"]);
const REQUIRED_ARTIFACTS = new Set(["manifest", "summary", "transcripts", "synthesis", "review-decisions", "evidence"]);
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function parseArgs(argv) {
  const opts = {
    root: process.cwd(),
    config: ".harness/config.json",
    contractsDir: null,
    runsDir: null,
    run: [],
    strict: false,
    json: false,
  };
  for (const arg of argv) {
    if (arg === "--strict") opts.strict = true;
    else if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--root=")) opts.root = arg.slice("--root=".length);
    else if (arg.startsWith("--config=")) opts.config = arg.slice("--config=".length);
    else if (arg.startsWith("--contracts-dir=")) opts.contractsDir = arg.slice("--contracts-dir=".length);
    else if (arg.startsWith("--runs-dir=")) opts.runsDir = arg.slice("--runs-dir=".length);
    else if (arg.startsWith("--run=")) opts.run.push(arg.slice("--run=".length));
  }
  opts.root = resolve(opts.root);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const ROOT = opts.root;
const errors = [];
const warnings = [];

function rel(path) {
  return relative(ROOT, path).split("\\").join("/") || ".";
}

function canonicalLocalPath(path) {
  return path.replace(/^\/private\/var\//, "/var/");
}

function readJson(path, label = rel(path)) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${label}: invalid JSON (${error.message})`);
    return null;
  }
}

function resolveProjectPath(value, label, { mustExist = false, allowAbsoluteInsideRoot = false } = {}) {
  if (!value || typeof value !== "string") {
    errors.push(`${label}: path is required`);
    return null;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    errors.push(`${label}: must be a repo-local relative path`);
    return null;
  }
  if (isAbsolute(value)) {
    const absolute = resolve(value);
    const relFromRoot = relative(canonicalLocalPath(ROOT), canonicalLocalPath(absolute)).split("\\").join("/");
    if (!allowAbsoluteInsideRoot || relFromRoot.startsWith("..") || relFromRoot === "") {
      errors.push(`${label}: must be a repo-local relative path`);
      return null;
    }
    if (mustExist && !existsSync(absolute)) {
      errors.push(`${label}: not found: ${relFromRoot}`);
    }
    return { absolute, normalized: relFromRoot };
  }
  const normalized = value.split("\\").join("/").replace(/^\.\//, "");
  if (normalized.split("/").includes("..")) {
    errors.push(`${label}: must stay inside the project root`);
    return null;
  }
  const absolute = resolve(ROOT, normalized);
  if (relative(ROOT, absolute).startsWith("..")) {
    errors.push(`${label}: must stay inside the project root`);
    return null;
  }
  if (mustExist && !existsSync(absolute)) {
    errors.push(`${label}: not found: ${normalized}`);
  }
  return { absolute, normalized };
}

function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => join(dir, entry));
}

function listRunDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry !== "contracts")
    .map((entry) => join(dir, entry))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function readConfig() {
  const configured = resolveProjectPath(opts.config, "--config", { mustExist: existsSync(resolve(ROOT, opts.config)) });
  if (!configured || !existsSync(configured.absolute)) return {};
  return readJson(configured.absolute, configured.normalized) || {};
}

const config = readConfig();
const orchestrationConfig = config.orchestration || {};
const taskConfig = config.taskContracts || {};
const contractsDir = resolve(
  ROOT,
  opts.contractsDir || orchestrationConfig.contractsDir || ".harness/orchestration/contracts",
);
const runsDir = resolve(ROOT, opts.runsDir || orchestrationConfig.runsDir || ".harness/orchestration");
const taskContractsDir = resolve(ROOT, taskConfig.contractsDir || ".harness/task-contracts");
const maxConcurrencyLimit = Number.isInteger(orchestrationConfig.maxConcurrency)
  ? orchestrationConfig.maxConcurrency
  : 3;
const maxAgentsLimit = Number.isInteger(orchestrationConfig.maxAgents)
  ? orchestrationConfig.maxAgents
  : 6;
const allowedPatterns = new Set(
  Array.isArray(orchestrationConfig.allowedPatterns) && orchestrationConfig.allowedPatterns.length > 0
    ? orchestrationConfig.allowedPatterns
    : DEFAULT_PATTERNS,
);

function stableId(value, label) {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    errors.push(`${label}: must be a stable lowercase id`);
    return false;
  }
  return true;
}

function validateStringArray(value, label, { required = false, allowed = null } = {}) {
  if (value === undefined) {
    if (required) errors.push(`${label}: is required`);
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push(`${label}: must be an array`);
    return [];
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim() === "") {
      errors.push(`${label}[${index}]: must be a non-empty string`);
      continue;
    }
    if (seen.has(item)) errors.push(`${label}: duplicate "${item}"`);
    seen.add(item);
    if (allowed && !allowed.has(item)) errors.push(`${label}[${index}]: unsupported value "${item}"`);
  }
  return value;
}

function loadTaskContract(taskId, contractPath) {
  const taskPath = join(taskContractsDir, `${taskId}.json`);
  if (!existsSync(taskPath)) {
    errors.push(`${contractPath}: taskId "${taskId}" has no task contract at ${rel(taskPath)}`);
    return null;
  }
  return readJson(taskPath, rel(taskPath));
}

function reviewerIdsFromTask(task) {
  return Array.isArray(task?.requiredReviewers) ? task.requiredReviewers : [];
}

function validateContract(contract, path) {
  const prefix = rel(path);
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    errors.push(`${prefix}: contract must be an object`);
    return null;
  }
  if (contract.schemaVersion !== 1) errors.push(`${prefix}: schemaVersion must be 1`);
  stableId(contract.id, `${prefix}: id`);
  if (!allowedPatterns.has(contract.pattern)) {
    errors.push(`${prefix}: pattern must be one of ${[...allowedPatterns].join(", ")}`);
  }
  if (contract.taskId !== undefined) stableId(contract.taskId, `${prefix}: taskId`);
  if (contract.featureId !== undefined) stableId(contract.featureId, `${prefix}: featureId`);
  if (!Number.isInteger(contract.maxConcurrency) || contract.maxConcurrency < 1) {
    errors.push(`${prefix}: maxConcurrency must be a positive integer`);
  } else if (contract.maxConcurrency > maxConcurrencyLimit) {
    errors.push(`${prefix}: maxConcurrency ${contract.maxConcurrency} exceeds configured limit ${maxConcurrencyLimit}`);
  }
  if (!PERMISSION_PROFILES.has(contract.permissionProfile)) {
    errors.push(`${prefix}: permissionProfile must be read-only, review-only, mixed, or mutation`);
  }

  const requiredArtifacts = validateStringArray(contract.requiredArtifacts, `${prefix}: requiredArtifacts`, {
    required: true,
    allowed: REQUIRED_ARTIFACTS,
  });
  const requiredReviewers = validateStringArray(contract.requiredReviewers, `${prefix}: requiredReviewers`)
    .filter((id) => stableId(id, `${prefix}: requiredReviewers`));
  const lanes = Array.isArray(contract.lanes) ? contract.lanes : [];
  if (!Array.isArray(contract.lanes) || lanes.length === 0) {
    errors.push(`${prefix}: lanes must be a non-empty array`);
  } else if (lanes.length > maxAgentsLimit) {
    errors.push(`${prefix}: lanes length ${lanes.length} exceeds configured maxAgents ${maxAgentsLimit}`);
  }
  if (Number.isInteger(contract.maxConcurrency) && lanes.length > 0 && contract.maxConcurrency > lanes.length) {
    warnings.push(`${prefix}: maxConcurrency exceeds lane count`);
  }

  let taskContract = null;
  if (contract.taskId) {
    taskContract = loadTaskContract(contract.taskId, prefix);
  }
  const taskReviewers = reviewerIdsFromTask(taskContract);
  for (const reviewer of taskReviewers) {
    if (!requiredReviewers.includes(reviewer)) {
      errors.push(`${prefix}: task contract reviewer "${reviewer}" is missing from requiredReviewers`);
    }
  }
  if (taskContract?.riskTier === "high-risk" && !["expert-pool", "red-team", "pipeline"].includes(contract.pattern)) {
    errors.push(`${prefix}: high-risk task orchestration must use expert-pool, red-team, or pipeline`);
  }
  if (requiredArtifacts.includes("review-decisions") && requiredReviewers.length === 0) {
    errors.push(`${prefix}: review-decisions artifact requires at least one requiredReviewer`);
  }

  const laneIds = new Set();
  const outputPaths = new Set();
  const reviewerLanes = new Set();
  let mutatingLanes = 0;
  for (const [index, lane] of lanes.entries()) {
    const lanePrefix = `${prefix}: lanes[${index}]`;
    if (!lane || typeof lane !== "object" || Array.isArray(lane)) {
      errors.push(`${lanePrefix}: must be an object`);
      continue;
    }
    if (stableId(lane.id, `${lanePrefix}.id`)) {
      if (laneIds.has(lane.id)) errors.push(`${prefix}: duplicate lane id "${lane.id}"`);
      laneIds.add(lane.id);
    }
    if (!lane.title || typeof lane.title !== "string") errors.push(`${lanePrefix}.title: is required`);
    if (!ROLES.has(lane.role)) errors.push(`${lanePrefix}.role: must be one of ${[...ROLES].join(", ")}`);
    if (!TOOL_POLICIES.has(lane.toolPolicy)) {
      errors.push(`${lanePrefix}.toolPolicy: must be read-only, review-only, or mutating`);
    }
    if (!lane.prompt || typeof lane.prompt !== "string") errors.push(`${lanePrefix}.prompt: is required`);
    if (lane.outputPath) {
      const output = resolveProjectPath(lane.outputPath, `${lanePrefix}.outputPath`);
      if (output) {
        if (outputPaths.has(output.normalized)) errors.push(`${prefix}: duplicate outputPath "${output.normalized}"`);
        outputPaths.add(output.normalized);
      }
    } else {
      errors.push(`${lanePrefix}.outputPath: is required`);
    }
    if (lane.requiredReviewer !== undefined) {
      stableId(lane.requiredReviewer, `${lanePrefix}.requiredReviewer`);
      if (!requiredReviewers.includes(lane.requiredReviewer)) {
        errors.push(`${lanePrefix}.requiredReviewer: must be listed in contract.requiredReviewers`);
      }
      if (lane.required !== false) reviewerLanes.add(lane.requiredReviewer);
    }
    if (lane.role === "review" && lane.toolPolicy === "mutating") {
      errors.push(`${lanePrefix}: review lanes cannot use mutating toolPolicy`);
    }
    if (lane.toolPolicy === "review-only" && lane.role !== "review" && lane.role !== "red-team") {
      errors.push(`${lanePrefix}: review-only toolPolicy is only for review/red-team lanes`);
    }
    if (lane.toolPolicy === "mutating") {
      mutatingLanes += 1;
      if (!contract.taskId) errors.push(`${lanePrefix}: mutating lanes require contract.taskId`);
      if (lane.requiresEvidence !== true) errors.push(`${lanePrefix}: mutating lanes require requiresEvidence=true`);
    }
  }

  for (const reviewer of requiredReviewers) {
    if (!reviewerLanes.has(reviewer)) {
      errors.push(`${prefix}: requiredReviewer "${reviewer}" has no required reviewer lane`);
    }
  }
  if (contract.permissionProfile === "read-only" && mutatingLanes > 0) {
    errors.push(`${prefix}: read-only permissionProfile cannot contain mutating lanes`);
  }
  if (contract.permissionProfile === "review-only" && lanes.some((lane) => lane.toolPolicy !== "review-only" && lane.toolPolicy !== "read-only")) {
    errors.push(`${prefix}: review-only permissionProfile cannot contain mutating lanes`);
  }
  if (mutatingLanes > 0 && !requiredArtifacts.includes("evidence")) {
    errors.push(`${prefix}: mutating workflows must include "evidence" in requiredArtifacts`);
  }

  return {
    id: contract.id,
    taskId: contract.taskId || null,
    featureId: contract.featureId || null,
    requiredReviewers,
    lanes,
    path: prefix,
  };
}

function validateRunDir(runDir, contractsByPath) {
  const manifestPath = join(runDir, "manifest.json");
  const summaryPath = join(runDir, "summary.json");
  const hasManifest = existsSync(manifestPath);
  const hasSummary = existsSync(summaryPath);
  if (!hasManifest && !hasSummary) return false;
  if (!hasManifest) errors.push(`${rel(runDir)}: missing manifest.json`);
  if (!hasSummary) errors.push(`${rel(runDir)}: missing summary.json`);
  if (!hasManifest || !hasSummary) return true;

  const manifest = readJson(manifestPath, rel(manifestPath));
  const summary = readJson(summaryPath, rel(summaryPath));
  if (!manifest || !summary) return true;
  if (manifest.schemaVersion !== 1) errors.push(`${rel(manifestPath)}: schemaVersion must be 1`);
  if (summary.schemaVersion !== 1) errors.push(`${rel(summaryPath)}: schemaVersion must be 1`);
  if (manifest.runId && summary.runId && manifest.runId !== summary.runId) {
    errors.push(`${rel(summaryPath)}: runId must match manifest.runId`);
  }
  if (manifest.contractId || manifest.contractPath) {
    if (!manifest.contractId) errors.push(`${rel(manifestPath)}: contractId is required when contractPath is present`);
    if (!manifest.contractPath) errors.push(`${rel(manifestPath)}: contractPath is required when contractId is present`);
    const contractPath = manifest.contractPath
      ? resolveProjectPath(manifest.contractPath, `${rel(manifestPath)}: contractPath`, { mustExist: true })
      : null;
    const contract = contractPath ? contractsByPath.get(contractPath.normalized) : null;
    if (contractPath && !contract) {
      errors.push(`${rel(manifestPath)}: contractPath was not loaded as an orchestration contract`);
    }
    if (contract && manifest.contractId !== contract.id) {
      errors.push(`${rel(manifestPath)}: contractId must match contract.id`);
    }
    if (contract && summary.contractId !== manifest.contractId) {
      errors.push(`${rel(summaryPath)}: contractId must match manifest.contractId`);
    }
    if (contract && summary.taskId !== undefined && summary.taskId !== contract.taskId) {
      errors.push(`${rel(summaryPath)}: taskId must match orchestration contract taskId`);
    }
    const manifestLaneIds = new Set((manifest.agents || []).map((agent) => agent.laneId || agent.id));
    for (const lane of contract?.lanes || []) {
      if (!manifestLaneIds.has(lane.id)) {
        errors.push(`${rel(manifestPath)}: missing manifest agent for contract lane "${lane.id}"`);
      }
    }
  } else if (opts.strict && manifest.taskId && !manifest.contractId) {
    warnings.push(`${rel(manifestPath)}: task-bound run has no orchestration contract`);
  }
  for (const [index, result] of (summary.results || []).entries()) {
    if (result.transcriptPath) {
      const transcript = resolveProjectPath(result.transcriptPath, `${rel(summaryPath)}: results[${index}].transcriptPath`, {
        mustExist: false,
        allowAbsoluteInsideRoot: true,
      });
      if (transcript && !transcript.normalized.startsWith(".harness/orchestration/")) {
        warnings.push(`${rel(summaryPath)}: transcript path is outside .harness/orchestration: ${transcript.normalized}`);
      }
    }
  }
  return true;
}

const contractRecords = [];
const contractsByPath = new Map();
for (const path of listJsonFiles(contractsDir)) {
  const contract = validateContract(readJson(path, rel(path)), path);
  if (contract) {
    contractRecords.push(contract);
    contractsByPath.set(contract.path, contract);
  }
}

let runsChecked = 0;
for (const run of opts.run) {
  const runPath = resolveProjectPath(run, "--run", { mustExist: true });
  if (runPath && validateRunDir(runPath.absolute, contractsByPath)) runsChecked += 1;
}
if (opts.run.length === 0) {
  for (const runDir of listRunDirs(runsDir)) {
    if (validateRunDir(runDir, contractsByPath)) runsChecked += 1;
  }
}

const payload = {
  status: errors.length === 0 ? "passed" : "failed",
  contractsDir: rel(contractsDir),
  runsDir: rel(runsDir),
  contracts: contractRecords.length,
  runs: runsChecked,
  errors,
  warnings,
};

if (opts.json) {
  console.log(JSON.stringify(payload, null, 2));
} else if (errors.length > 0) {
  console.error("check-orchestration-contracts: FAILED");
  for (const error of errors) console.error(`- ${error}`);
  for (const warning of warnings) console.error(`warning: ${warning}`);
} else {
  console.log(`check-orchestration-contracts: OK (${contractRecords.length} contracts, ${runsChecked} runs)`);
  for (const warning of warnings) console.log(`warning: ${warning}`);
}

process.exit(errors.length === 0 ? 0 : 1);

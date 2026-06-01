#!/usr/bin/env node
// orchestration-contract-from-task.mjs - derive a checked multi-agent workflow
// contract from a task contract so workflow shape follows task risk, reviewers,
// permissions, and evidence requirements instead of ad hoc prompt prose.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const DEFAULT_PATTERNS = ["pipeline", "fanout", "fanin", "expert-pool", "red-team", "supervisor"];
const MUTATING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "apply_patch"]);

function parseArgs(argv) {
  const opts = {
    root: process.cwd(),
    config: ".harness/config.json",
    task: null,
    id: null,
    out: null,
    pattern: null,
    reviewers: [],
    force: false,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      if (!opts.task) opts.task = token;
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    if (key === "force") {
      opts.force = true;
      continue;
    }
    if (key === "dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (key === "json") {
      opts.json = true;
      continue;
    }
    let value = eq === -1 ? null : body.slice(eq + 1);
    if (value === null) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }
    if (key === "root") opts.root = resolve(String(value));
    else if (key === "config") opts.config = String(value);
    else if (key === "task") opts.task = String(value);
    else if (key === "id") opts.id = String(value);
    else if (key === "out") opts.out = String(value);
    else if (key === "pattern") opts.pattern = String(value);
    else if (key === "reviewer" || key === "reviewers") opts.reviewers.push(...splitList(value));
    else throw new Error(`unknown option: --${key}`);
  }
  return opts;
}

function splitList(value) {
  if (value === true || value === null || value === undefined) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function rel(root, path) {
  return relative(root, path).split("\\").join("/") || ".";
}

function readJson(path, label = path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label}: invalid JSON (${error.message})`);
  }
}

function stableId(value, label) {
  if (!ID_RE.test(String(value || ""))) {
    throw new Error(`${label} must be a stable lowercase id`);
  }
  return String(value);
}

function isInside(root, target) {
  const inside = relative(root, target);
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

function resolveRepoPath(root, value, label) {
  if (!value || typeof value !== "string") throw new Error(`${label} is required`);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || isAbsolute(value)) {
    throw new Error(`${label} must be a repo-local relative path`);
  }
  const normalized = value.split("\\").join("/").replace(/^\.\//, "");
  if (normalized.split("/").includes("..")) throw new Error(`${label} must stay inside the project root`);
  const absolute = resolve(root, normalized);
  if (!isInside(root, absolute)) throw new Error(`${label} must stay inside the project root`);
  return { absolute, normalized };
}

function readConfig(root, configPath) {
  const configured = resolveRepoPath(root, configPath, "--config");
  if (!existsSync(configured.absolute)) return {};
  return readJson(configured.absolute, configured.normalized);
}

function permissionToolName(entry) {
  if (typeof entry === "string") return entry.split("(")[0];
  if (entry && typeof entry === "object" && typeof entry.tool === "string") return entry.tool.split("(")[0];
  return "";
}

function grantsMutation(task) {
  const allow = task?.permissions?.allow;
  if (!Array.isArray(allow)) return false;
  return allow.some((entry) => MUTATING_TOOLS.has(permissionToolName(entry)));
}

function uniqueStableIds(values, label) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const id = stableId(value, label);
    if (seen.has(id)) throw new Error(`${label} contains duplicate "${id}"`);
    seen.add(id);
    out.push(id);
  }
  return out;
}

function laneIdForReviewer(reviewer, seen) {
  const base = reviewer.endsWith("-reviewer") ? reviewer.replace(/-reviewer$/, "-review") : `${reviewer}-review`;
  let id = base;
  let suffix = 2;
  while (seen.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  seen.add(id);
  return id;
}

function defaultPattern(task, reviewers) {
  if (reviewers.length > 0 || task.riskTier === "high-risk") return "expert-pool";
  return "pipeline";
}

function allowedPatterns(config) {
  const configured = config.orchestration?.allowedPatterns;
  return Array.isArray(configured) && configured.length > 0 ? configured : DEFAULT_PATTERNS;
}

function buildContract(task, config, opts) {
  const taskId = stableId(task.id, "task contract id");
  const taskReviewers = Array.isArray(task.requiredReviewers) ? task.requiredReviewers : [];
  const reviewers = uniqueStableIds([...taskReviewers, ...opts.reviewers], "reviewer id");
  const contractId = stableId(opts.id || `${taskId}-${reviewers.length > 0 ? "review" : "workflow"}`, "contract id");
  const patterns = allowedPatterns(config);
  const pattern = opts.pattern || defaultPattern(task, reviewers);
  if (!patterns.includes(pattern)) throw new Error(`pattern must be one of ${patterns.join(", ")}`);
  const mutating = grantsMutation(task);
  const lanes = [];
  const laneIds = new Set();

  for (const reviewer of reviewers) {
    lanes.push({
      id: laneIdForReviewer(reviewer, laneIds),
      title: `${reviewer} lane`,
      role: "review",
      toolPolicy: "review-only",
      requiredReviewer: reviewer,
      prompt: `Review task contract ${taskId} for correctness, risk, and evidence gaps. Do not edit files.`,
      outputPath: `.harness/reviews/${taskId}/${reviewer}.json`,
    });
  }

  if (mutating) {
    laneIds.add("implementation");
    lanes.push({
      id: "implementation",
      title: "Implementation lane",
      role: "implementation",
      toolPolicy: "mutating",
      requiresEvidence: true,
      prompt: `Implement only task contract ${taskId}. Respect allowed layers, run acceptance verification, and write ${task.evidencePath || `.harness/evidence/${taskId}.json`} before claiming done.`,
      outputPath: `.harness/orchestration/<run-id>/lanes/implementation.json`,
    });
  } else if (lanes.length === 0) {
    lanes.push({
      id: "synthesis",
      title: "Synthesis lane",
      role: "synthesis",
      toolPolicy: "read-only",
      prompt: `Analyze task contract ${taskId} and produce a decision packet with required evidence gaps. Do not edit files.`,
      outputPath: `.harness/orchestration/<run-id>/lanes/synthesis.json`,
    });
  }

  const requiredArtifacts = ["manifest", "summary", "transcripts"];
  if (reviewers.length > 0) requiredArtifacts.push("review-decisions");
  if (mutating) requiredArtifacts.push("evidence");
  if (!mutating && reviewers.length === 0) requiredArtifacts.push("synthesis");

  const configuredMaxConcurrency = Number.isInteger(config.orchestration?.maxConcurrency)
    ? config.orchestration.maxConcurrency
    : 3;
  const maxConcurrency = pattern === "pipeline"
    ? 1
    : Math.max(1, Math.min(lanes.length, configuredMaxConcurrency));

  return {
    schemaVersion: 1,
    id: contractId,
    taskId,
    featureId: stableId(task.featureId || task.scope?.featureId || taskId, "feature id"),
    pattern,
    maxConcurrency,
    permissionProfile: mutating ? (reviewers.length > 0 ? "mixed" : "mutation") : (reviewers.length > 0 ? "review-only" : "read-only"),
    requiredReviewers: reviewers,
    requiredArtifacts,
    lanes,
  };
}

function taskPathFor(root, config, taskId) {
  const contractsDir = resolveRepoPath(root, config.taskContracts?.contractsDir || ".harness/task-contracts", "taskContracts.contractsDir");
  const path = resolve(contractsDir.absolute, `${taskId}.json`);
  if (!isInside(contractsDir.absolute, path)) throw new Error("task contract path must stay inside taskContracts.contractsDir");
  return path;
}

function outputPathFor(root, config, contractId, explicitOut) {
  const contractsDir = resolveRepoPath(
    root,
    config.orchestration?.contractsDir || ".harness/orchestration/contracts",
    "orchestration.contractsDir",
  );
  if (explicitOut) {
    const out = resolveRepoPath(root, explicitOut, "--out");
    if (!isInside(contractsDir.absolute, out.absolute)) {
      throw new Error("--out must stay inside orchestration.contractsDir");
    }
    return out;
  }
  const absolute = resolve(contractsDir.absolute, `${contractId}.json`);
  return { absolute, normalized: rel(root, absolute) };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = resolve(opts.root);
  if (!opts.task) throw new Error("usage: node .harness/scripts/orchestration-contract-from-task.mjs <task-id> [--reviewer=a,b] [--pattern=expert-pool] [--force] [--dry-run]");
  const taskId = stableId(opts.task, "task id");
  const config = readConfig(root, opts.config);
  const taskPath = taskPathFor(root, config, taskId);
  if (!existsSync(taskPath)) throw new Error(`task contract not found: ${rel(root, taskPath)}`);
  const task = readJson(taskPath, rel(root, taskPath));
  if (task.id !== taskId) throw new Error(`task contract id mismatch: expected ${taskId}, got ${task.id || "(missing)"}`);
  const contract = buildContract(task, config, opts);
  const out = outputPathFor(root, config, contract.id, opts.out);
  if (existsSync(out.absolute) && !opts.force && !opts.dryRun) {
    throw new Error(`orchestration contract already exists: ${out.normalized} (use --force to overwrite)`);
  }
  if (!opts.dryRun) {
    mkdirSync(dirname(out.absolute), { recursive: true });
    writeFileSync(out.absolute, JSON.stringify(contract, null, 2) + "\n");
  }
  const payload = {
    status: opts.dryRun ? "dry-run" : "created",
    contractId: contract.id,
    taskId,
    pattern: contract.pattern,
    permissionProfile: contract.permissionProfile,
    reviewers: contract.requiredReviewers,
    lanes: contract.lanes.map((lane) => ({ id: lane.id, role: lane.role, toolPolicy: lane.toolPolicy })),
    out: out.normalized,
    validationCommand: "node .harness/scripts/check-orchestration-contracts.mjs --strict",
  };
  console.log(JSON.stringify(payload, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exit(2);
}

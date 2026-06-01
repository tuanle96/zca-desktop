#!/usr/bin/env node
// check-session-isolation.mjs - verify active agent work is isolated from the
// protected checkout when the task contract can mutate source/config.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_PROTECTED_BRANCHES = ["main", "master", "develop", "release/*"];
const DEFAULT_BRANCH_PREFIXES = ["agent/", "codex/"];
const DEFAULT_SESSION_MANIFEST_DIR = ".harness/sessions";
const DEFAULT_ACTIVE_TASK_PATH = ".harness/active-task.json";
const MUTATING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "apply_patch"]);

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), activeTask: null, json: false, strict: false };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--active-task=")) opts.activeTask = arg.slice("--active-task=".length);
  }
  return opts;
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { __error: `${path}: invalid JSON (${error.message})` };
  }
}

function readConfig(root) {
  return readJson(resolve(root, ".harness/config.json")) || readJson(resolve(root, "harness.config.json")) || {};
}

function git(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function parseGitWorktrees(output) {
  if (!output) return [];
  const records = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) records.push(current);
      current = null;
      continue;
    }
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? true : line.slice(space + 1);
    if (key === "worktree") {
      if (current) records.push(current);
      current = { path: value, branch: null, head: null, detached: false, bare: false };
    } else if (current && key === "branch") {
      current.branch = value.replace(/^refs\/heads\//, "");
    } else if (current && key === "HEAD") {
      current.head = value;
    } else if (current && key === "detached") {
      current.detached = true;
    } else if (current && key === "bare") {
      current.bare = true;
    }
  }
  if (current) records.push(current);
  return records;
}

function gitWorktrees(root) {
  return parseGitWorktrees(git(root, ["worktree", "list", "--porcelain"]));
}

function wildcardMatch(value, pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(String(value || ""));
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"));
}

function resolveInside(root, relPath, label, errors) {
  const abs = resolve(root, relPath);
  if (!isInside(root, abs)) {
    errors.push(`${label} must stay inside the project root`);
    return null;
  }
  return abs;
}

function permissionToolName(entry) {
  if (typeof entry === "string") return entry.split("(")[0];
  if (entry && typeof entry === "object" && typeof entry.tool === "string") {
    return entry.tool.split("(")[0];
  }
  return "";
}

function grantsMutation(contract) {
  const allow = contract?.permissions?.allow;
  if (!Array.isArray(allow)) return false;
  return allow.some((entry) => MUTATING_TOOLS.has(permissionToolName(entry)));
}

function stableTaskId(id) {
  return /^[a-z0-9][a-z0-9._-]*$/.test(String(id || ""));
}

function readActiveTask(root, config, explicit, errors) {
  const cfg = config.sessionIsolation || {};
  const envName = cfg.activeTaskEnv || "AHK_ACTIVE_TASK";
  if (explicit) return { taskId: explicit, source: "argument" };
  if (process.env[envName]) return { taskId: process.env[envName], source: `env:${envName}` };
  if (envName !== "AHK_ACTIVE_TASK" && process.env.AHK_ACTIVE_TASK) {
    return { taskId: process.env.AHK_ACTIVE_TASK, source: "env:AHK_ACTIVE_TASK" };
  }

  const activePath = resolveInside(root, cfg.activeTaskPath || DEFAULT_ACTIVE_TASK_PATH, "sessionIsolation.activeTaskPath", errors);
  if (!activePath || !existsSync(activePath)) return { taskId: null, source: null };
  const active = readJson(activePath);
  if (active?.__error) {
    errors.push(active.__error);
    return { taskId: null, source: "active-task-file" };
  }
  return {
    taskId: typeof active?.taskId === "string" && active.taskId.trim() ? active.taskId.trim() : null,
    source: activePath,
    activeTaskPath: activePath,
  };
}

function readContract(root, config, taskId, errors) {
  if (!stableTaskId(taskId)) {
    errors.push("active task id must be stable lowercase");
    return null;
  }
  const contractsDir = resolveInside(
    root,
    config.taskContracts?.contractsDir || ".harness/task-contracts",
    "taskContracts.contractsDir",
    errors,
  );
  if (!contractsDir) return null;
  const path = resolve(contractsDir, `${taskId}.json`);
  if (!isInside(contractsDir, path)) {
    errors.push("active task contract path must stay inside contractsDir");
    return null;
  }
  const contract = readJson(path);
  if (!contract) {
    errors.push(`active task contract not found: ${relative(root, path)}`);
    return null;
  }
  if (contract.__error) {
    errors.push(contract.__error);
    return null;
  }
  if (contract.id !== taskId) {
    errors.push(`active task contract id mismatch: expected ${taskId}, got ${contract.id || "(missing)"}`);
  }
  return contract;
}

function gitState(root) {
  const toplevel = git(root, ["rev-parse", "--show-toplevel"]);
  if (!toplevel) {
    return { isGitRepo: false, branch: null, gitDir: null, linkedWorktree: false };
  }
  const branch = git(root, ["symbolic-ref", "--short", "HEAD"]) || git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const gitDirRaw = git(root, ["rev-parse", "--git-dir"]);
  const gitDir = gitDirRaw ? resolve(root, gitDirRaw) : null;
  return {
    isGitRepo: true,
    branch,
    gitDir,
    linkedWorktree: gitDir ? gitDir.includes(`${sep}.git${sep}worktrees${sep}`) : false,
    toplevel,
  };
}

function manifestDirFor(worktreePath, config, errors) {
  const relDir = config.sessionIsolation?.manifestDir || DEFAULT_SESSION_MANIFEST_DIR;
  const dir = resolve(worktreePath, relDir);
  if (!isInside(worktreePath, dir)) {
    errors.push("sessionIsolation.manifestDir must stay inside each worktree");
    return null;
  }
  return dir;
}

function collectSessionManifests(root, config, state, errors) {
  const worktrees = state.isGitRepo ? gitWorktrees(root) : [];
  const worktreePaths = new Set([root]);
  for (const item of worktrees) {
    if (item.path) worktreePaths.add(resolve(item.path));
  }

  const sessions = [];
  for (const worktreePath of worktreePaths) {
    const manifestDir = manifestDirFor(worktreePath, config, errors);
    if (!manifestDir || !existsSync(manifestDir)) continue;
    let entries = [];
    try {
      entries = readdirSync(manifestDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const manifestPath = resolve(manifestDir, entry.name);
      const parsed = readJson(manifestPath);
      if (!parsed || parsed.__error) {
        sessions.push({ _invalid: true, _path: relative(root, manifestPath), error: parsed?.__error || "unreadable JSON" });
        continue;
      }
      sessions.push({
        ...parsed,
        _path: relative(root, manifestPath),
        _manifestPath: manifestPath,
        _manifestWorktreePath: worktreePath,
      });
    }
  }
  return { worktrees, sessions };
}

function worktreesDirRoot(root, config, worktrees) {
  const primary = worktrees[0]?.path ? resolve(worktrees[0].path) : root;
  return resolve(primary, config.sessionIsolation?.worktreesDir || "../.agent-worktrees");
}

function sessionHealth(root, config, state, errors) {
  const { worktrees, sessions } = collectSessionManifests(root, config, state, errors);
  const staleSessions = [];
  const invalidSessions = sessions.filter((session) => session._invalid).map((session) => session._path);
  const manifestWorktreePaths = new Set();
  for (const session of sessions) {
    if (session._invalid) continue;
    if (session.worktreePath) {
      const worktreePath = resolve(session.worktreePath);
      manifestWorktreePaths.add(worktreePath);
      if (!existsSync(worktreePath)) {
        staleSessions.push({
          sessionId: session.sessionId || session._path,
          taskId: session.taskId || null,
          worktreePath,
          manifestPath: session._path,
        });
      }
    }
  }

  const configuredWorktreesDir = worktreesDirRoot(root, config, worktrees);
  const orphanWorktrees = worktrees
    .map((item) => ({ path: resolve(item.path), branch: item.branch || null }))
    .filter((item) => item.path !== resolve(worktrees[0]?.path || root))
    .filter((item) => isInside(configuredWorktreesDir, item.path))
    .filter((item) => !manifestWorktreePaths.has(item.path));

  const cleanupCommands = [];
  for (const session of staleSessions) {
    cleanupCommands.push(`node .harness/scripts/prepare-session-worktree.mjs --cleanup --session=${session.sessionId}`);
  }
  for (const worktree of orphanWorktrees) {
    cleanupCommands.push(`node .harness/scripts/prepare-session-worktree.mjs --cleanup --worktree=${worktree.path}`);
  }

  return {
    manifests: sessions.length,
    worktrees: worktrees.map((item) => ({ path: resolve(item.path), branch: item.branch || null })),
    worktreesDir: configuredWorktreesDir,
    staleSessions,
    invalidSessions,
    orphanWorktrees,
    cleanupCommands,
  };
}

function needsIsolation(contract, config) {
  const cfg = config.sessionIsolation || {};
  const riskTiers = cfg.requireForRiskTiers || ["high-risk"];
  const explicit = contract?.sessionIsolation?.required === true || contract?.isolation?.required === true;
  const risk = riskTiers.includes(contract?.riskTier);
  const mutation = cfg.requireForMutationTargets !== false && grantsMutation(contract);
  const reasons = [];
  if (explicit) reasons.push("contract-required");
  if (risk) reasons.push(`risk:${contract.riskTier}`);
  if (mutation) reasons.push("mutating-permissions");
  return { required: reasons.length > 0, reasons };
}

function evaluate({ root, config, activeTask }) {
  const errors = [];
  const warnings = [];
  const cfg = config.sessionIsolation || {};
  if (cfg.enabled === false) {
    const envName = cfg.activeTaskEnv || "AHK_ACTIVE_TASK";
    const taskId = activeTask || process.env[envName] || process.env.AHK_ACTIVE_TASK || null;
    return {
      status: "passed",
      enabled: false,
      activeTask: taskId,
      activeTaskSource: taskId ? "disabled-policy" : null,
      requiresIsolation: false,
      errors,
      warnings,
    };
  }

  const active = readActiveTask(root, config, activeTask, errors);
  const taskId = active.taskId;
  const state = gitState(root);
  const health = sessionHealth(root, config, state, errors);
  const payload = {
    status: "passed",
    enabled: true,
    activeTask: taskId,
    activeTaskSource: active.source,
    branch: state.branch,
    linkedWorktree: state.linkedWorktree,
    protectedBranch: false,
    branchPrefixOk: true,
    requiresIsolation: false,
    isolationReasons: [],
    sessionManifests: health.manifests,
    worktreesDir: health.worktreesDir,
    staleSessions: health.staleSessions,
    invalidSessions: health.invalidSessions,
    orphanWorktrees: health.orphanWorktrees,
    cleanupCommands: health.cleanupCommands,
    errors,
    warnings,
  };

  if (health.invalidSessions.length > 0) {
    errors.push(`${health.invalidSessions.length} invalid session manifest(s)`);
  }
  if (health.staleSessions.length > 0) {
    warnings.push(`${health.staleSessions.length} stale session manifest(s); run cleanup`);
  }
  if (health.orphanWorktrees.length > 0) {
    warnings.push(`${health.orphanWorktrees.length} isolated worktree(s) lack a session manifest; run cleanup or prepare-session-worktree`);
  }

  if (!taskId) {
    warnings.push("no active task; session isolation gate is idle");
    payload.status = errors.length === 0 ? "passed" : "failed";
    return payload;
  }

  const contract = readContract(root, config, taskId, errors);
  if (!contract) {
    payload.status = "failed";
    return payload;
  }

  const isolation = needsIsolation(contract, config);
  payload.requiresIsolation = isolation.required;
  payload.isolationReasons = isolation.reasons;
  if (!isolation.required) return payload;

  if (!state.isGitRepo) {
    errors.push(`active task ${taskId} requires isolation but the project is not a git repository`);
    payload.status = "failed";
    return payload;
  }

  const protectedBranches = cfg.protectedBranches || DEFAULT_PROTECTED_BRANCHES;
  payload.protectedBranch = protectedBranches.some((pattern) => wildcardMatch(state.branch, pattern));
  if (payload.protectedBranch) {
    errors.push(`active task ${taskId} requires isolation but current branch "${state.branch}" is protected`);
  }

  const branchPrefixes = cfg.branchPrefixes || DEFAULT_BRANCH_PREFIXES;
  payload.branchPrefixOk = branchPrefixes.length === 0 || branchPrefixes.some((prefix) => String(state.branch || "").startsWith(prefix));
  if (!payload.branchPrefixOk) {
    errors.push(`active task ${taskId} branch "${state.branch}" must start with one of: ${branchPrefixes.join(", ")}`);
  }

  if (cfg.requireLinkedWorktree !== false && !state.linkedWorktree) {
    errors.push(`active task ${taskId} requires a linked git worktree`);
  }

  const currentTaskSessions = health.staleSessions.filter((session) => session.taskId === taskId);
  if (currentTaskSessions.length > 0) {
    warnings.push(`active task ${taskId} has ${currentTaskSessions.length} stale session manifest(s)`);
  }

  payload.status = errors.length === 0 ? "passed" : "failed";
  return payload;
}

function renderText(payload) {
  console.log("=== session isolation ===");
  console.log(`active task: ${payload.activeTask || "(none)"}`);
  console.log(`requires isolation: ${payload.requiresIsolation ? "yes" : "no"}`);
  if (payload.isolationReasons?.length) console.log(`reasons: ${payload.isolationReasons.join(", ")}`);
  if (payload.branch !== undefined) console.log(`branch: ${payload.branch || "(unknown)"}`);
  if (payload.linkedWorktree !== undefined) console.log(`linked worktree: ${payload.linkedWorktree ? "yes" : "no"}`);
  if (payload.sessionManifests !== undefined) console.log(`session manifests: ${payload.sessionManifests}`);
  if (payload.staleSessions?.length) console.log(`stale sessions: ${payload.staleSessions.length}`);
  if (payload.orphanWorktrees?.length) console.log(`orphan worktrees: ${payload.orphanWorktrees.length}`);
  for (const warning of payload.warnings || []) console.log(`warning: ${warning}`);
  for (const error of payload.errors || []) console.log(`error: ${error}`);
  for (const command of payload.cleanupCommands || []) console.log(`cleanup: ${command}`);
  console.log(`session-isolation: ${payload.status.toUpperCase()}`);
}

const opts = parseArgs(process.argv.slice(2));
const root = resolve(opts.cwd);
const config = readConfig(root);
const payload = evaluate({ root, config: config.__error ? {} : config, activeTask: opts.activeTask });

if (config.__error) {
  payload.status = "failed";
  payload.errors.push(config.__error);
}

if (opts.json) console.log(JSON.stringify(payload, null, 2));
else renderText(payload);

if (opts.strict && payload.status !== "passed") process.exit(2);

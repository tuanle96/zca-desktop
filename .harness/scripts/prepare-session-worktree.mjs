#!/usr/bin/env node
// prepare-session-worktree.mjs - create an isolated git worktree for an active
// task contract and leave a machine-readable session manifest behind.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_BRANCH_PREFIXES = ["agent/", "codex/"];
const DEFAULT_PROTECTED_BRANCHES = ["main", "master", "develop", "release/*"];
const DEFAULT_SESSION_MANIFEST_DIR = ".harness/sessions";
const DEFAULT_ACTIVE_TASK_PATH = ".harness/active-task.json";
const DEFAULT_ACTIVE_TASK_ENV_PATH = ".harness/active-task.env";

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    taskId: null,
    branch: null,
    base: "HEAD",
    worktreePath: null,
    cleanup: false,
    sessionId: null,
    activate: true,
    dryRun: false,
    json: false,
  };
  for (const arg of argv) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--cleanup") opts.cleanup = true;
    else if (arg === "--no-activate") opts.activate = false;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--task=")) opts.taskId = arg.slice("--task=".length);
    else if (arg.startsWith("--active-task=")) opts.taskId = arg.slice("--active-task=".length);
    else if (arg.startsWith("--session=")) opts.sessionId = arg.slice("--session=".length);
    else if (arg.startsWith("--branch=")) opts.branch = arg.slice("--branch=".length);
    else if (arg.startsWith("--base=")) opts.base = arg.slice("--base=".length);
    else if (arg.startsWith("--worktree=")) opts.worktreePath = arg.slice("--worktree=".length);
  }
  return opts;
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${error.message})`);
  }
}

function readConfig(root) {
  return readJson(resolve(root, ".harness/config.json")) || readJson(resolve(root, "harness.config.json")) || {};
}

function git(root, args, { allowFail = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    status: result.status,
  };
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
  return parseGitWorktrees(git(root, ["worktree", "list", "--porcelain"], { allowFail: true }).stdout);
}

function stableTaskId(id) {
  return /^[a-z0-9][a-z0-9._-]*$/.test(String(id || ""));
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

function assertInside(root, target, label) {
  if (!isInside(root, target)) {
    throw new Error(`${label} must stay inside ${root}`);
  }
}

function resolveRoot(root) {
  const top = git(root, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (!top.ok) throw new Error("prepare-session-worktree requires a git repository");
  return resolve(top.stdout);
}

function readContract(root, config, taskId) {
  if (!stableTaskId(taskId)) throw new Error("task id must be stable lowercase");
  const contractsDir = resolve(root, config.taskContracts?.contractsDir || ".harness/task-contracts");
  assertInside(root, contractsDir, "taskContracts.contractsDir");
  const contractPath = resolve(contractsDir, `${taskId}.json`);
  assertInside(contractsDir, contractPath, "task contract path");
  const contract = readJson(contractPath);
  if (!contract) throw new Error(`task contract not found: ${relative(root, contractPath)}`);
  if (contract.id !== taskId) {
    throw new Error(`task contract id mismatch: expected ${taskId}, got ${contract.id || "(missing)"}`);
  }
  return { contract, contractPath };
}

function branchAllowed(branch, config) {
  const branchPrefixes = config.sessionIsolation?.branchPrefixes || DEFAULT_BRANCH_PREFIXES;
  const protectedBranches = config.sessionIsolation?.protectedBranches || DEFAULT_PROTECTED_BRANCHES;
  if (protectedBranches.some((pattern) => wildcardMatch(branch, pattern))) {
    return { ok: false, reason: `branch "${branch}" is protected` };
  }
  if (branchPrefixes.length > 0 && !branchPrefixes.some((prefix) => branch.startsWith(prefix))) {
    return { ok: false, reason: `branch "${branch}" must start with one of: ${branchPrefixes.join(", ")}` };
  }
  return { ok: true };
}

function defaultBranch(taskId, config) {
  const branchPrefixes = config.sessionIsolation?.branchPrefixes || DEFAULT_BRANCH_PREFIXES;
  return `${branchPrefixes[0] || "agent/"}${taskId}`;
}

function defaultWorktreePath(root, taskId, config) {
  const configured = config.sessionIsolation?.worktreesDir || "../.agent-worktrees";
  const base = resolve(root, configured);
  return resolve(base, `${basename(root)}-${taskId}`);
}

function writeManifest(worktreePath, config, manifest) {
  const manifestDir = resolve(worktreePath, config.sessionIsolation?.manifestDir || DEFAULT_SESSION_MANIFEST_DIR);
  assertInside(worktreePath, manifestDir, "session manifest directory");
  mkdirSync(manifestDir, { recursive: true });
  const manifestPath = resolve(manifestDir, `${manifest.sessionId}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifestPath;
}

function writeActivation(worktreePath, config, activation) {
  const activePath = resolve(worktreePath, config.sessionIsolation?.activeTaskPath || DEFAULT_ACTIVE_TASK_PATH);
  const envPath = resolve(worktreePath, config.sessionIsolation?.activeTaskEnvPath || DEFAULT_ACTIVE_TASK_ENV_PATH);
  assertInside(worktreePath, activePath, "active task path");
  assertInside(worktreePath, envPath, "active task env path");
  mkdirSync(dirname(activePath), { recursive: true });
  mkdirSync(dirname(envPath), { recursive: true });
  writeFileSync(activePath, JSON.stringify(activation, null, 2) + "\n");
  writeFileSync(envPath, `export ${activation.activeTaskEnv}=${activation.taskId}\n`);
  return { activeTaskPath: activePath, activeTaskEnvPath: envPath };
}

function readManifests(root, config) {
  const manifestDirName = config.sessionIsolation?.manifestDir || DEFAULT_SESSION_MANIFEST_DIR;
  const worktreePaths = new Set([root]);
  for (const worktree of gitWorktrees(root)) {
    if (worktree.path) worktreePaths.add(resolve(worktree.path));
  }
  const sessions = [];
  for (const worktreePath of worktreePaths) {
    const manifestDir = resolve(worktreePath, manifestDirName);
    if (!isInside(worktreePath, manifestDir) || !existsSync(manifestDir)) continue;
    let entries = [];
    try {
      entries = readdirSync(manifestDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const manifestPath = resolve(manifestDir, entry.name);
      let manifest = null;
      try {
        manifest = readJson(manifestPath, null);
      } catch {
        manifest = null;
      }
      if (!manifest) continue;
      sessions.push({ ...manifest, manifestPath, manifestWorktreePath: worktreePath });
    }
  }
  return sessions;
}

function recordOperationalState(root, config, manifest, manifestPath, status = "active") {
  if (config.operationalState?.enabled === false) {
    return { recorded: false, reason: "operational state disabled" };
  }
  const scriptPath = resolve(root, config.operationalState?.script || ".harness/scripts/harness-state.mjs");
  if (!existsSync(scriptPath)) return { recorded: false, reason: "harness-state script not found" };
  const args = [
    scriptPath,
    `--cwd=${root}`,
    "session-worktree",
    "record",
    `--session-id=${manifest.sessionId}`,
    `--task=${manifest.taskId}`,
    `--branch=${manifest.branch}`,
    `--base=${manifest.base}`,
    `--source-root=${manifest.sourceRoot}`,
    `--worktree=${manifest.worktreePath}`,
    `--manifest=${manifestPath || ""}`,
    `--active-task-env=${manifest.activeTaskEnv}`,
    `--status=${status}`,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return { recorded: false, reason: (result.stderr || result.stdout || "").trim() || `harness-state exited ${result.status}` };
  }
  return { recorded: true, reason: null };
}

function renderText(payload) {
  console.log("=== prepare session worktree ===");
  console.log(`task: ${payload.taskId || "(none)"}`);
  console.log(`branch: ${payload.branch || "(none)"}`);
  console.log(`worktree: ${payload.worktreePath || "(none)"}`);
  console.log(`manifest: ${payload.manifestPath || "(dry-run)"}`);
  if (payload.activeTaskPath) console.log(`active task: ${payload.activeTaskPath}`);
  if (!payload.dryRun && payload.operationalStateRecorded !== undefined) {
    console.log(`operational state: ${payload.operationalStateRecorded ? "recorded" : "not recorded"}`);
    if (payload.operationalStateError) console.log(`operational state warning: ${payload.operationalStateError}`);
  }
  if (payload.cleanupTargets?.length) console.log(`cleanup targets: ${payload.cleanupTargets.length}`);
  if (payload.dryRun) console.log(`command: ${payload.command.join(" ")}`);
  for (const item of payload.next || []) console.log(`next: ${item}`);
}

function cleanupSessionWorktrees(root, config, opts) {
  const sessions = readManifests(root, config);
  const worktreeArg = opts.worktreePath ? resolve(root, opts.worktreePath) : null;
  const targets = [];
  for (const session of sessions) {
    if (opts.sessionId && session.sessionId !== opts.sessionId) continue;
    if (opts.taskId && session.taskId !== opts.taskId) continue;
    if (worktreeArg && resolve(session.worktreePath || "") !== worktreeArg) continue;
    if (session.worktreePath) targets.push(session);
  }

  if (worktreeArg && targets.length === 0) {
    targets.push({
      sessionId: null,
      taskId: opts.taskId || null,
      branch: null,
      base: null,
      sourceRoot: root,
      worktreePath: worktreeArg,
      activeTaskEnv: config.sessionIsolation?.activeTaskEnv || "AHK_ACTIVE_TASK",
      manifestPath: null,
    });
  }
  if (targets.length === 0) {
    throw new Error("cleanup found no matching session worktrees");
  }

  const commands = targets.map((target) => ["git", "worktree", "remove", target.worktreePath]);
  const payload = {
    status: opts.dryRun ? "planned-cleanup" : "cleaned",
    dryRun: opts.dryRun,
    taskId: opts.taskId || null,
    branch: null,
    worktreePath: worktreeArg,
    manifestPath: null,
    cleanupTargets: targets.map((target) => ({
      sessionId: target.sessionId || null,
      taskId: target.taskId || null,
      worktreePath: target.worktreePath,
      manifestPath: target.manifestPath || null,
    })),
    command: commands[0],
    commands,
    next: [],
  };

  if (!opts.dryRun) {
    for (const target of targets) {
      if (existsSync(target.worktreePath)) {
        git(root, ["worktree", "remove", target.worktreePath]);
      }
      if (target.sessionId) {
        const state = recordOperationalState(root, config, {
          sessionId: target.sessionId,
          taskId: target.taskId || "(unknown)",
          branch: target.branch || "(unknown)",
          base: target.base || "",
          sourceRoot: target.sourceRoot || root,
          worktreePath: target.worktreePath,
          activeTaskEnv: target.activeTaskEnv || config.sessionIsolation?.activeTaskEnv || "AHK_ACTIVE_TASK",
        }, target.manifestPath || "", "removed");
        if (!state.recorded && !payload.operationalStateError) payload.operationalStateError = state.reason;
      }
    }
  }

  return payload;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const requestedRoot = resolve(opts.cwd);
  const root = resolveRoot(requestedRoot);
  const config = readConfig(root);

  if (opts.cleanup) {
    const payload = cleanupSessionWorktrees(root, config, opts);
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else renderText(payload);
    return;
  }

  const taskId = opts.taskId || process.env[config.sessionIsolation?.activeTaskEnv || "AHK_ACTIVE_TASK"] || process.env.AHK_ACTIVE_TASK;
  if (!taskId) throw new Error("missing --task=<task-id> or AHK_ACTIVE_TASK");

  const { contractPath } = readContract(root, config, taskId);
  const branch = opts.branch || defaultBranch(taskId, config);
  const branchPolicy = branchAllowed(branch, config);
  if (!branchPolicy.ok) throw new Error(branchPolicy.reason);

  git(root, ["rev-parse", "--verify", opts.base]);
  const existingBranch = git(root, ["show-ref", "--verify", `refs/heads/${branch}`], { allowFail: true });
  if (existingBranch.ok) throw new Error(`branch already exists: ${branch}`);

  const worktreePath = opts.worktreePath ? resolve(root, opts.worktreePath) : defaultWorktreePath(root, taskId, config);
  if (
    resolve(worktreePath) === root ||
    resolve(worktreePath) === requestedRoot ||
    isInside(root, resolve(worktreePath)) ||
    isInside(requestedRoot, resolve(worktreePath))
  ) {
    throw new Error("worktree path must be outside the primary checkout");
  }
  if (existsSync(worktreePath)) throw new Error(`worktree path already exists: ${worktreePath}`);

  const sessionId = `${taskId}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const command = ["git", "worktree", "add", "-b", branch, worktreePath, opts.base];
  const payload = {
    status: opts.dryRun ? "planned" : "prepared",
    dryRun: opts.dryRun,
    sessionId,
    taskId,
    branch,
    base: opts.base,
    sourceRoot: root,
    worktreePath,
    contractPath: relative(root, contractPath),
    manifestPath: null,
    activeTaskPath: null,
    activeTaskEnvPath: null,
    operationalStateRecorded: false,
    operationalStateError: null,
    command,
    next: [
      `cd ${worktreePath}`,
      `export ${config.sessionIsolation?.activeTaskEnv || "AHK_ACTIVE_TASK"}=${taskId}`,
      `source ${config.sessionIsolation?.activeTaskEnvPath || DEFAULT_ACTIVE_TASK_ENV_PATH}`,
      "node .harness/scripts/check-session-isolation.mjs --strict",
    ],
  };

  if (!opts.dryRun) {
    mkdirSync(dirname(worktreePath), { recursive: true });
    git(root, ["worktree", "add", "-b", branch, worktreePath, opts.base]);
    const manifest = {
      schemaVersion: 1,
      sessionId,
      taskId,
      branch,
      base: opts.base,
      sourceRoot: root,
      worktreePath,
      createdAt: new Date().toISOString(),
      activeTaskEnv: config.sessionIsolation?.activeTaskEnv || "AHK_ACTIVE_TASK",
    };
    payload.manifestPath = writeManifest(worktreePath, config, manifest);
    if (opts.activate) {
      const activation = writeActivation(worktreePath, config, {
        schemaVersion: 1,
        sessionId,
        taskId,
        worktreePath,
        createdAt: manifest.createdAt,
        activeTaskEnv: manifest.activeTaskEnv,
      });
      payload.activeTaskPath = activation.activeTaskPath;
      payload.activeTaskEnvPath = activation.activeTaskEnvPath;
    }
    const operationalState = recordOperationalState(root, config, manifest, payload.manifestPath, "active");
    payload.operationalStateRecorded = operationalState.recorded;
    payload.operationalStateError = operationalState.reason;
  }

  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else renderText(payload);
}

try {
  main();
} catch (error) {
  console.error(`prepare-session-worktree: ${error.message}`);
  process.exit(1);
}

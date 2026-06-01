#!/usr/bin/env node
// session-cleanup.mjs - SessionEnd side-car for isolated worktree cleanup
// accounting. Cleanup is opt-in; the record is always written.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DEFAULT_ACTIVE_TASK_PATH = ".harness/active-task.json";
const DEFAULT_SESSION_MANIFEST_DIR = ".harness/sessions";

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq === -1) opts[body] = "1";
    else opts[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return opts;
}

function readStdinSync() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function safeJson(text, fallback = null) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readJsonFile(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return safeJson(readFileSync(path, "utf8"), fallback);
}

function readConfig(root) {
  return readJsonFile(resolve(root, ".harness/config.json")) ||
    readJsonFile(resolve(root, "harness.config.json")) ||
    {};
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function readSessionManifest(root, config, sessionId) {
  if (!sessionId) return null;
  const manifestDir = resolve(root, config.sessionIsolation?.manifestDir || DEFAULT_SESSION_MANIFEST_DIR);
  const manifest = readJsonFile(resolve(manifestDir, `${sessionId}.json`));
  return manifest && manifest.sessionId === sessionId ? manifest : null;
}

function cleanupRequested(config, active) {
  return truthy(process.env.AHK_SESSION_CLEANUP) ||
    config.sessionIsolation?.cleanupOnSessionEnd === true ||
    active?.cleanupOnSessionEnd === true;
}

function runCleanup({ sourceRoot, active, manifest }) {
  const sessionId = active?.sessionId || manifest?.sessionId;
  if (!sessionId) return { status: "failed", succeeded: false, error: "active task record has no sessionId" };

  const sourceScript = resolve(sourceRoot, ".harness/scripts/prepare-session-worktree.mjs");
  const localScript = resolve(ROOT, ".harness/scripts/prepare-session-worktree.mjs");
  const script = existsSync(sourceScript) ? sourceScript : localScript;
  if (!existsSync(script)) {
    return { status: "failed", succeeded: false, error: "prepare-session-worktree.mjs not found" };
  }

  const result = spawnSync(process.execPath, [
    script,
    `--cwd=${sourceRoot}`,
    "--cleanup",
    `--session=${sessionId}`,
    "--json",
  ], {
    cwd: sourceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  });

  if (result.status === 0) {
    return { status: "succeeded", succeeded: true };
  }
  return {
    status: "failed",
    succeeded: false,
    error: (result.stderr || result.stdout || "").trim().slice(0, 500) || `cleanup exited ${result.status}`,
  };
}

function appendRecord(root, record) {
  const out = resolve(root, ".harness/session-cleanup.jsonl");
  mkdirSync(dirname(out), { recursive: true });
  appendFileSync(out, JSON.stringify(record) + "\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const input = safeJson(readStdinSync(), {});
  const config = readConfig(ROOT);
  const activePath = resolve(ROOT, config.sessionIsolation?.activeTaskPath || DEFAULT_ACTIVE_TASK_PATH);
  const active = readJsonFile(activePath);
  const manifest = readSessionManifest(ROOT, config, active?.sessionId);
  const sourceRoot = resolve(manifest?.sourceRoot || active?.sourceRoot || ROOT);
  const outRoot = existsSync(sourceRoot) ? sourceRoot : ROOT;
  const reason = opts.reason || input.end_reason || input.reason || "unknown";
  const sessionId = opts["session-id"] || opts.sessionId || input.session_id || "";

  const record = {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    event: "session_cleanup",
    source: "SessionEnd",
    reason,
    session_id: sessionId,
    taskId: active?.taskId || manifest?.taskId || null,
    sessionWorktreeId: active?.sessionId || manifest?.sessionId || null,
    worktreePath: active?.worktreePath || manifest?.worktreePath || null,
    cleanupRequested: false,
    cleanupStatus: active ? "skipped" : "not-needed",
    cleanupSucceeded: null,
  };

  if (active && cleanupRequested(config, active)) {
    const cleanup = runCleanup({ sourceRoot: outRoot, active, manifest });
    record.cleanupRequested = true;
    record.cleanupStatus = cleanup.status;
    record.cleanupSucceeded = cleanup.succeeded;
    if (cleanup.error) record.error = cleanup.error;
  }

  appendRecord(outRoot, record);
  process.stdout.write(record.cleanupStatus);
}

try {
  main();
} catch (error) {
  try {
    appendRecord(ROOT, {
      schemaVersion: 1,
      ts: new Date().toISOString(),
      event: "session_cleanup",
      source: "SessionEnd",
      cleanupRequested: false,
      cleanupStatus: "record-failed",
      cleanupSucceeded: false,
      error: error.message,
    });
  } catch {
    // SessionEnd must never block on cleanup accounting.
  }
  process.stdout.write("record-failed");
}

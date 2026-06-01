#!/usr/bin/env node
// session-rollup.mjs — deterministic SessionEnd side-car. Writes a single
// JSONL record summarising the session into .harness/telemetry.jsonl. Pure
// Node (no jq dependency).
//
// Record shape:
//   { ts, event: "session_rollup", reason, branch, sha, uncommitted,
//     skills_invoked: [...], session_id }
//
// Called from session-end.sh after the human-readable PROGRESS.md line is
// written, so a single session contributes one PROGRESS.md line + one
// telemetry rollup record.

import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function readStdinSync() {
  // SessionEnd hooks pass JSON on stdin. fd 0 is the inherited stdin.
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function safeJSON(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

function git(args, def = "") {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) return def;
  return (r.stdout || "").trim();
}

function recentSkillInvocations() {
  // Tail of telemetry.jsonl: count skill_invoked records since the last
  // session_rollup. If no prior rollup, count everything in the file (capped
  // to 50 for sanity).
  const path = resolve(ROOT, ".harness/telemetry.jsonl");
  if (!existsSync(path)) return [];
  const body = readFileSync(path, "utf8");
  const lines = body.split("\n").filter(Boolean);
  let startIdx = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(lines[i]);
      if (rec.event === "session_rollup") {
        startIdx = i + 1;
        break;
      }
    } catch { /* skip malformed */ }
  }
  const window = lines.slice(startIdx);
  const skills = [];
  for (const line of window) {
    try {
      const rec = JSON.parse(line);
      if (rec.event === "skill_invoked" && rec.skill) skills.push(rec.skill);
    } catch { /* skip */ }
  }
  return skills.slice(-50);
}

function main() {
  const input = safeJSON(readStdinSync());
  const reason = input.end_reason || "unknown";
  const sessionId = input.session_id || "";

  const branch = git(["branch", "--show-current"], "(detached)");
  const sha = git(["rev-parse", "--short", "HEAD"], "(no-git)");
  const uncommittedRaw = git(["status", "--short"], "");
  const uncommitted = uncommittedRaw ? uncommittedRaw.split("\n").filter(Boolean).length : 0;
  const skills = recentSkillInvocations();

  const record = {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    event: "session_rollup",
    source: "SessionEnd",
    reason,
    session_id: sessionId,
    branch,
    sha,
    uncommitted,
    skills_invoked: skills,
  };

  const outPath = resolve(ROOT, ".harness/telemetry.jsonl");
  mkdirSync(resolve(ROOT, ".harness"), { recursive: true });
  appendFileSync(outPath, JSON.stringify(record) + "\n");
}

main();

#!/usr/bin/env node
// feature-step-done.mjs — eval rubric for the "feature step done" task.
// Reads the agent's transcript + the final .harness/feature_list.json + the diff;
// returns a JSON verdict on the outcome / process / style / efficiency
// dimensions.
//
// Invocation (from eval-runner.mjs):
//   node .harness/eval/rubrics/feature-step-done.mjs --transcript <path> --task <task.json>
//
// Exit 0 = rubric ran. The JSON tail communicates pass/fail.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function parseArgs(argv) {
  const out = { transcript: null, task: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--transcript") out.transcript = argv[++i];
    else if (argv[i] === "--task") out.task = argv[++i];
  }
  return out;
}

function safeJSON(s, def = null) {
  try { return JSON.parse(s); } catch { return def; }
}

function loadFile(path, fallback = null) {
  try { return readFileSync(path, "utf8"); } catch { return fallback; }
}

function loadFeatureList() {
  const path = resolve(ROOT, ".harness/feature_list.json");
  const raw = loadFile(path);
  return raw ? safeJSON(raw) : null;
}

function gitDiffFiles() {
  // Files changed in the agent's run, relative to HEAD~1 (one commit before
  // the eval started). Eval-runner pins HEAD with a tag before each task.
  const r = spawnSync("git", ["diff", "--name-only", "HEAD~1...HEAD"], {
    cwd: ROOT, encoding: "utf8",
  });
  if (r.status !== 0) return [];
  return (r.stdout || "").split("\n").filter(Boolean);
}

function transcriptToolCalls(transcriptPath) {
  // Stream-json transcripts from claude-cli are JSONL with one record per
  // tool invocation / message. We collect the tool names + a small sample
  // of inputs so the rubric can spot /add-feature etc.
  const body = loadFile(transcriptPath, "");
  const calls = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const rec = safeJSON(line);
    if (!rec) continue;
    if (rec.type === "tool_use" || rec.tool || rec.skill) {
      calls.push({
        tool: rec.tool || rec.skill || rec.type,
        input: rec.input || rec.tool_input || rec.arguments || null,
      });
    }
  }
  return calls;
}

function grade({ task, fl, diffFiles, toolCalls }) {
  const dims = { outcome: "fail", process: "fail", style: "warn", efficiency: "warn" };
  const reasons = [];

  // --- outcome ---
  // features[0].steps[0].passes === true AND tests[] is non-empty AND
  // at least one tests[] entry appears in diffFiles.
  const step = fl?.features?.[0]?.steps?.[0];
  if (!step) {
    reasons.push("outcome: no features[0].steps[0] found in .harness/feature_list.json after run");
  } else if (step.passes !== true) {
    reasons.push(`outcome: features[0].steps[0].passes is ${JSON.stringify(step.passes)}, want true`);
  } else if (!Array.isArray(step.tests) || step.tests.length === 0) {
    reasons.push("outcome: features[0].steps[0].tests is empty — done flipped without test reference");
  } else {
    const testInDiff = step.tests.some((t) => diffFiles.includes(t));
    if (!testInDiff) {
      reasons.push(`outcome: .harness/feature_list.json#tests references [${step.tests.join(", ")}] but none appear in the diff`);
    } else {
      dims.outcome = "pass";
    }
  }

  // --- process ---
  // The agent should invoke /add-feature (or /refactor-feature) AND make
  // a write to the handler + test file in the same run.
  const ranSkill = toolCalls.some(
    (c) => /(add-feature|refactor-feature)/i.test(c.tool || "") ||
           /(add-feature|refactor-feature)/i.test(c.input?.skill || ""),
  );
  const handlerWrites = diffFiles.filter((f) => /\.(ts|tsx|js|mjs|py|rs|go)$/.test(f) && !/test/i.test(f));
  const testWrites = diffFiles.filter((f) => /test/i.test(f) || /\.spec\./.test(f));
  if (!ranSkill) {
    reasons.push("process: agent did not invoke /add-feature or /refactor-feature");
  } else if (handlerWrites.length === 0) {
    reasons.push("process: no handler file appeared in diff");
  } else if (testWrites.length === 0) {
    reasons.push("process: no test file appeared in diff");
  } else {
    dims.process = "pass";
  }

  // --- style ---
  // PROGRESS.md should be appended (kit convention). Soft check.
  const touchedProgress = diffFiles.includes(".harness/PROGRESS.md");
  if (touchedProgress) {
    dims.style = "pass";
  } else {
    reasons.push("style: .harness/PROGRESS.md not appended (soft fail)");
  }

  // --- efficiency ---
  // expected.tokensMax — actual token count comes from transcript meta.
  // Without that we can't grade hard; warn-pass if filesChanged within
  // task.expected.filesChanged bounds.
  const max = task?.expected?.filesChanged?.max ?? 99;
  const min = task?.expected?.filesChanged?.min ?? 1;
  if (diffFiles.length >= min && diffFiles.length <= max) {
    dims.efficiency = "pass";
  } else {
    reasons.push(`efficiency: ${diffFiles.length} files changed, want ${min}-${max}`);
  }

  const overall = (dims.outcome === "pass" && dims.process === "pass") ? "PASS" : "FAIL";
  return { overall, dimensions: dims, reasons, diff_files: diffFiles };
}

function main() {
  const { transcript, task: taskPath } = parseArgs(process.argv.slice(2));
  const task = taskPath ? safeJSON(loadFile(resolve(ROOT, taskPath)) ?? "", null) : null;
  const fl = loadFeatureList();
  const diffFiles = gitDiffFiles();
  const toolCalls = transcript ? transcriptToolCalls(resolve(ROOT, transcript)) : [];
  const verdict = grade({ task, fl, diffFiles, toolCalls });
  process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
}

main();

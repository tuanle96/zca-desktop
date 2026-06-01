#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEvalTaskPolicy } from "./_lib/eval-task-policy.mjs";

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), dir: ".harness/eval/tasks", json: false };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--dir=")) opts.dir = arg.slice("--dir=".length);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const ROOT = resolve(opts.cwd);
const TASK_DIR = resolve(ROOT, opts.dir);
const errors = [];
const warnings = [];
const policy = createEvalTaskPolicy({ root: ROOT });

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${policy.rel(path)}: invalid JSON (${error.message})`);
    return null;
  }
}

const listed = policy.listTaskFiles(TASK_DIR);
errors.push(...listed.errors);
const files = listed.files;
if (files.length === 0) {
  errors.push(`${policy.rel(TASK_DIR)}: no eval task JSON files found`);
}
for (const file of files) {
  errors.push(...policy.validateTask(readJson(file), file));
}

const payload = { status: errors.length === 0 ? "passed" : "failed", errors, warnings, files: files.map(policy.rel) };
if (opts.json) {
  console.log(JSON.stringify(payload, null, 2));
} else if (errors.length > 0) {
  console.error("check-eval-tasks: FAILED");
  for (const error of errors) console.error(`- ${error}`);
  for (const warning of warnings) console.error(`warning: ${warning}`);
} else {
  console.log(`check-eval-tasks: OK (${files.length} tasks)`);
  for (const warning of warnings) console.warn(`warning: ${warning}`);
}
process.exit(errors.length === 0 ? 0 : 1);

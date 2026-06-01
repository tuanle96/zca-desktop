#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const target = process.argv[2];
if (!target || target === "--help") {
  console.error("Usage: node .harness/scripts/orchestration-schema-check.mjs <run-id-or-dir>");
  process.exit(target === "--help" ? 0 : 1);
}

const orchestrate = resolve(process.cwd(), ".claude/skills/orchestrate/orchestrate.mjs");
const result = spawnSync(process.execPath, [orchestrate, `--validate-run=${target}`], {
  cwd: process.cwd(),
  stdio: "inherit",
});
process.exit(result.status ?? 1);

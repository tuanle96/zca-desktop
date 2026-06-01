#!/usr/bin/env node
import { resolve } from "node:path";
import { analyzeHookIntegrity } from "./_lib/hook-integrity.mjs";

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), json: false };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const payload = analyzeHookIntegrity(opts);

if (opts.json) {
  console.log(JSON.stringify(payload, null, 2));
} else if (payload.status === "fail") {
  console.error("check-hook-integrity: FAILED");
  for (const error of payload.errors) console.error(`- ${error}`);
  for (const warning of payload.warnings) console.error(`warning: ${warning}`);
} else {
  const enabled = payload.surfaces.filter((surface) => surface.enabled).map((surface) => surface.runtime).join(", ") || "none";
  console.log(`check-hook-integrity: OK (enabled: ${enabled})`);
  for (const warning of payload.warnings) console.warn(`warning: ${warning}`);
}

process.exit(payload.status === "fail" ? 1 : 0);

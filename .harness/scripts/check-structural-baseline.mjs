#!/usr/bin/env node
import { resolve } from "node:path";
import { analyzeStructuralBaseline } from "./_lib/structural-baseline.mjs";

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    json: false,
    baselinePath: null,
    compareRef: null,
    maxEntries: undefined,
    decreasingOnly: undefined,
    burnDownRate: undefined,
    burnDownRef: undefined,
  };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--no-compare") opts.decreasingOnly = false;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--baseline=")) opts.baselinePath = arg.slice("--baseline=".length);
    else if (arg.startsWith("--compare-ref=")) opts.compareRef = arg.slice("--compare-ref=".length);
    else if (arg.startsWith("--max-entries=")) {
      const value = Number(arg.slice("--max-entries=".length));
      if (Number.isInteger(value)) opts.maxEntries = value;
    }
    else if (arg.startsWith("--burn-down-rate=")) {
      const value = Number(arg.slice("--burn-down-rate=".length));
      if (Number.isFinite(value)) opts.burnDownRate = value;
    }
    else if (arg.startsWith("--burn-down-ref=")) opts.burnDownRef = arg.slice("--burn-down-ref=".length);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const payload = analyzeStructuralBaseline(opts);

if (opts.json) {
  console.log(JSON.stringify(payload, null, 2));
} else if (payload.status === "fail") {
  console.error("check-structural-baseline: FAILED");
  for (const error of payload.errors) console.error(`- ${error}`);
  for (const warning of payload.warnings) console.error(`warning: ${warning}`);
} else {
  const comparison = payload.comparison.exists
    ? `; ${payload.comparison.ref} ${payload.comparison.count}; delta ${payload.comparison.delta}`
    : "";
  const burn = payload.burnDown && payload.burnDown.enabled && payload.burnDown.refExists && payload.burnDown.previousCount !== null
    ? `; burn-down ${payload.burnDown.reduction}/${payload.burnDown.rate} vs ${payload.burnDown.ref}`
    : "";
  console.log(`check-structural-baseline: OK (${payload.count} entr${payload.count === 1 ? "y" : "ies"}${comparison}${burn})`);
  for (const warning of payload.warnings) console.warn(`warning: ${warning}`);
}

process.exit(payload.status === "fail" ? 1 : 0);

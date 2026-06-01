#!/usr/bin/env node
// strictness.mjs - inspect or migrate the harness strictness ladder without
// hand-editing multiple readiness keys.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  STRICTNESS_TIER_ORDER,
  STRICTNESS_TIERS,
  defaultStrictnessConfig,
  validateStrictnessTier,
} from "./_lib/strictness-ladder.mjs";

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), command: "show", tier: "", json: false };
  const positional = [];
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--tier=")) opts.tier = arg.slice("--tier=".length).trim();
    else if (!arg.startsWith("-")) positional.push(arg);
  }
  if (positional[0]) opts.command = positional[0];
  if (positional[1] && !opts.tier) opts.tier = positional[1];
  opts.cwd = resolve(opts.cwd);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const ROOT = opts.cwd;

function configPath() {
  const compact = resolve(ROOT, ".harness/config.json");
  if (existsSync(compact)) return compact;
  return resolve(ROOT, "harness.config.json");
}

function readConfig() {
  const path = configPath();
  if (!existsSync(path)) return { path, config: {} };
  try {
    return { path, config: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${error.message})`);
  }
}

function runReadinessPlan(tier) {
  const script = resolve(import.meta.dirname, "harness-readiness.mjs");
  const result = spawnSync(process.execPath, [script, `--cwd=${ROOT}`, "--list", "--json", `--tier=${tier}`], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout || "{}");
  } catch {
    payload = {
      status: "failed",
      errors: ["harness-readiness did not emit JSON"],
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  return {
    exitCode: result.status,
    payload,
  };
}

function writeConfig(path, config) {
  const relPath = relative(ROOT, path);
  if (!relPath || relPath.split(/[\\/]/)[0] === ".." || isAbsolute(relPath)) {
    throw new Error("config path must stay inside project root");
  }
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function renderText(payload) {
  if (payload.command === "tiers") {
    console.log("strictness tiers:");
    for (const tier of STRICTNESS_TIER_ORDER) {
      const spec = STRICTNESS_TIERS[tier];
      console.log(`- ${tier}: ${spec.behavior}`);
    }
    return;
  }
  console.log(`strictness: ${payload.tier}`);
  if (payload.changed) console.log(`updated: ${payload.path}`);
  if (payload.plan?.gates) {
    console.log(`compiled gates: ${payload.plan.gates.length}`);
    for (const gate of payload.plan.gates) {
      console.log(`- ${gate.id}${gate.required === false ? " (optional)" : ""}`);
    }
  }
  for (const warning of payload.warnings || []) console.log(`warning: ${warning}`);
}

function main() {
  if (opts.command === "tiers") {
    const payload = { command: "tiers", tiers: STRICTNESS_TIERS };
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else renderText(payload);
    return;
  }

  const { path, config } = readConfig();
  const currentTier = config.strictness?.tier || "standard";
  const targetTier = validateStrictnessTier(opts.tier || currentTier);
  const plan = runReadinessPlan(targetTier).payload;
  const payload = {
    command: opts.command,
    path,
    tier: targetTier,
    changed: false,
    warnings: Array.isArray(plan.warnings) ? plan.warnings : [],
    plan: {
      status: plan.status,
      strictness: plan.strictness,
      gates: Array.isArray(plan.gates) ? plan.gates.map((gate) => ({
        id: gate.id,
        required: gate.required !== false,
        command: gate.command,
      })) : [],
    },
  };

  if (opts.command === "set") {
    config.strictness = {
      ...defaultStrictnessConfig(targetTier),
      ...(config.strictness && typeof config.strictness === "object" && !Array.isArray(config.strictness) ? config.strictness : {}),
      tier: targetTier,
    };
    config.readiness = {
      ...(config.readiness && typeof config.readiness === "object" && !Array.isArray(config.readiness) ? config.readiness : {}),
      reporter: config.readiness?.reporter || ".harness/scripts/harness-readiness.mjs",
      compileFromStrictness: true,
    };
    writeConfig(path, config);
    payload.changed = true;
  } else if (opts.command !== "show" && opts.command !== "plan") {
    throw new Error(`Unknown strictness command "${opts.command}". Use show, plan, set, or tiers.`);
  }

  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else renderText(payload);
}

try {
  main();
} catch (error) {
  if (opts.json) {
    console.log(JSON.stringify({ status: "failed", error: error.message }, null, 2));
  } else {
    console.error(`strictness: ${error.message}`);
  }
  process.exit(1);
}

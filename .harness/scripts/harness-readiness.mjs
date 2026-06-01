#!/usr/bin/env node
// harness-readiness.mjs - aggregate the mechanical gates that make a harness
// install release-ready. This is intentionally command-based so projects can
// override gates in .harness/config.json without changing the runner.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  compileGatesForStrictness,
  normalizeStrictnessTier,
  validateStrictnessTier,
} from "./_lib/strictness-ladder.mjs";

const DEFAULT_TIMEOUT_MS = 120000;

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    json: false,
    list: false,
    strict: false,
    tier: "",
    skips: new Set(),
  };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--list") opts.list = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg === "--no-structural") opts.skips.add("structural");
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--tier=")) opts.tier = arg.slice("--tier=".length).trim();
    else if (arg.startsWith("--skip=")) {
      for (const item of arg.slice("--skip=".length).split(",")) {
        if (item.trim()) opts.skips.add(item.trim());
      }
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const ROOT = resolve(opts.cwd);

function rel(path) {
  return path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path;
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { __error: `${rel(path)}: invalid JSON (${error.message})` };
  }
}

function readConfig() {
  const compact = readJson(resolve(ROOT, ".harness/config.json"));
  if (compact) return compact;
  return readJson(resolve(ROOT, "harness.config.json")) || {};
}

function readPackageJson() {
  const pkg = readJson(resolve(ROOT, "package.json"));
  return pkg && !pkg.__error ? pkg : {};
}

function scriptCommand(pkg, name, extraArgs = "") {
  if (!pkg.scripts?.[name]) return null;
  return `npm run --silent ${name}${extraArgs ? ` -- ${extraArgs}` : ""}`;
}

function localNodeGate({ id, script, required = true, args = "" }) {
  const relPath = `.harness/scripts/${script}`;
  if (!existsSync(resolve(ROOT, relPath))) return null;
  return {
    id,
    command: `node ${relPath}${args ? ` ${args}` : ""}`,
    required,
    ifExists: relPath,
  };
}

function defaultInstalledGates() {
  return [
    localNodeGate({ id: "structural-baseline", script: "check-structural-baseline.mjs" }),
    localNodeGate({ id: "hook-integrity", script: "check-hook-integrity.mjs" }),
    {
      id: "structural",
      command: "npm run --silent harness:check",
      required: true,
      packageScript: "harness:check",
    },
    localNodeGate({ id: "skill-contracts", script: "check-skill-contracts.mjs" }),
    localNodeGate({ id: "skill-examples", script: "check-skill-examples.mjs" }),
    localNodeGate({ id: "trace-corpus", script: "check-trace-corpus.mjs" }),
    localNodeGate({ id: "review-coverage", script: "check-review-coverage.mjs", args: "--strict" }),
    localNodeGate({ id: "architecture-fitness", script: "check-architecture-fitness.mjs", args: "--strict" }),
    localNodeGate({ id: "policy-packs", script: "check-policy-packs.mjs" }),
    localNodeGate({ id: "stable-schemas", script: "check-stable-schemas.mjs", args: "--strict" }),
    localNodeGate({ id: "permissions-drift", script: "check-permissions-drift.mjs" }),
    localNodeGate({ id: "bypass-audit", script: "check-bypass-audit.mjs", args: opts.strict ? "--strict" : "" }),
    localNodeGate({ id: "eval-tasks", script: "check-eval-tasks.mjs" }),
    localNodeGate({ id: "adversarial-suite", script: "check-adversarial-suite.mjs" }),
    localNodeGate({ id: "failure-records", script: "check-failure-records.mjs" }),
    localNodeGate({ id: "operational-state", script: "harness-state.mjs", args: "check --strict" }),
    localNodeGate({ id: "harness-report", script: "harness-report.mjs", args: "--json --fail-on=fail --review-promotion=fail" }),
    localNodeGate({ id: "orchestration-contracts", script: "check-orchestration-contracts.mjs", args: "--strict" }),
    localNodeGate({ id: "session-isolation", script: "check-session-isolation.mjs", args: "--strict" }),
    localNodeGate({ id: "task-evidence", script: "task-evidence-check.mjs", args: "--strict" }),
    localNodeGate({ id: "evidence-attestation", script: "check-evidence-attestation.mjs", args: "--strict" }),
    localNodeGate({ id: "model-routing", script: "model-routing-report.mjs", required: false, args: "--strict" }),
    localNodeGate({ id: "runtime-parity", script: "runtime-parity-report.mjs", required: false, args: "--strict" }),
    localNodeGate({ id: "runtime-conformance", script: "runtime-conformance.mjs", required: false, args: "--strict" }),
  ].filter(Boolean);
}

function defaultKitSelfGates(pkg) {
  return [
    { id: "version-sync", command: existsSync(resolve(ROOT, "scripts/check-version-sync.mjs")) ? "node scripts/check-version-sync.mjs" : null, required: true },
    { id: "lint", command: scriptCommand(pkg, "lint"), required: true },
    { id: "structural-baseline", command: scriptCommand(pkg, "check:structural-baseline"), required: true },
    { id: "hook-integrity", command: scriptCommand(pkg, "check:hook-integrity"), required: true },
    { id: "structural", command: scriptCommand(pkg, "harness:check"), required: true },
    { id: "skill-count", command: scriptCommand(pkg, "check:skill-count"), required: true },
    { id: "skill-contracts", command: scriptCommand(pkg, "check:skill-contracts"), required: true },
    { id: "skill-examples", command: scriptCommand(pkg, "check:skill-examples"), required: true },
    { id: "trace-corpus", command: scriptCommand(pkg, "check:trace-corpus"), required: true },
    { id: "review-coverage", command: scriptCommand(pkg, "check:review-coverage", "--strict"), required: true },
    { id: "architecture-fitness", command: scriptCommand(pkg, "check:architecture-fitness", "--strict"), required: true },
    { id: "policy-packs", command: scriptCommand(pkg, "check:policy-packs"), required: true },
    { id: "stable-schemas", command: scriptCommand(pkg, "check:stable-schemas"), required: true },
    { id: "permissions-drift", command: scriptCommand(pkg, "check:permissions-drift"), required: true },
    { id: "bypass-audit", command: scriptCommand(pkg, "check:bypass-audit", opts.strict ? "--strict" : ""), required: true },
    { id: "eval-tasks", command: scriptCommand(pkg, "check:eval-tasks"), required: true },
    { id: "adversarial-suite", command: scriptCommand(pkg, "check:adversarial"), required: true },
    { id: "failure-records", command: scriptCommand(pkg, "check:failure-records"), required: true },
    { id: "operational-state", command: scriptCommand(pkg, "check:operational-state"), required: true },
    { id: "orchestration-contracts", command: scriptCommand(pkg, "check:orchestration-contracts", "--strict"), required: true },
    { id: "session-isolation", command: scriptCommand(pkg, "check:session-isolation", "--strict"), required: true },
    { id: "task-evidence", command: scriptCommand(pkg, "check:task-evidence"), required: true },
    { id: "evidence-attestation", command: scriptCommand(pkg, "check:evidence-attestation"), required: true },
    { id: "model-routing", command: scriptCommand(pkg, "report:model-routing", "--strict"), required: false },
    { id: "runtime-parity", command: scriptCommand(pkg, "report:runtime-parity", "--strict"), required: false },
    { id: "runtime-conformance", command: scriptCommand(pkg, "report:runtime-conformance", "--strict"), required: false },
  ].filter((gate) => gate.command);
}

function normalizeGate(gate) {
  return {
    id: gate.id,
    command: gate.command,
    required: gate.required !== false,
    timeoutMs: gate.timeoutMs,
    ifExists: gate.ifExists,
    packageScript: gate.packageScript,
  };
}

function configuredGatePlan(config, pkg) {
  const errors = [];
  const warnings = [];
  const raw = config.readiness?.gates;
  const baseGates = Array.isArray(raw) && raw.length > 0
    ? raw.map(normalizeGate)
    : (pkg.name === "agent-harness-kit" || config.preset === "kit-self")
      ? defaultKitSelfGates(pkg)
      : defaultInstalledGates();

  const configuredTier = opts.tier || config.strictness?.tier || "";
  const shouldCompile = Boolean(
    opts.tier ||
    config.readiness?.compileFromStrictness === true ||
    (config.strictness?.tier && (!Array.isArray(raw) || raw.length === 0)),
  );
  if (!shouldCompile) {
    return {
      gates: baseGates,
      errors,
      warnings,
      strictness: {
        tier: configuredTier ? normalizeStrictnessTier(configuredTier) : "custom",
        compiled: false,
        source: Array.isArray(raw) && raw.length > 0 ? "readiness.gates" : "default",
      },
    };
  }

  try {
    if (opts.tier) validateStrictnessTier(opts.tier);
    if (config.strictness?.tier) validateStrictnessTier(config.strictness.tier);
  } catch (error) {
    errors.push(error.message);
  }
  const compiled = compileGatesForStrictness(baseGates, configuredTier || "standard");
  if (compiled.missing.length > 0) {
    warnings.push(`strictness:${compiled.tier}: configured tier references unavailable gate(s): ${compiled.missing.join(", ")}`);
  }
  return {
    gates: compiled.gates,
    errors,
    warnings,
    strictness: {
      tier: compiled.tier,
      title: compiled.spec.title,
      behavior: compiled.spec.behavior,
      compiled: true,
      source: opts.tier ? "--tier" : "strictness.tier",
      missing: compiled.missing,
      customGateIds: compiled.customGateIds,
    },
  };
}

function validateGate(gate, pkg) {
  const errors = [];
  if (!gate || typeof gate !== "object") {
    return ["gate must be an object"];
  }
  if (!gate.id || !/^[a-z0-9][a-z0-9._-]*$/.test(String(gate.id))) {
    errors.push("gate.id must be a stable lowercase id");
  }
  if (!gate.command || typeof gate.command !== "string") {
    errors.push(`${gate.id || "(unknown)"}: command is required`);
  }
  if (gate.ifExists && !existsSync(resolve(ROOT, gate.ifExists))) {
    errors.push(`${gate.id}: missing ${gate.ifExists}`);
  }
  if (gate.packageScript && !pkg.scripts?.[gate.packageScript]) {
    errors.push(`${gate.id}: package script "${gate.packageScript}" is missing`);
  }
  if (gate.timeoutMs !== undefined && (!Number.isInteger(gate.timeoutMs) || gate.timeoutMs < 1)) {
    errors.push(`${gate.id}: timeoutMs must be a positive integer`);
  }
  return errors;
}

function runGate(gate) {
  const startedAt = Date.now();
  const result = spawnSync(gate.command, {
    cwd: ROOT,
    shell: true,
    encoding: "utf8",
    timeout: gate.timeoutMs || DEFAULT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  const lines = summarizeGateOutput(output);
  return {
    id: gate.id,
    command: gate.command,
    required: gate.required !== false,
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    output: lines,
  };
}

function summarizeGateOutput(output) {
  if (!output) return [];
  const parsed = parseJsonObject(output);
  if (!parsed) return output.split("\n").filter((line) => line.trim()).slice(0, 8);

  const lines = [];
  if (parsed.status) lines.push(`json status: ${String(parsed.status).toUpperCase()}`);
  for (const [name, section] of Object.entries(parsed.sections || {})) {
    if (!section || typeof section !== "object") continue;
    if (section.status !== "fail" && section.status !== "warn") continue;
    const reason = Array.isArray(section.reasons) && section.reasons.length > 0 ? ` - ${section.reasons[0]}` : "";
    lines.push(`${name}: ${section.status}${reason}`);
    const repairs = repairCommandsFrom(section);
    for (const command of repairs.slice(0, 3)) lines.push(`repair: ${command}`);
    for (const line of nextStepLinesFrom(section.nextSteps).slice(0, 3)) lines.push(line);
    if (lines.length >= 8) break;
  }
  const topRepairs = Array.isArray(parsed.repairCommands) ? parsed.repairCommands : [];
  for (const command of topRepairs.slice(0, 3)) {
    if (lines.length >= 8) break;
    lines.push(`repair: ${command}`);
  }
  for (const line of nextStepLinesFrom(parsed.nextSteps)) {
    if (lines.length >= 8) break;
    lines.push(line);
  }
  return lines.length > 0 ? lines.slice(0, 8) : output.split("\n").filter((line) => line.trim()).slice(0, 8);
}

function parseJsonObject(output) {
  try {
    const value = JSON.parse(output);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function repairCommandsFrom(section) {
  const direct = Array.isArray(section.repairCommands) ? section.repairCommands : [];
  const promotion = section.promotion && typeof section.promotion === "object" ? section.promotion : {};
  const promotionCommands = Array.isArray(promotion.repairCommands) ? promotion.repairCommands : [];
  return [...direct, ...promotionCommands].filter((item) => typeof item === "string" && item.trim());
}

function nextStepLinesFrom(nextSteps) {
  if (!nextSteps || typeof nextSteps !== "object" || Array.isArray(nextSteps)) return [];
  const lines = [];
  const instructions = Array.isArray(nextSteps.instructions) ? nextSteps.instructions : [];
  for (const instruction of instructions) {
    if (typeof instruction === "string" && instruction.trim()) lines.push(`next: ${instruction.trim()}`);
  }
  const commands = Array.isArray(nextSteps.commands) ? nextSteps.commands : [];
  for (const command of commands) {
    if (typeof command === "string" && command.trim()) lines.push(`next: ${command.trim()}`);
  }
  const templates = Array.isArray(nextSteps.promotionTemplates) ? nextSteps.promotionTemplates : [];
  for (const template of templates) {
    const command = template && typeof template === "object" ? template.command : null;
    if (typeof command === "string" && command.trim()) lines.push(`next: ${command.trim()}`);
  }
  return lines;
}

function renderText(payload) {
  if (payload.mode === "list") {
    console.log(`harness-readiness: ${payload.gates.length} gates configured`);
    if (payload.strictness) {
      console.log(`strictness: ${payload.strictness.tier}${payload.strictness.compiled ? " (compiled)" : ""}`);
    }
    for (const gate of payload.gates) {
      console.log(`- ${gate.id}${gate.required === false ? " (optional)" : ""}: ${gate.command}`);
    }
    return;
  }

  console.log("=== harness readiness ===");
  if (payload.strictness) {
    console.log(`strictness: ${payload.strictness.tier}${payload.strictness.compiled ? " (compiled)" : ""}`);
  }
  for (const gate of payload.results) {
    const mark = gate.status === "passed" ? "✓" : gate.status === "skipped" ? "•" : "✗";
    const required = gate.required ? "required" : "optional";
    console.log(`${mark} ${gate.id} (${required}) — ${gate.command}`);
    if (gate.status === "failed") {
      for (const line of gate.output) console.log(`  ${line}`);
    }
  }
  for (const error of payload.errors) console.log(`error: ${error}`);
  for (const warning of payload.warnings) console.log(`warning: ${warning}`);
  console.log(`readiness: ${payload.status.toUpperCase()}`);
}

const config = readConfig();
const pkg = readPackageJson();
const errors = [];
const warnings = [];

if (config.__error) errors.push(config.__error);
const gatePlan = configuredGatePlan(config.__error ? {} : config, pkg);
errors.push(...gatePlan.errors);
warnings.push(...gatePlan.warnings);
const gates = gatePlan.gates
  .filter((gate) => !opts.skips.has(gate.id));

for (const gate of gates) {
  const gateErrors = validateGate(gate, pkg);
  if (gateErrors.length > 0) {
    if (gate.required === false && !opts.strict) warnings.push(...gateErrors);
    else errors.push(...gateErrors);
  }
}

if (opts.list) {
  const payload = {
    mode: "list",
    status: errors.length === 0 ? "passed" : "failed",
    strictness: gatePlan.strictness,
    errors,
    warnings,
    gates,
  };
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else renderText(payload);
  process.exit(errors.length === 0 ? 0 : 1);
}

const runnableGates = gates.filter((gate) => validateGate(gate, pkg).length === 0);
const results = runnableGates.map(runGate);
for (const result of results) {
  if (result.status === "failed" && (result.required || opts.strict)) {
    errors.push(`${result.id} failed`);
  } else if (result.status === "failed") {
    warnings.push(`${result.id} failed (optional)`);
  }
}

const payload = {
  status: errors.length === 0 ? "passed" : "failed",
  strict: opts.strict,
  strictness: gatePlan.strictness,
  errors,
  warnings,
  results,
};

if (opts.json) console.log(JSON.stringify(payload, null, 2));
else renderText(payload);

process.exit(errors.length === 0 ? 0 : 1);

#!/usr/bin/env node
// model-routing-report.mjs - inspect model usage by harness lane.
//
// The model-profile skill should not change defaults from taste alone. This
// report turns telemetry + task contracts into evidence: which lane ran, which
// model it used, expected model, cost/tokens, and mismatches.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { annotateProviderCalls, calculateStats } from "./_lib/cost-attribution.mjs";

const UNKNOWN = "unattributed";
const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function parseArgs(argv) {
  const opts = { cwd: ROOT, json: false, strict: false, days: null };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--days=")) opts.days = Number(arg.slice("--days=".length));
  }
  return opts;
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // skip malformed telemetry
    }
  }
  return rows;
}

function listJson(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJson(join(dir, entry.name)))
    .filter(Boolean);
}

function readConfig(root) {
  return readJson(resolve(root, ".harness/config.json")) || readJson(resolve(root, "harness.config.json")) || {};
}

function chooseTraceCorpusDir(root, config) {
  const configured = config.traceCorpus?.corpusDir;
  if (typeof configured === "string" && configured.trim()) {
    const configuredPath = resolve(root, configured);
    if (existsSync(configuredPath)) return configuredPath;
  }
  for (const candidate of ["src/templates/.harness/trace-corpus", ".harness/trace-corpus"]) {
    const path = resolve(root, candidate);
    if (existsSync(path)) return path;
  }
  return resolve(root, typeof configured === "string" && configured.trim() ? configured : ".harness/trace-corpus");
}

function traceCorpusEntries(root, config) {
  const corpusDir = chooseTraceCorpusDir(root, config);
  if (!existsSync(corpusDir)) {
    return { corpusDir, entries: [], errors: [], warnings: [`trace corpus not found: ${corpusDir}`] };
  }
  const entries = [];
  const errors = [];
  for (const dirent of readdirSync(corpusDir, { withFileTypes: true })) {
    if (!dirent.isFile() || !dirent.name.endsWith(".json")) continue;
    const file = join(corpusDir, dirent.name);
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      entries.push(parsed);
    } catch (error) {
      errors.push(`${file}: invalid JSON (${error.message})`);
    }
  }
  return { corpusDir, entries, errors, warnings: [] };
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function summarizeTraceCorpus(root, config) {
  const { corpusDir, entries, errors, warnings } = traceCorpusEntries(root, config);
  const cases = {};
  const outcomes = {};
  const byLane = {};
  for (const entry of entries) {
    increment(cases, entry.case || "unknown");
    const status = entry.outcome?.status || "unknown";
    increment(outcomes, status);
    const lane = entry.modelRouting?.lane || "unknown";
    const current = byLane[lane] || {
      entries: 0,
      passes: 0,
      failures: 0,
      totalCost: 0,
      totalTokens: 0,
      models: {},
      cases: {},
      outcomes: {},
    };
    current.entries += 1;
    if (status === "pass") current.passes += 1;
    else current.failures += 1;
    current.totalCost += entry.modelRouting?.costUsd || 0;
    current.totalTokens += (entry.modelRouting?.inputTokens || 0) + (entry.modelRouting?.outputTokens || 0);
    increment(current.models, entry.modelRouting?.model || "unknown");
    increment(current.cases, entry.case || "unknown");
    increment(current.outcomes, status);
    byLane[lane] = current;
  }
  return {
    corpusDir,
    entries: entries.length,
    cases,
    outcomes,
    lanes: Object.keys(byLane).sort(),
    byLane,
    errors,
    warnings,
  };
}

function wildcardMatch(value, pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(String(value || ""));
}

function defaultLanes(config) {
  const models = config.models || {};
  return [
    {
      id: "review",
      description: "Read-only reviewer and critique lanes.",
      expectedModel: models.reviewers || models.main || "claude-sonnet-4-6",
      matchSkills: ["review-this-pr", "*-reviewer", "security-reviewer", "architecture-reviewer"],
    },
    {
      id: "high-risk",
      description: "High-risk task contracts.",
      expectedModel: models.main || "claude-sonnet-4-6",
      requiresTaskId: true,
      riskTiers: ["high-risk"],
    },
    {
      id: "explore",
      description: "Read-only inspection, discovery, and status lanes.",
      expectedModel: models.explore || models.main || "claude-haiku-4-5",
      matchSkills: ["inspect-*", "map-domain", "project-status", "context-health", "skill-discovery"],
    },
    {
      id: "eval",
      description: "Eval, benchmark, and regression lanes.",
      expectedModel: models.main || "claude-sonnet-4-6",
      matchSkills: ["eval-*", "regression-benchmark", "benchmark-suite", "model-profile"],
    },
    {
      id: "implementation",
      description: "Feature, bugfix, refactor, and story implementation lanes.",
      expectedModel: models.main || "claude-sonnet-4-6",
      requiresTaskId: true,
      matchSkills: ["add-feature", "debug-flow", "refactor-feature", "create-story", "feature-intake"],
    },
    {
      id: "default",
      description: "Calls with no stronger skill or risk signal.",
      expectedModel: models.main || "claude-sonnet-4-6",
      matchSkills: ["*"],
    },
  ];
}

function configuredLanes(config) {
  const lanes = config.modelRouting?.lanes;
  if (Array.isArray(lanes) && lanes.length > 0) return lanes;
  return defaultLanes(config);
}

function contractRiskMap(root, config) {
  const contractsDir = resolve(root, config.taskContracts?.contractsDir || ".harness/task-contracts");
  const map = new Map();
  for (const contract of listJson(contractsDir)) {
    if (contract.id) map.set(contract.id, contract.riskTier || "normal");
  }
  return map;
}

function laneForCall(call, lanes, riskByTask) {
  const skill = call.skill || UNKNOWN;
  const riskTier = call.risk_tier || call.riskTier || riskByTask.get(call.task_id) || "normal";
  for (const lane of lanes) {
    const skillMatch = (lane.matchSkills || []).some((pattern) => wildcardMatch(skill, pattern));
    const riskMatch = (lane.riskTiers || []).includes(riskTier);
    if (skillMatch || riskMatch) return { ...lane, riskTier };
  }
  return { id: "default", expectedModel: null, riskTier };
}

function laneRequiresTaskId(lane) {
  return lane.requiresTaskId === true || lane.id === "high-risk" || lane.id === "implementation";
}

function recentFilter(days) {
  if (!Number.isFinite(days) || days <= 0) return () => true;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return (row) => {
    const t = Date.parse(row.ts);
    return Number.isFinite(t) && t >= cutoff;
  };
}

function summarize(calls, lanes, riskByTask) {
  const byLane = new Map();
  const mismatches = [];
  const missingModel = [];
  const missingTask = [];

  for (const call of calls) {
    const lane = laneForCall(call, lanes, riskByTask);
    const id = lane.id || "default";
    const current = byLane.get(id) || {
      id,
      description: lane.description || "",
      expectedModel: lane.expectedModel || null,
      calls: [],
      modelCounts: {},
      mismatches: [],
      missingModel: [],
      missingTask: [],
    };
    current.calls.push(call);
    if (call.model) current.modelCounts[call.model] = (current.modelCounts[call.model] || 0) + 1;
    else {
      const item = { lane: id, task_id: call.task_id, skill: call.skill, provider: call.provider };
      current.missingModel.push(item);
      missingModel.push(item);
    }
    if (lane.expectedModel && call.model && call.model !== lane.expectedModel) {
      const item = {
        lane: id,
        task_id: call.task_id,
        skill: call.skill,
        model: call.model,
        expectedModel: lane.expectedModel,
        riskTier: lane.riskTier,
      };
      current.mismatches.push(item);
      mismatches.push(item);
    }
    if (laneRequiresTaskId(lane) && (!call.task_id || call.task_id === UNKNOWN)) {
      const item = {
        lane: id,
        skill: call.skill,
        model: call.model,
        expectedModel: lane.expectedModel,
        riskTier: lane.riskTier,
      };
      current.missingTask.push(item);
      missingTask.push(item);
    }
    byLane.set(id, current);
  }

  const laneRows = [...byLane.values()]
    .map((lane) => {
      const stats = calculateStats(lane.calls);
      return {
        id: lane.id,
        description: lane.description,
        expectedModel: lane.expectedModel,
        calls: lane.calls.length,
        totalCost: stats.totalCost,
        totalTokens: stats.totalTokens,
        modelCounts: lane.modelCounts,
        mismatches: lane.mismatches,
        missingModel: lane.missingModel,
        missingTask: lane.missingTask,
      };
    })
    .sort((a, b) => b.totalCost - a.totalCost || a.id.localeCompare(b.id));

  return {
    status: mismatches.length === 0 && missingModel.length === 0 && missingTask.length === 0 ? "passed" : "attention",
    totalCalls: calls.length,
    lanes: laneRows,
    mismatches,
    missingModel,
    missingTask,
  };
}

function renderText(payload) {
  console.log("=== model routing report ===");
  console.log(`provider calls: ${payload.totalCalls}`);
  if (payload.traceCorpus?.entries > 0) {
    console.log(`trace corpus: ${payload.traceCorpus.entries} entries across ${payload.traceCorpus.lanes.length} model lane(s)`);
  }
  if (payload.totalCalls === 0) {
    console.log("No provider calls found in .harness/telemetry.jsonl.");
    return;
  }
  console.log("lane                         expected model          calls   cost       tokens      models");
  console.log("---------------------------  ----------------------  ------  ---------  ----------  ----------------");
  for (const lane of payload.lanes) {
    const models = Object.entries(lane.modelCounts).map(([model, count]) => `${model}:${count}`).join(", ") || "(missing)";
    console.log(
      `${lane.id.slice(0, 27).padEnd(27)}  ` +
      `${String(lane.expectedModel || "(none)").slice(0, 22).padEnd(22)}  ` +
      `${String(lane.calls).padStart(6)}  ` +
      `$${lane.totalCost.toFixed(4).padStart(8)}  ` +
      `${String(lane.totalTokens).padStart(10)}  ` +
      `${models}`,
    );
  }
  if (payload.mismatches.length > 0) {
    console.log("\nMismatches:");
    for (const item of payload.mismatches.slice(0, 20)) {
      console.log(`- ${item.lane}: ${item.skill || UNKNOWN}/${item.task_id || UNKNOWN} used ${item.model}, expected ${item.expectedModel}`);
    }
  }
  if (payload.missingModel.length > 0) {
    console.log(`\nMissing model field: ${payload.missingModel.length} provider_call row(s).`);
  }
  if (payload.missingTask.length > 0) {
    console.log(`\nMissing task_id for task-bound lane: ${payload.missingTask.length} provider_call row(s).`);
  }
}

const opts = parseArgs(process.argv.slice(2));
const root = resolve(opts.cwd);
const config = readConfig(root);
const lanes = configuredLanes(config);
const riskByTask = contractRiskMap(root, config);
const records = readJsonl(resolve(root, ".harness/telemetry.jsonl")).filter(recentFilter(opts.days));
const calls = annotateProviderCalls(records);
const payload = summarize(calls, lanes, riskByTask);
payload.traceCorpus = summarizeTraceCorpus(root, config);

if (opts.json) console.log(JSON.stringify(payload, null, 2));
else renderText(payload);

if (opts.strict && payload.status !== "passed") process.exit(2);

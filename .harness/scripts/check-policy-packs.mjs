#!/usr/bin/env node
// check-policy-packs.mjs - validate reusable policy pack manifests and their
// deterministic fitness rule examples.

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const STABLE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const STRICTNESS = new Set(["starter", "standard", "strict", "release", "team"]);
const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "id",
  "title",
  "description",
  "stacks",
  "strictnessDefault",
  "structuralRules",
  "fitnessRules",
  "taskContractDefaults",
  "reviewerDefaults",
  "evidenceRequirements",
  "evalTemplates",
  "verifyUiFlows",
  "antiPatterns",
];

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    json: false,
    packsDir: "",
    pack: "",
    strict: false,
    examples: true,
  };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg === "--no-examples") opts.examples = false;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--packs-dir=")) opts.packsDir = arg.slice("--packs-dir=".length).trim();
    else if (arg.startsWith("--pack=")) opts.pack = arg.slice("--pack=".length).trim();
  }
  opts.cwd = resolve(opts.cwd);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const ROOT = opts.cwd;
const errors = [];
const warnings = [];

function rel(path) {
  return relative(ROOT, path).replaceAll("\\", "/") || ".";
}

function normalizeRel(path) {
  return String(path || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function insideRoot(path) {
  const normalizedRoot = ROOT.endsWith("/") ? ROOT : `${ROOT}/`;
  return path === ROOT || path.startsWith(normalizedRoot);
}

function insideDir(path, dir) {
  const resolvedDir = resolve(dir);
  const normalizedDir = resolvedDir.endsWith("/") ? resolvedDir : `${resolvedDir}/`;
  return path === resolvedDir || path.startsWith(normalizedDir);
}

function isSafeLocalPath(value) {
  const text = String(value || "").trim();
  if (!text || text.startsWith("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return false;
  const normalized = normalizeRel(text);
  if (normalized.split("/").includes("..")) return false;
  return insideRoot(resolve(ROOT, text));
}

function isSafeRelativePath(value) {
  const text = String(value || "").trim();
  if (!text || text.startsWith("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return false;
  const normalized = normalizeRel(text);
  if (normalized.split("/").includes("..")) return false;
  return true;
}

function isSafeGlob(value) {
  const text = String(value || "").trim();
  if (!text || text.startsWith("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return false;
  return !normalizeRel(text).split("/").includes("..");
}

function readJson(path, label = rel(path)) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${label}: invalid JSON (${error.message})`);
    return null;
  }
}

function readConfig() {
  for (const candidate of [".harness/config.json", "harness.config.json"]) {
    const path = resolve(ROOT, candidate);
    if (!existsSync(path)) continue;
    const parsed = readJson(path, rel(path));
    return parsed && typeof parsed === "object" ? parsed : {};
  }
  return {};
}

function defaultPacksDir(config) {
  if (opts.packsDir) return opts.packsDir;
  if (existsSync(resolve(ROOT, "src/templates/.harness/policy-packs"))) {
    return "src/templates/.harness/policy-packs";
  }
  return config.policyPacks?.packsDir || ".harness/policy-packs";
}

function discoverPackIds(packsDir, config) {
  if (opts.pack) return opts.pack.split(",").map((id) => id.trim()).filter(Boolean);
  const configured = Array.isArray(config.policyPacks?.selected)
    ? config.policyPacks.selected.map((id) => String(id).trim()).filter(Boolean)
    : [];
  if (configured.length > 0) return configured;
  const abs = resolve(ROOT, packsDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(abs, entry.name, "pack.json")))
    .map((entry) => entry.name)
    .sort();
}

function requireStableId(value, label) {
  if (!STABLE_ID_RE.test(String(value || ""))) errors.push(`${label} must be a stable lowercase id`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") errors.push(`${label} must be a non-empty string`);
}

function requireNonEmptyArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return [];
  }
  return value;
}

function requireNoUnknownKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${label}.${key} is not supported by the policy pack schema`);
  }
}

function requireUnique(values, label) {
  const seen = new Set();
  for (const [idx, value] of values.entries()) {
    const key = String(value);
    if (seen.has(key)) errors.push(`${label}[${idx}] duplicates "${key}"`);
    seen.add(key);
  }
}

function requireSafeGlobArray(value, label) {
  const items = requireNonEmptyArray(value, label);
  for (const [idx, item] of items.entries()) {
    if (typeof item !== "string" || !isSafeGlob(item)) {
      errors.push(`${label}[${idx}] must be a safe repo-local glob`);
    }
  }
  return items;
}

function requireStringArray(value, label) {
  const items = requireNonEmptyArray(value, label);
  for (const [idx, item] of items.entries()) requireString(item, `${label}[${idx}]`);
  return items;
}

function requireStableIdArray(value, label) {
  const items = requireNonEmptyArray(value, label);
  for (const [idx, item] of items.entries()) requireStableId(item, `${label}[${idx}]`);
  requireUnique(items, label);
  return items;
}

function validatePack(pack, { id, packDir, source }) {
  const before = errors.length;
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
    errors.push(`${source}: pack must be an object`);
    return null;
  }
  requireNoUnknownKeys(pack, TOP_LEVEL_KEYS, source);
  if (pack.schemaVersion !== 1) errors.push(`${source}: schemaVersion must be 1`);
  requireStableId(pack.id, `${source}: id`);
  if (pack.id && pack.id !== id) errors.push(`${source}: id must match directory name "${id}"`);
  requireString(pack.title, `${source}: title`);
  requireString(pack.description, `${source}: description`);
  if (!STRICTNESS.has(String(pack.strictnessDefault || ""))) {
    errors.push(`${source}: strictnessDefault must be one of ${[...STRICTNESS].join(", ")}`);
  }

  for (const [idx, stack] of requireNonEmptyArray(pack.stacks, `${source}: stacks`).entries()) {
    requireNoUnknownKeys(stack, ["language", "frameworks"], `${source}: stacks[${idx}]`);
    requireString(stack?.language, `${source}: stacks[${idx}].language`);
    const frameworks = requireStringArray(stack?.frameworks, `${source}: stacks[${idx}].frameworks`);
    requireUnique(frameworks, `${source}: stacks[${idx}].frameworks`);
  }

  const structuralRules = requireNonEmptyArray(pack.structuralRules, `${source}: structuralRules`);
  for (const [idx, ruleId] of structuralRules.entries()) {
    requireStableId(ruleId, `${source}: structuralRules[${idx}]`);
  }
  requireUnique(structuralRules, `${source}: structuralRules`);

  let fitnessRuleCount = 0;
  const fitnessRuleIds = [];
  for (const [idx, rule] of requireNonEmptyArray(pack.fitnessRules, `${source}: fitnessRules`).entries()) {
    requireNoUnknownKeys(rule, ["id", "path", "owner"], `${source}: fitnessRules[${idx}]`);
    requireStableId(rule?.id, `${source}: fitnessRules[${idx}].id`);
    if (rule?.id) fitnessRuleIds.push(rule.id);
    requireStableId(rule?.owner, `${source}: fitnessRules[${idx}].owner`);
    requireString(rule?.path, `${source}: fitnessRules[${idx}].path`);
    if (rule?.path && !isSafeRelativePath(rule.path)) {
      errors.push(`${source}: fitnessRules[${idx}].path must stay inside the pack directory`);
      continue;
    }
    const absRule = resolve(packDir, rule.path || "");
    if (!insideRoot(absRule) || !insideDir(absRule, packDir)) {
      errors.push(`${source}: fitnessRules[${idx}].path must stay inside the pack directory`);
      continue;
    }
    if (!existsSync(absRule)) {
      errors.push(`${source}: fitnessRules[${idx}].path not found: ${rule.path}`);
    } else if (lstatSync(absRule).isSymbolicLink()) {
      errors.push(`${source}: fitnessRules[${idx}].path must not be a symlink`);
    } else {
      const parsedRule = readJson(absRule, rel(absRule));
      if (parsedRule?.id && parsedRule.id !== rule.id) {
        errors.push(`${source}: fitnessRules[${idx}].id does not match rule file id ${parsedRule.id}`);
      }
      fitnessRuleCount += 1;
    }
  }
  requireUnique(fitnessRuleIds, `${source}: fitnessRules[].id`);

  const taskDefaults = pack.taskContractDefaults || {};
  if (!taskDefaults || typeof taskDefaults !== "object" || Array.isArray(taskDefaults)) {
    errors.push(`${source}: taskContractDefaults must be an object`);
  } else {
    requireStableIdArray(taskDefaults.scope?.allowedLayers, `${source}: taskContractDefaults.scope.allowedLayers`);
    requireStableIdArray(taskDefaults.doneRequires, `${source}: taskContractDefaults.doneRequires`);
    for (const [idx, route] of requireNonEmptyArray(taskDefaults.riskRouting, `${source}: taskContractDefaults.riskRouting`).entries()) {
      requireSafeGlobArray(route?.match, `${source}: taskContractDefaults.riskRouting[${idx}].match`);
      if (!["tiny", "normal", "high-risk"].includes(String(route?.riskTier || ""))) {
        errors.push(`${source}: taskContractDefaults.riskRouting[${idx}].riskTier must be tiny, normal, or high-risk`);
      }
      requireStableIdArray(route?.requiredReviewers, `${source}: taskContractDefaults.riskRouting[${idx}].requiredReviewers`);
    }
  }

  const reviewerDefaults = pack.reviewerDefaults || {};
  if (!reviewerDefaults || typeof reviewerDefaults !== "object" || Array.isArray(reviewerDefaults)) {
    errors.push(`${source}: reviewerDefaults must be an object`);
  } else {
    requireStableIdArray(reviewerDefaults.required, `${source}: reviewerDefaults.required`);
    for (const [idx, item] of requireNonEmptyArray(reviewerDefaults.conditional, `${source}: reviewerDefaults.conditional`).entries()) {
      requireStableId(item?.reviewer, `${source}: reviewerDefaults.conditional[${idx}].reviewer`);
      requireSafeGlobArray(item?.whenChanged, `${source}: reviewerDefaults.conditional[${idx}].whenChanged`);
    }
  }

  for (const [idx, item] of requireNonEmptyArray(pack.evidenceRequirements, `${source}: evidenceRequirements`).entries()) {
    requireStableId(item?.id, `${source}: evidenceRequirements[${idx}].id`);
    if (item?.whenChanged !== undefined) requireSafeGlobArray(item.whenChanged, `${source}: evidenceRequirements[${idx}].whenChanged`);
    requireStringArray(item?.requires, `${source}: evidenceRequirements[${idx}].requires`);
  }
  for (const [idx, item] of requireNonEmptyArray(pack.evalTemplates, `${source}: evalTemplates`).entries()) {
    requireStableId(item?.id, `${source}: evalTemplates[${idx}].id`);
    requireString(item?.description, `${source}: evalTemplates[${idx}].description`);
  }
  for (const [idx, item] of requireNonEmptyArray(pack.verifyUiFlows, `${source}: verifyUiFlows`).entries()) {
    requireStableId(item?.id, `${source}: verifyUiFlows[${idx}].id`);
    requireStringArray(item?.routes, `${source}: verifyUiFlows[${idx}].routes`);
    requireStringArray(item?.assertions, `${source}: verifyUiFlows[${idx}].assertions`);
  }
  for (const [idx, item] of requireNonEmptyArray(pack.antiPatterns, `${source}: antiPatterns`).entries()) {
    requireStableId(item?.id, `${source}: antiPatterns[${idx}].id`);
    requireString(item?.description, `${source}: antiPatterns[${idx}].description`);
    requireString(item?.fix, `${source}: antiPatterns[${idx}].fix`);
  }

  return {
    id,
    title: pack.title || id,
    source,
    fitnessRules: fitnessRuleCount,
    valid: errors.length === before,
  };
}

function runFitnessExamples(packs) {
  if (!opts.examples || packs.length === 0) return [];
  const checker = existsSync(resolve(ROOT, "src/templates/scripts/check-architecture-fitness.mjs"))
    ? resolve(ROOT, "src/templates/scripts/check-architecture-fitness.mjs")
    : resolve(ROOT, ".harness/scripts/check-architecture-fitness.mjs");
  if (!existsSync(checker)) {
    warnings.push("architecture fitness checker is missing; policy pack rule examples were not executed");
    return [];
  }
  const results = [];
  for (const pack of packs) {
    const rulesDir = resolve(dirname(resolve(ROOT, pack.source)), "fitness-rules");
    if (!existsSync(rulesDir)) continue;
    const result = spawnSync(process.execPath, [
      checker,
      `--cwd=${ROOT}`,
      `--rules-dir=${rel(rulesDir)}`,
      "--examples-only",
      "--json",
    ], {
      cwd: ROOT,
      encoding: "utf8",
    });
    let payload = null;
    try {
      payload = JSON.parse(result.stdout || "{}");
    } catch {
      payload = null;
    }
    results.push({
      pack: pack.id,
      status: result.status === 0 ? "pass" : "fail",
      examples: payload?.examples ?? 0,
      errors: payload?.errors || [],
      stderr: result.stderr.trim(),
    });
    if (result.status !== 0) {
      errors.push(`${pack.id}: fitness rule examples failed`);
      for (const error of payload?.errors || []) errors.push(`${pack.id}: ${error}`);
      if (result.stderr.trim()) errors.push(`${pack.id}: ${result.stderr.trim()}`);
    }
  }
  return results;
}

function main() {
  const config = readConfig();
  const packsDir = defaultPacksDir(config);
  if (!isSafeLocalPath(packsDir)) errors.push(`policyPacks.packsDir must be a safe repo-local path: ${packsDir}`);
  const absPacksDir = resolve(ROOT, packsDir);
  if (!existsSync(absPacksDir)) errors.push(`${packsDir}: policy packs directory not found`);
  const ids = errors.length === 0 ? discoverPackIds(packsDir, config) : [];
  const packs = [];
  for (const id of ids) {
    if (!STABLE_ID_RE.test(id)) {
      errors.push(`policy pack id must be a stable lowercase id: ${id}`);
      continue;
    }
    const packDir = resolve(absPacksDir, id);
    const packPath = resolve(packDir, "pack.json");
    if (!existsSync(packPath)) {
      errors.push(`${id}: pack.json not found`);
      continue;
    }
    const pack = readJson(packPath, rel(packPath));
    const validated = validatePack(pack, { id, packDir, source: rel(packPath) });
    if (validated) packs.push(validated);
  }
  const fitness = runFitnessExamples(packs);
  const payload = {
    status: errors.length === 0 ? "pass" : "fail",
    packsDir,
    packs,
    fitness,
    errors,
    warnings,
  };

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (payload.status === "pass") {
    const rules = packs.reduce((sum, pack) => sum + pack.fitnessRules, 0);
    console.log(`policy packs: OK (${packs.length} pack(s), ${rules} fitness rule(s))`);
    for (const warning of warnings) console.error(`warning: ${warning}`);
  } else {
    console.error("policy packs: FAILED");
    for (const error of errors) console.error(`- ${error}`);
    for (const warning of warnings) console.error(`warning: ${warning}`);
  }
  process.exit(payload.status === "pass" ? 0 : 1);
}

main();

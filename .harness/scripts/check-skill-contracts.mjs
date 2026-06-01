#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  compareSkillSurfaces,
  validateSkillContracts,
  validateSkillSurfaceParity,
} from "./_lib/skill-contracts.mjs";

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), json: false, reportOnly: false };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--report-only") opts.reportOnly = true;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const root = resolve(opts.cwd);
const templateSkills = resolve(root, "src/templates/.claude/skills");
const hasTemplateSkills = existsSync(templateSkills);
const claudeSkills = resolve(root, ".claude/skills");
const codexSkills = resolve(root, ".agents/skills");
const kiroSkills = resolve(root, ".kiro/skills");
const installedSkills = existsSync(claudeSkills)
  ? claudeSkills
  : existsSync(codexSkills)
    ? codexSkills
    : existsSync(kiroSkills)
      ? kiroSkills
      : codexSkills;
const skillsDir = hasTemplateSkills ? templateSkills : installedSkills;
const registryPath = hasTemplateSkills
  ? resolve(root, "src/templates/.harness/skill-registry.json")
  : resolve(root, ".harness/skill-registry.json");
const permissionsPath = hasTemplateSkills
  ? resolve(root, "src/templates/.harness/permissions.json")
  : resolve(root, ".harness/permissions.json");

async function readConfig() {
  for (const rel of [".harness/config.json", "harness.config.json"]) {
    const path = resolve(root, rel);
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      return {};
    }
  }
  return {};
}

function runtimeTargets(config) {
  const targets = config.agentRuntime?.targets;
  if (Array.isArray(targets) && targets.length > 0) return targets;
  if (typeof config.agentRuntime?.primary === "string") return [config.agentRuntime.primary];
  if (existsSync(codexSkills) && !existsSync(claudeSkills)) return ["codex"];
  if (existsSync(kiroSkills) && !existsSync(claudeSkills)) return ["kiro"];
  return ["claude"];
}

function installedSurfaceSpecs(config) {
  const targets = new Set(runtimeTargets(config));
  const specs = [];
  const claudeEnabled = targets.has("claude") && config.agentRuntime?.claude?.skills !== false;
  const codexEnabled = targets.has("codex") && config.agentRuntime?.codex?.skills !== false;
  const kiroEnabled = targets.has("kiro") && config.agentRuntime?.kiro?.skills !== false;
  if (claudeEnabled) specs.push({ name: "claude", path: claudeSkills, required: true });
  if (codexEnabled) specs.push({ name: "agents", path: codexSkills, required: true });
  if (kiroEnabled) specs.push({ name: "kiro", path: kiroSkills, required: true });
  if (specs.length === 0) specs.push({ name: "installed", path: installedSkills, required: true });
  return specs;
}

const config = await readConfig();
const validation = await validateSkillContracts({ skillsDir, registryPath, permissionsPath });
const surfaceSpecs = hasTemplateSkills
  ? [{ name: "templates", path: templateSkills, required: true }]
  : installedSurfaceSpecs(config);
const surfaceValidation = hasTemplateSkills
  ? { status: "passed", errors: [], warnings: [] }
  : await validateSkillSurfaceParity({ registryPath, surfaces: surfaceSpecs });
const report = await compareSkillSurfaces(surfaceSpecs);
const payload = { validation, surfaceValidation, report };

if (opts.json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(`skill contracts: ${validation.status} (${validation.skills} skills, registry ${validation.registrySkills})`);
  for (const surface of report.surfaces) {
    console.log(`  ${surface.name}: ${surface.count} skills at ${surface.path}`);
  }
  for (const [name, drift] of Object.entries(report.drift)) {
    if (drift.missing.length > 0) console.log(`  ${name} missing: ${drift.missing.join(", ")}`);
  }
  console.log(`skill surfaces: ${surfaceValidation.status}`);
  for (const warning of validation.warnings) console.warn(`warning: ${warning}`);
  for (const warning of surfaceValidation.warnings) console.warn(`warning: ${warning}`);
  for (const error of validation.errors) console.error(`error: ${error}`);
  for (const error of surfaceValidation.errors) console.error(`error: ${error}`);
}

if (!opts.reportOnly && (validation.status !== "passed" || surfaceValidation.status !== "passed")) process.exit(1);

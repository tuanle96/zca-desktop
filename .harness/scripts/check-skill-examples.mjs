#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const DEFAULT_REQUIRED_SKILLS = [
  "feature-intake",
  "create-story",
  "add-feature",
  "debug-flow",
  "inspect-app",
  "orchestrate",
  "verify-ui",
  "harness-improvement-loop",
];
const REQUIRED_FILES = [
  "good.trace.jsonl",
  "good.evidence.json",
  "bad.false-done.trace.jsonl",
  "bad.overbroad-edit.trace.jsonl",
];
const STABLE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    json: false,
    skillsDir: "",
    skill: "",
  };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--skills-dir=")) opts.skillsDir = arg.slice("--skills-dir=".length);
    else if (arg.startsWith("--skill=")) opts.skill = arg.slice("--skill=".length);
  }
  opts.cwd = resolve(opts.cwd);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const ROOT = opts.cwd;

function rel(path) {
  return relative(ROOT, path).replaceAll("\\", "/") || ".";
}

function readJson(path, errors) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${rel(path)}: invalid JSON (${error.message})`);
    return null;
  }
}

function readConfig() {
  for (const candidate of [".harness/config.json", "harness.config.json", "src/templates/harness.config.json.hbs"]) {
    const path = resolve(ROOT, candidate);
    if (!existsSync(path)) continue;
    const parsed = readJson(path, []);
    if (parsed) return parsed;
  }
  return {};
}

function chooseSkillsDir(config) {
  if (opts.skillsDir) return resolve(ROOT, opts.skillsDir);
  const configured = config.skillExamples?.skillsDir;
  if (typeof configured === "string" && configured.trim() && existsSync(resolve(ROOT, configured))) {
    return resolve(ROOT, configured);
  }
  const candidates = [
    "src/templates/.claude/skills",
    ".claude/skills",
    ".agents/skills",
  ];
  for (const candidate of candidates) {
    const path = resolve(ROOT, candidate);
    if (existsSync(path)) return path;
  }
  return resolve(ROOT, typeof configured === "string" && configured.trim() ? configured : "src/templates/.claude/skills");
}

function requiredSkills(config) {
  const configured = config.skillExamples?.requiredCoreSkills;
  const skills = Array.isArray(configured) && configured.length > 0 ? configured : DEFAULT_REQUIRED_SKILLS;
  return opts.skill ? skills.filter((skill) => skill === opts.skill) : skills;
}

function discoverExampleSkills(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "examples")))
    .map((entry) => entry.name)
    .sort();
}

function validateTrace(path, skill, expectedCase, errors) {
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) {
    errors.push(`${rel(path)}: trace file must not be empty`);
    return 0;
  }
  const lines = raw.split(/\r?\n/);
  const events = [];
  for (const [idx, line] of lines.entries()) {
    try {
      const event = JSON.parse(line);
      events.push(event);
      const prefix = `${rel(path)}:${idx + 1}`;
      if (event.schemaVersion !== 1) errors.push(`${prefix}: schemaVersion must be 1`);
      if (event.skill !== skill) errors.push(`${prefix}: skill must be "${skill}"`);
      if (!STABLE_ID_RE.test(String(event.traceId || ""))) errors.push(`${prefix}: traceId must be a stable id`);
      if (event.case !== expectedCase) errors.push(`${prefix}: case must be "${expectedCase}"`);
      if (typeof event.event !== "string" || !event.event.trim()) errors.push(`${prefix}: event is required`);
      if (expectedCase === "good" && event.expectedBlock) errors.push(`${prefix}: good traces cannot include expectedBlock`);
    } catch (error) {
      errors.push(`${rel(path)}:${idx + 1}: invalid JSONL event (${error.message})`);
    }
  }
  if (expectedCase === "good" && !events.some((event) => event.expectedOutcome === "pass")) {
    errors.push(`${rel(path)}: good trace must include expectedOutcome="pass"`);
  }
  if (expectedCase === "bad-false-done" && !events.some((event) => event.failureClass === "false-done" && event.expectedBlock)) {
    errors.push(`${rel(path)}: false-done trace must include failureClass="false-done" and expectedBlock`);
  }
  if (expectedCase === "bad-overbroad-edit" && !events.some((event) => event.failureClass === "permission-gap" && event.expectedBlock)) {
    errors.push(`${rel(path)}: overbroad-edit trace must include failureClass="permission-gap" and expectedBlock`);
  }
  return events.length;
}

function validateEvidence(path, skill, errors) {
  const evidence = readJson(path, errors);
  if (!evidence) return 0;
  if (evidence.schemaVersion !== 1) errors.push(`${rel(path)}: schemaVersion must be 1`);
  if (evidence.skill !== skill) errors.push(`${rel(path)}: skill must be "${skill}"`);
  if (evidence.case !== "good") errors.push(`${rel(path)}: case must be "good"`);
  if (evidence.status !== "pass") errors.push(`${rel(path)}: status must be pass`);
  if (!STABLE_ID_RE.test(String(evidence.taskId || ""))) errors.push(`${rel(path)}: taskId must be a stable id`);
  if (!STABLE_ID_RE.test(String(evidence.featureId || ""))) errors.push(`${rel(path)}: featureId must be a stable id`);
  if (typeof evidence.diffSummary !== "string" || evidence.diffSummary.trim().length < 12) {
    errors.push(`${rel(path)}: diffSummary must be concrete`);
  }
  const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
  if (checks.length === 0) errors.push(`${rel(path)}: checks must contain at least one proof`);
  for (const [idx, check] of checks.entries()) {
    const prefix = `${rel(path)}: checks[${idx}]`;
    if (check.status !== "pass") errors.push(`${prefix}.status must be pass`);
    if (typeof check.command !== "string" || !check.command.trim()) errors.push(`${prefix}.command is required`);
    if (typeof check.summary !== "string" || !check.summary.trim()) errors.push(`${prefix}.summary is required`);
  }
  return 1;
}

function validateSkillExamples(skillsDir, skill, errors) {
  const skillDir = join(skillsDir, skill);
  const examplesDir = join(skillDir, "examples");
  if (!existsSync(skillDir)) {
    errors.push(`${rel(skillDir)}: required skill is missing`);
    return { skill, files: 0, events: 0 };
  }
  if (!existsSync(examplesDir)) {
    errors.push(`${rel(examplesDir)}: required examples directory is missing`);
    return { skill, files: 0, events: 0 };
  }

  let files = 0;
  let events = 0;
  for (const file of REQUIRED_FILES) {
    const path = join(examplesDir, file);
    if (!existsSync(path)) {
      errors.push(`${rel(path)}: required skill example file is missing`);
      continue;
    }
    files += 1;
    if (file.endsWith(".trace.jsonl")) {
      const expectedCase = file === "good.trace.jsonl"
        ? "good"
        : file.includes("false-done")
          ? "bad-false-done"
          : "bad-overbroad-edit";
      events += validateTrace(path, skill, expectedCase, errors);
    } else {
      validateEvidence(path, skill, errors);
    }
  }

  for (const entry of readdirSync(examplesDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!REQUIRED_FILES.includes(entry.name)) {
      errors.push(`${rel(join(examplesDir, entry.name))}: unsupported example file; expected ${REQUIRED_FILES.join(", ")}`);
    }
  }
  return { skill, files, events };
}

const config = readConfig();
const skillsDir = chooseSkillsDir(config);
const errors = [];
const warnings = [];
const required = requiredSkills(config);
if (opts.skill && required.length === 0) errors.push(`--skill=${opts.skill}: not in requiredCoreSkills`);
if (!existsSync(skillsDir)) errors.push(`${rel(skillsDir)}: skills directory not found`);

const exampleSkills = new Set(discoverExampleSkills(skillsDir));
const skills = opts.skill ? required : [...new Set([...required, ...exampleSkills])].sort();
const results = existsSync(skillsDir)
  ? skills.map((skill) => validateSkillExamples(skillsDir, skill, errors))
  : [];

const payload = {
  status: errors.length === 0 ? "passed" : "failed",
  skillsDir: rel(skillsDir),
  requiredCoreSkills: required,
  skills: results,
  files: results.reduce((sum, item) => sum + item.files, 0),
  events: results.reduce((sum, item) => sum + item.events, 0),
  errors,
  warnings,
};

if (opts.json) {
  console.log(JSON.stringify(payload, null, 2));
} else if (payload.status === "passed") {
  console.log(`skill examples: OK (${payload.skills.length} skills, ${payload.files} files, ${payload.events} trace events)`);
} else {
  console.error("skill examples: FAILED");
  for (const error of errors) console.error(`- ${error}`);
  for (const warning of warnings) console.warn(`warning: ${warning}`);
}

process.exit(payload.status === "passed" ? 0 : 1);

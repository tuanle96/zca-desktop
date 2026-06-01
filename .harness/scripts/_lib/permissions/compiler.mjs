import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  normalizePermission,
  overbroadSensitiveBashPermission,
  permissionMatchesTool,
} from "../permission-matching.mjs";
import { buildRuntimePermissionHints } from "./runtime-hints.mjs";
import { validatePermissionRuntimeHooks } from "./runtime-expectations.mjs";

const SUBCOMMANDS = new Set(["compile", "diff", "explain"]);

const DEFAULT_PERMISSION_POLICY = {
  allow: [
    "Read",
    "Grep",
    "Glob",
    "LS",
    "TodoWrite",
    "Bash(git status*)",
    "Bash(git diff*)",
    "Bash(git log*)",
    "Bash(ls*)",
    "Bash(rg*)",
    "Bash(find*)",
    "Bash(node .harness/scripts/*)",
  ],
  deny: [
    "Bash(git push*)",
    "Bash(git commit*)",
  ],
};

function parseArgs(argv) {
  const opts = {
    command: "compile",
    cwd: process.cwd(),
    check: false,
    write: false,
    json: false,
    runtime: "",
    outputPath: "",
    skillId: "",
    taskId: "",
    tool: "",
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (SUBCOMMANDS.has(arg)) opts.command = arg;
    else if (arg === "--check") opts.check = true;
    else if (arg === "--write") opts.write = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--runtime") opts.runtime = String(argv[++idx] || "").trim();
    else if (arg.startsWith("--runtime=")) opts.runtime = arg.slice("--runtime=".length).trim();
    else if (arg === "--out") opts.outputPath = String(argv[++idx] || "").trim();
    else if (arg.startsWith("--out=")) opts.outputPath = arg.slice("--out=".length).trim();
    else if (arg === "--skill") opts.skillId = String(argv[++idx] || "").trim();
    else if (arg.startsWith("--skill=")) opts.skillId = arg.slice("--skill=".length).trim();
    else if (arg === "--task") opts.taskId = String(argv[++idx] || "").trim();
    else if (arg.startsWith("--task=")) opts.taskId = arg.slice("--task=".length).trim();
    else if (arg === "--tool" || arg === "--permission") opts.tool = String(argv[++idx] || "").trim();
    else if (arg.startsWith("--tool=")) opts.tool = arg.slice("--tool=".length).trim();
    else if (arg.startsWith("--permission=")) opts.tool = arg.slice("--permission=".length).trim();
    else if (arg === "--cwd") opts.cwd = resolve(String(argv[++idx] || process.cwd()));
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
  }
  if (opts.command === "diff") opts.check = true;
  return opts;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function rel(root, path) {
  return relative(root, path).replaceAll("\\", "/") || ".";
}

function detectRuntime(root, opts) {
  if (opts.runtime) return opts.runtime;
  const configPath = resolve(root, ".harness/config.json");
  if (existsSync(configPath)) {
    try {
      const config = readJson(configPath);
      if (Array.isArray(config.agentRuntime?.targets) && config.agentRuntime.targets.length === 1) {
        return String(config.agentRuntime.targets[0]);
      }
      if (typeof config.agentRuntime?.primary === "string") return config.agentRuntime.primary;
    } catch {
      // Fall back to filesystem detection below.
    }
  }
  if (existsSync(resolve(root, ".agents/skills")) && !existsSync(resolve(root, ".claude/skills"))) return "codex";
  return "claude";
}

function resolveSurface(root, opts) {
  const templateSkills = resolve(root, "src/templates/.claude/skills");
  if (existsSync(templateSkills)) {
    return {
      mode: "template",
      skillsDir: templateSkills,
      policyPath: resolve(root, "src/templates/.harness/permissions.json"),
      outputPath: resolve(root, opts.outputPath || "src/templates/.harness/permissions.compiled.json"),
    };
  }
  const runtime = detectRuntime(root, opts);
  let skillsDir = resolve(root, ".claude/skills");
  if (runtime === "codex" && existsSync(resolve(root, ".agents/skills"))) {
    skillsDir = resolve(root, ".agents/skills");
  } else if (runtime === "kiro" && existsSync(resolve(root, ".kiro/skills"))) {
    skillsDir = resolve(root, ".kiro/skills");
  }
  return {
    mode: "installed",
    skillsDir,
    policyPath: resolve(root, ".harness/permissions.json"),
    outputPath: resolve(root, opts.outputPath || ".harness/permissions.compiled.json"),
  };
}

function readConfig(root) {
  for (const path of [resolve(root, ".harness/config.json"), resolve(root, "harness.config.json")]) {
    if (!existsSync(path)) continue;
    try {
      return readJson(path);
    } catch {
      return {};
    }
  }
  return {};
}

function runtimeHooksEnabled(config, runtime) {
  if (runtime === "codex") return config.agentRuntime?.codex?.hooks === true;
  if (runtime === "kiro") return config.agentRuntime?.kiro?.hooks === true;
  return config.agentRuntime?.claude?.hooks === true;
}

function resolveTaskContractsDir(root, surface, config) {
  const configured = config.taskContracts?.contractsDir;
  if (configured) return resolve(root, configured);
  if (surface.mode === "template") return resolve(root, "src/templates/.harness/task-contracts");
  return resolve(root, ".harness/task-contracts");
}

function rewriteClaudeSkillPathsForRuntime(value, runtime) {
  if (typeof value !== "string") return value;
  if (runtime === "codex") {
    return value
      .replaceAll(".claude/skills/", ".agents/skills/")
      .replaceAll(".claude\\/skills\\/", ".agents\\/skills\\/");
  }
  if (runtime === "kiro") {
    return value
      .replaceAll(".claude/skills/", ".kiro/skills/")
      .replaceAll(".claude\\/skills\\/", ".kiro\\/skills\\/");
  }
  return value;
}

function permissionsForRuntime(permissions = { allow: [], deny: [] }, runtime = "claude") {
  return {
    allow: (permissions.allow || []).map((permission) => rewriteClaudeSkillPathsForRuntime(permission, runtime)),
    deny: (permissions.deny || []).map((permission) => rewriteClaudeSkillPathsForRuntime(permission, runtime)),
  };
}

function skillDirs(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function compilePolicy({ root, skillsDir, runtime }) {
  const skills = {};
  const sources = {};
  const errors = [];
  for (const id of skillDirs(skillsDir)) {
    const path = join(skillsDir, id, "skill.json");
    if (!existsSync(path)) {
      errors.push(`${rel(root, path)} missing`);
      continue;
    }
    let contract;
    try {
      contract = readJson(path);
    } catch (err) {
      errors.push(`${rel(root, path)} invalid JSON (${err.message})`);
      continue;
    }
    if (contract.id && contract.id !== id) errors.push(`${rel(root, path)} id "${contract.id}" must match directory "${id}"`);
    const permissions = permissionsForRuntime(contract.permissions || {}, runtime);
    skills[id] = permissions;
    sources[id] = {
      skillJson: rel(root, path),
      allow: permissions.allow.map((permission) => ({ permission, source: `${rel(root, path)}#permissions.allow` })),
      deny: permissions.deny.map((permission) => ({ permission, source: `${rel(root, path)}#permissions.deny` })),
    };
  }
  const policy = {
    version: 1,
    default: DEFAULT_PERMISSION_POLICY,
    skills,
  };
  return {
    schemaVersion: 1,
    runtime,
    generatedAt: new Date().toISOString(),
    source: {
      defaultPolicy: "permissions-compiler:DEFAULT_PERMISSION_POLICY",
      skillsDir: rel(root, skillsDir),
    },
    policy,
    sources,
    errors,
  };
}

function jsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

function normalizedList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizePermission).filter(Boolean);
}

function taskPermissionErrors({ task, path, root }) {
  const errors = [];
  if (task.riskTier !== "high-risk") return errors;
  const allow = normalizedList(task.permissions?.allow);
  const allowedLayers = Array.isArray(task.scope?.allowedLayers) ? task.scope.allowedLayers : [];
  if (allow.length === 0) {
    errors.push(`${rel(root, path)}: high-risk task requires a non-empty permissions.allow list`);
  }
  for (const permission of allow) {
    if (permission === "*" || permission === "Bash(*)" || overbroadSensitiveBashPermission(permission)) {
      errors.push(`${rel(root, path)}: high-risk task permission "${permission}" is too broad`);
    }
  }
  if (allowedLayers.length === 0) {
    errors.push(`${rel(root, path)}: high-risk task requires scope.allowedLayers`);
  }
  return errors;
}

function compileTaskContracts({ root, contractsDir }) {
  const tasks = {};
  const taskSources = {};
  const errors = [];
  if (!existsSync(contractsDir)) {
    return {
      source: {
        contractsDir: rel(root, contractsDir),
        exists: false,
      },
      tasks,
      taskSources,
      errors,
    };
  }
  for (const name of jsonFiles(contractsDir)) {
    const path = join(contractsDir, name);
    let task;
    try {
      task = readJson(path);
    } catch (err) {
      errors.push(`${rel(root, path)} invalid JSON (${err.message})`);
      continue;
    }
    const fallbackId = name.replace(/\.json$/, "");
    const id = String(task.id || fallbackId);
    if (task.id && task.id !== fallbackId) {
      errors.push(`${rel(root, path)} id "${task.id}" must match file "${fallbackId}.json"`);
    }
    const allow = normalizedList(task.permissions?.allow);
    const deny = normalizedList(task.permissions?.deny);
    const taskErrors = taskPermissionErrors({ task, path, root });
    errors.push(...taskErrors);
    tasks[id] = {
      id,
      riskTier: task.riskTier || "",
      type: task.type || "",
      scope: task.scope || {},
      doneRequires: Array.isArray(task.doneRequires) ? task.doneRequires : [],
      permissions: { allow, deny },
      source: rel(root, path),
      errors: taskErrors,
    };
    taskSources[id] = {
      taskContract: rel(root, path),
      allow: allow.map((permission) => ({ permission, source: `${rel(root, path)}#permissions.allow` })),
      deny: deny.map((permission) => ({ permission, source: `${rel(root, path)}#permissions.deny` })),
    };
  }
  return {
    source: {
      contractsDir: rel(root, contractsDir),
      exists: true,
    },
    tasks,
    taskSources,
    errors,
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function policyDrift(existing, compiledPolicy) {
  const left = JSON.stringify(canonical(existing));
  const right = JSON.stringify(canonical(compiledPolicy));
  if (left === right) return [];
  const errors = ["permissions policy drift: existing policy does not match compiled skill contracts"];
  const existingSkills = new Set(Object.keys(existing?.skills || {}));
  const compiledSkills = new Set(Object.keys(compiledPolicy?.skills || {}));
  const missing = [...compiledSkills].filter((id) => !existingSkills.has(id)).sort();
  const extra = [...existingSkills].filter((id) => !compiledSkills.has(id)).sort();
  if (missing.length > 0) errors.push(`missing skill policies: ${missing.join(", ")}`);
  if (extra.length > 0) errors.push(`extra skill policies: ${extra.join(", ")}`);
  for (const id of [...compiledSkills].filter((skill) => existingSkills.has(skill)).sort()) {
    const existingSkill = canonical(existing.skills[id]);
    const compiledSkill = canonical(compiledPolicy.skills[id]);
    if (JSON.stringify(existingSkill) !== JSON.stringify(compiledSkill)) errors.push(`${id}: compiled permissions differ from existing policy`);
  }
  if (JSON.stringify(canonical(existing?.default || {})) !== JSON.stringify(canonical(compiledPolicy.default))) {
    errors.push("default policy differs from compiler default");
  }
  return errors;
}

function renderText(payload) {
  if (payload.explanation) {
    const explanation = payload.explanation;
    const lines = [
      `permissions explain: ${explanation.decision}`,
      `tool: ${explanation.tool}`,
    ];
    if (explanation.skill?.id) lines.push(`skill: ${explanation.skill.id}`);
    if (explanation.task?.id) lines.push(`task: ${explanation.task.id}`);
    for (const reason of explanation.reasons) lines.push(`reason: ${reason}`);
    for (const match of explanation.matchedBy) {
      lines.push(`${match.effect}: ${match.permission} (${match.level}: ${match.source})`);
    }
    for (const error of payload.errors || []) lines.push(`error: ${error}`);
    return `${lines.join("\n")}\n`;
  }
  if (payload.command === "diff") {
    const lines = [
      `permissions diff: ${payload.status}`,
      `runtime: ${payload.runtime}`,
      `skills: ${Object.keys(payload.compiled.policy.skills).length}`,
      `policy: ${payload.policyPath}`,
    ];
    if (payload.compiled.runtimeExpectations) {
      lines.push(`runtime expectations: ${payload.compiled.runtimeExpectations.validation.status}`);
    }
    if (payload.compiled.runtimePermissionHints) {
      lines.push(`permission hints: ${payload.compiled.runtimePermissionHints.allow.length}`);
    }
    for (const warning of payload.warnings || []) lines.push(`warning: ${warning}`);
    for (const error of payload.errors || []) lines.push(`error: ${error}`);
    return `${lines.join("\n")}\n`;
  }
  const lines = [
    `permissions-compile: ${payload.status}`,
    `runtime: ${payload.runtime}`,
    `skills: ${Object.keys(payload.compiled.policy.skills).length}`,
    `policy: ${payload.policyPath}`,
  ];
  if (payload.compiled.runtimeExpectations) {
    lines.push(`runtime expectations: ${payload.compiled.runtimeExpectations.validation.status}`);
  }
  if (payload.compiled.runtimePermissionHints) {
    lines.push(`permission hints: ${payload.compiled.runtimePermissionHints.allow.length}`);
  }
  if (payload.outputPath) lines.push(`compiled: ${payload.outputPath}`);
  if (payload.skill) {
    lines.push(`skill: ${payload.skill.id}`);
    for (const item of payload.skill.allow) lines.push(`allow: ${item.permission} (${item.source})`);
    for (const item of payload.skill.deny) lines.push(`deny: ${item.permission} (${item.source})`);
  }
  for (const warning of payload.warnings || []) lines.push(`warning: ${warning}`);
  for (const error of payload.errors || []) lines.push(`error: ${error}`);
  return `${lines.join("\n")}\n`;
}

function parseTool(tool) {
  const normalizedTool = normalizePermission(tool);
  const bash = normalizedTool.match(/^Bash\((.*)\)$/);
  if (bash) {
    return {
      raw: String(tool || "").trim(),
      normalizedTool,
      request: {
        toolName: "Bash",
        command: bash[1],
      },
    };
  }
  return {
    raw: String(tool || "").trim(),
    normalizedTool,
    request: {
      toolName: normalizedTool,
      command: "",
    },
  };
}

function defaultEntries(effect) {
  return (DEFAULT_PERMISSION_POLICY[effect] || []).map((permission) => ({
    level: "default",
    effect,
    permission,
    source: `permissions-compiler:DEFAULT_PERMISSION_POLICY.${effect}`,
  }));
}

function skillEntries(compiled, skillId, effect) {
  if (!skillId) return [];
  const source = compiled.sources[skillId];
  if (source) {
    return source[effect].map((item) => ({
      level: "skill",
      effect,
      permission: item.permission,
      source: item.source,
    }));
  }
  return defaultEntries(effect).map((item) => ({
    ...item,
    level: "skill",
    source: `${item.source} (fallback for missing skill ${skillId})`,
  }));
}

function taskEntries(compiled, taskId, effect) {
  if (!taskId) return [];
  const source = compiled.taskSources[taskId];
  if (!source) return [];
  return source[effect].map((item) => ({
    level: "task",
    effect,
    permission: item.permission,
    source: item.source,
  }));
}

function matching(entries, request) {
  return entries.filter((entry) => permissionMatchesTool(entry.permission, request));
}

function requirementResult({ label, entries, request }) {
  if (entries.length === 0) return { ok: true, matches: [] };
  const matches = matching(entries, request);
  if (matches.length > 0) return { ok: true, matches };
  return {
    ok: false,
    matches: [],
    reason: `${label} allow list does not cover requested tool`,
  };
}

function explainPermission({ compiled, skillId, taskId, tool }) {
  const parsed = parseTool(tool);
  const errors = [];
  const reasons = [];
  if (!parsed.raw) errors.push("--tool is required for permissions explain");
  const skill = skillId
    ? {
        id: skillId,
        found: Boolean(compiled.sources[skillId]),
      }
    : null;
  const task = taskId
    ? {
        id: taskId,
        found: Boolean(compiled.tasks[taskId]),
        riskTier: compiled.tasks[taskId]?.riskTier || "",
        source: compiled.tasks[taskId]?.source || "",
      }
    : null;
  if (skillId && !skill.found) reasons.push(`skill "${skillId}" has no compiled policy; using default policy fallback`);
  if (taskId && !task.found) errors.push(`${taskId}: no compiled task policy found`);

  const denyEntries = [
    ...defaultEntries("deny"),
    ...skillEntries(compiled, skillId, "deny"),
    ...taskEntries(compiled, taskId, "deny"),
  ];
  const denyMatches = matching(denyEntries, parsed.request);
  if (denyMatches.length > 0) {
    reasons.push("deny rule matched before allow evaluation");
    return {
      tool: parsed.raw,
      normalizedTool: parsed.normalizedTool,
      decision: "deny",
      matchedBy: denyMatches,
      reasons,
      skill,
      task,
      errors,
    };
  }

  const allowMatches = [];
  const requirements = [];
  if (skillId) requirements.push({ label: `skill "${skillId}"`, entries: skillEntries(compiled, skillId, "allow") });
  else if (!taskId) requirements.push({ label: "default policy", entries: defaultEntries("allow") });
  if (taskId && task?.found) requirements.push({ label: `task "${taskId}"`, entries: taskEntries(compiled, taskId, "allow") });

  for (const requirement of requirements) {
    const result = requirementResult({ ...requirement, request: parsed.request });
    if (!result.ok) {
      reasons.push(result.reason);
      return {
        tool: parsed.raw,
        normalizedTool: parsed.normalizedTool,
        decision: "deny",
        matchedBy: allowMatches,
        reasons,
        skill,
        task,
        errors,
      };
    }
    allowMatches.push(...result.matches);
  }
  if (allowMatches.length === 0) reasons.push("no task or skill allow list was selected; no compiler-level block found");
  else reasons.push("all selected allow lists cover the requested tool");
  return {
    tool: parsed.raw,
    normalizedTool: parsed.normalizedTool,
    decision: errors.length > 0 ? "deny" : "allow",
    matchedBy: allowMatches,
    reasons,
    skill,
    task,
    errors,
  };
}

export async function runPermissionsCompileCli(argv = [], { exit = true, silent = false } = {}) {
  const opts = parseArgs(argv);
  const root = resolve(opts.cwd);
  const runtime = detectRuntime(root, opts);
  const surface = resolveSurface(root, { ...opts, runtime });
  const config = readConfig(root);
  const taskContractsDir = resolveTaskContractsDir(root, surface, config);
  const warnings = [];
  const compiled = compilePolicy({ root, skillsDir: surface.skillsDir, runtime });
  const compiledTasks = compileTaskContracts({ root, contractsDir: taskContractsDir });
  const runtimeValidation = validatePermissionRuntimeHooks({
    root,
    runtime,
    mode: surface.mode,
    enabled: runtimeHooksEnabled(config, runtime),
  });
  compiled.source.taskContractsDir = compiledTasks.source.contractsDir;
  compiled.tasks = compiledTasks.tasks;
  compiled.taskSources = compiledTasks.taskSources;
  compiled.runtimeExpectations = {
    ...runtimeValidation.expectations,
    validation: {
      status: runtimeValidation.status,
      errors: runtimeValidation.errors,
      warnings: runtimeValidation.warnings,
    },
  };
  compiled.runtimePermissionHints = buildRuntimePermissionHints(compiled);
  compiled.errors.push(...compiledTasks.errors);
  compiled.errors.push(...runtimeValidation.errors);
  const errors = [...compiled.errors];
  warnings.push(...runtimeValidation.warnings);
  let existing = null;
  if (existsSync(surface.policyPath)) {
    try {
      existing = readJson(surface.policyPath);
    } catch (err) {
      errors.push(`${rel(root, surface.policyPath)} invalid JSON (${err.message})`);
    }
  } else {
    errors.push(`${rel(root, surface.policyPath)} missing`);
  }
  if (opts.check && existing) errors.push(...policyDrift(existing, compiled.policy));

  let outputPath = "";
  if (opts.write) {
    outputPath = rel(root, surface.outputPath);
    if (!surface.outputPath.startsWith(root.endsWith("/") ? root : `${root}/`)) {
      errors.push(`${outputPath}: output path must stay inside the project root`);
    } else {
      writeFileSync(surface.outputPath, `${JSON.stringify(compiled, null, 2)}\n`);
    }
  }

  let skill = null;
  if (opts.skillId) {
    const source = compiled.sources[opts.skillId];
    if (!source) {
      if (opts.command !== "explain") errors.push(`${opts.skillId}: no compiled skill policy found`);
    } else {
      skill = { id: opts.skillId, allow: source.allow, deny: source.deny };
    }
  }
  let task = null;
  if (opts.taskId) {
    const compiledTask = compiled.tasks[opts.taskId];
    if (!compiledTask && opts.command !== "explain") errors.push(`${opts.taskId}: no compiled task policy found`);
    else if (compiledTask) task = compiledTask;
  }
  const explanation = opts.command === "explain"
    ? explainPermission({ compiled, skillId: opts.skillId, taskId: opts.taskId, tool: opts.tool })
    : null;
  if (explanation) errors.push(...explanation.errors);

  const payload = {
    command: opts.command,
    status: errors.length === 0 ? "passed" : "failed",
    runtime,
    mode: surface.mode,
    policyPath: rel(root, surface.policyPath),
    outputPath,
    compiled,
    skill,
    task,
    explanation,
    warnings,
    errors,
  };
  if (!silent) {
    if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(renderText(payload));
  }
  const exitCode = errors.length === 0 ? 0 : 1;
  if (exit) process.exit(exitCode);
  return { payload, exitCode };
}

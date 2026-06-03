#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { analyzeHookIntegrity } from "./_lib/hook-integrity.mjs";

const COMMON_MEMORY_FILES = [
  ".harness/project/state.json",
  ".harness/memory/ledger.jsonl",
  ".harness/memory/current-summary.md",
  ".harness/scripts/project-memory.mjs",
  ".harness/scripts/session-start.sh",
  ".harness/scripts/session-end.sh",
];

const RUNTIME_FILES = {
  claude: [
    "CLAUDE.md",
    ".claude/skills/inspect-module/SKILL.md",
  ],
  codex: [
    "AGENTS.md",
    ".agents/skills/inspect-module/SKILL.md",
  ],
  kiro: [
    ".kiro/steering/harness.md",
    ".kiro/skills/inspect-module/SKILL.md",
  ],
};

const RUNTIME_HOOK_FILES = {
  claude: [".claude/hooks/hooks.json", ".claude/settings.json"],
  codex: [".codex/hooks.json"],
  kiro: [".kiro/agents/harness.json"],
};

const RUNTIME_HOOK_SIGNAL_FILES = {
  claude: [".claude/hooks/hooks.json"],
  codex: [".codex/hooks.json"],
  kiro: [".kiro/agents/harness.json"],
};

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), runtime: "", json: false };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--runtime=")) opts.runtime = arg.slice("--runtime=".length);
  }
  return opts;
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readConfig(cwd) {
  return safeReadJson(resolve(cwd, ".harness/config.json")) ||
    safeReadJson(resolve(cwd, "harness.config.json")) ||
    {};
}

function normalizeRuntimeTargets(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .flatMap((item) => (item === "dual" || item === "both" ? ["claude", "codex"] : [item]))
    .filter((item, index, list) => ["claude", "codex", "kiro"].includes(item) && list.indexOf(item) === index);
}

function inferRuntimes(cwd, config, explicit) {
  const requested = normalizeRuntimeTargets(explicit);
  if (requested.length > 0) return requested;
  const targets = normalizeRuntimeTargets(config.agentRuntime?.targets?.join?.(",") || config.agentRuntime?.primary || "");
  for (const runtime of ["claude", "codex", "kiro"]) {
    if (config.agentRuntime?.[runtime]?.skills === true || config.agentRuntime?.[runtime]?.hooks === true) {
      if (!targets.includes(runtime)) targets.push(runtime);
    }
  }
  if (targets.length > 0) return targets;
  const detected = [];
  if (existsSync(resolve(cwd, "CLAUDE.md")) || existsSync(resolve(cwd, ".claude"))) detected.push("claude");
  if (existsSync(resolve(cwd, "AGENTS.md")) || existsSync(resolve(cwd, ".codex"))) detected.push("codex");
  if (existsSync(resolve(cwd, ".kiro"))) detected.push("kiro");
  return detected;
}

function missingFiles(cwd, files) {
  return files.filter((file) => !existsSync(resolve(cwd, file)));
}

function checkLockfile(cwd) {
  const lockPath = resolve(cwd, ".harness/installed.json");
  if (!existsSync(lockPath)) {
    return { status: "fail", missingManagedFiles: [], errors: ["missing .harness/installed.json"] };
  }
  const lock = safeReadJson(lockPath);
  if (!lock || typeof lock !== "object") {
    return { status: "fail", missingManagedFiles: [], errors: [".harness/installed.json is not valid JSON"] };
  }
  const files = Object.keys(lock.files || {});
  const missingManagedFiles = missingFiles(cwd, files);
  return {
    status: missingManagedFiles.length > 0 ? "fail" : "pass",
    version: lock.version || "unknown",
    managedFiles: files.length,
    missingManagedFiles,
    errors: missingManagedFiles.length > 0
      ? [`${missingManagedFiles.length} managed file(s) from .harness/installed.json are missing`]
      : [],
  };
}

function checkSessionStart(cwd) {
  const script = resolve(cwd, ".harness/scripts/session-start.sh");
  if (!existsSync(script)) {
    return { status: "fail", output: "", errors: ["cannot simulate SessionStart because .harness/scripts/session-start.sh is missing"] };
  }
  const result = spawnSync("bash", [script], {
    cwd,
    input: JSON.stringify({ source: "startup", hook_event_name: "SessionStart" }),
    encoding: "utf8",
  });
  const output = result.stdout || "";
  const errors = [];
  if (result.status !== 0) errors.push(`SessionStart simulation exited ${result.status}`);
  if (!output.includes("[harness] project:")) {
    errors.push('SessionStart output does not include "[harness] project:"');
  }
  return {
    status: errors.length > 0 ? "fail" : "pass",
    output,
    errors,
  };
}

function runtimeRequiredFiles(cwd, config, runtime) {
  const files = [...(RUNTIME_FILES[runtime] || [])];
  const hookFiles = RUNTIME_HOOK_FILES[runtime] || [];
  const hookSignalFiles = RUNTIME_HOOK_SIGNAL_FILES[runtime] || hookFiles;
  const hooksEnabled = config.agentRuntime?.[runtime]?.hooks === true;
  const hooksExist = hookSignalFiles.some((file) => existsSync(resolve(cwd, file)));
  if (hooksEnabled || hooksExist) files.push(...hookFiles);
  return files;
}

function checkRuntimeFiles(cwd, config, runtimes) {
  return runtimes.map((runtime) => {
    const requiredFiles = runtimeRequiredFiles(cwd, config, runtime);
    const missing = missingFiles(cwd, requiredFiles);
    return {
      runtime,
      status: missing.length > 0 ? "fail" : "pass",
      requiredFiles,
      missing,
    };
  });
}

function worst(statuses) {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  return "pass";
}

export function analyzeRuntimeSurface({ cwd = process.cwd(), runtime = "" } = {}) {
  const root = resolve(cwd);
  const config = readConfig(root);
  const runtimes = inferRuntimes(root, config, runtime);
  const lockfile = checkLockfile(root);
  const memoryMissing = missingFiles(root, COMMON_MEMORY_FILES);
  const memory = {
    status: memoryMissing.length > 0 ? "fail" : "pass",
    requiredFiles: COMMON_MEMORY_FILES,
    missing: memoryMissing,
  };
  const sessionStart = checkSessionStart(root);
  const runtimeSurfaces = checkRuntimeFiles(root, config, runtimes);
  const hookIntegrity = analyzeHookIntegrity({ cwd: root });
  const errors = [
    ...lockfile.errors,
    ...memory.missing.map((file) => `missing ${file}`),
    ...sessionStart.errors,
    ...runtimeSurfaces.flatMap((surface) => surface.missing.map((file) => `${surface.runtime}: missing ${file}`)),
    ...hookIntegrity.errors,
  ];
  const warnings = [
    ...(runtimes.length === 0 ? ["no agent runtime surface detected; pass --runtime=claude, --runtime=codex, or --runtime=claude,codex"] : []),
    ...hookIntegrity.warnings,
  ];
  return {
    status: worst([
      lockfile.status,
      memory.status,
      sessionStart.status,
      ...runtimeSurfaces.map((surface) => surface.status),
      hookIntegrity.status,
    ]),
    runtimes,
    lockfile,
    memory,
    sessionStart,
    runtimeSurfaces,
    hookIntegrity,
    errors,
    warnings,
  };
}

const invoked = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invoked) {
  const opts = parseArgs(process.argv.slice(2));
  const payload = analyzeRuntimeSurface(opts);
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (payload.status === "fail") {
    console.error("check-runtime-surface: FAILED");
    for (const error of payload.errors) console.error(`- ${error}`);
    for (const warning of payload.warnings) console.error(`warning: ${warning}`);
  } else {
    console.log(`check-runtime-surface: OK (runtime: ${payload.runtimes.join(",") || "none"})`);
    for (const warning of payload.warnings) console.warn(`warning: ${warning}`);
  }
  process.exit(payload.status === "fail" ? 1 : 0);
}

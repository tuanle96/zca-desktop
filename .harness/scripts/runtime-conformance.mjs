#!/usr/bin/env node
// runtime-conformance.mjs - deterministic adapter conformance checks.
//
// Runtime parity compares Claude and Codex capability quality. This suite asks
// a stricter platform question: does each advertised runtime target ship the
// required install, hook, evidence, review, telemetry, and orchestration spine?

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { analyzeHookIntegrity } from "./_lib/hook-integrity.mjs";

const EXPECTED_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "Notification",
  "PostToolUse",
  "PreCompact",
  "Stop",
  "SubagentStop",
  "SessionEnd",
];

const KIRO_HOOK_EVENTS = [
  "agentSpawn",
  "userPromptSubmit",
  "preToolUse",
  "postToolUse",
  "stop",
];

const SUPPORTED_RUNTIMES = new Set(["claude", "codex", "kiro"]);

function expectedHookEvents(runtime) {
  return runtime === "kiro" ? KIRO_HOOK_EVENTS : EXPECTED_HOOK_EVENTS;
}

const CHECKS = [
  {
    id: "install-surface-renders",
    title: "Install surface renders",
    evidence: [
      { path: "tests/render-templates.test.mjs", contains: "renderAll dual runtime writes Claude and Codex surfaces" },
    ],
  },
  {
    id: "skills-load",
    title: "Skills load",
    evidence: [
      { path: "tests/skill-renderer.test.mjs", contains: "renderSkill generates Codex format from contract" },
      { path: "tests/e2e-codex-cli.test.mjs", contains: "skill-discovery indexes Codex .agents/skills" },
    ],
  },
  {
    id: "hooks-fire",
    title: "Hooks fire",
    evidence: [
      { path: "tests/e2e-claude-cli.test.mjs", contains: "real claude -p session fires kit hooks" },
      { path: "tests/e2e-codex-cli.test.mjs", contains: "real codex exec reads generated Codex runtime surface" },
      { path: "tests/codex-synthetic.test.mjs", contains: "Codex hooks.json has all 9 events with AHK_RUNTIME=codex" },
    ],
  },
  {
    id: "mutation-hooks-block-protected-paths",
    title: "Mutation hooks block protected paths",
    evidence: [
      { path: "tests/v9-hook-expansion.test.mjs", contains: "pretooluse-edit-guard denies apply_patch moves into .claude" },
      { path: "tests/skill-permission-guard.test.mjs", contains: "source and config mutations require an active task contract when configured" },
    ],
  },
  {
    id: "task-contract-discovered",
    title: "Task contract is discovered",
    evidence: [
      { path: "tests/skill-permission-guard.test.mjs", contains: "task contract permissions can use active task state from SessionStart" },
      { path: "tests/task-evidence-check.test.mjs", contains: "task contract directories in config must stay inside the project root" },
    ],
  },
  {
    id: "evidence-gate-blocks-false-done",
    title: "Evidence gate blocks false done",
    evidence: [
      { path: "tests/task-evidence-check.test.mjs", contains: "blocks a current-diff passes=true claim without task/evidence proof" },
      { path: "tests/precompletion-active-task-evidence.test.mjs", contains: "Stop hook blocks verbal done claims for the active task without evidence" },
    ],
  },
  {
    id: "reviewer-advisor-artifact-captured",
    title: "Reviewer and advisor artifacts are captured",
    evidence: [
      { path: "tests/review-agent-contracts.test.mjs", contains: "review agents produce schema-compatible evidence decision guidance" },
      { path: "tests/task-evidence-check.test.mjs", contains: "validates JSON reviewer artifacts and required gates" },
      { path: "tests/v9-hook-expansion.test.mjs", contains: "subagent-stop hook ships + appends telemetry row" },
    ],
  },
  {
    id: "telemetry-recorded",
    title: "Telemetry is recorded",
    evidence: [
      { path: "tests/telemetry-hook.test.mjs", contains: "telemetry records Skill invocations as JSONL" },
      { path: "tests/orchestrate-runtime.test.mjs", contains: 'assert.match(telemetry, /"provider":"codex"/);' },
    ],
  },
  {
    id: "orchestration-bounded-task",
    title: "Orchestration can run a bounded task",
    evidence: [
      { path: "tests/orchestrate-runtime.test.mjs", contains: "orchestrate runtime writes manifest, transcripts, and cost summary" },
      { path: "tests/orchestrate-runtime.test.mjs", contains: "rendered Codex orchestrate skill runs from .agents without .claude" },
    ],
  },
];

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), json: false, strict: false, runtime: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg === "--cwd") opts.cwd = resolve(argv[++i] || ".");
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg === "--runtime") opts.runtime = argv[++i] || "";
    else if (arg.startsWith("--runtime=")) opts.runtime = arg.slice("--runtime=".length);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const ROOT = resolve(opts.cwd);

function rel(path) {
  return relative(ROOT, path).split("\\").join("/") || ".";
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function readText(path) {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function listDirs(path) {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function countSkillContracts(skillsRoot) {
  return listDirs(skillsRoot).filter((id) => existsSync(resolve(skillsRoot, id, "contract.json"))).length;
}

function readConfig() {
  return readJson(resolve(ROOT, ".harness/config.json")) || readJson(resolve(ROOT, "harness.config.json")) || {};
}

function splitRuntimeTargets(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .flatMap((item) => item === "dual" || item === "both" ? ["claude", "codex"] : [item]);
}

function inferRuntimeTargets(config, kitRepo) {
  const requested = splitRuntimeTargets(opts.runtime);
  if (requested.length > 0) return [...new Set(requested)];
  if (kitRepo) return ["claude", "codex"];
  const configured = Array.isArray(config.agentRuntime?.targets) ? config.agentRuntime.targets : [];
  if (configured.length > 0) return [...new Set(splitRuntimeTargets(configured.join(",")))];
  const inferred = [];
  if (existsSync(resolve(ROOT, ".claude"))) inferred.push("claude");
  if (existsSync(resolve(ROOT, ".codex")) || existsSync(resolve(ROOT, ".agents"))) inferred.push("codex");
  return inferred.length > 0 ? inferred : ["claude"];
}

function sourceRel(relPath) {
  return `src/templates/${relPath}`;
}

function harnessRel(relPath, kitRepo) {
  return kitRepo ? sourceRel(`.harness/${relPath}`) : `.harness/${relPath}`;
}

function scriptRel(name, kitRepo) {
  const sourceName = name.endsWith(".sh") ? `${name}.hbs` : name;
  if (!kitRepo) return `.harness/scripts/${name}`;
  const rendered = sourceRel(`scripts/${sourceName}`);
  if (existsSync(resolve(ROOT, rendered))) return rendered;
  return sourceRel(`scripts/${name}`);
}

function skillRootRel(runtime, kitRepo) {
  if (kitRepo) return "src/templates/.claude/skills";
  if (runtime === "codex") return ".agents/skills";
  if (runtime === "kiro") return ".kiro/skills";
  return ".claude/skills";
}

function hookPath(runtime, kitRepo) {
  if (kitRepo) {
    return resolve(ROOT, runtime === "codex" ? "src/templates/.codex/hooks.json" : "src/templates/.claude/hooks/hooks.json");
  }
  if (runtime === "kiro") return resolve(ROOT, ".kiro/agents/harness.json");
  return resolve(ROOT, runtime === "codex" ? ".codex/hooks.json" : ".claude/hooks/hooks.json");
}

function hookConfig(runtime, kitRepo) {
  return readJson(hookPath(runtime, kitRepo), {})?.hooks || {};
}

function hookEvents(runtime, kitRepo) {
  return Object.keys(hookConfig(runtime, kitRepo)).sort();
}

function missingItems(expected, actual) {
  return expected.filter((item) => !actual.includes(item));
}

function hookHas(runtime, kitRepo, event, predicate) {
  const entries = hookConfig(runtime, kitRepo)?.[event] || [];
  return entries.some((entry) => predicate(entry));
}

// Kiro names lifecycle events in camelCase and has no SubagentStop. Map the
// canonical (Claude/Codex) event name onto the kiro equivalent for checks.
function runtimeEvent(runtime, canonicalEvent) {
  if (runtime !== "kiro") return canonicalEvent;
  return {
    SessionStart: "agentSpawn",
    UserPromptSubmit: "userPromptSubmit",
    PreToolUse: "preToolUse",
    PostToolUse: "postToolUse",
    Stop: "stop",
  }[canonicalEvent] || canonicalEvent;
}

function hookCommandHas(runtime, kitRepo, event, marker) {
  return hookHas(runtime, kitRepo, event, (entry) => {
    if (typeof entry.command === "string") return entry.command.includes(marker);
    return (entry.hooks || []).some((hook) => String(hook.command || "").includes(marker));
  });
}

function hookMatcherHas(runtime, kitRepo, event, marker) {
  return hookHas(runtime, kitRepo, event, (entry) => String(entry.matcher || "").includes(marker));
}

function pathOk(relPath, detail) {
  const abs = resolve(ROOT, relPath);
  return existsSync(abs) ? null : `${detail || relPath} missing (${relPath})`;
}

function textOk(relPath, marker, detail) {
  const text = readText(resolve(ROOT, relPath));
  if (text === null) return `${detail || relPath} missing (${relPath})`;
  return text.includes(marker) ? null : `${detail || relPath} missing marker "${marker}"`;
}

function sourceSurfaceFailures(runtime) {
  if (runtime === "claude") {
    return [
      pathOk("src/templates/CLAUDE.md.hbs", "Claude instruction template"),
      pathOk("src/templates/.claude/hooks/hooks.json", "Claude hooks template"),
      pathOk("src/templates/.claude/agents/advisor.md.hbs", "Claude advisor template"),
    ].filter(Boolean);
  }
  if (runtime === "kiro") {
    return [
      pathOk("src/templates/.kiro/steering/harness.md.hbs", "Kiro steering template"),
      pathOk("src/core/rendering/kiro-surfaces.mjs", "Kiro surface renderer"),
    ].filter(Boolean);
  }
  return [
    pathOk("src/templates/AGENTS.md.hbs", "Codex instruction template"),
    pathOk("src/templates/.codex/hooks.json", "Codex hooks template"),
    pathOk("src/templates/.harness/skill-renderers/SKILL.md.codex.hbs", "Codex skill renderer"),
    pathOk("src/core/rendering/codex-surfaces.mjs", "Codex surface renderer"),
  ].filter(Boolean);
}

function installedSurfaceFailures(runtime) {
  if (runtime === "claude") {
    return [
      pathOk("CLAUDE.md", "Claude instruction file"),
      pathOk(".claude/hooks/hooks.json", "Claude hooks file"),
      pathOk(".claude/agents/advisor.md", "Claude advisor file"),
    ].filter(Boolean);
  }
  if (runtime === "kiro") {
    return [
      pathOk(".kiro/steering/harness.md", "Kiro steering file"),
      pathOk(".kiro/agents/harness.json", "Kiro primary agent file"),
      pathOk(".kiro/skills/add-feature/SKILL.md", "Kiro add-feature skill"),
    ].filter(Boolean);
  }
  return [
    pathOk("AGENTS.md", "Codex instruction file"),
    pathOk(".codex/hooks.json", "Codex hooks file"),
    pathOk(".codex/agents/advisor.toml", "Codex advisor file"),
      pathOk(".agents/skills/add-feature/SKILL.md", "Codex add-feature skill"),
  ].filter(Boolean);
}

function evaluateLocalCheck(checkId, runtime, kitRepo) {
  const failures = [];
  const inspected = [];
  const addPath = (relPath) => {
    inspected.push(relPath);
    const failure = pathOk(relPath);
    if (failure) failures.push(failure);
  };

  if (checkId === "install-surface-renders") {
    failures.push(...(kitRepo ? sourceSurfaceFailures(runtime) : installedSurfaceFailures(runtime)));
    inspected.push(runtime === "codex" ? (kitRepo ? "src/templates/AGENTS.md.hbs" : "AGENTS.md") : (kitRepo ? "src/templates/CLAUDE.md.hbs" : "CLAUDE.md"));
  } else if (checkId === "skills-load") {
    const skillsRoot = skillRootRel(runtime, kitRepo);
    const skills = listDirs(resolve(ROOT, skillsRoot));
    inspected.push(skillsRoot);
    if (skills.length === 0) failures.push(`${skillsRoot} has no skills`);
    if (kitRepo) {
      const contractCount = countSkillContracts(resolve(ROOT, skillsRoot));
      if (contractCount !== skills.length) failures.push(`${skillsRoot} skill contracts missing: ${contractCount}/${skills.length}`);
      if (runtime === "codex") addPath("src/templates/.harness/skill-renderers/SKILL.md.codex.hbs");
    } else if (runtime === "codex" || runtime === "kiro") {
      const withSkillJson = skills.filter((id) => existsSync(resolve(ROOT, skillsRoot, id, "skill.json"))).length;
      if (withSkillJson !== skills.length) failures.push(`${skillsRoot} skill.json missing: ${withSkillJson}/${skills.length}`);
    }
  } else if (checkId === "hooks-fire") {
    const hooksRel = rel(hookPath(runtime, kitRepo));
    const events = hookEvents(runtime, kitRepo);
    inspected.push(hooksRel);
    const missing = missingItems(expectedHookEvents(runtime), events);
    if (missing.length > 0) failures.push(`${runtime} hooks missing events: ${missing.join(", ")}`);
    if (!kitRepo) {
      const hookIntegrity = analyzeHookIntegrity({ cwd: ROOT });
      inspected.push(".harness/scripts/check-hook-integrity.mjs");
      if (hookIntegrity.status === "fail") failures.push(...hookIntegrity.errors.map((error) => `hook-integrity: ${error}`));
    }
  } else if (checkId === "mutation-hooks-block-protected-paths") {
    const editGuard = scriptRel("pretooluse-edit-guard.sh", kitRepo);
    const skillGuard = scriptRel("pretooluse-skill-permission-guard.mjs", kitRepo);
    inspected.push(editGuard, skillGuard, rel(hookPath(runtime, kitRepo)));
    addPath(editGuard);
    addPath(skillGuard);
    const preEvent = runtimeEvent(runtime, "PreToolUse");
    if (!hookMatcherHas(runtime, kitRepo, preEvent, runtime === "kiro" ? "write" : "Edit")) failures.push(`${runtime} PreToolUse does not match ${runtime === "kiro" ? "write" : "Edit"}`);
    if (!hookCommandHas(runtime, kitRepo, preEvent, "pretooluse-edit-guard")) failures.push(`${runtime} PreToolUse edit guard is not wired`);
    if (!hookCommandHas(runtime, kitRepo, preEvent, "pretooluse-skill-permission-guard")) failures.push(`${runtime} PreToolUse skill permission guard is not wired`);
    if (runtime === "codex" && !hookMatcherHas(runtime, kitRepo, "PreToolUse", "apply_patch")) {
      failures.push("Codex PreToolUse does not match apply_patch");
    }
  } else if (checkId === "task-contract-discovered") {
    const schema = harnessRel("schemas/task-contract.schema.json", kitRepo);
    const contractsDir = harnessRel("task-contracts", kitRepo);
    const activeScript = scriptRel("pretooluse-skill-permission-guard.mjs", kitRepo);
    inspected.push(schema, contractsDir, activeScript);
    addPath(schema);
    addPath(contractsDir);
    const markerFailure = textOk(activeScript, "active task", "skill permission guard active-task support");
    if (markerFailure) failures.push(markerFailure);
  } else if (checkId === "evidence-gate-blocks-false-done") {
    const evidenceSchema = harnessRel("schemas/evidence-bundle.schema.json", kitRepo);
    const checker = scriptRel("task-evidence-check.mjs", kitRepo);
    const stopHook = scriptRel("precompletion-checklist.sh", kitRepo);
    inspected.push(evidenceSchema, checker, stopHook);
    addPath(evidenceSchema);
    addPath(checker);
    const markerFailure = textOk(stopHook, "task-evidence-check", "Stop hook evidence gate");
    if (markerFailure) failures.push(markerFailure);
  } else if (checkId === "reviewer-advisor-artifact-captured") {
    const reviewSchema = harnessRel("schemas/review-decision.schema.json", kitRepo);
    const subagentStop = scriptRel("subagent-stop.sh", kitRepo);
    const advisor = kitRepo
      ? (runtime === "codex" ? "src/core/rendering/codex-surfaces.mjs" : runtime === "kiro" ? "src/core/rendering/kiro-surfaces.mjs" : "src/templates/.claude/agents/advisor.md.hbs")
      : (runtime === "codex" ? ".codex/agents/advisor.toml" : runtime === "kiro" ? ".kiro/agents/advisor.json" : ".claude/agents/advisor.md");
    inspected.push(reviewSchema, subagentStop, advisor);
    addPath(reviewSchema);
    addPath(subagentStop);
    addPath(advisor);
  } else if (checkId === "telemetry-recorded") {
    const telemetry = scriptRel("telemetry-on-skill.sh", kitRepo);
    const state = scriptRel("harness-state.mjs", kitRepo);
    inspected.push(telemetry, state, rel(hookPath(runtime, kitRepo)));
    addPath(telemetry);
    addPath(state);
    if (!hookCommandHas(runtime, kitRepo, runtimeEvent(runtime, "PostToolUse"), "telemetry-on-skill")) failures.push(`${runtime} PostToolUse telemetry hook is not wired`);
    if (!hookCommandHas(runtime, kitRepo, "SubagentStop", "subagent-stop")) failures.push(`${runtime} SubagentStop telemetry hook is not wired`);
  } else if (checkId === "orchestration-bounded-task") {
    const schema = harnessRel("schemas/orchestration-contract.schema.json", kitRepo);
    const checker = scriptRel("check-orchestration-contracts.mjs", kitRepo);
    const contractFromTask = scriptRel("orchestration-contract-from-task.mjs", kitRepo);
    const skill = kitRepo ? "src/templates/.claude/skills/orchestrate/SKILL.md" : skillRootRel(runtime, kitRepo) + "/orchestrate/SKILL.md";
    inspected.push(schema, checker, contractFromTask, skill);
    addPath(schema);
    addPath(checker);
    addPath(contractFromTask);
    addPath(skill);
  }

  return {
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    inspected: [...new Set(inspected)],
  };
}

function verifyEvidence(kitRepo) {
  return CHECKS.flatMap((check) => check.evidence.map((item) => {
    if (!kitRepo) {
      return {
        check: check.id,
        path: item.path,
        contains: item.contains,
        status: "upstream",
      };
    }
    const abs = resolve(ROOT, item.path);
    const text = readText(abs);
    if (text === null) {
      return {
        check: check.id,
        path: item.path,
        contains: item.contains,
        status: "missing",
        detail: "evidence file is missing",
      };
    }
    if (item.contains && !text.includes(item.contains)) {
      return {
        check: check.id,
        path: item.path,
        contains: item.contains,
        status: "missing",
        detail: "evidence marker was not found",
      };
    }
    return {
      check: check.id,
      path: item.path,
      contains: item.contains,
      status: "verified",
    };
  }));
}

function evaluateRuntime(runtime, kitRepo, evidenceByCheck) {
  const checks = CHECKS.map((check) => {
    const local = evaluateLocalCheck(check.id, runtime, kitRepo);
    const evidence = evidenceByCheck.get(check.id) || [];
    const evidenceMissing = evidence.filter((item) => item.status === "missing");
    const failures = [
      ...local.failures,
      ...evidenceMissing.map((item) => `${item.path}: ${item.detail}`),
    ];
    return {
      id: check.id,
      title: check.title,
      required: true,
      status: failures.length === 0 ? "pass" : "fail",
      inspected: local.inspected,
      evidence,
      failures,
    };
  });
  const failed = checks.filter((check) => check.status === "fail");
  return {
    runtime,
    status: failed.length === 0 ? "pass" : "fail",
    passed: checks.length - failed.length,
    failed: failed.length,
    checks,
  };
}

function renderText(payload) {
  console.log("runtime conformance report");
  console.log(`status: ${payload.status}`);
  console.log(`mode: ${payload.mode}`);
  console.log(`runtimes: ${payload.runtimeTargets.join(", ")}`);
  console.log("");
  for (const runtime of payload.runtimes) {
    console.log(`${runtime.runtime}: ${runtime.status} (${runtime.passed}/${runtime.checks.length})`);
    for (const check of runtime.checks) {
      console.log(`- ${check.id}: ${check.status}`);
      for (const failure of check.failures) console.log(`  error: ${failure}`);
    }
    console.log("");
  }
  for (const warning of payload.warnings) console.log(`warning: ${warning}`);
  for (const error of payload.errors) console.log(`error: ${error}`);
}

const config = readConfig();
const kitRepo = existsSync(resolve(ROOT, "src/templates/.claude/skills")) && existsSync(resolve(ROOT, "tests"));
const runtimeTargets = inferRuntimeTargets(config, kitRepo);
const unknownRuntimes = runtimeTargets.filter((runtime) => !SUPPORTED_RUNTIMES.has(runtime));
const evidence = verifyEvidence(kitRepo);
const evidenceByCheck = new Map();
for (const item of evidence) {
  const list = evidenceByCheck.get(item.check) || [];
  list.push(item);
  evidenceByCheck.set(item.check, list);
}
const runtimes = runtimeTargets
  .filter((runtime) => SUPPORTED_RUNTIMES.has(runtime))
  .map((runtime) => evaluateRuntime(runtime, kitRepo, evidenceByCheck));
const failedChecks = runtimes.flatMap((runtime) =>
  runtime.checks
    .filter((check) => check.status === "fail")
    .map((check) => `${runtime.runtime}:${check.id}`),
);
const errors = [
  ...unknownRuntimes.map((runtime) => `unsupported runtime target "${runtime}"`),
  ...failedChecks,
];
const warnings = [];
if (!kitRepo) warnings.push("test evidence is upstream kit release evidence; installed projects are checked for local runtime surfaces");

const payload = {
  schemaVersion: 1,
  status: errors.length === 0 ? "passed" : "failed",
  mode: kitRepo ? "kit-source" : "installed",
  generatedAt: new Date().toISOString(),
  runtimeTargets,
  checks: CHECKS.map((check) => ({ id: check.id, title: check.title, required: true })),
  runtimes,
  evidence: {
    mode: kitRepo ? "verified-local-tests" : "upstream-kit-tests",
    total: evidence.length,
    verified: evidence.filter((item) => item.status === "verified").length,
    upstream: evidence.filter((item) => item.status === "upstream").length,
    missing: evidence.filter((item) => item.status === "missing"),
  },
  errors,
  warnings,
};

if (opts.json) console.log(JSON.stringify(payload, null, 2));
else renderText(payload);

process.exit(payload.status === "failed" ? 1 : 0);

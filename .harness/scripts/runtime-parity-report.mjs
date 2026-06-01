#!/usr/bin/env node
// runtime-parity-report.mjs - publish measured Claude/Codex capability parity.
//
// The report is intentionally evidence-gated: every advertised runtime
// capability must link to at least one test or verifier in the kit repo. In
// generated installs, those release-test paths are reported as upstream
// evidence instead of being required on disk.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
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

const CAPABILITIES = [
  {
    id: "skill-rendering",
    title: "Skill rendering",
    category: "rendering",
    claude: "pass",
    codex: "pass",
    notes: "Claude skills render from canonical templates; Codex mirrors render under .agents/skills with rewritten paths.",
    evidence: [
      { path: "tests/skill-renderer.test.mjs", contains: "renderSkill generates Codex format from contract" },
      { path: "tests/render-templates.test.mjs", contains: "renderAll codex-only writes AGENTS.md and shared harness files without .claude surface" },
    ],
  },
  {
    id: "hook-availability",
    title: "Hook availability",
    category: "hooks",
    claude: "pass",
    codex: "pass",
    notes: "Both runtimes ship all nine hook groups with root-aware commands.",
    evidence: [
      { path: "tests/codex-synthetic.test.mjs", contains: "Codex hooks.json has all 9 events with AHK_RUNTIME=codex" },
      { path: "tests/hook-integrity-check.test.mjs", contains: "hook integrity validates Codex hook runtime markers" },
    ],
  },
  {
    id: "hook-fire-tests",
    title: "Hook fire tests",
    category: "hooks",
    claude: "pass",
    codex: "partial",
    notes: "Claude has a real hook-fire E2E. Codex has real surface smoke, synthetic hook validation, and an opt-in native hook probe with diagnostics; blocking native Codex hook-fire conformance remains experimental.",
    promotionCriteria: [
      "A real generated Codex workspace records SessionStart and SessionEnd hook artifacts during codex exec.",
      "The Codex E2E hook probe passes with AHK_E2E_CODEX_REQUIRE_HOOKS=1 in release CI.",
      "Hook diagnostics include no missing lifecycle artifact rows for the generated Codex surface.",
    ],
    nextSteps: [
      "Run npm run check:codex-parity-probes -- --hooks in the kit repo against the supported Codex CLI/App version.",
      "Promote the native lifecycle artifact probe from warning-only to required once supported Codex versions produce hook artifacts consistently.",
    ],
    evidence: [
      { path: "tests/e2e-claude-cli.test.mjs", contains: "real claude -p session fires kit hooks" },
      { path: "tests/e2e-codex-cli.test.mjs", contains: "codex exec hook diagnostics captured" },
      { path: "tests/e2e-codex-cli.test.mjs", contains: "codex exec native hook probe completed" },
      { path: "tests/codex-synthetic.test.mjs", contains: "Codex hook-integrity check passes for default install" },
    ],
  },
  {
    id: "mutation-guard-coverage",
    title: "Mutation guard coverage",
    category: "guards",
    claude: "pass",
    codex: "pass",
    notes: "Skill permission guard and active-task mutation gates cover runtime mutation tools.",
    evidence: [
      { path: "tests/skill-permission-guard.test.mjs", contains: "source and config mutations require an active task contract when configured" },
      { path: "tests/skill-permission-guard.test.mjs", contains: "Codex Bash read commands use Read/Grep/Glob/LS task permissions" },
    ],
  },
  {
    id: "apply-patch-protected-path",
    title: "apply_patch protected path coverage",
    category: "guards",
    claude: "n/a",
    codex: "pass",
    notes: "Codex apply_patch is matched as a mutating tool and participates in protected-path and active-task gates.",
    evidence: [
      { path: "tests/codex-synthetic.test.mjs", contains: "Codex hook matchers include apply_patch as a mutation tool" },
      { path: "tests/v9-hook-expansion.test.mjs", contains: "pretooluse-edit-guard denies apply_patch moves into .claude" },
      { path: "tests/skill-permission-guard.test.mjs", contains: "apply_patch mutations participate in the active task mutation gate" },
    ],
  },
  {
    id: "evidence-gate",
    title: "Evidence gate",
    category: "gates",
    claude: "pass",
    codex: "pass",
    notes: "Task evidence validation is runtime-agnostic and Stop-hook enforcement is shared.",
    evidence: [
      { path: "tests/task-evidence-check.test.mjs", contains: "blocks a current-diff passes=true claim without task/evidence proof" },
      { path: "tests/precompletion-active-task-evidence.test.mjs", contains: "Stop hook blocks verbal done claims for the active task without evidence" },
    ],
  },
  {
    id: "advisor-gate",
    title: "Advisor gate",
    category: "gates",
    claude: "pass",
    codex: "pass",
    notes: "Advisor protocol is enforced through shared evidence/review artifacts; Codex renders advisor TOML with the same mandatory protocol.",
    evidence: [
      { path: "tests/precompletion-active-task-evidence.test.mjs", contains: "Advisor is mandatory for active-task completion even when task evidence is valid" },
      { path: "tests/codex-synthetic.test.mjs", contains: "Codex TOML agents render correctly" },
    ],
  },
  {
    id: "task-contract-routing",
    title: "Task contract routing",
    category: "contracts",
    claude: "pass",
    codex: "pass",
    notes: "Task contract lookup, permissions, scope, and Codex tool aliases share the same checker.",
    evidence: [
      { path: "tests/skill-permission-guard.test.mjs", contains: "task contract permissions can use active task state from SessionStart" },
      { path: "tests/task-evidence-check.test.mjs", contains: "task contract permissions accept Codex apply_patch tool id" },
    ],
  },
  {
    id: "transcript-parser",
    title: "Transcript parser",
    category: "observability",
    claude: "pass",
    codex: "pass",
    notes: "Claude stream-json and Codex exec JSONL are parsed into replay/transcript artifacts.",
    evidence: [
      { path: "tests/e2e-claude-cli.test.mjs", contains: "real claude -p session fires kit hooks" },
      { path: "tests/orchestrate-runtime.test.mjs", contains: "orchestrate runtime supports codex-cli transport" },
      { path: "tests/orchestrate-runtime.test.mjs", contains: "orchestrate validation rejects corrupt transcript JSONL" },
    ],
  },
  {
    id: "telemetry",
    title: "Telemetry",
    category: "observability",
    claude: "pass",
    codex: "pass",
    notes: "Shared telemetry schema records skill/provider events; Codex orchestration emits provider=codex rows.",
    evidence: [
      { path: "tests/telemetry-hook.test.mjs", contains: "telemetry records Skill invocations as JSONL" },
      { path: "tests/orchestrate-runtime.test.mjs", contains: "assert.match(telemetry, /\"provider\":\"codex\"/);" },
    ],
  },
  {
    id: "orchestration-run-support",
    title: "Orchestration run support",
    category: "orchestration",
    claude: "pass",
    codex: "pass",
    notes: "Orchestrate supports mock/Claude-compatible runs and codex-cli transport from rendered Codex skills.",
    evidence: [
      { path: "tests/orchestrate-runtime.test.mjs", contains: "orchestrate runtime writes manifest, transcripts, and cost summary" },
      { path: "tests/orchestrate-runtime.test.mjs", contains: "rendered Codex orchestrate skill runs from .agents without .claude" },
    ],
  },
  {
    id: "reviewer-artifact-capture",
    title: "Subagent/reviewer artifact capture",
    category: "reviews",
    claude: "pass",
    codex: "partial",
    notes: "Reviewer decision artifacts are shared. Codex TOML reviewers render and the real Codex E2E probes reviewer artifact creation; native subagent-stop capture remains experimental.",
    promotionCriteria: [
      "A real Codex reviewer/subagent run creates a schema-valid advisor or reviewer decision artifact without manual fallback.",
      "The Codex E2E reviewer artifact probe passes with AHK_E2E_CODEX_REQUIRE_REVIEWER_ARTIFACT=1 in release CI.",
      "SubagentStop telemetry or equivalent reviewer capture is present for generated Codex installs.",
    ],
    nextSteps: [
      "Run npm run check:codex-parity-probes -- --reviewer in the kit repo against the supported Codex CLI/App version.",
      "Promote reviewer artifact capture to required once native Codex agent artifact behavior is stable.",
    ],
    evidence: [
      { path: "tests/review-agent-contracts.test.mjs", contains: "review agents produce schema-compatible evidence decision guidance" },
      { path: "tests/task-evidence-check.test.mjs", contains: "validates JSON reviewer artifacts and required gates" },
      { path: "tests/e2e-codex-cli.test.mjs", contains: "codex exec reviewer artifact probe completed" },
      { path: "tests/codex-synthetic.test.mjs", contains: "Codex TOML agents render correctly" },
    ],
  },
];

// Kiro is the third, experimental runtime. Statuses are honest: guard-based
// enforcement, skill rendering, evidence/task gates, and hook validation are
// real; lifecycle parity (only 5 of 9 triggers, advisory-only Stop), transcript
// parsing, telemetry, and orchestration transport are not yet at Claude depth.
const KIRO_STATUS = {
  "skill-rendering": "pass",
  "hook-availability": "partial",
  "hook-fire-tests": "partial",
  "mutation-guard-coverage": "pass",
  "evidence-gate": "pass",
  "advisor-gate": "partial",
  "task-contract-routing": "pass",
  "transcript-parser": "partial",
  "telemetry": "partial",
  "orchestration-run-support": "pass",
  "reviewer-artifact-capture": "partial",
};
const KIRO_EVIDENCE = {
  "skill-rendering": { path: "tests/render-templates.test.mjs", contains: "renderAll kiro-only writes .kiro steering, skills, and agents without .claude/.codex surface" },
  "mutation-guard-coverage": { path: "tests/skill-permission-guard.test.mjs", contains: "Kiro write tool is normalized to Write and denied by the active skill matrix" },
  "task-contract-routing": { path: "tests/skill-permission-guard.test.mjs", contains: "Kiro shell tool maps to Bash and honors the skill allow list" },
  "hook-availability": { path: "tests/hook-integrity-check.test.mjs", contains: "hook integrity passes for a kiro install and validates the agent-config hook block" },
  "orchestration-run-support": { path: "tests/orchestrate-runtime.test.mjs", contains: "orchestrate runtime supports kiro-cli transport" },
};
for (const cap of CAPABILITIES) {
  cap.kiro = KIRO_STATUS[cap.id] || "n/a";
  const evidence = KIRO_EVIDENCE[cap.id];
  if (evidence) cap.evidence = [...(cap.evidence || []), evidence];
}

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), json: false, strict: false, failPartial: false };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg === "--fail-partial") opts.failPartial = true;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
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

function readConfig() {
  return readJson(resolve(ROOT, ".harness/config.json")) || readJson(resolve(ROOT, "harness.config.json")) || {};
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

function hookEvents(path) {
  const hooks = readJson(path);
  return Object.keys(hooks?.hooks || {}).sort();
}

function missingItems(expected, actual) {
  return expected.filter((item) => !actual.includes(item));
}

function supportWeight(status) {
  if (status === "pass") return 1;
  if (status === "partial") return 0.5;
  return 0;
}

function scoreFor(runtime) {
  let possible = 0;
  let score = 0;
  const counts = { pass: 0, partial: 0, fail: 0, na: 0 };
  for (const cap of CAPABILITIES) {
    const status = cap[runtime];
    if (status === "n/a") {
      counts.na += 1;
      continue;
    }
    counts[status] += 1;
    possible += 1;
    score += supportWeight(status);
  }
  return { score, possible, percent: possible === 0 ? 0 : Math.round((score / possible) * 100), counts };
}

function partialCapabilities() {
  return CAPABILITIES.flatMap((cap) => ["claude", "codex", "kiro"]
    .filter((runtime) => cap[runtime] === "partial")
    .map((runtime) => ({
      id: cap.id,
      runtime,
      status: cap[runtime],
      notes: cap.notes,
      promotionCriteria: cap.promotionCriteria || [],
      nextSteps: cap.nextSteps || [],
    })));
}

function verifyEvidence({ kitRepo }) {
  return CAPABILITIES.flatMap((capability) => {
    if (!Array.isArray(capability.evidence) || capability.evidence.length === 0) {
      return [{
        capability: capability.id,
        status: "missing",
        detail: "capability has no evidence references",
      }];
    }
    return capability.evidence.map((item) => {
      if (!kitRepo) {
        return {
          capability: capability.id,
          path: item.path,
          contains: item.contains,
          status: "upstream",
        };
      }
      const abs = resolve(ROOT, item.path);
      const text = readText(abs);
      if (text === null) {
        return {
          capability: capability.id,
          path: item.path,
          contains: item.contains,
          status: "missing",
          detail: "evidence file is missing",
        };
      }
      if (item.contains && !text.includes(item.contains)) {
        return {
          capability: capability.id,
          path: item.path,
          contains: item.contains,
          status: "missing",
          detail: "evidence marker was not found",
        };
      }
      return {
        capability: capability.id,
        path: item.path,
        contains: item.contains,
        status: "verified",
      };
    });
  });
}

function sourceSurfaceChecks() {
  const claudeSkills = resolve(ROOT, "src/templates/.claude/skills");
  const claudeHooks = resolve(ROOT, "src/templates/.claude/hooks/hooks.json");
  const codexHooks = resolve(ROOT, "src/templates/.codex/hooks.json");
  const codexRenderer = resolve(ROOT, "src/templates/.harness/skill-renderers/SKILL.md.codex.hbs");
  const claudeEvents = hookEvents(claudeHooks);
  const codexEvents = hookEvents(codexHooks);
  const codexHooksText = readText(codexHooks) || "";
  return {
    mode: "source",
    skills: {
      templateSkills: listDirs(claudeSkills).length,
      contractSkills: countSkillContracts(claudeSkills),
      codexRenderer: existsSync(codexRenderer),
    },
    hooks: {
      claudeEvents,
      codexEvents,
      missingClaudeEvents: missingItems(EXPECTED_HOOK_EVENTS, claudeEvents),
      missingCodexEvents: missingItems(EXPECTED_HOOK_EVENTS, codexEvents),
      codexRuntimeMarker: codexHooksText.includes("AHK_RUNTIME=codex"),
      codexProjectDir: codexHooksText.includes("CODEX_PROJECT_DIR"),
      codexApplyPatchMatcher: codexHooksText.includes("apply_patch"),
    },
  };
}

function installedSurfaceChecks(config) {
  const runtimeTargets = Array.isArray(config.agentRuntime?.targets) ? config.agentRuntime.targets : [];
  const hookIntegrity = analyzeHookIntegrity({ cwd: ROOT });
  return {
    mode: "installed",
    runtimeTargets,
    skills: {
      claudeSkills: listDirs(resolve(ROOT, ".claude/skills")).length,
      codexSkills: listDirs(resolve(ROOT, ".agents/skills")).length,
    },
    hooks: hookIntegrity,
  };
}

function collectDynamicFailures(surface) {
  const failures = [];
  if (surface.mode === "source") {
    if (surface.skills.templateSkills === 0) failures.push("source templates have no Claude skills");
    if (surface.skills.contractSkills !== surface.skills.templateSkills) {
      failures.push(`skill contracts missing: ${surface.skills.contractSkills}/${surface.skills.templateSkills}`);
    }
    if (!surface.skills.codexRenderer) failures.push("Codex skill renderer template is missing");
    if (surface.hooks.missingClaudeEvents.length > 0) {
      failures.push(`Claude template hooks missing: ${surface.hooks.missingClaudeEvents.join(", ")}`);
    }
    if (surface.hooks.missingCodexEvents.length > 0) {
      failures.push(`Codex template hooks missing: ${surface.hooks.missingCodexEvents.join(", ")}`);
    }
    if (!surface.hooks.codexRuntimeMarker) failures.push("Codex hooks do not set AHK_RUNTIME=codex");
    if (!surface.hooks.codexProjectDir) failures.push("Codex hooks do not reference CODEX_PROJECT_DIR");
    if (!surface.hooks.codexApplyPatchMatcher) failures.push("Codex hooks do not match apply_patch");
  } else if (surface.mode === "installed") {
    if (surface.hooks.status === "fail") failures.push(...surface.hooks.errors);
  }
  return failures;
}

function renderText(payload) {
  console.log("runtime parity report");
  console.log(`status: ${payload.status}`);
  console.log(`mode: ${payload.mode}`);
  console.log(`claude: ${payload.scores.claude.score}/${payload.scores.claude.possible} (${payload.scores.claude.percent}%)`);
  console.log(`codex: ${payload.scores.codex.score}/${payload.scores.codex.possible} (${payload.scores.codex.percent}%)`);
  console.log(`kiro: ${payload.scores.kiro.score}/${payload.scores.kiro.possible} (${payload.scores.kiro.percent}%)`);
  console.log("");
  for (const cap of payload.capabilities) {
    console.log(`- ${cap.id}: claude=${cap.claude} codex=${cap.codex} kiro=${cap.kiro}`);
    if (cap.codex === "partial" || cap.claude === "partial" || cap.kiro === "partial") console.log(`  note: ${cap.notes}`);
  }
  if (payload.experimental.length > 0) {
    console.log("");
    console.log("experimental / partial:");
    for (const cap of payload.experimental) {
      console.log(`- ${cap.id} (${cap.runtime}): ${cap.notes}`);
      for (const criterion of cap.promotionCriteria || []) console.log(`  promote: ${criterion}`);
      for (const step of cap.nextSteps || []) console.log(`  next: ${step}`);
    }
  }
  if (payload.errors.length > 0) {
    console.log("");
    for (const error of payload.errors) console.log(`error: ${error}`);
  }
  if (payload.warnings.length > 0) {
    console.log("");
    for (const warning of payload.warnings) console.log(`warning: ${warning}`);
  }
}

const config = readConfig();
const kitRepo = existsSync(resolve(ROOT, "src/templates/.claude/skills")) && existsSync(resolve(ROOT, "tests"));
const mode = kitRepo ? "kit-source" : "installed";
const evidence = verifyEvidence({ kitRepo });
const evidenceFailures = evidence.filter((item) => item.status === "missing");
const surface = kitRepo ? sourceSurfaceChecks() : installedSurfaceChecks(config);
const dynamicFailures = collectDynamicFailures(surface);
const partial = partialCapabilities();
const warnings = partial.map((cap) => `${cap.id}:${cap.runtime}: ${cap.notes}`);
if (!kitRepo) warnings.push("release-test evidence paths are upstream kit evidence and are not expected inside generated installs");
const errors = [
  ...evidenceFailures.map((item) => `${item.capability}: ${item.path || "(none)"} ${item.detail || "missing evidence"}`),
  ...dynamicFailures,
  ...(opts.failPartial ? partial.map((cap) => `${cap.id}:${cap.runtime}: partial runtime capability is not allowed with --fail-partial`) : []),
];

const capabilities = CAPABILITIES.map((cap) => ({
  id: cap.id,
  title: cap.title,
  category: cap.category,
  claude: cap.claude,
  codex: cap.codex,
  kiro: cap.kiro,
  notes: cap.notes,
  promotionCriteria: cap.promotionCriteria || [],
  nextSteps: cap.nextSteps || [],
  evidence: evidence.filter((item) => item.capability === cap.id),
}));

const payload = {
  schemaVersion: 1,
  status: errors.length === 0 ? "passed" : "failed",
  mode,
  generatedAt: new Date().toISOString(),
  scores: {
    claude: scoreFor("claude"),
    codex: scoreFor("codex"),
    kiro: scoreFor("kiro"),
  },
  capabilities,
  experimental: partial,
  evidence: {
    mode: kitRepo ? "verified-local-tests" : "upstream-kit-tests",
    total: evidence.length,
    verified: evidence.filter((item) => item.status === "verified").length,
    upstream: evidence.filter((item) => item.status === "upstream").length,
    missing: evidenceFailures,
  },
  surface,
  errors,
  warnings,
};

if (opts.json) console.log(JSON.stringify(payload, null, 2));
else renderText(payload);

process.exit(payload.status === "failed" ? 1 : 0);

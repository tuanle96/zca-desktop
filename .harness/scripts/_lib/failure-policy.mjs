import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const FAILURE_CLASSES = new Set([
  "context-miss",
  "false-done",
  "architecture-drift",
  "test-gap",
  "doc-drift",
  "tool-misuse",
  "permission-gap",
  "runtime-gap",
  "eval-gap",
  "cost-spike",
  "model-behavior",
]);

export const DEFAULT_PREVENTION_TARGET = Object.freeze({
  "context-miss": "docs",
  "false-done": "script",
  "architecture-drift": "structural-rule",
  "test-gap": "eval-task",
  "doc-drift": "script",
  "tool-misuse": "skill",
  "permission-gap": "permission-policy",
  "runtime-gap": "hook",
  "eval-gap": "eval-task",
  "cost-spike": "skill",
  "model-behavior": "subagent",
});

export const FAILURE_SOURCES = new Set(["eval", "hook", "review", "user-report", "session-trace", "ci", "runtime"]);

export const PREVENTION_TARGETS = new Set([
  "docs",
  "skill",
  "hook",
  "subagent",
  "script",
  "structural-rule",
  "eval-task",
  "permission-policy",
  "project-code",
]);

export const PROMOTION_STATUSES = new Set(["proposed", "applied", "verified", "rejected"]);

function hasClass(available, id) {
  if (!available) return FAILURE_CLASSES.has(id);
  if (typeof available.has === "function") return available.has(id);
  return new Set(available).has(id);
}

function firstClass(available) {
  if (!available) return "model-behavior";
  if (typeof available.keys === "function") return [...available.keys()][0];
  if (typeof available[Symbol.iterator] === "function") return [...available][0];
  return "model-behavior";
}

function classIfAvailable(available, id) {
  return hasClass(available, id) ? id : null;
}

export function failureClassFromText(text, available = FAILURE_CLASSES, { fallback = "model-behavior" } = {}) {
  const normalized = String(text || "").toLowerCase();
  for (const id of FAILURE_CLASSES) {
    const pattern = id.replace("-", "[- ]");
    if (new RegExp(`(^|[^a-z0-9])${pattern}([^a-z0-9]|$)`).test(normalized)) {
      const found = classIfAvailable(available, id);
      if (found) return found;
    }
  }
  if (/\b(permission|allow|deny|tool policy|blast radius)\b/.test(normalized)) {
    const found = classIfAvailable(available, "permission-gap");
    if (found) return found;
  }
  if (/\b(eval|rubric|oracle)\b|\bacceptance (check|criterion|command|artifact|oracle)\b/.test(normalized)) {
    const found = classIfAvailable(available, "eval-gap");
    if (found) return found;
  }
  if (/\b(test|coverage|verification|proof)\b/.test(normalized)) {
    const found = classIfAvailable(available, "test-gap");
    if (found) return found;
  }
  if (/\b(doc|readme|claim|registry|template drift|drift)\b/.test(normalized)) {
    const found = classIfAvailable(available, "doc-drift");
    if (found) return found;
  }
  if (/\b(layer|boundary|architecture|import|provider|api)\b/.test(normalized)) {
    const found = classIfAvailable(available, "architecture-drift");
    if (found) return found;
  }
  if (/\b(runtime|hook|adapter|claude|codex)\b/.test(normalized)) {
    const found = classIfAvailable(available, "runtime-gap");
    if (found) return found;
  }
  if (/\b(context|wrong file|wrong module)\b/.test(normalized)) {
    const found = classIfAvailable(available, "context-miss");
    if (found) return found;
  }
  if (/\b(done|evidence|passes=true)\b/.test(normalized)) {
    const found = classIfAvailable(available, "false-done");
    if (found) return found;
  }
  if (/\b(cost|token|latency|budget)\b/.test(normalized)) {
    const found = classIfAvailable(available, "cost-spike");
    if (found) return found;
  }
  if (fallback === null) return null;
  if (fallback && hasClass(available, fallback)) return fallback;
  return firstClass(available);
}

export function failureClassFromSignal(signal, available = FAILURE_CLASSES, options = {}) {
  const event = signal?.event;
  if (event === "structural_test_fail") return classIfAvailable(available, "architecture-drift") || failureClassFromText("", available, options);
  if (event === "precompletion_block") return classIfAvailable(available, "false-done") || failureClassFromText("", available, options);
  if (event === "permission_denied") return classIfAvailable(available, "permission-gap") || failureClassFromText("", available, options);
  if (event === "userprompt_block") return classIfAvailable(available, "context-miss") || failureClassFromText("", available, options);
  if (event === "bypass") return classIfAvailable(available, "tool-misuse") || failureClassFromText("", available, options);
  return failureClassFromText([signal?.event, signal?.source, signal?.detail].filter(Boolean).join(" "), available, options);
}

export function hasUrlScheme(value) {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(value || ""));
}

export function insideRoot(root, path) {
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  return path === root || path.startsWith(normalizedRoot);
}

export function normalizedProjectPath(root, value) {
  const text = String(value || "").trim();
  if (!text || hasUrlScheme(text)) return "";
  const file = resolve(root, text);
  return insideRoot(root, file) ? file.slice(root.length + 1).replaceAll("\\", "/").replace(/^\.\//, "") : "";
}

export const PREVENTION_TARGET_PATH_PATTERNS = {
  docs: [
    /^README\.md$/,
    /^AGENTS\.md$/,
    /^CLAUDE\.md$/,
    /^docs\//,
    /^\.harness\/docs\//,
    /^src\/templates\/docs\//,
    /^src\/templates\/(?:AGENTS|CLAUDE)\.md/,
  ],
  skill: [
    /^\.claude\/skills\//,
    /^\.agents\/skills\//,
    /^src\/templates\/\.claude\/skills\//,
    /^src\/templates\/\.agents\/skills\//,
  ],
  hook: [
    /^\.claude\/hooks\//,
    /^\.codex\/hooks\.json$/,
    /^\.harness\/scripts\/(?:pre|post|session-|subagent-|userprompt-|notify-)/,
    /^src\/templates\/\.claude\/hooks\//,
    /^src\/templates\/\.codex\/hooks\.json$/,
    /^src\/templates\/scripts\/(?:pre|post|session-|subagent-|userprompt-|notify-)/,
  ],
  subagent: [
    /^\.claude\/agents\//,
    /^\.codex\/agents\//,
    /^src\/templates\/\.claude\/agents\//,
    /^src\/templates\/\.codex\/agents\//,
  ],
  script: [
    /^scripts\//,
    /^\.harness\/scripts\//,
    /^src\/templates\/scripts\//,
  ],
  "structural-rule": [
    /^\.harness\/runners\//,
    /^\.harness\/fitness\/rules\//,
    /^src\/templates\/_adapter-[^/]+\/harness\//,
    /^src\/templates\/\.harness\/fitness\/rules\//,
    /^src\/templates\/scripts\/check-architecture-fitness\.mjs$/,
    /^schema\/harness-spec\.yaml$/,
    /^src\/templates\/harness\.config\.json\.hbs$/,
  ],
  "eval-task": [
    /^\.harness\/eval\/tasks\//,
    /^\.harness\/regression\/tasks\//,
    /^src\/templates\/\.harness\/eval\/tasks\//,
    /^src\/templates\/\.harness\/regression\/tasks\//,
  ],
  "permission-policy": [
    /^\.harness\/permissions\.json$/,
    /^\.harness\/task-contracts\//,
    /^\.harness\/scripts\/pretooluse-skill-permission-guard\.mjs$/,
    /^src\/templates\/\.harness\/permissions\.json$/,
    /^src\/templates\/\.harness\/task-contracts\//,
    /^src\/templates\/scripts\/pretooluse-skill-permission-guard\.mjs$/,
    /^scripts\/pretooluse-skill-permission-guard\.mjs$/,
  ],
};

export function preventionTargetPathAllowed(root, target, path) {
  const file = normalizedProjectPath(root, path);
  if (!file) return false;
  if (target === "project-code") {
    return !file.startsWith(".harness/failures/records/")
      && !file.startsWith("src/templates/.harness/failures/records/");
  }
  return (PREVENTION_TARGET_PATH_PATTERNS[target] || []).some((re) => re.test(file));
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "") || "failure-prevention";
}

function existingFirst(root, candidates, fallback) {
  for (const candidate of candidates) {
    if (existsSync(resolve(root, candidate))) return candidate;
  }
  return fallback;
}

export function preventionTemplateFor({ root = process.cwd(), recordId, primaryClass, preventionTarget, symptom } = {}) {
  const id = slugify(recordId || `${primaryClass || "failure"}-${symptom || "prevention"}`);
  const target = PREVENTION_TARGETS.has(preventionTarget) ? preventionTarget : DEFAULT_PREVENTION_TARGET[primaryClass] || "script";
  const summaryTail = symptom ? `: ${String(symptom).trim()}` : ".";
  const common = {
    target,
    summary: `Add durable ${target} prevention for ${primaryClass || "agent failure"}${summaryTail}`,
    verificationCommand: "node .harness/scripts/check-failure-records.mjs",
  };

  if (target === "docs") {
    return { ...common, path: `.harness/docs/failures/${id}.md` };
  }
  if (target === "skill") {
    const base = existingFirst(root, [".agents/skills", ".claude/skills"], ".claude/skills");
    return {
      ...common,
      path: `${base}/${id}/SKILL.md`,
      verificationCommand: "node .harness/scripts/check-skill-contracts.mjs",
    };
  }
  if (target === "hook") {
    return {
      ...common,
      path: `.harness/scripts/pretooluse-${id}.mjs`,
      verificationCommand: "node .harness/scripts/check-hook-integrity.mjs",
    };
  }
  if (target === "subagent") {
    const base = existingFirst(root, [".claude/agents", ".codex/agents"], ".claude/agents");
    return {
      ...common,
      path: `${base}/${id}.md`,
      summary: `Update reviewer/subagent prevention for ${primaryClass || "agent failure"}${summaryTail}`,
      verificationCommand: "node .harness/scripts/check-review-coverage.mjs --strict",
    };
  }
  if (target === "script") {
    return { ...common, path: `.harness/scripts/${id}.mjs` };
  }
  if (target === "structural-rule") {
    return {
      ...common,
      path: `.harness/fitness/rules/${id}.json`,
      verificationCommand: "node .harness/scripts/check-architecture-fitness.mjs --strict",
    };
  }
  if (target === "eval-task") {
    return {
      ...common,
      path: `.harness/eval/tasks/${id}.json`,
      verificationCommand: "node .harness/scripts/check-eval-tasks.mjs",
    };
  }
  if (target === "permission-policy") {
    return {
      ...common,
      path: ".harness/permissions.json",
      verificationCommand: "node .harness/scripts/check-permissions-drift.mjs",
    };
  }
  return {
    ...common,
    path: `src/${id}.prevention.md`,
  };
}

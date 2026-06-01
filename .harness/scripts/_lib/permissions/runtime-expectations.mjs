import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const COMMON_HOOKS = [
  {
    event: "SessionStart",
    matcher: "startup|resume|compact",
    script: ".harness/scripts/session-start.sh",
    category: "session",
  },
  {
    event: "UserPromptSubmit",
    matcher: "",
    script: ".harness/scripts/userprompt-guard.sh",
    category: "prompt",
  },
  {
    event: "PreToolUse",
    matcher: "",
    script: ".harness/scripts/pretooluse-skill-permission-guard.mjs",
    category: "permission-policy",
  },
  {
    event: "PreToolUse",
    matcher: "Bash",
    script: ".harness/scripts/pretooluse-bash-guard.sh",
    category: "bash-safety",
  },
  {
    event: "Notification",
    matcher: "",
    script: ".harness/scripts/notify-on-block.sh",
    category: "notification",
    optional: true,
  },
  {
    event: "PostToolUse",
    matcher: "Skill",
    script: ".harness/scripts/telemetry-on-skill.sh",
    category: "telemetry",
  },
  {
    event: "PreCompact",
    matcher: "",
    script: ".harness/scripts/pre-compact.sh",
    category: "context",
  },
  {
    event: "Stop",
    matcher: "",
    script: ".harness/scripts/precompletion-checklist.sh",
    category: "precompletion",
  },
  {
    event: "SubagentStop",
    matcher: "",
    script: ".harness/scripts/subagent-stop.sh",
    category: "review",
  },
  {
    event: "SessionEnd",
    matcher: "",
    script: ".harness/scripts/session-end.sh",
    category: "session",
  },
];

const RUNTIME_SPECIFIC_HOOKS = {
  claude: [
    {
      event: "PreToolUse",
      matcher: "Edit|Write|MultiEdit",
      script: ".harness/scripts/pretooluse-edit-guard.sh",
      category: "protected-paths",
    },
    {
      event: "PostToolUse",
      matcher: "Write|Edit|MultiEdit",
      script: ".harness/scripts/structural-test-on-edit.sh",
      category: "structural",
    },
  ],
  codex: [
    {
      event: "PreToolUse",
      matcher: "Edit|Write|MultiEdit|apply_patch",
      script: ".harness/scripts/pretooluse-edit-guard.sh",
      category: "protected-paths",
    },
    {
      event: "PostToolUse",
      matcher: "Write|Edit|MultiEdit|apply_patch",
      script: ".harness/scripts/structural-test-on-edit.sh",
      category: "structural",
    },
  ],
};

const RUNTIME_SURFACES = {
  claude: {
    hooksPath: ".claude/hooks/hooks.json",
    templateHooksPath: "src/templates/.claude/hooks/hooks.json",
    settingsPath: ".claude/settings.json",
    settingsMirror: true,
    policyPath: ".harness/permissions.json",
    compiledPolicyPath: ".harness/permissions.compiled.json",
  },
  codex: {
    hooksPath: ".codex/hooks.json",
    templateHooksPath: "src/templates/.codex/hooks.json",
    settingsPath: "",
    settingsMirror: false,
    policyPath: ".harness/permissions.json",
    compiledPolicyPath: ".harness/permissions.compiled.json",
  },
  kiro: {
    // Kiro hooks live inside the primary agent config, not a standalone file.
    hooksPath: ".kiro/agents/harness.json",
    templateHooksPath: ".kiro/agents/harness.json",
    settingsPath: "",
    settingsMirror: false,
    policyPath: ".harness/permissions.json",
    compiledPolicyPath: ".harness/permissions.compiled.json",
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hooksForRuntime(runtime) {
  // Kiro hooks live inside the agent config with a different shape and only 5
  // lifecycle events. Hook-surface validation for Kiro is intentionally a
  // no-op here; the runtime label still flows through for reporting.
  if (runtime === "kiro") return [];
  return [
    ...COMMON_HOOKS,
    ...(RUNTIME_SPECIFIC_HOOKS[runtime] || RUNTIME_SPECIFIC_HOOKS.claude),
  ].sort((left, right) => {
    if (left.event !== right.event) return left.event.localeCompare(right.event);
    return left.script.localeCompare(right.script);
  });
}

export function permissionRuntimeExpectations(runtime = "claude", { mode = "installed" } = {}) {
  const normalizedRuntime = RUNTIME_SURFACES[runtime] ? runtime : "claude";
  const surface = RUNTIME_SURFACES[normalizedRuntime];
  return {
    runtime: normalizedRuntime,
    hooksPath: mode === "template" ? surface.templateHooksPath : surface.hooksPath,
    installedHooksPath: surface.hooksPath,
    templateHooksPath: surface.templateHooksPath,
    settingsPath: surface.settingsPath,
    settingsMirror: surface.settingsMirror,
    policyPath: surface.policyPath,
    compiledPolicyPath: surface.compiledPolicyPath,
    hooks: clone(hooksForRuntime(normalizedRuntime)),
  };
}

export function hookIntegrityExpectations(runtime = "claude") {
  const grouped = new Map();
  for (const hook of hooksForRuntime(runtime)) {
    if (!grouped.has(hook.event)) {
      grouped.set(hook.event, {
        event: hook.event,
        scripts: [],
        optional: false,
      });
    }
    const item = grouped.get(hook.event);
    item.scripts.push(hook.script);
    item.optional = item.optional || hook.optional === true;
  }
  return [...grouped.values()].map((item) => ({
    ...item,
    scripts: item.scripts.sort(),
  }));
}

function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

function hookRegistrations(hooksJson, event) {
  const entries = hooksJson?.hooks?.[event];
  if (!Array.isArray(entries)) return [];
  const registrations = [];
  for (const entry of entries) {
    const matcher = typeof entry?.matcher === "string" ? entry.matcher : "";
    const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
    for (const hook of hooks) {
      if (hook?.type === "command" && typeof hook.command === "string") {
        registrations.push({ matcher, command: hook.command });
      }
    }
  }
  return registrations;
}

function matcherTokens(value) {
  return String(value || "")
    .split("|")
    .map((token) => token.trim())
    .filter(Boolean);
}

function matcherCovers(actual, expected) {
  const expectedTokens = matcherTokens(expected);
  if (expectedTokens.length === 0) return String(actual || "") === "";
  const actualTokens = new Set(matcherTokens(actual));
  return expectedTokens.every((token) => actualTokens.has(token));
}

function validateHookJson({ label, runtime, hooksJson, expectations }) {
  const errors = [];
  if (!hooksJson || typeof hooksJson !== "object" || !hooksJson.hooks || typeof hooksJson.hooks !== "object") {
    return [`${label}: missing top-level hooks object`];
  }
  for (const expected of expectations.hooks) {
    const registrations = hookRegistrations(hooksJson, expected.event);
    const registration = registrations.find((entry) => entry.command.includes(expected.script));
    const prefix = `${label}: ${runtime} ${expected.event} ${expected.script}`;
    if (!registration) {
      if (!expected.optional) errors.push(`${prefix} not registered`);
      continue;
    }
    if (!matcherCovers(registration.matcher, expected.matcher)) {
      errors.push(`${prefix} matcher "${registration.matcher}" must cover "${expected.matcher}"`);
    }
  }
  return errors;
}

export function validatePermissionRuntimeHooks({
  root,
  runtime = "claude",
  mode = "installed",
  enabled = false,
  requireHooks = false,
} = {}) {
  const expectations = permissionRuntimeExpectations(runtime, { mode });
  const warnings = [];
  const errors = [];
  const hooksPath = resolve(root, expectations.hooksPath);
  const hooksExists = existsSync(hooksPath);
  const shouldValidate = mode === "template" || enabled || requireHooks || hooksExists;

  if (!shouldValidate) {
    return {
      status: "skipped",
      expectations,
      errors,
      warnings,
    };
  }
  if (!enabled && mode !== "template" && hooksExists) {
    warnings.push(`${expectations.hooksPath} exists but ${runtime} hooks are not enabled in config`);
  }
  if (!hooksExists) {
    const message = `${expectations.hooksPath} is required for ${runtime} runtime expectations`;
    if (enabled || requireHooks || mode === "template") errors.push(message);
    else warnings.push(message);
    return {
      status: errors.length > 0 ? "failed" : "warning",
      expectations,
      errors,
      warnings,
    };
  }

  const parsed = readJson(hooksPath);
  if (parsed.error) errors.push(`${expectations.hooksPath}: invalid JSON (${parsed.error.message})`);
  else errors.push(...validateHookJson({
    label: expectations.hooksPath,
    runtime,
    hooksJson: parsed.value,
    expectations,
  }));

  if (expectations.settingsMirror && mode !== "template" && enabled) {
    const settingsPath = resolve(root, expectations.settingsPath);
    if (!existsSync(settingsPath)) {
      errors.push(`${expectations.settingsPath} is required because Claude Code reads hooks from settings.json`);
    } else {
      const settings = readJson(settingsPath);
      if (settings.error) errors.push(`${expectations.settingsPath}: invalid JSON (${settings.error.message})`);
      else errors.push(...validateHookJson({
        label: `${expectations.settingsPath}#hooks`,
        runtime,
        hooksJson: { hooks: settings.value?.hooks },
        expectations,
      }));
    }
  }

  return {
    status: errors.length > 0 ? "failed" : warnings.length > 0 ? "warning" : "passed",
    expectations,
    errors,
    warnings,
  };
}

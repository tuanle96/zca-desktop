import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { hookIntegrityExpectations } from "./permissions/runtime-expectations.mjs";

// Kiro hooks live inside the primary agent config and expose 5 lifecycle
// triggers (no PreCompact/SubagentStop/SessionEnd equivalent). Each expected
// trigger must route to a shipped, executable, root-aware harness script.
const KIRO_HOOK_EXPECTATIONS = [
  { event: "agentSpawn", scripts: [".harness/scripts/session-start.sh"] },
  { event: "userPromptSubmit", scripts: [".harness/scripts/userprompt-guard.sh"] },
  {
    event: "preToolUse",
    scripts: [
      ".harness/scripts/pretooluse-skill-permission-guard.mjs",
      ".harness/scripts/pretooluse-bash-guard.sh",
      ".harness/scripts/pretooluse-edit-guard.sh",
    ],
  },
  { event: "postToolUse", scripts: [".harness/scripts/structural-test-on-edit.sh"] },
  { event: "stop", scripts: [".harness/scripts/precompletion-checklist.sh"] },
];

function rel(root, path) {
  return relative(root, path).split("\\").join("/") || ".";
}

function insideRoot(root, path) {
  const r = relative(root, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

function readConfig(root) {
  for (const candidate of [".harness/config.json", "harness.config.json"]) {
    const path = resolve(root, candidate);
    if (!existsSync(path)) continue;
    const parsed = readJson(path);
    return parsed.value && !parsed.error ? parsed.value : {};
  }
  return {};
}

function commandsForEvent(hooksJson, eventName) {
  const entries = hooksJson?.hooks?.[eventName];
  if (!Array.isArray(entries)) return [];
  const commands = [];
  for (const entry of entries) {
    const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
    for (const hook of hooks) {
      if (hook?.type === "command" && typeof hook.command === "string") {
        commands.push(hook.command);
      }
    }
  }
  return commands;
}

function hasDisableAllHooks(value) {
  if (!value || typeof value !== "object") return false;
  if (value.disableAllHooks === true) return true;
  if (Array.isArray(value)) return value.some(hasDisableAllHooks);
  return Object.values(value).some(hasDisableAllHooks);
}

function scriptExecutable(root, script) {
  const path = resolve(root, script);
  if (!insideRoot(root, path)) return { exists: false, executable: false };
  if (!existsSync(path)) return { exists: false, executable: false };
  try {
    const st = statSync(path);
    return { exists: true, executable: Boolean(st.mode & 0o111) };
  } catch {
    return { exists: false, executable: false };
  }
}

function validateRootAwareCommand({ command, runtime, script, prefix }) {
  const errors = [];
  if (!command.includes(`AHK_SCRIPT="${script}"`) && !command.includes(`AHK_SCRIPT=\\"${script}\\"`)) {
    errors.push(`${prefix}: command must set AHK_SCRIPT="${script}"`);
  }
  if (!command.includes("AHK_ROOT")) errors.push(`${prefix}: command must resolve AHK_ROOT`);
  if (!command.includes("git rev-parse --show-toplevel")) errors.push(`${prefix}: command must fall back to git root`);
  if (!command.includes("cd \"$AHK_ROOT\"")) errors.push(`${prefix}: command must cd to resolved root`);
  if (runtime === "claude" && !command.includes("CLAUDE_PROJECT_DIR")) {
    errors.push(`${prefix}: Claude command must prefer CLAUDE_PROJECT_DIR`);
  }
  if (runtime === "codex") {
    if (!command.includes("AHK_RUNTIME=codex")) errors.push(`${prefix}: Codex command must set AHK_RUNTIME=codex`);
    if (!command.includes("CODEX_PROJECT_DIR")) errors.push(`${prefix}: Codex command must prefer CODEX_PROJECT_DIR`);
  }
  if (runtime === "kiro" && !command.includes("AHK_RUNTIME=kiro")) {
    errors.push(`${prefix}: Kiro command must set AHK_RUNTIME=kiro`);
  }
  return errors;
}

function validateHookBlock({ root, runtime, label, hooksJson, expected, settingsHooks = null }) {
  const errors = [];
  const warnings = [];
  if (!hooksJson || typeof hooksJson !== "object" || !hooksJson.hooks || typeof hooksJson.hooks !== "object") {
    return { errors: [`${label}: missing top-level hooks object`], warnings };
  }

  for (const item of expected) {
    const commands = commandsForEvent(hooksJson, item.event);
    if (commands.length === 0) {
      const message = `${label}: missing ${item.event}`;
      if (item.optional) warnings.push(message);
      else errors.push(message);
      continue;
    }
    for (const script of item.scripts) {
      const command = commands.find((entry) => entry.includes(script));
      const prefix = `${label}: ${item.event} ${script}`;
      if (!command) {
        errors.push(`${prefix} not registered`);
        continue;
      }
      const executable = scriptExecutable(root, script);
      if (!executable.exists) errors.push(`${prefix} referenced script missing`);
      else if (!executable.executable) errors.push(`${prefix} referenced script is not executable`);
      errors.push(...validateRootAwareCommand({ command, runtime, script, prefix }));

      if (settingsHooks) {
        const settingsCommands = commandsForEvent({ hooks: settingsHooks }, item.event);
        const settingsCommand = settingsCommands.find((entry) => entry.includes(script));
        if (!settingsCommand) {
          errors.push(`${label}: .claude/settings.json ${item.event} missing ${script}`);
        } else {
          errors.push(...validateRootAwareCommand({
            command: settingsCommand,
            runtime,
            script,
            prefix: `${label}: .claude/settings.json ${item.event} ${script}`,
          }));
        }
      }
    }
  }
  return { errors, warnings };
}

function surfaceEnabled(config, runtime) {
  if (runtime === "claude") return config.agentRuntime?.claude?.hooks === true;
  if (runtime === "codex") return config.agentRuntime?.codex?.hooks === true;
  if (runtime === "kiro") return config.agentRuntime?.kiro?.hooks === true;
  return false;
}

function kiroCommandsForEvent(agentHooks, event) {
  const entries = agentHooks?.[event];
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => entry?.command).filter((command) => typeof command === "string");
}

function evaluateKiroSurface({ root, enabled }) {
  const hooksRel = ".kiro/agents/harness.json";
  const errors = [];
  const warnings = [];
  const hooksPath = resolve(root, hooksRel);
  const exists = existsSync(hooksPath);
  if (!enabled) {
    if (exists) warnings.push(`${hooksRel} exists but kiro hooks are disabled in config`);
    return { runtime: "kiro", enabled: false, hooksPath: hooksRel, status: warnings.length > 0 ? "warn" : "pass", errors, warnings, registeredEvents: [] };
  }
  if (!exists) {
    errors.push(`${hooksRel} is required because kiro hooks are enabled`);
    return { runtime: "kiro", enabled: true, hooksPath: hooksRel, status: "fail", errors, warnings, registeredEvents: [] };
  }
  const parsed = readJson(hooksPath);
  if (parsed.error) errors.push(`${hooksRel}: invalid JSON (${parsed.error.message})`);
  const agentHooks = parsed.value?.hooks;
  if (parsed.value && (!agentHooks || typeof agentHooks !== "object")) {
    errors.push(`${hooksRel}: missing hooks object in agent config`);
  } else if (agentHooks) {
    for (const item of KIRO_HOOK_EXPECTATIONS) {
      const commands = kiroCommandsForEvent(agentHooks, item.event);
      if (commands.length === 0) {
        errors.push(`${hooksRel}: missing ${item.event}`);
        continue;
      }
      for (const script of item.scripts) {
        const command = commands.find((entry) => entry.includes(script));
        const prefix = `${hooksRel}: ${item.event} ${script}`;
        if (!command) {
          errors.push(`${prefix} not registered`);
          continue;
        }
        const executable = scriptExecutable(root, script);
        if (!executable.exists) errors.push(`${prefix} referenced script missing`);
        else if (!executable.executable) errors.push(`${prefix} referenced script is not executable`);
        errors.push(...validateRootAwareCommand({ command, runtime: "kiro", script, prefix }));
      }
    }
  }
  return {
    runtime: "kiro",
    enabled: true,
    hooksPath: hooksRel,
    status: errors.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass",
    errors,
    warnings,
    registeredEvents: Object.keys(agentHooks || {}).sort(),
  };
}

function evaluateSurface({ root, runtime, enabled, hooksRel, settingsRel, expected }) {
  const errors = [];
  const warnings = [];
  const hooksPath = resolve(root, hooksRel);
  const exists = existsSync(hooksPath);
  if (!enabled) {
    if (exists) warnings.push(`${hooksRel} exists but ${runtime} hooks are disabled in config`);
    return {
      runtime,
      enabled: false,
      hooksPath: hooksRel,
      status: warnings.length > 0 ? "warn" : "pass",
      errors,
      warnings,
      registeredEvents: [],
    };
  }
  if (!exists) {
    errors.push(`${hooksRel} is required because ${runtime} hooks are enabled`);
    return {
      runtime,
      enabled: true,
      hooksPath: hooksRel,
      status: "fail",
      errors,
      warnings,
      registeredEvents: [],
    };
  }

  const parsed = readJson(hooksPath);
  if (parsed.error) {
    errors.push(`${hooksRel}: invalid JSON (${parsed.error.message})`);
  }
  let settingsHooks = null;
  if (settingsRel) {
    const settingsPath = resolve(root, settingsRel);
    if (!existsSync(settingsPath)) {
      errors.push(`${settingsRel} is required because Claude Code reads hooks from settings.json`);
    } else {
      const settings = readJson(settingsPath);
      if (settings.error) errors.push(`${settingsRel}: invalid JSON (${settings.error.message})`);
      else {
        if (hasDisableAllHooks(settings.value)) errors.push(`${settingsRel}: disableAllHooks=true disables harness protections`);
        if (!settings.value?.hooks || typeof settings.value.hooks !== "object") {
          errors.push(`${settingsRel}: missing hooks object merged from ${hooksRel}`);
        } else {
          settingsHooks = settings.value.hooks;
        }
      }
    }
  }

  if (parsed.value) {
    const validation = validateHookBlock({
      root,
      runtime,
      label: hooksRel,
      hooksJson: parsed.value,
      expected,
      settingsHooks,
    });
    errors.push(...validation.errors);
    warnings.push(...validation.warnings);
  }

  return {
    runtime,
    enabled: true,
    hooksPath: hooksRel,
    status: errors.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass",
    errors,
    warnings,
    registeredEvents: Object.keys(parsed.value?.hooks || {}).sort(),
  };
}

function worstStatus(statuses) {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  return "pass";
}

export function analyzeHookIntegrity({ cwd = process.cwd() } = {}) {
  const root = resolve(cwd);
  const config = readConfig(root);
  const surfaces = [];

  surfaces.push(evaluateSurface({
    root,
    runtime: "claude",
    enabled: surfaceEnabled(config, "claude"),
    hooksRel: ".claude/hooks/hooks.json",
    settingsRel: ".claude/settings.json",
    expected: hookIntegrityExpectations("claude"),
  }));
  surfaces.push(evaluateSurface({
    root,
    runtime: "codex",
    enabled: surfaceEnabled(config, "codex"),
    hooksRel: ".codex/hooks.json",
    settingsRel: null,
    expected: hookIntegrityExpectations("codex"),
  }));
  surfaces.push(evaluateKiroSurface({
    root,
    enabled: surfaceEnabled(config, "kiro"),
  }));

  const errors = surfaces.flatMap((surface) => surface.errors);
  const warnings = surfaces.flatMap((surface) => surface.warnings);
  const reasons = [...errors, ...warnings];
  return {
    status: worstStatus(surfaces.map((surface) => surface.status)),
    surfaces,
    errors,
    warnings,
    reasons,
  };
}

const CLAUDE_MUTATION_TOOLS = ["Edit", "Write", "MultiEdit"];

function uniqueOrdered(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function collectPolicyPermissions(compiled, key) {
  const values = [];
  values.push(...(compiled?.policy?.default?.[key] || []));
  for (const skill of Object.values(compiled?.policy?.skills || {})) {
    values.push(...(skill?.[key] || []));
  }
  for (const task of Object.values(compiled?.tasks || {})) {
    values.push(...(task?.permissions?.[key] || []));
  }
  return values;
}

export function buildRuntimePermissionHints(compiled) {
  const runtime = compiled?.runtime || "claude";
  if (runtime !== "claude") {
    return {
      runtime,
      settingsPath: "",
      allow: [],
      deny: [],
      source: "permissions-compiler:runtime-permission-hints",
      appliesTo: [],
    };
  }

  return {
    runtime,
    settingsPath: ".claude/settings.json",
    allow: uniqueOrdered([
      ...CLAUDE_MUTATION_TOOLS,
      ...collectPolicyPermissions(compiled, "allow"),
    ]),
    deny: uniqueOrdered(collectPolicyPermissions(compiled, "deny")),
    source: "permissions-compiler:runtime-permission-hints",
    appliesTo: ["claude-settings-permissions"],
  };
}

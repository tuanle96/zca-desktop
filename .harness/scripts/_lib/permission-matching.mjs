export function normalizePermission(permission) {
  const trimmed = String(permission || "").trim();
  const bash = trimmed.match(/^Bash\((.*)\)$/);
  if (!bash) return trimmed;
  return `Bash(${normalizeBashPattern(bash[1])})`;
}

export function normalizeBashPattern(pattern) {
  return String(pattern || "").trim().replace(/:\*$/, "*");
}

export function splitAllowedTools(value = "") {
  const tokens = [];
  let current = "";
  let depth = 0;
  for (const ch of String(value)) {
    if (ch === "(") depth += 1;
    if (ch === ")" && depth > 0) depth -= 1;
    if (ch === "," && depth === 0) {
      if (current.trim()) tokens.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) tokens.push(current.trim());
  return tokens.flatMap(expandBashToken).map(normalizePermission).filter(Boolean);
}

export function expandBashToken(token) {
  const match = String(token || "").trim().match(/^Bash\((.*)\)$/);
  if (!match) return [token];
  return splitAllowedTools(match[1]).map((inner) => `Bash(${inner})`);
}

export function bashCommand(permission) {
  const match = normalizePermission(permission).match(/^Bash\((.*)\)$/);
  return match ? match[1] : null;
}

export function wildcardToRegExp(pattern) {
  const escaped = String(pattern || "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

const APPLY_PATCH_TOOL = "apply_patch";
const PATCH_WRITE_PERMISSIONS = new Set(["Edit", "Write", "MultiEdit"]);

function singleShellCommand(command) {
  const text = String(command || "").trim();
  if (!text || /[;&|<>\n\r]/.test(text) || /\$\(|`/.test(text)) return "";
  return text;
}

function safeFindCommand(command) {
  return /^find(?:\s|$)/.test(command)
    && !/(?:^|\s)-(?:delete|exec|execdir|fprint|fprintf|fls|ok|okdir)(?:\s|$)/.test(command);
}

function readOnlyBashCommand(permission, command) {
  const text = singleShellCommand(command);
  if (!text) return false;
  if (permission === "LS") return /^(?:pwd|ls)(?:\s|$)/.test(text);
  if (permission === "Grep") return /^(?:rg|grep|git\s+grep)(?:\s|$)/.test(text);
  if (permission === "Glob") return /^rg\s+--files(?:\s|$)/.test(text) || safeFindCommand(text);
  if (permission === "Read") {
    return /^(?:cat|head|tail|nl|wc|stat|file)(?:\s|$)/.test(text)
      || /^sed\s+-n(?:\s|$)/.test(text)
      || /^git\s+(?:blame|diff|show|log|rev-parse|ls-files|grep)(?:\s|$)/.test(text);
  }
  return false;
}

export function overbroadSensitiveBashPermission(permission) {
  const command = bashCommand(permission);
  return ["*", "git*", "gh*", "node*"].includes(command);
}

export function permissionCovers(declaredPermission, requestedPermission) {
  const declared = normalizePermission(declaredPermission);
  const requested = normalizePermission(requestedPermission);
  if (declared === requested) return true;
  if (requested === APPLY_PATCH_TOOL && PATCH_WRITE_PERMISSIONS.has(declared)) return true;
  const declaredCommand = bashCommand(declared);
  const requestedCommand = bashCommand(requested);
  if (requestedCommand !== null && readOnlyBashCommand(declared, requestedCommand)) return true;
  if (declaredCommand === null || requestedCommand === null) return false;
  if (requestedCommand.includes("*")) return false;
  const safeRequestedCommand = singleShellCommand(requestedCommand);
  if (!safeRequestedCommand) return false;
  return wildcardToRegExp(declaredCommand).test(safeRequestedCommand);
}

export function uncoveredPermissions(requested = [], declared = []) {
  return [...new Set(requested.map(normalizePermission))]
    .filter((permission) => !declared.some((declaredPermission) => permissionCovers(declaredPermission, permission)))
    .sort();
}

export function permissionMatchesTool(permission, { toolName = "", command = "" } = {}) {
  const normalized = normalizePermission(permission);
  const requestedTool = String(toolName || "").trim();
  if (normalized === "*" || normalized === requestedTool) return true;
  if (requestedTool === APPLY_PATCH_TOOL && PATCH_WRITE_PERMISSIONS.has(normalized)) return true;
  if (requestedTool === "Bash" && readOnlyBashCommand(normalized, command)) return true;
  const declaredCommand = bashCommand(normalized);
  if (toolName === "Bash" && declaredCommand !== null) {
    const safeCommand = singleShellCommand(command);
    if (!safeCommand) return false;
    return wildcardToRegExp(declaredCommand).test(safeCommand);
  }
  return false;
}

// Kiro CLI emits lowercase built-in tool names (read/write/shell/...) and
// legacy aliases (fs_read/fs_write/execute_bash). Map them onto the canonical
// kit tool taxonomy (Read/Write/Bash/...) so permission policies authored once
// enforce identically across Claude, Codex, and Kiro runtimes.
const KIRO_TOOL_CANONICAL = new Map([
  ["read", "Read"],
  ["fs_read", "Read"],
  ["fsread", "Read"],
  ["write", "Write"],
  ["fs_write", "Write"],
  ["fswrite", "Write"],
  ["shell", "Bash"],
  ["execute_bash", "Bash"],
  ["executebash", "Bash"],
  ["execute_cmd", "Bash"],
  ["executecmd", "Bash"],
  ["grep", "Grep"],
  ["glob", "Glob"],
  ["subagent", "Task"],
  ["use_subagent", "Task"],
  ["agent_crew", "Task"],
]);

export function canonicalKiroToolName(name) {
  const raw = String(name || "").trim();
  return KIRO_TOOL_CANONICAL.get(raw.toLowerCase()) || raw;
}

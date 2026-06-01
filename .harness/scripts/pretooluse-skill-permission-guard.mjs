#!/usr/bin/env node
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  normalizePermission,
  overbroadSensitiveBashPermission,
  permissionMatchesTool,
  canonicalKiroToolName,
} from "./_lib/permission-matching.mjs";

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const POLICY_PATH = resolve(ROOT, ".harness/permissions.json");
const CONFIG_PATH = resolve(ROOT, ".harness/config.json");
const TELEMETRY_PATH = resolve(ROOT, ".harness/telemetry.jsonl");
const ACTIVE_TASK_PATH = resolve(ROOT, ".harness/state/active-task.txt");
const MUTATING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "apply_patch"]);
const TASK_RECOVERY_TOOL_NAMES = new Set([
  "codex_app.read_thread_terminal",
  "mcp__code_review_graph.detect_changes_tool",
  "mcp__code_review_graph.find_large_functions_tool",
  "mcp__code_review_graph.get_affected_flows_tool",
  "mcp__code_review_graph.get_architecture_overview_tool",
  "mcp__code_review_graph.get_bridge_nodes_tool",
  "mcp__code_review_graph.get_community_tool",
  "mcp__code_review_graph.get_flow_tool",
  "mcp__code_review_graph.get_hub_nodes_tool",
  "mcp__code_review_graph.get_impact_radius_tool",
  "mcp__code_review_graph.get_knowledge_gaps_tool",
  "mcp__code_review_graph.get_minimal_context_tool",
  "mcp__code_review_graph.get_review_context_tool",
  "mcp__code_review_graph.get_suggested_questions_tool",
  "mcp__code_review_graph.get_surprising_connections_tool",
  "mcp__code_review_graph.list_communities_tool",
  "mcp__code_review_graph.list_flows_tool",
  "mcp__code_review_graph.list_graph_stats_tool",
  "mcp__code_review_graph.query_graph_tool",
  "mcp__code_review_graph.semantic_search_nodes_tool",
  "mcp__code_review_graph.traverse_graph_tool",
]);

function readStdin() {
  return new Promise((resolveRead) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolveRead(input));
  });
}

function parseJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readPolicy() {
  if (!existsSync(POLICY_PATH)) return null;
  return parseJson(readFileSync(POLICY_PATH, "utf8"));
}

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  return parseJson(readFileSync(CONFIG_PATH, "utf8"), {}) || {};
}

function readJsonFile(path) {
  if (!existsSync(path)) return null;
  return parseJson(readFileSync(path, "utf8"));
}

function inferSkillFromTelemetry(sessionId) {
  if (!sessionId || !existsSync(TELEMETRY_PATH)) return "";
  const lines = readFileSync(TELEMETRY_PATH, "utf8").trim().split("\n").filter(Boolean).slice(-500);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const row = parseJson(lines[i]);
    if (!row || row.event !== "skill_invoked") continue;
    if ((row.session_id || row.sessionId || "") === sessionId && row.skill) return row.skill;
  }
  return "";
}

function inferTaskFromTelemetry(sessionId) {
  if (!sessionId || !existsSync(TELEMETRY_PATH)) return "";
  const lines = readFileSync(TELEMETRY_PATH, "utf8").trim().split("\n").filter(Boolean).slice(-500);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const row = parseJson(lines[i]);
    if (!row) continue;
    if ((row.session_id || row.sessionId || "") !== sessionId) continue;
    const taskId = row.task_id || row.taskId || row.eval_task_id || row.regression_task_id || "";
    if (taskId) return taskId;
  }
  return "";
}

function activeTaskFromState() {
  if (!existsSync(ACTIVE_TASK_PATH)) return "";
  return readFileSync(ACTIVE_TASK_PATH, "utf8").trim();
}

function activeSkill(payload) {
  return (
    process.env.AHK_ACTIVE_SKILL ||
    payload.active_skill ||
    payload.activeSkill ||
    payload.skill ||
    payload.tool_input?.active_skill ||
    payload.tool_input?.skill_context ||
    inferSkillFromTelemetry(payload.session_id || payload.sessionId) ||
    ""
  );
}

function activeTask(payload) {
  return (
    process.env.AHK_ACTIVE_TASK ||
    process.env.AHK_ACTIVE_TASK_ID ||
    payload.active_task ||
    payload.activeTask ||
    payload.task_id ||
    payload.taskId ||
    payload.tool_input?.active_task ||
    payload.tool_input?.activeTask ||
    payload.tool_input?.task_id ||
    payload.tool_input?.taskId ||
    inferTaskFromTelemetry(payload.session_id || payload.sessionId) ||
    activeTaskFromState() ||
    ""
  );
}

function toolCommand(payload) {
  return payload.tool_input?.command || payload.tool_input?.pattern || payload.tool_input?.file_path || "";
}

function singleSafeCommand(command) {
  const text = String(command || "").trim();
  if (!text || /[;&|<>\n\r]/.test(text) || /\$\(|`/.test(text)) return "";
  return text;
}

function isRecoveryBash(payload) {
  if ((payload.tool_name || "") !== "Bash") return false;
  const command = singleSafeCommand(toolCommand(payload));
  if (!command) return false;
  return /^(?:node\s+)?\.harness\/scripts\/(?:task-evidence-check|check-evidence-attestation|explain)\.mjs(?:\s|$)/.test(command)
    || /^node\s+scripts\/(?:task-evidence-check|check-evidence-attestation|explain)\.mjs(?:\s|$)/.test(command)
    || /^npx\s+agent-harness-kit\s+explain(?:\s|$)/.test(command);
}

function isAdvisorTask(payload) {
  if ((payload.tool_name || "") !== "Task") return false;
  const input = payload.tool_input || payload.input || {};
  return [input.subagent_type, input.subagentType, input.agent, input.agent_id, input.agentId]
    .some((value) => String(value || "") === "advisor");
}

function patchText(payload) {
  return (
    payload.tool_input?.command ||
    payload.tool_input?.patch ||
    payload.input?.command ||
    payload.input?.patch ||
    payload.command ||
    payload.patch ||
    ""
  );
}

function patchMutationTargets(payload) {
  const text = String(patchText(payload));
  return [
    ...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm),
    ...text.matchAll(/^\*\*\* Move to: (.+)$/gm),
  ]
    .map((match) => match[1]?.trim())
    .filter(Boolean);
}

function mutationTargets(payload) {
  if (!MUTATING_TOOLS.has(payload.tool_name || "")) return [];
  const direct = (
    payload.tool_input?.file_path ||
    payload.tool_input?.path ||
    payload.tool_input?.file ||
    payload.input?.file_path ||
    payload.input?.path ||
    payload.input?.file ||
    payload.file_path ||
    payload.path ||
    ""
  );
  if (direct) return [direct];
  if ((payload.tool_name || "") === "apply_patch") return patchMutationTargets(payload);
  return [];
}

function mutationTarget(payload) {
  return mutationTargets(payload)[0] || "";
}

function normalizedProjectPath(value) {
  const text = String(value || "").trim();
  if (!text || hasUrlScheme(text)) return "";
  const abs = resolve(ROOT, text);
  return insideRoot(abs) ? relPath(abs) : "";
}

function relPath(path) {
  if (!path) return "";
  const raw = String(path).replace(/\\/g, "/");
  const root = ROOT.replace(/\\/g, "/");
  if (raw === root) return "";
  if (raw.startsWith(`${root}/`)) return raw.slice(root.length + 1);
  return raw.replace(/^\.\//, "");
}

function insideRoot(path) {
  const root = ROOT.replace(/\\/g, "/");
  const target = String(path || "").replace(/\\/g, "/");
  return target === root || target.startsWith(`${root}/`);
}

function hasUrlScheme(value) {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(value || ""));
}

function stableId(value) {
  return /^[a-z0-9][a-z0-9._-]*$/.test(String(value || ""));
}

function resolveRepoLocal(value) {
  const text = String(value || "").trim();
  if (!text || hasUrlScheme(text)) return "";
  const abs = resolve(ROOT, text);
  return insideRoot(abs) ? abs : "";
}

function layerForPath(config, filePath) {
  const rel = relPath(filePath);
  if (!rel) return null;
  const domains = Array.isArray(config.domains) ? config.domains : [];
  for (const domain of domains) {
    const root = String(domain.root || "").replace(/^\.?\//, "").replace(/\/$/, "");
    const layers = Array.isArray(domain.layers) ? domain.layers : [];
    const pattern = domain.layerDirPattern || "{layer}";
    if (!root || !rel.startsWith(`${root}/`)) continue;
    for (const layer of layers) {
      const layerDir = String(pattern).replaceAll("{layer}", layer);
      if (rel === `${root}/${layerDir}` || rel.startsWith(`${root}/${layerDir}/`)) {
        return { domain: domain.name || "default", layer, rel };
      }
    }
    return { domain: domain.name || "default", layer: "", rel };
  }
  return null;
}

function isHarnessProofArtifact(file) {
  return (
    file === ".harness/feature_list.json" ||
    file === ".harness/PROGRESS.md" ||
    file.startsWith(".harness/evidence/") ||
    file.startsWith(".harness/task-contracts/") ||
    file.startsWith(".harness/reviews/") ||
    file.startsWith(".harness/state/") ||
    file.startsWith(".harness/failures/records/")
  );
}

function isProofArtifactMutation(payload) {
  const targets = mutationTargets(payload).map(normalizedProjectPath).filter(Boolean);
  return targets.length > 0 && targets.every(isHarnessProofArtifact);
}

function isTaskRecoveryTool(payload) {
  const toolName = String(payload.tool_name || "");
  return TASK_RECOVERY_TOOL_NAMES.has(toolName)
    || isRecoveryBash(payload)
    || isAdvisorTask(payload)
    || isProofArtifactMutation(payload);
}

function isTechnicalMutationTarget(file) {
  return (
    /(^|\/)package(?:-lock)?\.json$/.test(file) ||
    /(^|\/)(pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/.test(file) ||
    /(^|\/)(tsconfig[^/]*\.json|jsconfig\.json)$/.test(file) ||
    /(^|\/)(next|vite|eslint|prettier|tailwind|postcss)\.config\.[cm]?[jt]s$/.test(file) ||
    /(^|\/)(pyproject\.toml|poetry\.lock|requirements[^/]*\.txt)$/.test(file) ||
    /(^|\/)(Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Package\.swift)$/.test(file) ||
    /(^|\/)(build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/.test(file) ||
    /(^|\/)Dockerfile[^/]*$/.test(file) ||
    /(^|\/)docker-compose[^/]*\.ya?ml$/.test(file) ||
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) ||
    /^\.harness\/config\.json$/.test(file) ||
    /^\.claude\/settings\.json$/.test(file) ||
    /^\.codex\/hooks\.json$/.test(file) ||
    /(^|\/)\.env\.(example|sample)$/.test(file)
  );
}

function taskContractsEnabled(config) {
  return config.taskContracts?.enabled !== false;
}

function requiresActiveTaskForMutationTargets(config) {
  return taskContractsEnabled(config) && config.taskContracts?.requireActiveTaskForMutationTargets === true;
}

function taskRequiredMutationTarget(config, payload) {
  if (!requiresActiveTaskForMutationTargets(config)) return "";
  for (const target of mutationTargets(payload)) {
    const normalized = normalizedProjectPath(target);
    if (!normalized || isHarnessProofArtifact(normalized)) continue;
    if (layerForPath(config, normalized)) return normalized;
    if (isTechnicalMutationTarget(normalized)) return normalized;
  }
  return "";
}

function permissionMatches(permission, payload) {
  return permissionMatchesTool(permission, {
    toolName: payload.tool_name || "",
    command: toolCommand(payload),
  });
}

function policyForSkill(policy, skill) {
  if (!skill) return null;
  const skillPolicy = policy?.skills?.[skill];
  if (!skillPolicy) return policy?.default || null;
  return {
    allow: skillPolicy.allow ?? policy?.default?.allow ?? [],
    deny: [...(policy?.default?.deny ?? []), ...(skillPolicy.deny ?? [])],
  };
}

function policyForTask(config, taskId, { requireExisting = false } = {}) {
  if (!taskId) return null;
  if (!stableId(taskId)) {
    return {
      id: taskId,
      invalidTaskId: true,
    };
  }
  const contractsDir = config.taskContracts?.contractsDir || ".harness/task-contracts";
  const resolvedContractsDir = resolveRepoLocal(contractsDir);
  if (!resolvedContractsDir) {
    return {
      id: taskId,
      invalidContractsDir: contractsDir,
    };
  }
  const contract = readJsonFile(resolve(resolvedContractsDir, `${taskId}.json`));
  if (!contract) {
    return requireExisting
      ? {
          id: taskId,
          missingTaskContract: true,
          contractsDir,
        }
      : null;
  }
  if (contract.id && contract.id !== taskId) {
    return {
      id: taskId,
      mismatchedTaskId: contract.id,
    };
  }
  if (contract.riskTier === "high-risk") {
    const allow = contract.permissions?.allow;
    const allowedLayers = contract.scope?.allowedLayers;
    const invalidAllow = !Array.isArray(allow)
      || allow.length === 0
      || allow
        .map(normalizePermission)
        .some((permission) => permission === "*" || permission === "Bash(*)" || overbroadSensitiveBashPermission(permission));
    const invalidLayerScope = !Array.isArray(allowedLayers) || allowedLayers.length === 0;
    if (!contract.permissions || invalidAllow || invalidLayerScope) {
      const missing = [];
      if (!contract.permissions || invalidAllow) missing.push("non-wildcard permissions.allow");
      if (invalidLayerScope) missing.push("scope.allowedLayers");
      return {
        id: contract.id || taskId,
        invalidHighRiskControls: true,
        invalidHighRiskControlsReason: missing.join(" and "),
        allow: ["Read", "Grep", "Glob", "LS", "Bash(git status*)", "Bash(git diff*)"],
        deny: ["Edit", "Write", "MultiEdit", "Bash(*)"],
      };
    }
  }
  if (!contract.permissions) {
    return requireExisting
      ? {
          id: contract.id || taskId,
          missingTaskPermissions: true,
        }
      : null;
  }
  return {
    id: contract.id || taskId,
    allow: contract.permissions.allow || [],
    deny: contract.permissions.deny || [],
    allowedLayers: contract.scope?.allowedLayers || [],
  };
}

function enforcePolicy({ label, id, rule, payload }) {
  if (!rule) return "";
  if (rule.invalidTaskId) {
    return `${label} "${id}" is not a stable lowercase id; task-scoped tools require a valid task contract id.`;
  }
  if (rule.invalidContractsDir) {
    return `${label} "${id}" cannot load task contracts because contractsDir must stay inside the project root.`;
  }
  if (rule.mismatchedTaskId) {
    return `${label} "${id}" cannot use task contract "${rule.mismatchedTaskId}" because the contract id does not match the active task.`;
  }
  if (rule.missingTaskContract) {
    return `${label} "${id}" requires ${rule.contractsDir}/${id}.json before mutating source or technical config files.`;
  }
  if (rule.missingTaskPermissions) {
    return `${label} "${id}" must declare permissions.allow before mutating source or technical config files.`;
  }
  if (rule.invalidHighRiskControls) {
    const readOnlyAllowed = (rule.allow || []).some((permission) => permissionMatches(permission, payload));
    if (!readOnlyAllowed) {
      return `${label} "${id}" is high-risk and must declare ${rule.invalidHighRiskControlsReason} before mutating tools can run.`;
    }
    return "";
  }
  const denied = (rule.deny || []).find((permission) => permissionMatches(permission, payload));
  if (denied) {
    return `${label} "${id}" is not allowed to use ${payload.tool_name || "this tool"} by deny rule ${denied}.`;
  }
  if (Array.isArray(rule.allow) && rule.allow.length > 0) {
    const allowed = rule.allow.some((permission) => permissionMatches(permission, payload));
    if (!allowed) {
      return `${label} "${id}" is not allowed to use ${payload.tool_name || "this tool"} by its allow list.`;
    }
  }
  return "";
}

function enforceTaskRequiredMutationTarget({ target, taskId }) {
  if (!target || taskId) return "";
  return `Mutation of "${target}" requires an active task contract. Create or activate .harness/task-contracts/<task-id>.json before editing source or technical config files.`;
}

function enforceTaskScope({ taskId, taskRule, config, payload }) {
  if (!taskRule || !Array.isArray(taskRule.allowedLayers) || taskRule.allowedLayers.length === 0) {
    return "";
  }
  for (const target of mutationTargets(payload)) {
    const layer = layerForPath(config, target);
    if (!layer) continue;
    if (!layer.layer) {
      return `Task "${taskId}" allows layer(s) ${taskRule.allowedLayers.join(", ")} but ${layer.rel} is unlayered under domain "${layer.domain}".`;
    }
    if (!taskRule.allowedLayers.includes(layer.layer)) {
      return `Task "${taskId}" allows layer(s) ${taskRule.allowedLayers.join(", ")} but ${layer.rel} is in layer "${layer.layer}".`;
    }
  }
  return "";
}

function deny(reason) {
  logPermissionDenied({ skill, taskId, payload, reason });
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(out));
}

function logPermissionDenied({ skill, taskId, payload, reason }) {
  if (process.env.AHK_DISABLE_TELEMETRY === "1") return;
  mkdirSync(resolve(ROOT, ".harness"), { recursive: true });
  const row = {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    event: "permission_denied",
    rule: "skill-permission-guard",
    hook: "PreToolUse",
    skill,
    task_id: taskId,
    tool: payload.tool_name || "",
    reason,
  };
  appendFileSync(TELEMETRY_PATH, JSON.stringify(row) + "\n");
}

function logBypass({ skill, taskId, payload, reason }) {
  mkdirSync(resolve(ROOT, ".harness"), { recursive: true });
  const row = {
    ts: new Date().toISOString(),
    bypass: process.env.AHK_ALLOW_BYPASS === "1" ? "AHK_ALLOW_BYPASS" : "AHK_SKILL_PERMISSIONS_MODE=warn",
    rule: "skill-permission-guard",
    skill,
    task_id: taskId,
    tool: payload.tool_name || "",
    reason,
  };
  appendFileSync(resolve(ROOT, ".harness/bypass.log"), JSON.stringify(row) + "\n");
}

const input = await readStdin();
const payload = parseJson(input, {});
if (process.env.AHK_RUNTIME === "kiro" && payload && typeof payload === "object") {
  payload.tool_name = canonicalKiroToolName(payload.tool_name);
}
const policy = readPolicy();
if (!policy) process.exit(0);
const config = readConfig();

const skill = activeSkill(payload);
const taskId = activeTask(payload);
const requiredMutationTarget = taskRequiredMutationTarget(config, payload);
if (!skill && !taskId && !requiredMutationTarget) process.exit(0);

const skillRule = policyForSkill(policy, skill);
const taskRule = policyForTask(config, taskId, { requireExisting: Boolean(requiredMutationTarget) });
const recoveryAllowed = isTaskRecoveryTool(payload);
const reason =
  enforceTaskRequiredMutationTarget({ target: requiredMutationTarget, taskId }) ||
  (recoveryAllowed ? "" : enforcePolicy({ label: "Skill", id: skill, rule: skillRule, payload })) ||
  (recoveryAllowed ? "" : enforcePolicy({ label: "Task", id: taskId, rule: taskRule, payload })) ||
  enforceTaskScope({ taskId, taskRule, config, payload });

if (!reason) process.exit(0);

if (process.env.AHK_ALLOW_BYPASS === "1" || process.env.AHK_SKILL_PERMISSIONS_MODE === "warn") {
  logBypass({ skill, taskId, payload, reason });
  process.exit(0);
}

deny(reason);

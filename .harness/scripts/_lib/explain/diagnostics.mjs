import { existsSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { explainBypassFingerprint } from "../bypass-audit.mjs";
import { permissionMatchesTool } from "../permission-matching.mjs";

const DEFAULT_TASK_CONTRACTS_DIR = ".harness/task-contracts";
const DEFAULT_EVIDENCE_DIR = ".harness/evidence";
const REQUIRED_CONTRACT_FIELDS = [
  "schemaVersion",
  "id",
  "type",
  "riskTier",
  "scope",
  "acceptance",
  "permissions",
  "doneRequires",
  "evidencePath",
];
const REQUIRED_EVIDENCE_FIELDS = [
  "schemaVersion",
  "taskId",
  "status",
  "createdAt",
  "changedFiles",
  "checks",
];

export function parseExplainArgs(argv = []) {
  const opts = {
    cwd: process.cwd(),
    json: false,
    strict: false,
    mode: "",
    taskId: "",
    permission: "",
    skill: "",
    evidencePath: "",
    bypassFingerprint: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg === "--last-block") opts.mode = "last-block";
    else if (arg === "--readiness") opts.mode = "readiness";
    else if (arg === "--cwd") opts.cwd = resolve(argv[++i] || "");
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg === "--task") {
      if (!opts.mode) opts.mode = "task";
      opts.taskId = argv[++i] || "";
    } else if (arg.startsWith("--task=")) {
      if (!opts.mode) opts.mode = "task";
      opts.taskId = arg.slice("--task=".length);
    } else if (arg === "--permission") {
      opts.mode = "permission";
      opts.permission = argv[++i] || "";
    } else if (arg.startsWith("--permission=")) {
      opts.mode = "permission";
      opts.permission = arg.slice("--permission=".length);
    } else if (arg === "--skill") {
      opts.skill = argv[++i] || "";
    } else if (arg.startsWith("--skill=")) {
      opts.skill = arg.slice("--skill=".length);
    } else if (arg === "--evidence") {
      opts.mode = "evidence";
      opts.evidencePath = argv[++i] || "";
    } else if (arg.startsWith("--evidence=")) {
      opts.mode = "evidence";
      opts.evidencePath = arg.slice("--evidence=".length);
    } else if (arg === "--bypass") {
      opts.mode = "bypass";
      opts.bypassFingerprint = argv[++i] || "";
    } else if (arg.startsWith("--bypass=")) {
      opts.mode = "bypass";
      opts.bypassFingerprint = arg.slice("--bypass=".length);
    }
  }
  return opts;
}

export function buildExplainPayload(input = {}) {
  const opts = { ...parseExplainArgs([]), ...input, cwd: resolve(input.cwd || process.cwd()) };
  if (opts.mode === "last-block") return explainLastBlock(opts);
  if (opts.mode === "task") return explainTask(opts);
  if (opts.mode === "permission") return explainPermission(opts);
  if (opts.mode === "evidence") return explainEvidence(opts);
  if (opts.mode === "bypass") return explainBypass(opts);
  if (opts.mode === "readiness") return explainReadiness(opts);
  return basePayload(opts, {
    status: "failed",
    blockedBy: "usage",
    sourceRule: "agent-harness-kit explain",
    missingFields: ["mode"],
    nextCommand: "npx agent-harness-kit explain --readiness",
    details: [
      "Choose one mode: --last-block, --task <id>, --permission <tool>, --evidence <path>, --bypass <fingerprint>, or --readiness.",
    ],
  });
}

export function renderExplainText(payload) {
  const lines = ["=== harness explain ==="];
  lines.push(`mode: ${payload.mode || "(unknown)"}`);
  lines.push(`status: ${String(payload.status || "unknown").toUpperCase()}`);
  if (payload.blockedBy) lines.push(`blocked by: ${payload.blockedBy}`);
  if (payload.sourceRule) lines.push(`source rule: ${payload.sourceRule}`);
  if (payload.taskId) lines.push(`task: ${payload.taskId}`);
  if (payload.featureId) lines.push(`feature: ${payload.featureId}`);
  if (payload.fingerprint) lines.push(`fingerprint: ${payload.fingerprint}`);
  if (payload.runtime) lines.push(`runtime: ${payload.runtime}`);
  appendList(lines, "missing files", payload.missingFiles);
  appendList(lines, "missing fields", payload.missingFields);
  appendList(lines, "next command", arrayOf(payload.nextCommand));
  if (payload.overridePolicy) lines.push(`override: ${payload.overridePolicy}`);
  appendList(lines, "details", payload.details);
  return `${lines.join("\n")}\n`;
}

export async function runExplainCli(argv = [], { exit = true } = {}) {
  const opts = parseExplainArgs(argv);
  const payload = buildExplainPayload(opts);
  if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(renderExplainText(payload));
  const exitCode = payload.status === "failed" ? 1 : 0;
  if (exit) process.exit(exitCode);
  return { payload, exitCode };
}

function basePayload(opts, patch = {}) {
  return {
    schemaVersion: 1,
    mode: opts.mode || "",
    status: "passed",
    cwd: opts.cwd,
    blockedBy: "",
    sourceRule: "",
    taskId: opts.taskId || "",
    featureId: "",
    runtime: detectRuntime(opts.cwd),
    missingFiles: [],
    missingFields: [],
    nextCommand: "",
    overridePolicy: "Use a reviewed bypass record only when the gate explicitly allows it.",
    details: [],
    ...patch,
  };
}

function explainLastBlock(opts) {
  const telemetryPath = resolve(opts.cwd, ".harness/telemetry.jsonl");
  const rows = readJsonl(telemetryPath);
  const record = rows.reverse().find(isBlockRecord);
  const taskId = record?.task_id || record?.taskId || "";
  if (!record) {
    return basePayload(opts, {
      status: "failed",
      blockedBy: "last-block",
      sourceRule: ".harness/telemetry.jsonl",
      missingFiles: existsSync(telemetryPath) ? [] : [".harness/telemetry.jsonl"],
      details: ["No recent or historical block record was found in harness telemetry."],
      nextCommand: "npx agent-harness-kit explain --readiness",
    });
  }
  return basePayload(opts, {
    status: "attention",
    blockedBy: record.rule || record.event || record.type || record.hook || "last-block",
    sourceRule: ".harness/telemetry.jsonl",
    taskId,
    details: [
      record.event ? `event: ${record.event}` : "",
      record.title ? `title: ${record.title}` : "",
      record.body ? `body: ${record.body}` : "",
      record.reason ? `reason: ${record.reason}` : "",
      blockFailures(record).length ? `failures: ${blockFailures(record).join(", ")}` : "",
      record.tool ? `tool: ${record.tool}` : "",
      record.command ? `command: ${record.command}` : "",
    ].filter(Boolean),
    nextCommand: record.nextCommand || lastBlockNextCommand(opts, record),
  });
}

function blockFailures(record) {
  if (Array.isArray(record?.failures)) return record.failures.map((item) => String(item).trim()).filter(Boolean);
  return String(record?.failures || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function permissionToolFromBlock(record) {
  const tool = String(record?.tool || record?.tool_name || "").trim();
  const command = String(record?.command || "").trim();
  if (tool === "Bash" && command) return `Bash(${command})`;
  if (!tool && command) return `Bash(${command})`;
  return tool;
}

function lastBlockNextCommand(opts, record) {
  const taskId = record.task_id || record.taskId || "";
  const event = String(record.event || record.type || "").toLowerCase();
  const failures = blockFailures(record);
  if (event === "permission_denied") {
    const permission = permissionToolFromBlock(record);
    if (permission) {
      return `npx agent-harness-kit explain --permission ${quoteCliArg(permission)}${taskId ? ` --task=${quoteCliArg(taskId)}` : ""}`;
    }
  }
  if (taskId && failures.includes("task-evidence")) return taskEvidenceCommand(opts.cwd, taskId);
  if (taskId && failures.includes("advisor-required")) return `npx agent-harness-kit explain --task=${quoteCliArg(taskId)}`;
  if (event === "structural_test_fail" || failures.some((failure) => /structural/i.test(failure))) return "npm run harness:check";
  if (event === "userprompt_block") return "Review the prompt, adjust the request, or create a reviewed bypass if policy allows it.";
  return "npx agent-harness-kit explain --readiness";
}

function explainTask(opts) {
  const taskId = String(opts.taskId || "").trim();
  if (!stableId(taskId)) {
    return basePayload(opts, {
      status: "failed",
      blockedBy: "task-contract",
      sourceRule: "task id",
      missingFields: ["stable lowercase task id"],
      details: [`Invalid task id: ${taskId || "(empty)"}`],
    });
  }
  const config = readConfig(opts.cwd);
  const contractsDir = config.taskContracts?.contractsDir || DEFAULT_TASK_CONTRACTS_DIR;
  const contractRel = `${contractsDir.replace(/\/$/, "")}/${taskId}.json`;
  const contractPath = resolve(opts.cwd, contractRel);
  const missingFiles = [];
  const missingFields = [];
  const details = [];
  if (!inside(opts.cwd, contractPath) || !existsSync(contractPath)) {
    missingFiles.push(contractRel);
    return basePayload(opts, {
      status: "failed",
      blockedBy: "task-contract",
      sourceRule: contractRel,
      taskId,
      missingFiles,
      nextCommand: `Create ${contractRel} or run /feature-intake for ${taskId}.`,
      details,
    });
  }
  const contract = readJson(contractPath);
  if (contract.__error) {
    return basePayload(opts, {
      status: "failed",
      blockedBy: "task-contract",
      sourceRule: rel(opts.cwd, contractPath),
      taskId,
      details: [contract.__error],
    });
  }
  for (const field of REQUIRED_CONTRACT_FIELDS) {
    if (contract[field] === undefined) missingFields.push(`contract.${field}`);
  }
  if (contract.id && contract.id !== taskId) missingFields.push("contract.id matching active task");
  const evidenceRel = String(contract.evidencePath || `${DEFAULT_EVIDENCE_DIR}/${taskId}.json`);
  const evidencePath = resolve(opts.cwd, evidenceRel);
  if (!inside(opts.cwd, evidencePath)) {
    missingFields.push("contract.evidencePath inside project root");
    details.push(`evidencePath escapes project root: ${evidenceRel}`);
  } else if (!existsSync(evidencePath)) missingFiles.push(evidenceRel);
  else {
    const evidence = readJson(evidencePath);
    if (evidence.__error) details.push(evidence.__error);
    else missingFields.push(...missingEvidenceProofFields(evidence));
  }
  return basePayload(opts, {
    status: missingFiles.length || missingFields.length || details.length ? "failed" : "passed",
    blockedBy: missingFiles.length || missingFields.length ? "task-evidence" : "",
    sourceRule: rel(opts.cwd, contractPath),
    taskId,
    featureId: contract.featureId || taskId,
    missingFiles,
    missingFields,
    nextCommand: taskEvidenceCommand(opts.cwd, taskId),
    details: [
      `riskTier: ${contract.riskTier || "(missing)"}`,
      `doneRequires: ${Array.isArray(contract.doneRequires) ? contract.doneRequires.join(", ") : "(missing)"}`,
      ...details,
    ],
  });
}

function explainPermission(opts) {
  const requested = parseRequestedTool(opts.permission);
  if (!requested.toolName) {
    return basePayload(opts, {
      status: "failed",
      blockedBy: "permission",
      sourceRule: "permission input",
      missingFields: ["permission"],
      nextCommand: 'npx agent-harness-kit explain --permission "Bash(npm test)" --task <taskId>',
    });
  }
  const policyPath = resolve(opts.cwd, ".harness/permissions.json");
  const policy = readJson(policyPath, {});
  const config = readConfig(opts.cwd);
  const details = [`requested: ${requested.label}`];
  const decisions = [];
  if (opts.skill) {
    decisions.push(decidePolicy({
      label: `Skill "${opts.skill}"`,
      rule: skillRule(policy, opts.skill),
      requested,
    }));
  }
  if (opts.taskId) {
    decisions.push(decidePolicy({
      label: `Task "${opts.taskId}"`,
      rule: taskRule(opts.cwd, config, opts.taskId),
      requested,
    }));
  }
  if (decisions.length === 0) {
    decisions.push(decidePolicy({
      label: "Default policy",
      rule: policy.default || null,
      requested,
    }));
  }
  const denied = decisions.find((decision) => decision.status === "denied");
  const missing = decisions.find((decision) => decision.status === "missing");
  const status = denied || missing ? "failed" : "passed";
  const usesSkillPolicy = decisions.some((decision) => decision.label.startsWith("Skill "));
  const usesTaskPolicy = decisions.some((decision) => decision.label.startsWith("Task "));
  const usesDefaultPolicy = decisions.some((decision) => decision.label === "Default policy");
  const policyFileRequired = usesSkillPolicy || usesDefaultPolicy;
  const policyFileMissing = policyFileRequired && !existsSync(policyPath);
  return basePayload(opts, {
    status,
    blockedBy: denied ? "permission-denied" : missing ? "permission-policy" : "",
    sourceRule: permissionSourceRule({ policyFileRequired, usesTaskPolicy }),
    taskId: opts.taskId || "",
    missingFiles: policyFileMissing ? [".harness/permissions.json"] : [],
    missingFields: missing ? [missing.reason] : [],
    nextCommand: opts.taskId
      ? `npx agent-harness-kit explain --task ${opts.taskId}`
      : "Inspect .harness/permissions.json and the active skill/task contract.",
    details: [...details, ...decisions.map((decision) => `${decision.label}: ${decision.reason}`)],
  });
}

function explainEvidence(opts) {
  const evidenceRel = String(opts.evidencePath || "").trim();
  if (!evidenceRel) {
    return basePayload(opts, {
      status: "failed",
      blockedBy: "evidence",
      sourceRule: "evidence path",
      missingFields: ["evidence path"],
      nextCommand: "npx agent-harness-kit explain --evidence .harness/evidence/<taskId>.json",
    });
  }
  const evidencePath = resolve(opts.cwd, evidenceRel);
  if (!inside(opts.cwd, evidencePath)) {
    return basePayload(opts, {
      status: "failed",
      blockedBy: "evidence",
      sourceRule: evidenceRel,
      missingFields: ["evidence path inside project root"],
      nextCommand: "npx agent-harness-kit explain --evidence .harness/evidence/<taskId>.json",
      details: [`Evidence path escapes project root: ${evidenceRel}`],
    });
  }
  if (!existsSync(evidencePath)) {
    return basePayload(opts, {
      status: "failed",
      blockedBy: "evidence",
      sourceRule: evidenceRel,
      missingFiles: [evidenceRel],
      nextCommand: `Create ${evidenceRel} or run the task evidence generator/checker.`,
    });
  }
  const evidence = readJson(evidencePath);
  if (evidence.__error) {
    return basePayload(opts, {
      status: "failed",
      blockedBy: "evidence",
      sourceRule: rel(opts.cwd, evidencePath),
      details: [evidence.__error],
    });
  }
  const missingFields = missingEvidenceProofFields(evidence);
  const details = [];
  const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
  return basePayload(opts, {
    status: missingFields.length ? "failed" : "passed",
    blockedBy: missingFields.length ? "task-evidence" : "",
    sourceRule: rel(opts.cwd, evidencePath),
    taskId: evidence.taskId || "",
    featureId: evidence.featureId || "",
    missingFields,
    nextCommand: taskEvidenceCommand(opts.cwd, evidence.taskId || ""),
    details: [
      `evidence status: ${evidence.status || "(missing)"}`,
      `checks: ${checks.length}`,
      ...details,
    ],
  });
}

function explainBypass(opts) {
  const fingerprint = String(opts.bypassFingerprint || "").trim();
  if (!fingerprint) {
    return basePayload(opts, {
      status: "failed",
      blockedBy: "bypass-audit",
      sourceRule: "bypass fingerprint",
      missingFields: ["bypass fingerprint"],
      nextCommand: "npx agent-harness-kit bypass audit --strict --json",
      details: ["Pass a 16-character bypass fingerprint from the strict bypass audit output."],
    });
  }
  const payload = explainBypassFingerprint({ cwd: opts.cwd, fingerprint });
  if (payload.status !== "found") {
    return basePayload(opts, {
      status: "failed",
      blockedBy: "bypass-audit",
      sourceRule: ".harness/bypass.log",
      fingerprint,
      missingFields: ["matching bypass log row"],
      nextCommand: "npx agent-harness-kit bypass audit --strict --json",
      details: [`No bypass log row matched fingerprint ${fingerprint}.`],
    });
  }
  const row = payload.row || {};
  const requestMatches = Array.isArray(payload.requestMatches) ? payload.requestMatches : [];
  const auditStatus = payload.audit?.status || "unknown";
  const status = auditStatus === "passed" ? "passed" : "attention";
  const blockedBy = auditStatus === "passed" ? "" : "bypass-audit";
  const target = row.file
    ? `edit:${row.file}`
    : row.command
      ? `command:${row.command}`
      : row.tool
        ? `tool:${row.tool}`
        : row.rule
          ? `rule:${row.rule}`
          : "<scope>";
  return basePayload(opts, {
    status,
    blockedBy,
    sourceRule: ".harness/bypass.log",
    taskId: row.task_id || row.taskId || "",
    fingerprint,
    nextCommand: requestMatches.length > 0
      ? "npx agent-harness-kit bypass audit --strict"
      : `npx agent-harness-kit bypass request --scope ${quoteCliArg(target)} --reason "<why>" --approved-by <reviewer>`,
    details: [
      `audit status: ${auditStatus}`,
      `line: ${row._line || "(unknown)"}`,
      `rule: ${row.rule || row.hook || row.hook_event_name || row.tool || "(unknown)"}`,
      row.file ? `file: ${row.file}` : "",
      row.command ? `command: ${row.command}` : "",
      row.reason ? `reason: ${row.reason}` : "",
      requestMatches.length > 0
        ? `matching requests: ${requestMatches.length}`
        : "matching requests: none",
      ...requestMatches.slice(0, 5).map((request) => (
        `request: ${request.id} (${request.path}) approvedBy=${request.approvedBy || "(unapproved)"} expiresAt=${request.expiresAt || "(missing)"}`
      )),
    ].filter(Boolean),
  });
}

function explainReadiness(opts) {
  const command = readinessCommand(opts.cwd, opts.strict);
  if (!command) {
    return basePayload(opts, {
      status: "failed",
      blockedBy: "readiness",
      sourceRule: "readiness runner",
      missingFiles: ["scripts/harness-readiness.mjs", ".harness/scripts/harness-readiness.mjs"],
      nextCommand: "npm run check:readiness -- --strict",
    });
  }
  const result = spawnSync(command, {
    cwd: opts.cwd,
    shell: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = parseJsonText(result.stdout);
  if (!parsed) {
    return basePayload(opts, {
      status: result.status === 0 ? "passed" : "failed",
      blockedBy: result.status === 0 ? "" : "readiness",
      sourceRule: command,
      nextCommand: command.replace(" --json", ""),
      details: `${result.stdout || ""}${result.stderr || ""}`.trim().split("\n").filter(Boolean).slice(0, 8),
    });
  }
  const failing = (parsed.results || []).find((gate) => gate.status === "failed" && (gate.required || opts.strict));
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
  return basePayload(opts, {
    status: parsed.status === "passed" ? "passed" : "failed",
    blockedBy: failing ? `readiness:${failing.id}` : parsed.status === "passed" ? "" : "readiness",
    sourceRule: command,
    missingFields: errors,
    nextCommand: failing?.command || command.replace(" --json", ""),
    details: [
      `strict: ${parsed.strict ? "yes" : "no"}`,
      failing ? `failing gate: ${failing.id}` : "",
      ...(failing?.output || []).map((line) => `gate output: ${line}`),
      ...warnings.map((warning) => `warning: ${warning}`),
    ].filter(Boolean),
  });
}

function quoteCliArg(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function appendList(lines, label, values) {
  const items = arrayOf(values).filter(Boolean);
  if (items.length === 0) return;
  lines.push(`${label}:`);
  for (const item of items) lines.push(`- ${item}`);
}

function arrayOf(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { __error: `${path}: invalid JSON (${error.message})` };
  }
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = parseJsonText(line);
    if (row) rows.push(row);
  }
  return rows;
}

function parseJsonText(text) {
  try {
    const value = JSON.parse(String(text || ""));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function readConfig(root) {
  return readJson(resolve(root, ".harness/config.json")) || readJson(resolve(root, "harness.config.json")) || {};
}

function stableId(value) {
  return /^[a-z0-9][a-z0-9._-]*$/.test(String(value || ""));
}

function inside(root, path) {
  const relativePath = relative(root, path);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("/") && !relativePath.startsWith("\\"));
}

function rel(root, path) {
  return relative(root, path).replaceAll("\\", "/") || ".";
}

function detectRuntime(root) {
  const codex = existsSync(resolve(root, ".codex/hooks.json")) || existsSync(resolve(root, "AGENTS.md"));
  const claude = existsSync(resolve(root, ".claude/settings.json")) || existsSync(resolve(root, "CLAUDE.md"));
  if (codex && claude) return "dual";
  if (codex) return "codex";
  if (claude) return "claude";
  return "unknown";
}

function isBlockRecord(record) {
  const event = String(record.event || record.type || "").toLowerCase();
  if (event === "block_remediated" || event === "remediation") return false;
  if (["precompletion_block", "permission_denied", "userprompt_block", "structural_test_fail"].includes(event)) return true;
  const text = [
    record.type,
    record.event,
    record.rule,
    record.title,
    record.body,
    record.reason,
  ].filter(Boolean).join(" ").toLowerCase();
  return /\b(block|blocked|denied|failed|failure)\b/.test(text);
}

function missingEvidenceFields(evidence) {
  const missing = [];
  for (const field of REQUIRED_EVIDENCE_FIELDS) {
    if (evidence?.[field] === undefined) missing.push(field);
  }
  return missing;
}

function missingEvidenceProofFields(evidence) {
  const missing = missingEvidenceFields(evidence).map((field) => `evidence.${field}`);
  if (evidence?.status === "pass" && !String(evidence.diffSummary || "").trim()) missing.push("evidence.diffSummary");
  const checks = Array.isArray(evidence?.checks) ? evidence.checks : [];
  if (evidence?.status === "pass" && !checks.some((check) => check.status === "pass")) {
    missing.push("evidence.checks[status=pass]");
  }
  for (const check of checks) {
    if (check?.status !== "pass") continue;
    const uiish = /(^|[._-])ui([._-]|$)|(^|[._-])browser([._-]|$)|verify-ui|playwright/i.test(`${check.name || ""} ${check.command || ""}`);
    if (uiish && !check.artifact) missing.push(`evidence.checks.${check.name || "(unnamed)"}.artifact`);
  }
  return missing;
}

function permissionSourceRule({ policyFileRequired, usesTaskPolicy }) {
  if (policyFileRequired && usesTaskPolicy) return ".harness/permissions.json + task contract";
  if (policyFileRequired) return ".harness/permissions.json";
  if (usesTaskPolicy) return "task contract";
  return "permission policy";
}

function taskEvidenceCommand(root, taskId) {
  const suffix = taskId ? ` --task=${taskId} --json` : " --json";
  if (existsSync(resolve(root, "scripts/task-evidence-check.mjs"))) {
    return `node scripts/task-evidence-check.mjs${suffix}`;
  }
  if (existsSync(resolve(root, ".harness/scripts/task-evidence-check.mjs"))) {
    return `node .harness/scripts/task-evidence-check.mjs${suffix}`;
  }
  return `node .harness/scripts/task-evidence-check.mjs${suffix}`;
}

function readinessCommand(root, strict) {
  const strictArg = strict ? " --strict" : "";
  if (existsSync(resolve(root, "scripts/harness-readiness.mjs"))) {
    return `node scripts/harness-readiness.mjs --json${strictArg}`;
  }
  if (existsSync(resolve(root, ".harness/scripts/harness-readiness.mjs"))) {
    return `node .harness/scripts/harness-readiness.mjs --json${strictArg}`;
  }
  const pkg = readJson(resolve(root, "package.json"), {});
  if (pkg.scripts?.["check:readiness"]) return `npm run --silent check:readiness -- --json${strictArg}`;
  if (pkg.scripts?.["harness:readiness"]) return `npm run --silent harness:readiness -- --json${strictArg}`;
  return "";
}

function parseRequestedTool(value) {
  const text = String(value || "").trim();
  const bash = text.match(/^Bash\((.*)\)$/);
  if (bash) return { label: text, toolName: "Bash", command: bash[1] };
  if (!text) return { label: "", toolName: "", command: "" };
  return { label: text, toolName: text, command: "" };
}

function skillRule(policy, skill) {
  const rule = policy?.skills?.[skill];
  if (!rule) return policy?.default || null;
  return {
    allow: rule.allow ?? policy?.default?.allow ?? [],
    deny: [...(policy?.default?.deny ?? []), ...(rule.deny ?? [])],
  };
}

function taskRule(root, config, taskId) {
  if (!stableId(taskId)) return { missing: `task "${taskId}" is not a stable lowercase id` };
  const contractsDir = config.taskContracts?.contractsDir || DEFAULT_TASK_CONTRACTS_DIR;
  const path = resolve(root, contractsDir, `${taskId}.json`);
  if (!inside(root, path) || !existsSync(path)) return { missing: `${contractsDir}/${taskId}.json` };
  const contract = readJson(path);
  if (contract.__error) return { missing: contract.__error };
  if (!contract.permissions) return { missing: `task "${taskId}" permissions` };
  return contract.permissions;
}

function decidePolicy({ label, rule, requested }) {
  if (!rule) return { label, status: "missing", reason: "policy not found" };
  if (rule.missing) return { label, status: "missing", reason: rule.missing };
  const denied = (rule.deny || []).find((permission) => permissionMatchesTool(permission, requested));
  if (denied) return { label, status: "denied", reason: `denied by ${denied}` };
  if (Array.isArray(rule.allow) && rule.allow.length > 0) {
    const allowed = rule.allow.find((permission) => permissionMatchesTool(permission, requested));
    if (!allowed) return { label, status: "denied", reason: "not covered by allow list" };
    return { label, status: "allowed", reason: `allowed by ${allowed}` };
  }
  return { label, status: "allowed", reason: "no allow restriction matched" };
}

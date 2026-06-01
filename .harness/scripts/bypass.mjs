#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditBypassRecords,
  createBypassRequest,
  explainBypassFingerprint,
} from "./_lib/bypass-audit.mjs";

const DEFAULT_LOG = ".harness/bypass.log";
const DEFAULT_ACK = ".harness/bypass-audit.json";
const DEFAULT_REQUESTS = ".harness/bypass-requests";

function parseGlobalArgs(argv = []) {
  const opts = {
    cwd: process.cwd(),
    json: false,
    logPath: DEFAULT_LOG,
    ackPath: DEFAULT_ACK,
    requestsDir: DEFAULT_REQUESTS,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--cwd") opts.cwd = resolve(argv[++i] || "");
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg === "--log") opts.logPath = argv[++i] || DEFAULT_LOG;
    else if (arg.startsWith("--log=")) opts.logPath = arg.slice("--log=".length);
    else if (arg === "--ack") opts.ackPath = argv[++i] || DEFAULT_ACK;
    else if (arg.startsWith("--ack=")) opts.ackPath = arg.slice("--ack=".length);
    else if (arg === "--requests-dir") opts.requestsDir = argv[++i] || DEFAULT_REQUESTS;
    else if (arg.startsWith("--requests-dir=")) opts.requestsDir = arg.slice("--requests-dir=".length);
    else rest.push(arg);
  }
  return { opts, rest };
}

function parseRequestArgs(argv = []) {
  const { opts, rest } = parseGlobalArgs(argv);
  const request = {
    cwd: opts.cwd,
    requestsDir: opts.requestsDir,
    scope: [],
    requestedBy: "human",
    approvedBy: "",
    usedByRunId: "",
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--task") request.taskId = rest[++i] || "";
    else if (arg.startsWith("--task=")) request.taskId = arg.slice("--task=".length);
    else if (arg === "--scope") request.scope.push(rest[++i] || "");
    else if (arg.startsWith("--scope=")) request.scope.push(arg.slice("--scope=".length));
    else if (arg === "--reason") request.reason = rest[++i] || "";
    else if (arg.startsWith("--reason=")) request.reason = arg.slice("--reason=".length);
    else if (arg === "--requested-by") request.requestedBy = rest[++i] || "";
    else if (arg.startsWith("--requested-by=")) request.requestedBy = arg.slice("--requested-by=".length);
    else if (arg === "--approved-by") request.approvedBy = rest[++i] || "";
    else if (arg.startsWith("--approved-by=")) request.approvedBy = arg.slice("--approved-by=".length);
    else if (arg === "--expires-at") request.expiresAt = rest[++i] || "";
    else if (arg.startsWith("--expires-at=")) request.expiresAt = arg.slice("--expires-at=".length);
    else if (arg === "--id") request.id = rest[++i] || "";
    else if (arg.startsWith("--id=")) request.id = arg.slice("--id=".length);
    else if (arg === "--used-by-run-id") request.usedByRunId = rest[++i] || "";
    else if (arg.startsWith("--used-by-run-id=")) request.usedByRunId = arg.slice("--used-by-run-id=".length);
  }
  return { opts, request };
}

function parseAuditArgs(argv = []) {
  const { opts, rest } = parseGlobalArgs(argv);
  opts.strict = rest.includes("--strict");
  return opts;
}

function parseExplainArgs(argv = []) {
  const { opts, rest } = parseGlobalArgs(argv);
  const fingerprint = rest.find((arg) => !arg.startsWith("-")) || "";
  return { ...opts, fingerprint };
}

export function renderBypassAuditText(payload) {
  const lines = [];
  if (payload.status === "passed") {
    const mode = payload.strict ? "strict " : "";
    if (payload.total === 0) lines.push(`check-bypass-audit: OK (${mode}no bypass records)`);
    else if (payload.strict) lines.push(`check-bypass-audit: OK (strict ${payload.total} bypass records reviewed or approved)`);
    else lines.push(`check-bypass-audit: OK (${payload.total} bypass records acknowledged)`);
    return `${lines.join("\n")}\n`;
  }

  lines.push("check-bypass-audit: FAILED");
  for (const error of payload.errors || []) lines.push(`- ${error}`);
  if (payload.unacknowledged?.length > 0) {
    lines.push(`- ${payload.unacknowledged.length} bypass record(s) require review in ${payload.ackPath}`);
    for (const row of payload.unacknowledged.slice(0, 8)) {
      const label = row.rule || row.hook || row.hook_event_name || row.tool || "bypass";
      const reason = row.reason || row.prompt || row.command || row.file || "";
      lines.push(`  ${row.fingerprint} line ${row.line}: ${label}${reason ? ` - ${String(reason).slice(0, 140)}` : ""}`);
    }
    if (payload.unacknowledged.length > 8) lines.push(`  ...and ${payload.unacknowledged.length - 8} more`);
  }
  if (payload.scopeMismatches?.length > 0) {
    lines.push(`- ${payload.scopeMismatches.length} bypass record(s) are outside approved request scope in ${payload.requestsDir}`);
    for (const row of payload.scopeMismatches.slice(0, 5)) {
      const target = row.file || row.command || row.tool || row.rule || row.hook || "(unknown target)";
      lines.push(`  ${row.fingerprint} line ${row.line}: ${target}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderExplainText(payload) {
  if (payload.status === "missing") {
    return `bypass explain: missing fingerprint ${payload.fingerprint}\n`;
  }
  const lines = [`bypass explain: ${payload.fingerprint}`];
  const row = payload.row || {};
  lines.push(`line: ${row._line}`);
  lines.push(`rule: ${row.rule || row.hook || row.hook_event_name || row.tool || "(unknown)"}`);
  if (row.file) lines.push(`file: ${row.file}`);
  if (row.command) lines.push(`command: ${row.command}`);
  if (row.reason) lines.push(`reason: ${row.reason}`);
  if (payload.requestMatches.length === 0) {
    lines.push(`matching requests: none`);
    lines.push(`next command: node .harness/scripts/bypass.mjs request --scope edit:<path> --reason "<why>"`);
  } else {
    lines.push(`matching requests: ${payload.requestMatches.length}`);
    for (const request of payload.requestMatches.slice(0, 5)) {
      lines.push(`  ${request.id} (${request.path}) approvedBy=${request.approvedBy || "(unapproved)"} expiresAt=${request.expiresAt || "(missing)"}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function usage() {
  return [
    "usage:",
    "  bypass request --task <taskId> --scope <kind:target> --reason <why> [--approved-by <name>]",
    "  bypass audit [--strict] [--json]",
    "  bypass explain <fingerprint> [--json]",
  ].join("\n");
}

export async function runBypassCli(argv = [], { exit = true } = {}) {
  const [command, ...rest] = argv;
  let exitCode = 0;
  try {
    if (command === "request") {
      const { opts, request } = parseRequestArgs(rest);
      const result = createBypassRequest(request);
      if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(`bypass request written: ${result.path}\n`);
    } else if (command === "audit") {
      const opts = parseAuditArgs(rest);
      const payload = auditBypassRecords(opts);
      if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      else process.stdout.write(renderBypassAuditText(payload));
      exitCode = payload.status === "passed" ? 0 : 1;
    } else if (command === "explain") {
      const opts = parseExplainArgs(rest);
      const payload = explainBypassFingerprint(opts);
      if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      else process.stdout.write(renderExplainText(payload));
      exitCode = payload.status === "found" ? 0 : 1;
    } else {
      process.stderr.write(`${usage()}\n`);
      exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`bypass: ${error.message}\n`);
    exitCode = 1;
  }
  if (exit) process.exit(exitCode);
  return { exitCode };
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  await runBypassCli(process.argv.slice(2));
}

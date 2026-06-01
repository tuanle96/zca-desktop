import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function insideRoot(root, path) {
  const normalizedRoot = normalizePath(root);
  const target = normalizePath(path);
  return target === normalizedRoot || target.startsWith(`${normalizedRoot}/`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function bypassRecordFingerprint(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);
}

function stableId(value) {
  return /^[a-z0-9][a-z0-9._-]*$/.test(String(value || ""));
}

function validDate(value) {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function normalizeRelPath(value) {
  return String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function globMatches(pattern, value) {
  const source = String(value || "");
  const escaped = String(pattern || "")
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(source);
}

function splitScope(scope) {
  const idx = String(scope || "").indexOf(":");
  if (idx <= 0) return { kind: "", target: "" };
  return {
    kind: scope.slice(0, idx),
    target: scope.slice(idx + 1),
  };
}

function scopeMatchesRow(scope, row) {
  const { kind, target } = splitScope(scope);
  if (!kind || !target) return false;
  if (kind === "command") return globMatches(target, row.command || "");
  if (kind === "edit") return globMatches(normalizeRelPath(target), normalizeRelPath(row.file || ""));
  if (kind === "tool") return globMatches(target, row.tool || "");
  if (kind === "rule") return globMatches(target, row.rule || "");
  if (kind === "hook") return globMatches(target, row.hook || row.hook_event_name || "");
  if (kind === "prompt") return globMatches(target, row.prompt || "");
  return false;
}

function requestCoversRowLoose(request, row) {
  if (request.taskId) {
    const rowTask = row.task_id || row.taskId || "";
    if (rowTask && rowTask !== request.taskId) return false;
  }
  return (Array.isArray(request.scope) ? request.scope : []).some((scope) => scopeMatchesRow(scope, row));
}

export function auditBypassRecords({
  cwd = process.cwd(),
  logPath = ".harness/bypass.log",
  ackPath = ".harness/bypass-audit.json",
  requestsDir = ".harness/bypass-requests",
  strict = false,
} = {}) {
  const root = resolve(cwd);
  const rel = (path) => relative(root, path).replaceAll("\\", "/") || ".";
  const errors = [];

  function resolveRepoPath(value, label) {
    const text = String(value || "").trim();
    if (!text || /^[a-z][a-z0-9+.-]*:/i.test(text)) {
      errors.push(`${label} must be a repo-local path`);
      return "";
    }
    const abs = resolve(root, text);
    if (!insideRoot(root, abs)) {
      errors.push(`${label} must stay inside the project root`);
      return "";
    }
    return abs;
  }

  function repoPathOk(value, label, { requireJson = false, mustExist = false } = {}) {
    const path = resolveRepoPath(value, label);
    if (!path) return "";
    if (requireJson && !String(value).endsWith(".json")) errors.push(`${label} must point to a JSON file`);
    if (mustExist && !existsSync(path)) errors.push(`${label} not found: ${value}`);
    return path;
  }

  function readJson(path) {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      errors.push(`${rel(path)}: invalid JSON (${error.message})`);
      return null;
    }
  }

  function readBypassRows(path) {
    if (!existsSync(path)) return [];
    const rows = [];
    const raw = readFileSync(path, "utf8");
    let lineNo = 0;
    for (const line of raw.split("\n")) {
      lineNo += 1;
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (!row || typeof row !== "object" || Array.isArray(row)) {
          errors.push(`${rel(path)}:${lineNo}: bypass row must be a JSON object`);
          continue;
        }
        rows.push({
          ...row,
          _line: lineNo,
          _fingerprint: bypassRecordFingerprint(row),
        });
      } catch (error) {
        errors.push(`${rel(path)}:${lineNo}: invalid JSONL (${error.message})`);
      }
    }
    return rows;
  }

  function validateAcknowledgements(ack, resolvedAckPath) {
    if (!ack) return [];
    if (!ack || typeof ack !== "object" || Array.isArray(ack)) {
      errors.push(`${rel(resolvedAckPath)}: must be a JSON object`);
      return [];
    }
    if (ack.schemaVersion !== 1) errors.push(`${rel(resolvedAckPath)}: schemaVersion must be 1`);
    if (!Array.isArray(ack.acknowledged)) {
      errors.push(`${rel(resolvedAckPath)}: acknowledged must be an array`);
      return [];
    }
    const seen = new Set();
    const valid = [];
    for (const [idx, entry] of ack.acknowledged.entries()) {
      const prefix = `${rel(resolvedAckPath)}: acknowledged[${idx}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push(`${prefix} must be an object`);
        continue;
      }
      if (!/^[0-9a-f]{16}$/.test(String(entry.fingerprint || ""))) {
        errors.push(`${prefix}.fingerprint must be a 16-character hex fingerprint`);
      }
      if (seen.has(entry.fingerprint)) errors.push(`${prefix}.fingerprint duplicates ${entry.fingerprint}`);
      seen.add(entry.fingerprint);
      if (!entry.reviewedAt || Number.isNaN(new Date(entry.reviewedAt).getTime())) {
        errors.push(`${prefix}.reviewedAt must be an ISO timestamp`);
      }
      if (!String(entry.reviewer || "").trim()) errors.push(`${prefix}.reviewer is required`);
      if (!["accepted", "converted-to-failure-record", "false-positive", "superseded"].includes(entry.disposition)) {
        errors.push(`${prefix}.disposition must be accepted, converted-to-failure-record, false-positive, or superseded`);
      }
      if (!String(entry.reason || "").trim()) errors.push(`${prefix}.reason is required`);
      if (strict && entry.disposition === "converted-to-failure-record") {
        if (!String(entry.failureRecord || "").trim()) {
          errors.push(`${prefix}.failureRecord is required when disposition=converted-to-failure-record`);
        } else {
          repoPathOk(entry.failureRecord, `${prefix}.failureRecord`, { requireJson: true, mustExist: true });
        }
      }
      valid.push(entry);
    }
    return valid;
  }

  function readRequestFiles(dir) {
    if (!existsSync(dir)) return [];
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json")) out.push(join(dir, entry.name));
    }
    return out.sort();
  }

  function validateRequest(request, path) {
    const prefix = rel(path);
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      return { status: "invalid", path: prefix, errors: [`${prefix}: must be a JSON object`] };
    }
    const requestErrors = [];
    const add = (message) => requestErrors.push(`${prefix}: ${message}`);
    if (request.schemaVersion !== 1) add("schemaVersion must be 1");
    if (!/^bypass-[a-z0-9][a-z0-9._-]*$/.test(String(request.id || ""))) add("id must be a stable id prefixed with bypass-");
    if (request.taskId !== undefined && !stableId(request.taskId)) add("taskId must be a stable lowercase id");
    if (!String(request.reason || "").trim()) add("reason is required");
    if (!String(request.requestedBy || "").trim()) add("requestedBy is required");
    if (!String(request.approvedBy || "").trim()) add("approvedBy is required in strict bypass requests");
    if (!validDate(request.expiresAt)) add("expiresAt must be an ISO timestamp");
    if (!Array.isArray(request.scope) || request.scope.length === 0) {
      add("scope must be a non-empty array");
    } else {
      const seen = new Set();
      for (const [idx, scope] of request.scope.entries()) {
        const scopePrefix = `scope[${idx}]`;
        if (typeof scope !== "string" || !scope.trim()) {
          add(`${scopePrefix} must be a non-empty string`);
          continue;
        }
        const { kind, target } = splitScope(scope);
        if (!["command", "edit", "tool", "rule", "hook", "prompt"].includes(kind) || !target) {
          add(`${scopePrefix} must use command:, edit:, tool:, rule:, hook:, or prompt:`);
        }
        if (kind === "edit") repoPathOk(target, `${prefix}: ${scopePrefix}`);
        if (seen.has(scope)) add(`${scopePrefix} duplicates ${scope}`);
        seen.add(scope);
      }
    }
    if (request.usedByRunId !== undefined && !String(request.usedByRunId || "").trim()) add("usedByRunId must be a non-empty string");
    return {
      status: requestErrors.length === 0 ? "valid" : "invalid",
      path: prefix,
      request,
      errors: requestErrors,
    };
  }

  const resolvedLogPath = resolveRepoPath(logPath, "--log");
  const resolvedAckPath = resolveRepoPath(ackPath, "--ack");
  const resolvedRequestsDir = resolveRepoPath(requestsDir, "--requests-dir");
  const rows = resolvedLogPath ? readBypassRows(resolvedLogPath) : [];
  const ack = resolvedAckPath ? readJson(resolvedAckPath) : null;
  const acknowledged = validateAcknowledgements(ack, resolvedAckPath);
  const acknowledgedSet = new Set(acknowledged.map((entry) => entry.fingerprint));
  const requestRecords = strict && resolvedRequestsDir
    ? readRequestFiles(resolvedRequestsDir).map((path) => validateRequest(readJson(path), path))
    : [];
  const requestErrors = requestRecords.flatMap((record) => record.errors || []);
  const now = Date.now();
  const validRequests = requestRecords
    .filter((record) => record.status === "valid")
    .map((record) => record.request);
  const expiredRequests = validRequests
    .filter((request) => new Date(request.expiresAt).getTime() <= now)
    .map((request) => ({
      id: request.id,
      expiresAt: request.expiresAt,
      scope: request.scope || [],
      taskId: request.taskId || "",
    }));
  const approvedActiveRequests = validRequests
    .filter((request) => String(request.approvedBy || "").trim())
    .filter((request) => new Date(request.expiresAt).getTime() > now);
  const scopeMismatches = [];
  const unacknowledged = rows
    .filter((row) => {
      if (acknowledgedSet.has(row._fingerprint)) return false;
      if (!strict) return true;
      const covering = approvedActiveRequests.find((request) => requestCoversRowLoose(request, row));
      if (covering) return false;
      scopeMismatches.push({
        fingerprint: row._fingerprint,
        line: row._line,
        command: row.command || "",
        file: row.file || "",
        tool: row.tool || "",
        rule: row.rule || "",
        hook: row.hook || row.hook_event_name || "",
        reason: "no approved, unexpired bypass request scope matches this bypass record",
      });
      return true;
    })
    .map((row) => ({
      fingerprint: row._fingerprint,
      line: row._line,
      ts: row.ts || "",
      bypass: row.bypass || "",
      rule: row.rule || "",
      hook: row.hook || "",
      hook_event_name: row.hook_event_name || "",
      tool: row.tool || "",
      reason: row.reason || "",
      command: row.command || "",
      prompt: row.prompt || "",
      file: row.file || "",
    }));

  if (strict) {
    errors.push(...requestErrors);
    for (const request of expiredRequests) errors.push(`bypass request ${request.id} expired at ${request.expiresAt}`);
  }

  return {
    status: errors.length === 0 && unacknowledged.length === 0 && (!strict || scopeMismatches.length === 0) ? "passed" : "failed",
    strict,
    logPath: resolvedLogPath ? rel(resolvedLogPath) : logPath,
    ackPath: resolvedAckPath ? rel(resolvedAckPath) : ackPath,
    requestsDir: resolvedRequestsDir ? rel(resolvedRequestsDir) : requestsDir,
    total: rows.length,
    acknowledged: acknowledgedSet.size,
    requests: {
      total: requestRecords.length,
      valid: requestRecords.filter((record) => record.status === "valid").length,
      approved: approvedActiveRequests.length,
      expired: expiredRequests,
    },
    scopeMismatches,
    unacknowledged,
    errors,
  };
}

export function createBypassRequest({
  cwd = process.cwd(),
  requestsDir = ".harness/bypass-requests",
  id,
  taskId,
  scope = [],
  reason,
  requestedBy = "human",
  approvedBy = "",
  expiresAt,
  usedByRunId = "",
} = {}) {
  const root = resolve(cwd);
  const dir = resolve(root, requestsDir);
  if (!insideRoot(root, dir)) throw new Error("--requests-dir must stay inside the project root");
  const now = new Date();
  const requestId = id || `bypass-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").toLowerCase()}`;
  if (!/^bypass-[a-z0-9][a-z0-9._-]*$/.test(requestId)) {
    throw new Error("--id must be a stable lowercase id prefixed with bypass-");
  }
  const scopes = Array.isArray(scope) ? scope : [scope].filter(Boolean);
  const expiry = expiresAt || new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  if (taskId !== undefined && taskId !== "" && !stableId(taskId)) throw new Error("--task must be a stable lowercase id");
  if (!String(reason || "").trim()) throw new Error("--reason is required");
  if (!String(requestedBy || "").trim()) throw new Error("--requested-by is required");
  if (!validDate(expiry)) throw new Error("--expires-at must be an ISO timestamp");
  if (scopes.length === 0) throw new Error("--scope is required");
  for (const item of scopes) {
    const { kind, target } = splitScope(item);
    if (!["command", "edit", "tool", "rule", "hook", "prompt"].includes(kind) || !target) {
      throw new Error("--scope must use command:, edit:, tool:, rule:, hook:, or prompt:");
    }
    if (kind === "edit" && !insideRoot(root, resolve(root, target))) {
      throw new Error("--scope edit target must stay inside the project root");
    }
  }
  const request = {
    schemaVersion: 1,
    id: requestId,
    reason,
    scope: scopes,
    requestedBy,
    expiresAt: expiry,
  };
  if (taskId) request.taskId = taskId;
  if (approvedBy) request.approvedBy = approvedBy;
  if (usedByRunId) request.usedByRunId = usedByRunId;
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${requestId}.json`);
  if (!insideRoot(root, path)) throw new Error("request path must stay inside the project root");
  if (existsSync(path)) throw new Error(`bypass request already exists: ${relative(root, path).replaceAll("\\", "/")}`);
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`);
  return {
    request,
    path: relative(root, path).replaceAll("\\", "/"),
  };
}

export function explainBypassFingerprint({
  cwd = process.cwd(),
  fingerprint,
  logPath = ".harness/bypass.log",
  ackPath = ".harness/bypass-audit.json",
  requestsDir = ".harness/bypass-requests",
} = {}) {
  const audit = auditBypassRecords({ cwd, logPath, ackPath, requestsDir, strict: true });
  const root = resolve(cwd);
  const log = resolve(root, logPath);
  const rows = existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line, idx) => {
      try {
        const row = JSON.parse(line);
        return { ...row, _line: idx + 1, _fingerprint: bypassRecordFingerprint(row) };
      } catch {
        return null;
      }
    }).filter(Boolean)
    : [];
  const row = rows.find((item) => item._fingerprint === fingerprint);
  const requestMatches = [];
  const requestsPath = resolve(root, requestsDir);
  if (existsSync(requestsPath)) {
    for (const path of readdirSync(requestsPath, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => join(requestsPath, entry.name))) {
      try {
        const request = JSON.parse(readFileSync(path, "utf8"));
        if (row && requestCoversRowForExplain(request, row)) {
          requestMatches.push({
            id: request.id,
            path: relative(root, path).replaceAll("\\", "/"),
            expiresAt: request.expiresAt,
            approvedBy: request.approvedBy || "",
            scope: Array.isArray(request.scope) ? request.scope : [],
          });
        }
      } catch {
        // The main audit payload already reports malformed request files.
      }
    }
  }
  return {
    status: row ? "found" : "missing",
    fingerprint,
    row: row || null,
    requestMatches,
    audit,
  };
}

function requestCoversRowForExplain(request, row) {
  return request && typeof request === "object" && requestCoversRowLoose(request, row);
}

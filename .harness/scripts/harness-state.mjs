#!/usr/bin/env node
// harness-state.mjs - SQLite-backed operational state for intake, stories,
// backlog items, and task traces. Uses the system sqlite3 CLI to avoid adding a
// native npm dependency to generated projects.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const DEFAULT_DB = ".harness/state/harness.db";
const DEFAULT_SCHEMA = ".harness/state/schema.sql";
const CURRENT_SCHEMA_VERSION = 1;
const TIER_SCORE = { insufficient: 0, minimal: 1, standard: 2, detailed: 3 };
const SCORE_TIER = ["insufficient", "minimal", "standard", "detailed"];
const REQUIRED_BY_LANE = { tiny: 1, normal: 2, "high-risk": 3 };
const EXPECTED_TABLES = [
  "schema_version",
  "state_migration",
  "intake",
  "story",
  "decision_record",
  "backlog",
  "trace",
  "session_worktree",
];
const EXPORT_TABLES = ["intake", "story", "decision_record", "backlog", "trace", "session_worktree"];
const SECRET_RE = /\b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{20,}|(?:api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*["']?[^"',\s]+)["']?/gi;

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    db: null,
    schema: null,
    json: false,
    strict: false,
    rest: [],
  };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--db=")) opts.db = arg.slice("--db=".length);
    else if (arg.startsWith("--schema=")) opts.schema = arg.slice("--schema=".length);
    else opts.rest.push(arg);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const ROOT = resolve(opts.cwd);

function rel(path) {
  return path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path;
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function config() {
  return readJson(resolve(ROOT, ".harness/config.json")) ||
    readJson(resolve(ROOT, "harness.config.json")) ||
    {};
}

const cfg = config();
const stateCfg = cfg.operationalState || {};
const dbPath = resolve(ROOT, opts.db || stateCfg.dbPath || DEFAULT_DB);
const schemaPath = resolveSchemaPath(opts.schema || stateCfg.schemaPath || DEFAULT_SCHEMA);

function resolveSchemaPath(input) {
  const primary = resolve(ROOT, input);
  if (existsSync(primary)) return primary;
  const kitSelf = resolve(ROOT, "src/templates/.harness/state/schema.sql");
  if (existsSync(kitSelf)) return kitSelf;
  return primary;
}

function die(message) {
  console.error(`harness-state: ${message}`);
  process.exit(1);
}

function sqliteAvailable() {
  const result = spawnSync("sqlite3", ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

function requireSqlite() {
  if (!sqliteAvailable()) {
    die("sqlite3 is required for operational state. Install sqlite3 or disable the operational-state readiness gate.");
  }
}

function runSql(sql, { db = dbPath, json = false, allowMissingDb = false } = {}) {
  requireSqlite();
  if (!allowMissingDb && !existsSync(db)) {
    die(`database not found at ${rel(db)}. Run: node .harness/scripts/harness-state.mjs init`);
  }
  mkdirSync(dirname(db), { recursive: true });
  const input = json ? `.mode json\n${sql}\n` : `${sql}\n`;
  const result = spawnSync("sqlite3", [db], {
    cwd: ROOT,
    input,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    die(detail || `sqlite3 exited with ${result.status}`);
  }
  if (!json) return result.stdout.trim();
  const text = result.stdout.trim();
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch (error) {
    die(`could not parse sqlite JSON output: ${error.message}`);
  }
}

function runSqlSafe(sql, { db = dbPath, json = false, allowMissingDb = false } = {}) {
  if (!sqliteAvailable()) {
    return { ok: false, status: 127, stdout: "", stderr: "sqlite3 is not available", rows: null };
  }
  if (!allowMissingDb && !existsSync(db)) {
    return { ok: false, status: 1, stdout: "", stderr: `database not found at ${rel(db)}`, rows: null };
  }
  mkdirSync(dirname(db), { recursive: true });
  const input = json ? `.mode json\n${sql}\n` : `${sql}\n`;
  const result = spawnSync("sqlite3", [db], {
    cwd: ROOT,
    input,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const payload = {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    rows: null,
  };
  if (payload.ok && json) {
    const text = payload.stdout.trim();
    try {
      payload.rows = text ? JSON.parse(text) : [];
    } catch (error) {
      payload.ok = false;
      payload.status = 1;
      payload.stderr = `could not parse sqlite JSON output: ${error.message}`;
    }
  }
  return payload;
}

function migrationSql() {
  return `
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO schema_version (version) VALUES (${CURRENT_SCHEMA_VERSION});
    CREATE TABLE IF NOT EXISTS state_migration (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO state_migration (version, name) VALUES (${CURRENT_SCHEMA_VERSION}, 'initial-operational-state');
  `;
}

function initDb({ db = dbPath } = {}) {
  requireSqlite();
  if (!existsSync(schemaPath)) die(`schema file missing: ${rel(schemaPath)}`);
  mkdirSync(dirname(db), { recursive: true });
  const schema = readFileSync(schemaPath, "utf8");
  runSql(schema, { db, allowMissingDb: true });
  return db;
}

function expectedTableStatus() {
  const result = runSqlSafe("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;", { json: true });
  if (!result.ok) return { ok: false, error: result.stderr.trim() || result.stdout.trim(), tables: [], missing: EXPECTED_TABLES };
  const tables = (result.rows || []).map((row) => row.name).filter(Boolean);
  const missing = EXPECTED_TABLES.filter((table) => !tables.includes(table));
  return { ok: missing.length === 0, tables, missing };
}

function migrationStatus() {
  if (!existsSync(dbPath)) {
    return { status: "not-initialized", currentVersion: null, requiredVersion: CURRENT_SCHEMA_VERSION, pending: [CURRENT_SCHEMA_VERSION], rows: [] };
  }
  const table = runSqlSafe("SELECT name FROM sqlite_master WHERE type='table' AND name='state_migration';", { json: true });
  if (!table.ok) return { status: "failed", error: table.stderr.trim() || table.stdout.trim(), currentVersion: null, requiredVersion: CURRENT_SCHEMA_VERSION, pending: [CURRENT_SCHEMA_VERSION], rows: [] };
  if ((table.rows || []).length === 0) {
    return { status: "pending", currentVersion: 0, requiredVersion: CURRENT_SCHEMA_VERSION, pending: [CURRENT_SCHEMA_VERSION], rows: [] };
  }
  const rows = runSqlSafe("SELECT version, name, applied_at FROM state_migration ORDER BY version;", { json: true });
  if (!rows.ok) return { status: "failed", error: rows.stderr.trim() || rows.stdout.trim(), currentVersion: null, requiredVersion: CURRENT_SCHEMA_VERSION, pending: [CURRENT_SCHEMA_VERSION], rows: [] };
  const currentVersion = Math.max(0, ...(rows.rows || []).map((row) => Number(row.version) || 0));
  const pending = currentVersion >= CURRENT_SCHEMA_VERSION ? [] : [CURRENT_SCHEMA_VERSION];
  return {
    status: pending.length === 0 ? "current" : "pending",
    currentVersion,
    requiredVersion: CURRENT_SCHEMA_VERSION,
    pending,
    rows: rows.rows || [],
  };
}

function integrityStatus() {
  if (!existsSync(dbPath)) return { status: "not-initialized", ok: true, detail: "database has not been initialized yet" };
  const result = runSqlSafe("PRAGMA integrity_check;", { json: true });
  if (!result.ok) return { status: "failed", ok: false, detail: result.stderr.trim() || result.stdout.trim() };
  const details = (result.rows || []).map((row) => row.integrity_check || Object.values(row)[0]).filter(Boolean);
  const ok = details.length === 1 && details[0] === "ok";
  return { status: ok ? "passed" : "failed", ok, detail: details.join("; ") || "no integrity_check output" };
}

function diagnoseState() {
  const sqlite = sqliteAvailable();
  const schemaExists = existsSync(schemaPath);
  const dbExists = existsSync(dbPath);
  const errors = [];
  const warnings = [];
  if (!sqlite) errors.push("sqlite3 is not available");
  if (!schemaExists) errors.push(`schema file missing: ${rel(schemaPath)}`);

  let tables = { ok: !dbExists, tables: [], missing: dbExists ? EXPECTED_TABLES : [] };
  let migrations = { status: dbExists ? "unknown" : "not-initialized", currentVersion: null, requiredVersion: CURRENT_SCHEMA_VERSION, pending: dbExists ? [CURRENT_SCHEMA_VERSION] : [], rows: [] };
  let integrity = { status: dbExists ? "unknown" : "not-initialized", ok: true, detail: "database has not been initialized yet" };
  let traceQuality = { status: "passed", rows: 0, failures: [] };

  if (sqlite && schemaExists && dbExists) {
    integrity = integrityStatus();
    if (!integrity.ok) errors.push(`database integrity failed: ${integrity.detail}`);
    tables = expectedTableStatus();
    if (!tables.ok) errors.push(`missing table(s): ${tables.missing.join(", ")}`);
    migrations = migrationStatus();
    if (migrations.status === "pending") warnings.push(`pending state migration(s): ${migrations.pending.join(", ")}`);
    if (migrations.status === "failed") errors.push(`migration status failed: ${migrations.error}`);
    if (tables.ok && integrity.ok) {
      traceQuality = scoreStoredTraces();
      if (traceQuality.status !== "passed" && opts.strict) errors.push("trace quality failed");
    }
  }

  return {
    status: errors.length === 0 ? "passed" : "failed",
    errors,
    warnings,
    sqlite,
    dbPath: rel(dbPath),
    schemaPath: rel(schemaPath),
    dbExists,
    schemaExists,
    integrity,
    migrations,
    tables,
    traceQuality,
  };
}

function doctorState() {
  const payload = diagnoseState();
  printPayload(payload, `state-doctor: ${payload.status === "passed" ? "OK" : "FAILED"}`);
  if (payload.status !== "passed") process.exit(1);
}

function migrateState(args) {
  const values = parseKeyValues(args);
  const dryRun = values["dry-run"] === "1";
  requireSqlite();
  const before = existsSync(dbPath) ? migrationStatus() : { status: "not-initialized", currentVersion: null, pending: [CURRENT_SCHEMA_VERSION], rows: [] };
  const pending = before.status === "current" ? [] : [CURRENT_SCHEMA_VERSION];
  const payload = {
    status: dryRun ? "planned" : "applied",
    dryRun,
    dbPath: rel(dbPath),
    schemaPath: rel(schemaPath),
    currentVersion: before.currentVersion,
    requiredVersion: CURRENT_SCHEMA_VERSION,
    pending,
  };
  if (!dryRun) {
    initDb();
    runSql(migrationSql(), { allowMissingDb: false });
    payload.after = migrationStatus();
  }
  printPayload(payload, dryRun
    ? `state-migrate: ${pending.length ? `pending ${pending.join(", ")}` : "no pending migrations"}`
    : "state-migrate: OK");
}

function checkOperationalState() {
  requireSqlite();
  if (!existsSync(schemaPath)) die(`schema file missing: ${rel(schemaPath)}`);
  const tmp = mkdtempSync(resolve(tmpdir(), "ahk-state-check-"));
  const tempDb = resolve(tmp, "harness.db");
  try {
    initDb({ db: tempDb });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (!existsSync(dbPath)) {
    const payload = {
      status: "passed",
      dbPath: rel(dbPath),
      schemaPath: rel(schemaPath),
      message: "schema valid; operational database has not been initialized yet",
      traceQuality: { status: "passed", rows: 0, failures: [] },
    };
    printPayload(payload, `operational-state: OK (${payload.message})`);
    return;
  }

  const diagnostics = diagnoseState();
  if (diagnostics.status !== "passed") {
    printPayload(diagnostics, "operational-state: FAILED");
    process.exit(1);
  }
  const traceQuality = diagnostics.traceQuality;
  const payload = {
    status: traceQuality.status,
    dbPath: rel(dbPath),
    schemaPath: rel(schemaPath),
    integrity: diagnostics.integrity,
    migrations: diagnostics.migrations,
    traceQuality,
  };
  printPayload(payload, `operational-state: ${payload.status === "passed" ? "OK" : "FAILED"}`);
  if (payload.status !== "passed") process.exit(1);
}

function parseKeyValues(args) {
  const values = {};
  const positional = [];
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        values[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (args[idx + 1] && !args[idx + 1].startsWith("--")) {
        values[body] = args[idx + 1];
        idx += 1;
      } else {
        values[body] = "1";
      }
    } else {
      positional.push(arg);
    }
  }
  values._ = positional;
  return values;
}

function required(values, key) {
  const value = values[key];
  if (value === undefined || value === "") die(`--${key} is required`);
  return value;
}

function normalizeToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeInputType(value) {
  const token = normalizeToken(value);
  const aliases = {
    new_spec: "new_spec",
    spec_slice: "spec_slice",
    change_request: "change_request",
    new_initiative: "new_initiative",
    maintenance: "maintenance",
    maintenance_request: "maintenance",
    harness_improvement: "harness_improvement",
  };
  if (!aliases[token]) {
    die(`unknown input type "${value}". Use new_spec, spec_slice, change_request, new_initiative, maintenance, or harness_improvement.`);
  }
  return aliases[token];
}

function normalizeLane(value) {
  const token = normalizeToken(value || "normal");
  if (token === "tiny") return "tiny";
  if (token === "normal") return "normal";
  if (token === "high_risk") return "high-risk";
  die(`unknown lane "${value}". Use tiny, normal, or high-risk.`);
}

function normalizeStatus(value, allowed, fallback) {
  const token = normalizeToken(value || fallback);
  const normalized = token.replaceAll("_", "-");
  if (allowed.includes(token)) return token;
  if (allowed.includes(normalized)) return normalized;
  die(`unknown status "${value}". Use: ${allowed.join(", ")}.`);
}

function boolFlag(value) {
  if (value === undefined) return null;
  if (value === "0" || value === 0 || value === false) return 0;
  if (value === "1" || value === 1 || value === true) return 1;
  die("proof flags must be 0 or 1");
}

function integerValue(label, value) {
  if (value === undefined || value === "") return null;
  if (!/^\d+$/.test(String(value))) die(`${label} must be a positive integer`);
  return Number(value);
}

function sqlValue(value) {
  if (value === undefined || value === null || value === "") return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNumber(value) {
  return value === undefined || value === null ? "NULL" : String(value);
}

function csvArray(value) {
  if (value === undefined || value === null || value === "") return null;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function jsonText(value) {
  const array = Array.isArray(value) ? value : csvArray(value);
  if (!array || array.length === 0) return null;
  return JSON.stringify(array);
}

function parseJsonArrayText(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(value)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

function scoreTrace(trace) {
  const reasons = [];
  const hasSummary = typeof trace.task_summary === "string" && trace.task_summary.trim().length >= 10;
  const hasOutcome = typeof trace.outcome === "string" && trace.outcome.trim().length > 0;
  const actions = parseJsonArrayText(trace.actions_taken);
  const read = parseJsonArrayText(trace.files_read);
  const changed = parseJsonArrayText(trace.files_changed);
  const decisions = parseJsonArrayText(trace.decisions_made);
  const errors = parseJsonArrayText(trace.errors);
  const hasFriction = typeof trace.harness_friction === "string" && trace.harness_friction.trim().length > 0;

  let score = 0;
  if (hasSummary && hasOutcome) {
    score = 1;
  } else {
    if (!hasSummary) reasons.push("minimal requires task_summary with at least 10 characters");
    if (!hasOutcome) reasons.push("minimal requires outcome");
  }

  const standardMissing = [];
  if (!trace.agent) standardMissing.push("agent");
  if (actions.length === 0) standardMissing.push("actions_taken");
  if (read.length === 0) standardMissing.push("files_read");
  if (changed.length === 0) standardMissing.push("files_changed");
  if (errors.length === 0 && !hasFriction) standardMissing.push("errors or harness_friction");
  if (score >= 1 && standardMissing.length === 0) score = 2;
  else if (score >= 1) reasons.push(`standard missing: ${standardMissing.join(", ")}`);

  const detailedMissing = [];
  if (decisions.length === 0) detailedMissing.push("decisions_made");
  if (errors.length === 0) detailedMissing.push("errors");
  if (!hasFriction) detailedMissing.push("harness_friction");
  if (!trace.duration_seconds && !trace.token_estimate) detailedMissing.push("duration_seconds or token_estimate");
  if (score >= 2 && detailedMissing.length === 0) score = 3;
  else if (score >= 2) reasons.push(`detailed missing: ${detailedMissing.join(", ")}`);

  const tier = SCORE_TIER[score] || "insufficient";
  const lane = normalizeLane(trace.risk_lane || "normal");
  const requiredScore = REQUIRED_BY_LANE[lane] ?? 2;
  if (score < requiredScore) {
    reasons.push(`${lane} lane requires ${SCORE_TIER[requiredScore]} trace quality`);
  }
  return {
    score,
    tier,
    requiredScore,
    requiredTier: SCORE_TIER[requiredScore],
    reasons,
  };
}

function recordIntake(args) {
  const values = parseKeyValues(args);
  initDb();
  const sql = `
    INSERT INTO intake (input_type, summary, risk_lane, risk_flags, affected_docs, story_id, notes)
    VALUES (
      ${sqlValue(normalizeInputType(required(values, "type")))},
      ${sqlValue(required(values, "summary"))},
      ${sqlValue(normalizeLane(required(values, "lane")))},
      ${sqlValue(jsonText(values.flags))},
      ${sqlValue(jsonText(values.docs))},
      ${sqlValue(values.story)},
      ${sqlValue(values.notes)}
    );
    SELECT last_insert_rowid() AS id;
  `;
  const rows = runSql(sql, { json: true });
  console.log(`Intake #${rows.at(-1)?.id ?? "?"} recorded.`);
}

function addStory(args) {
  const values = parseKeyValues(args);
  initDb();
  runSql(`
    INSERT INTO story (id, title, risk_lane, contract_doc, notes)
    VALUES (
      ${sqlValue(required(values, "id"))},
      ${sqlValue(required(values, "title"))},
      ${sqlValue(normalizeLane(required(values, "lane")))},
      ${sqlValue(values.contract)},
      ${sqlValue(values.notes)}
    );
  `);
  console.log(`Story ${values.id} added.`);
}

function updateStory(args) {
  const values = parseKeyValues(args);
  initDb();
  const id = required(values, "id");
  const status = values.status
    ? normalizeStatus(values.status, ["planned", "in_progress", "implemented", "changed", "retired"], "planned")
    : null;
  runSql(`
    UPDATE story SET
      status=COALESCE(${sqlValue(status)}, status),
      evidence=COALESCE(${sqlValue(values.evidence)}, evidence),
      unit_proof=COALESCE(${sqlNumber(boolFlag(values.unit))}, unit_proof),
      integration_proof=COALESCE(${sqlNumber(boolFlag(values.integration))}, integration_proof),
      e2e_proof=COALESCE(${sqlNumber(boolFlag(values.e2e))}, e2e_proof),
      platform_proof=COALESCE(${sqlNumber(boolFlag(values.platform))}, platform_proof)
    WHERE id=${sqlValue(id)};
  `);
  console.log(`Story ${id} updated.`);
}

function addDecision(args) {
  const values = parseKeyValues(args);
  initDb();
  const status = normalizeStatus(values.status, ["proposed", "accepted", "superseded", "rejected"], "accepted");
  runSql(`
    INSERT INTO decision_record (id, title, status, doc_path, verify_command, predicted_impact, notes)
    VALUES (
      ${sqlValue(required(values, "id"))},
      ${sqlValue(required(values, "title"))},
      ${sqlValue(status)},
      ${sqlValue(values.doc)},
      ${sqlValue(values.verify)},
      ${sqlValue(values.predicted)},
      ${sqlValue(values.notes)}
    );
  `);
  console.log(`Decision ${values.id} added.`);
}

function addBacklog(args) {
  const values = parseKeyValues(args);
  initDb();
  runSql(`
    INSERT INTO backlog (title, discovered_while, current_pain, suggested_improvement, risk, predicted_impact, notes)
    VALUES (
      ${sqlValue(required(values, "title"))},
      ${sqlValue(values.while)},
      ${sqlValue(values.pain)},
      ${sqlValue(values.suggestion)},
      ${sqlValue(values.risk ? normalizeLane(values.risk) : null)},
      ${sqlValue(values.predicted)},
      ${sqlValue(values.notes)}
    );
  `);
  console.log("Backlog item recorded.");
}

function closeBacklog(args) {
  const values = parseKeyValues(args);
  initDb();
  const id = integerValue("--id", required(values, "id"));
  const status = normalizeStatus(values.status, ["proposed", "accepted", "implemented", "rejected"], "implemented");
  runSql(`
    UPDATE backlog
    SET status=${sqlValue(status)}, actual_outcome=${sqlValue(values.outcome)}, implemented_at=datetime('now')
    WHERE id=${sqlNumber(id)};
  `);
  console.log(`Backlog #${id} closed as ${status}.`);
}

function recordTrace(args) {
  const values = parseKeyValues(args);
  initDb();
  const trace = {
    task_summary: required(values, "summary"),
    outcome: values.outcome || null,
    risk_lane: normalizeLane(values.lane || "normal"),
    agent: values.agent || null,
    actions_taken: jsonText(values.actions),
    files_read: jsonText(values.read),
    files_changed: jsonText(values.changed),
    decisions_made: jsonText(values.decisions),
    errors: jsonText(values.errors),
    harness_friction: values.friction || null,
    duration_seconds: integerValue("--duration", values.duration),
    token_estimate: integerValue("--tokens", values.tokens),
  };
  const quality = scoreTrace(trace);
  runSql(`
    INSERT INTO trace (
      task_summary, intake_id, story_id, agent, risk_lane, actions_taken, files_read,
      files_changed, decisions_made, errors, outcome, duration_seconds,
      token_estimate, harness_friction, trace_quality_score,
      trace_quality_tier, trace_quality_reasons, notes
    ) VALUES (
      ${sqlValue(trace.task_summary)},
      ${sqlNumber(integerValue("--intake", values.intake))},
      ${sqlValue(values.story)},
      ${sqlValue(trace.agent)},
      ${sqlValue(trace.risk_lane)},
      ${sqlValue(trace.actions_taken)},
      ${sqlValue(trace.files_read)},
      ${sqlValue(trace.files_changed)},
      ${sqlValue(trace.decisions_made)},
      ${sqlValue(trace.errors)},
      ${sqlValue(trace.outcome)},
      ${sqlNumber(trace.duration_seconds)},
      ${sqlNumber(trace.token_estimate)},
      ${sqlValue(trace.harness_friction)},
      ${sqlNumber(quality.score)},
      ${sqlValue(quality.tier)},
      ${sqlValue(jsonText(quality.reasons))},
      ${sqlValue(values.notes)}
    );
  `);
  console.log(`Trace recorded (${quality.tier}, score ${quality.score}/${quality.requiredScore}).`);
  if (quality.reasons.length > 0) {
    for (const reason of quality.reasons) console.log(`- ${reason}`);
  }
}

function recordSessionWorktree(args) {
  const values = parseKeyValues(args);
  initDb();
  const status = normalizeStatus(values.status, ["planned", "active", "stale", "removed", "closed"], "active");
  const sessionId = required(values, "session-id");
  runSql(`
    INSERT INTO session_worktree (
      session_id, task_id, branch, base_ref, source_root, worktree_path,
      manifest_path, active_task_env, status, notes, updated_at
    ) VALUES (
      ${sqlValue(sessionId)},
      ${sqlValue(required(values, "task"))},
      ${sqlValue(required(values, "branch"))},
      ${sqlValue(values.base)},
      ${sqlValue(required(values, "source-root"))},
      ${sqlValue(required(values, "worktree"))},
      ${sqlValue(values.manifest)},
      ${sqlValue(values["active-task-env"])},
      ${sqlValue(status)},
      ${sqlValue(values.notes)},
      datetime('now')
    )
    ON CONFLICT(session_id) DO UPDATE SET
      task_id=excluded.task_id,
      branch=excluded.branch,
      base_ref=excluded.base_ref,
      source_root=excluded.source_root,
      worktree_path=excluded.worktree_path,
      manifest_path=excluded.manifest_path,
      active_task_env=excluded.active_task_env,
      status=excluded.status,
      notes=COALESCE(excluded.notes, session_worktree.notes),
      updated_at=datetime('now');
  `);
  console.log(`Session worktree ${sessionId} recorded (${status}).`);
}

function query(view, args) {
  if (!existsSync(dbPath)) die(`database not found at ${rel(dbPath)}. Run init first.`);
  const values = parseKeyValues(args);
  const limit = Math.min(integerValue("--limit", values.limit) || 20, 200);
  const sqlByView = {
    stats: `SELECT
      (SELECT COUNT(*) FROM intake) AS intakes,
      (SELECT COUNT(*) FROM story) AS stories,
      (SELECT COUNT(*) FROM decision_record) AS decisions,
      (SELECT COUNT(*) FROM backlog) AS backlog_items,
      (SELECT COUNT(*) FROM trace) AS traces,
      (SELECT COUNT(*) FROM session_worktree) AS session_worktrees;`,
    matrix: `SELECT id, title, status, unit_proof AS unit, integration_proof AS integration, e2e_proof AS e2e, platform_proof AS platform, evidence FROM story ORDER BY id;`,
    intakes: `SELECT id, created_at, input_type, risk_lane, summary, story_id FROM intake ORDER BY id DESC LIMIT ${limit};`,
    traces: `SELECT id, created_at, outcome, risk_lane, trace_quality_tier, task_summary, harness_friction FROM trace ORDER BY id DESC LIMIT ${limit};`,
    friction: `SELECT id, created_at, risk_lane, trace_quality_tier, task_summary, harness_friction FROM trace WHERE harness_friction IS NOT NULL AND trim(harness_friction) <> '' ORDER BY id DESC LIMIT ${limit};`,
    backlog: `SELECT id, title, status, risk, predicted_impact, actual_outcome FROM backlog ORDER BY status, id LIMIT ${limit};`,
    decisions: `SELECT id, title, status, doc_path, predicted_impact, actual_outcome FROM decision_record ORDER BY id LIMIT ${limit};`,
    "session-worktrees": `SELECT session_id, task_id, status, branch, worktree_path, manifest_path, updated_at FROM session_worktree ORDER BY updated_at DESC LIMIT ${limit};`,
  };
  if (view === "sql") {
    const sql = values._.join(" ").trim();
    if (!sql) die("query sql requires a SQL statement");
    printRows(runSql(sql, { json: true }));
    return;
  }
  const sql = sqlByView[view];
  if (!sql) die(`unknown query view "${view}". Use stats, matrix, intakes, traces, friction, backlog, decisions, session-worktrees, or sql.`);
  printRows(runSql(sql, { json: true }));
}

function redactScalar(value, { redact = true } = {}) {
  if (!redact || value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  let text = String(value);
  text = text.replace(SECRET_RE, (match) => {
    const prefix = match.includes("=") ? match.slice(0, match.indexOf("=") + 1) : match.includes(":") ? match.slice(0, match.indexOf(":") + 1) : "";
    return `${prefix}<redacted-secret>`;
  });
  if (text.startsWith(ROOT)) {
    return `<repo>/${rel(text)}`;
  }
  text = text.replaceAll(ROOT, "<repo>");
  text = text.replace(/\/(?:Users|home|private|var|tmp)\/[^\s"',)]+/g, "<path>");
  return text;
}

function redactValue(value, options) {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, options));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, options)]));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
      try {
        return redactValue(JSON.parse(trimmed), options);
      } catch {
        return redactScalar(value, options);
      }
    }
  }
  return redactScalar(value, options);
}

function exportState(args) {
  if (!existsSync(dbPath)) die(`database not found at ${rel(dbPath)}. Run init first.`);
  const values = parseKeyValues(args);
  const redact = values.redact !== "0" && values.unredacted !== "1";
  const tables = {};
  for (const table of EXPORT_TABLES) {
    const exists = runSqlSafe(`SELECT name FROM sqlite_master WHERE type='table' AND name=${sqlValue(table)};`, { json: true });
    if (!exists.ok || (exists.rows || []).length === 0) continue;
    const rows = runSql(`SELECT * FROM ${table} ORDER BY rowid;`, { json: true });
    tables[table] = rows.map((row) => redactValue(row, { redact }));
  }
  const payload = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    redacted: redact,
    dbPath: redact ? redactScalar(dbPath) : rel(dbPath),
    tables,
  };
  console.log(JSON.stringify(payload, null, 2));
}

function parseOlderThanDays(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d+)(?:d|day|days)?$/i);
  if (!match) die("--older-than must be a day count like 30d");
  const days = Number(match[1]);
  if (!Number.isInteger(days) || days < 1) die("--older-than must be at least 1 day");
  return days;
}

function pruneState(args) {
  if (!existsSync(dbPath)) die(`database not found at ${rel(dbPath)}. Run init first.`);
  const values = parseKeyValues(args);
  const defaultDays = stateCfg.retention?.maxAgeDays ?? stateCfg.retentionDays ?? 30;
  const days = parseOlderThanDays(values["older-than"] || `${defaultDays}d`);
  const dryRun = values["dry-run"] === "1";
  const cutoff = `datetime('now', '-${days} days')`;
  const targets = [
    { table: "trace", where: `created_at < ${cutoff}` },
    { table: "intake", where: `created_at < ${cutoff}` },
    { table: "backlog", where: `created_at < ${cutoff} AND status IN ('implemented', 'rejected')` },
    { table: "session_worktree", where: `updated_at < ${cutoff} AND status IN ('removed', 'closed', 'stale')` },
  ];
  const results = [];
  for (const target of targets) {
    const countRows = runSql(`SELECT COUNT(*) AS count FROM ${target.table} WHERE ${target.where};`, { json: true });
    const count = Number(countRows[0]?.count || 0);
    results.push({ table: target.table, count });
    if (!dryRun && count > 0) runSql(`DELETE FROM ${target.table} WHERE ${target.where};`);
  }
  const payload = { status: dryRun ? "planned" : "pruned", dryRun, olderThanDays: days, results };
  printPayload(payload, `state-prune: ${dryRun ? "planned" : "OK"} (${results.reduce((sum, item) => sum + item.count, 0)} rows)`);
}

function explainState(id, args) {
  if (!existsSync(dbPath)) die(`database not found at ${rel(dbPath)}. Run init first.`);
  if (!id) die("state explain requires a runId, trace id, story id, or session id");
  const values = parseKeyValues(args);
  const redact = values.redact === "1";
  const numericId = /^\d+$/.test(String(id)) ? Number(id) : null;
  const queries = {
    traces: numericId !== null
      ? `SELECT * FROM trace WHERE id=${sqlNumber(numericId)} OR story_id=${sqlValue(id)} ORDER BY id;`
      : `SELECT * FROM trace WHERE story_id=${sqlValue(id)} ORDER BY id;`,
    stories: `SELECT * FROM story WHERE id=${sqlValue(id)};`,
    intakes: numericId !== null
      ? `SELECT * FROM intake WHERE id=${sqlNumber(numericId)};`
      : `SELECT * FROM intake WHERE story_id=${sqlValue(id)} ORDER BY id;`,
    decisions: `SELECT * FROM decision_record WHERE id=${sqlValue(id)};`,
    backlog: numericId !== null ? `SELECT * FROM backlog WHERE id=${sqlNumber(numericId)};` : "SELECT * FROM backlog WHERE 0;",
    sessionWorktrees: `SELECT * FROM session_worktree WHERE session_id=${sqlValue(id)} OR task_id=${sqlValue(id)} ORDER BY updated_at DESC;`,
  };
  const payload = {
    id,
    redacted: redact,
    matches: Object.fromEntries(Object.entries(queries).map(([key, sql]) => [
      key,
      runSql(sql, { json: true }).map((row) => redactValue(row, { redact })),
    ])),
  };
  const total = Object.values(payload.matches).reduce((sum, rows) => sum + rows.length, 0);
  payload.status = total > 0 ? "found" : "missing";
  if (opts.json || redact) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`state-explain: ${payload.status} (${total} row(s))`);
    printRows(Object.entries(payload.matches).flatMap(([kind, rows]) => rows.map((row) => ({ kind, ...row }))));
  }
  if (total === 0) process.exit(1);
}

function scoreStoredTraces() {
  if (!existsSync(dbPath)) {
    return { status: "passed", rows: 0, failures: [] };
  }
  const rows = runSql("SELECT * FROM trace ORDER BY id;", { json: true });
  const scored = rows.map((row) => {
    const quality = scoreTrace(row);
    return {
      id: row.id,
      task_summary: row.task_summary,
      risk_lane: normalizeLane(row.risk_lane || "normal"),
      score: quality.score,
      tier: quality.tier,
      requiredScore: quality.requiredScore,
      requiredTier: quality.requiredTier,
      reasons: quality.reasons,
    };
  });
  const failures = scored.filter((row) => row.score < row.requiredScore);
  return {
    status: failures.length === 0 ? "passed" : "failed",
    rows: scored.length,
    failures,
    traces: scored,
  };
}

function traceQuality() {
  const payload = scoreStoredTraces();
  printPayload(payload, `trace-quality: ${payload.status === "passed" ? "OK" : "FAILED"} (${payload.rows} traces)`);
  if ((opts.strict || payload.status === "failed") && payload.status !== "passed") process.exit(1);
}

function printRows(rows) {
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("(no rows)");
    return;
  }
  const headers = Object.keys(rows[0]);
  const widths = headers.map((header) => Math.max(header.length, ...rows.map((row) => String(row[header] ?? "").length)));
  console.log(headers.map((header, index) => header.padEnd(widths[index])).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(headers.map((header, index) => String(row[header] ?? "").padEnd(widths[index])).join("  "));
  }
}

function printPayload(payload, text) {
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(text);
    for (const error of payload.errors || []) console.log(`error: ${error}`);
    for (const warning of payload.warnings || []) console.log(`warning: ${warning}`);
    if (payload.integrity?.detail) console.log(`integrity: ${payload.integrity.detail}`);
    if (payload.migrations?.status) console.log(`migrations: ${payload.migrations.status}`);
    if (payload.tables?.missing?.length) console.log(`missing tables: ${payload.tables.missing.join(", ")}`);
    for (const failure of payload.failures || payload.traceQuality?.failures || []) {
      console.log(`- trace #${failure.id}: ${failure.tier} < ${failure.requiredTier}`);
      for (const reason of failure.reasons || []) console.log(`  ${reason}`);
    }
  }
}

function usage() {
  console.log(`Usage:
  harness-state.mjs [--cwd=<path>] [--json] init
  harness-state.mjs intake --type=<type> --summary=<text> --lane=<tiny|normal|high-risk>
  harness-state.mjs story add --id=<id> --title=<text> --lane=<lane>
  harness-state.mjs story update --id=<id> [--status=<status>] [--unit=0|1] [--integration=0|1] [--e2e=0|1] [--platform=0|1]
  harness-state.mjs decision add --id=<id> --title=<text> [--status=<status>]
  harness-state.mjs backlog add --title=<text> [--pain=<text>] [--risk=<lane>]
  harness-state.mjs backlog close --id=<n> [--status=implemented] [--outcome=<text>]
  harness-state.mjs trace --summary=<text> --outcome=<completed|blocked|partial|failed> --lane=<lane>
  harness-state.mjs session-worktree record --session-id=<id> --task=<id> --branch=<branch> --source-root=<path> --worktree=<path>
  harness-state.mjs query <stats|matrix|intakes|traces|friction|backlog|decisions|session-worktrees|sql>
  harness-state.mjs trace-quality [--strict] [--json]
  harness-state.mjs check [--strict] [--json]
  harness-state.mjs doctor [--json]
  harness-state.mjs migrate [--dry-run] [--json]
  harness-state.mjs export [--redact]
  harness-state.mjs prune --older-than=<days>d [--dry-run] [--json]
  harness-state.mjs explain <runId> [--redact] [--json]`);
}

const [command, subcommand, ...rest] = opts.rest;
try {
  if (!command || command === "--help" || command === "help") usage();
  else if (command === "init") {
    initDb();
    console.log(`Operational database ready at ${rel(dbPath)}`);
  } else if (command === "check") checkOperationalState();
  else if (command === "doctor") doctorState();
  else if (command === "migrate") migrateState([subcommand, ...rest].filter(Boolean));
  else if (command === "export") exportState([subcommand, ...rest].filter(Boolean));
  else if (command === "prune") pruneState([subcommand, ...rest].filter(Boolean));
  else if (command === "explain") explainState(subcommand, rest);
  else if (command === "intake") recordIntake([subcommand, ...rest].filter(Boolean));
  else if (command === "story" && subcommand === "add") addStory(rest);
  else if (command === "story" && subcommand === "update") updateStory(rest);
  else if (command === "decision" && subcommand === "add") addDecision(rest);
  else if (command === "backlog" && subcommand === "add") addBacklog(rest);
  else if (command === "backlog" && subcommand === "close") closeBacklog(rest);
  else if (command === "trace") recordTrace([subcommand, ...rest].filter(Boolean));
  else if (command === "session-worktree" && subcommand === "record") recordSessionWorktree(rest);
  else if (command === "query") query(subcommand, rest);
  else if (command === "trace-quality") traceQuality();
  else die(`unknown command "${[command, subcommand].filter(Boolean).join(" ")}"`);
} catch (error) {
  die(error.message);
}

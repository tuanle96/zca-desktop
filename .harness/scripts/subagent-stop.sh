#!/usr/bin/env bash
# SubagentStop hook — fires when a subagent finishes its turn (Task tool).
# Triggers the same structural-test that PostToolUse(Edit) runs, because a
# subagent can edit files in batches that individually pass but jointly drift
# off-layer. Running the check at subagent boundary catches that drift early.
#
# Contract:
#   - Never blocks (exit 0 even on failure — the parent Stop hook handles the
#     final gate). We only emit a stderr summary that Claude reads.
#   - Telemetry append to .harness/telemetry.jsonl as {event:"subagent_stop"}.
#   - Skipped when .harness/config.json#structuralTest.engine === "none" (the
#     "structural test not yet wired" escape hatch used by polyglot scaffolds).
set -eo pipefail

INPUT=$(cat)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
_LIB_DIR="$SCRIPT_DIR/_lib"
. "$_LIB_DIR/jp.sh"
. "$_LIB_DIR/telemetry.sh"

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
SHA=$(git rev-parse --short HEAD 2>/dev/null || echo 'no-git')
SUBAGENT="(unknown)"
LINE=""

if command -v node >/dev/null 2>&1; then
  META=$(AHK_SUBAGENT_TS="$TS" AHK_SUBAGENT_SHA="$SHA" node - "$INPUT" <<'NODE' 2>/dev/null || true
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const input = process.argv[2] || "";
let payload = {};
try {
  payload = JSON.parse(input);
} catch {
  payload = {};
}

function firstString(values, fallback = "") {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function activeTaskFromState() {
  try {
    return fs.readFileSync(".harness/state/active-task.txt", "utf8").split(/\r?\n/)[0].trim();
  } catch {
    return "";
  }
}

function stableTaskId(value) {
  return /^[A-Za-z0-9._-]+$/.test(String(value || ""));
}

const subagent = firstString([
  payload.subagent,
  payload.subagent_type,
  payload.subagentType,
  payload.agent,
  payload.agent_id,
  payload.agentId,
  payload.session_id,
  payload.sessionId,
], "unknown");
const taskId = firstString([
  process.env.AHK_ACTIVE_TASK,
  payload.taskId,
  payload.task_id,
  payload.activeTask,
  payload.active_task,
  payload.tool_input?.taskId,
  payload.tool_input?.activeTask,
  activeTaskFromState(),
]);
const sessionId = firstString([payload.session_id, payload.sessionId]);
const inputHash = `sha256:${crypto.createHash("sha256").update(input).digest("hex")}`;
const eventId = `${Date.now().toString(36)}-${inputHash.slice(7, 19)}`;
const base = {
  schemaVersion: 1,
  ts: process.env.AHK_SUBAGENT_TS || new Date().toISOString(),
  source: "SubagentStop",
  subagent,
  taskId: taskId || undefined,
  session_id: sessionId || undefined,
  eventId,
  inputHash,
  sha: process.env.AHK_SUBAGENT_SHA || "no-git",
};
for (const key of Object.keys(base)) {
  if (base[key] === undefined || base[key] === "") delete base[key];
}

let proofPath = "";
if (subagent === "advisor" && stableTaskId(taskId)) {
  const relPath = `.harness/state/advisor-runs/${taskId}.jsonl`;
  proofPath = relPath;
  fs.mkdirSync(path.dirname(relPath), { recursive: true });
  fs.appendFileSync(
    relPath,
    `${JSON.stringify({ ...base, event: "advisor_subagent_stop", proofPath: relPath })}\n`,
  );
}

process.stdout.write(JSON.stringify({
  subagent,
  taskId,
  eventId,
  inputHash,
  proofPath,
  telemetryLine: JSON.stringify({ ...base, event: "subagent_stop" }),
}));
NODE
)
  if [ -n "$META" ] && have_jp; then
    SUBAGENT=$(printf '%s' "$META" | jp '.subagent // "unknown"' 2>/dev/null || echo "unknown")
    LINE=$(printf '%s' "$META" | jp '.telemetryLine // empty' 2>/dev/null || true)
  fi
elif have_jp; then
  SUBAGENT=$(echo "$INPUT" | jp '.subagent // .session_id // "unknown"' 2>/dev/null || echo "unknown")
fi

# Telemetry first so we record every subagent boundary, even if the
# structural-test bails below. telemetry_append handles rotation.
if [ -z "$LINE" ]; then
  LINE=$(printf '{"schemaVersion":1,"ts":"%s","event":"subagent_stop","source":"SubagentStop","subagent":"%s","sha":"%s"}' \
    "$TS" "$SUBAGENT" "$SHA")
fi
telemetry_append "$LINE"

# Skip if structural test disabled.
if [ -f .harness/config.json ] \
   && grep -qE '"engine"[[:space:]]*:[[:space:]]*"none"' .harness/config.json; then
  exit 0
fi

# AHK_HOOK_MODE=warn → log only, don't run.
if [ "${AHK_HOOK_MODE:-}" = "warn" ]; then
  exit 0
fi

# Run structural test workspace-wide. Subagents typically touch multiple
# files; per-file scoping would miss the cross-file drift case. Cap output
# to 30 lines on stderr so the parent agent sees the summary without flood.
RAN=0
if [ -f .harness/runners/structural-check.mjs ] && command -v node >/dev/null 2>&1; then
  RAN=1
  if ! node .harness/runners/structural-check.mjs 2>&1 | tail -30 >&2; then
    echo "[ahk] subagent_stop: structural-test reported violations (see above). Continuing — parent Stop hook will gate." >&2
  fi
elif [ -f .harness/runners/structural_check.go ] && command -v go >/dev/null 2>&1; then
  RAN=1
  if ! go run .harness/runners/structural_check.go 2>&1 | tail -30 >&2; then
    echo "[ahk] subagent_stop: structural-test reported violations (see above). Continuing — parent Stop hook will gate." >&2
  fi
elif [ -f .harness/runners/structural_test.py ] && command -v python >/dev/null 2>&1; then
  RAN=1
  if ! python .harness/runners/structural_test.py 2>&1 | tail -30 >&2; then
    echo "[ahk] subagent_stop: structural-test reported violations (see above). Continuing — parent Stop hook will gate." >&2
  fi
elif command -v npm >/dev/null 2>&1 && [ -f package.json ] \
     && grep -q '"harness:check"' package.json 2>/dev/null; then
  RAN=1
  if ! npm run --silent harness:check 2>&1 | tail -30 >&2; then
    echo "[ahk] subagent_stop: structural-test reported violations (see above). Continuing — parent Stop hook will gate." >&2
  fi
fi
if [ "$RAN" = "0" ]; then
  # No structural-test entry point. Skip silently — already logged in telemetry.
  exit 0
fi
exit 0

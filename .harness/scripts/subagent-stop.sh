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

SUBAGENT="(unknown)"
if have_jp; then
  SUBAGENT=$(echo "$INPUT" | jp '.subagent // .session_id // "unknown"' 2>/dev/null || echo "unknown")
fi

# Telemetry first so we record every subagent boundary, even if the
# structural-test bails below. telemetry_append handles rotation.
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
SHA=$(git rev-parse --short HEAD 2>/dev/null || echo 'no-git')
LINE=$(printf '{"schemaVersion":1,"ts":"%s","event":"subagent_stop","source":"SubagentStop","subagent":"%s","sha":"%s"}' \
  "$TS" "$SUBAGENT" "$SHA")
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

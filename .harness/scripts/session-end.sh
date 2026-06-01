#!/usr/bin/env bash
# SessionEnd hook — append a single observability line to PROGRESS.md when
# the session terminates. Never blocks (SessionEnd is cleanup-only per
# Claude Code docs).
#
# Output line shape:
#   YYYY-MM-DD HH:MM | session_end | <reason> | <branch> | <sha> | <session_id> | cleanup=<status>
#
# Example:
#   2026-05-16 19:00 | session_end | clear | main | abc1234 | sess_abc123 | cleanup=skipped
#
# Reasons (per Claude Code docs): clear, resume, logout, prompt_input_exit,
# bypass_permissions_disabled, other.
#
# Dedup: a line is only appended when (session_id, reason) differs from the
# most recent matching entry in PROGRESS.md. Prevents the duplicate-spam
# bug where Claude Code fires SessionEnd more than once on a single teardown.
set -eo pipefail

INPUT=$(cat)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
_LIB_DIR="$SCRIPT_DIR/_lib"
. "$_LIB_DIR/jp.sh"

REASON=""
SESSION_ID=""
if have_jp; then
  # Fallback chain: prefer .end_reason (current Claude Code key), accept
  # .reason as a legacy synonym. Done as two separate jp calls because the
  # Node-fallback (json-pick.mjs) only supports a single `// default` per
  # expression — chaining `// .reason //` would parse-fail there.
  REASON=$(echo "$INPUT" | jp '.end_reason // ""' 2>/dev/null || echo "")
  if [ -z "$REASON" ] || [ "$REASON" = "null" ]; then
    REASON=$(echo "$INPUT" | jp '.reason // ""' 2>/dev/null || echo "")
  fi
  SESSION_ID=$(echo "$INPUT" | jp '.session_id // ""' 2>/dev/null || echo "")
  [ "$SESSION_ID" = "null" ] && SESSION_ID=""
fi
[ -z "$REASON" ] || [ "$REASON" = "null" ] && REASON="unknown"

BR="(no-git)"
SHA="(no-git)"
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  BR=$(git branch --show-current 2>/dev/null || echo "(detached)")
  SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "(none)")
fi

mkdir -p .harness
TS=$(date +"%Y-%m-%d %H:%M")
CLEANUP_STATUS="not-recorded"
if command -v node >/dev/null 2>&1 && [ -f .harness/scripts/session-cleanup.mjs ]; then
  CLEANUP_STATUS=$(printf '%s' "$INPUT" | node .harness/scripts/session-cleanup.mjs \
    --reason="$REASON" \
    --session-id="$SESSION_ID" 2>/dev/null || echo "record-failed")
fi
[ -z "$CLEANUP_STATUS" ] && CLEANUP_STATUS="record-failed"
LINE="$TS | session_end | $REASON | $BR | $SHA | $SESSION_ID | cleanup=$CLEANUP_STATUS"

# Idempotency guard: when the SessionEnd hook fires twice on the same
# teardown (Claude Code sometimes emits both `clear` and a follow-up
# `prompt_input_exit`, or repeats the same reason), drop the duplicate
# rather than spamming PROGRESS.md. Match on (session_id, reason): if
# both are present in the most recent entry for this session, skip.
DEDUP_KEY="| $REASON | $BR | $SHA | $SESSION_ID"
if [ -f .harness/PROGRESS.md ] && \
   [ -n "$SESSION_ID" ] && \
   tail -n 5 .harness/PROGRESS.md 2>/dev/null | grep -qF "$DEDUP_KEY"; then
  : # duplicate within the last 5 entries — skip silently
else
  echo "$LINE" >> .harness/PROGRESS.md || true
fi

# Rollup side-car — writes a JSONL record to .harness/telemetry.jsonl.
# Best-effort: never blocks the cleanup-only SessionEnd contract.
if command -v node >/dev/null 2>&1 && [ -f .harness/scripts/session-rollup.mjs ]; then
  printf '%s' "$INPUT" | node .harness/scripts/session-rollup.mjs 2>/dev/null || true
fi

# Project memory side-car — append a semantic session summary to the
# repo-local ledger. This is separate from telemetry: it is the durable
# "future humans and agents should know this happened" layer.
if [ "${AHK_DISABLE_MEMORY:-0}" != "1" ] && \
   command -v node >/dev/null 2>&1 && \
   [ -f .harness/scripts/project-memory.mjs ]; then
  printf '%s' "$INPUT" | node .harness/scripts/project-memory.mjs session-end \
    --reason "$REASON" \
    --session-id "$SESSION_ID" \
    --branch "$BR" \
    --sha "$SHA" >/dev/null 2>&1 || true
fi
exit 0

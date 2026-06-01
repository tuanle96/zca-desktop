#!/usr/bin/env bash
# PostToolUse telemetry hook — logs every Skill invocation to
# .harness/telemetry.jsonl. Pure observation; never blocks.
#
# Used by harness:report to compute per-skill success rate, average duration,
# and to surface drift over time.
#
# v0.7: migrated from `command -v jq` fail-open gate to the kit's jp() helper
# so the telemetry record still gets written on jq-less CI / Windows. Without
# the migration, telemetry quietly went dark anywhere jq wasn't installed.
# v0.10.3: jp/have_jq/have_jp extracted to _lib/jp.sh; AHK_DISABLE_TELEMETRY
# opt-out + AHK_TELEMETRY_MAX_LINES rotation added.
set -e

# Opt-out: respect AHK_DISABLE_TELEMETRY=1 before reading stdin so the user
# can fully disable observability without removing the hook from settings.
[ "${AHK_DISABLE_TELEMETRY:-}" = "1" ] && exit 0

INPUT=$(cat)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
_LIB_DIR="$SCRIPT_DIR/_lib"
. "$_LIB_DIR/jp.sh"
. "$_LIB_DIR/telemetry.sh"
if ! have_jp; then exit 0; fi

TOOL=$(echo "$INPUT" | jp '.tool_name // empty')
[ "$TOOL" = "Skill" ] || exit 0

SKILL=$(echo "$INPUT" | jp '.tool_input.skill // empty')
[ -z "$SKILL" ] && exit 0
SESSION_ID=$(echo "$INPUT" | jp '.session_id // .sessionId // empty' 2>/dev/null || true)
TASK_ID=$(echo "$INPUT" | jp '.task_id // .taskId // .tool_input.task_id // .tool_input.taskId // empty' 2>/dev/null || true)
if [ -z "$TASK_ID" ] && [ -f .harness/state/active-task.txt ]; then
  TASK_ID=$(cat .harness/state/active-task.txt 2>/dev/null || true)
fi

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
SHA=$(git rev-parse --short HEAD 2>/dev/null || echo 'no-git')

# Compose JSONL line by hand — same shape as the previous jq-built record.
# Skill names are constrained to `[a-z0-9-]+` upstream so we don't need full
# JSON escaping here. telemetry_append handles mkdir, append, and rotation.
LINE=$(node -e "
  const row = {
    schemaVersion: 1,
    ts: process.argv[1],
    event: 'skill_invoked',
    source: 'PostToolUse',
    skill: process.argv[2],
    sha: process.argv[3],
  };
  if (process.argv[4]) row.session_id = process.argv[4];
  if (process.argv[5]) row.task_id = process.argv[5];
  process.stdout.write(JSON.stringify(row));
" "$TS" "$SKILL" "$SHA" "$SESSION_ID" "$TASK_ID")
telemetry_append "$LINE"
exit 0

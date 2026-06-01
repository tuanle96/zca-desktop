#!/usr/bin/env bash
# SessionStart hook — inject a compact, deterministic context block when
# a session begins, resumes, or comes back from compaction. Output goes
# via JSON stdout `hookSpecificOutput.additionalContext`, which Claude
# Code feeds into the conversation context before the first turn.
#
# Three matchers fire this hook:
#   startup → fresh session. Inject branch + uncommitted summary +
#             current feature (from .harness/feature_list.json) + golden-principles
#             cap reminder. ~10-20 lines of structured state.
#   resume  → user ran --resume / --continue. Same payload as startup,
#             plus tail of PROGRESS.md so the model picks up where the
#             last session stopped.
#   compact → context was just compacted (mid-session). Pull the snapshot
#             written by the PreCompact hook (.harness/compaction-snapshot.json)
#             and re-inject it. Without this, the model loses everything
#             that mattered about the current feature mid-compaction.
#
# The hook never blocks. Exit 0 + JSON to stdout is the *only* control
# path that Claude reads.
set -eo pipefail

INPUT=$(cat)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
_LIB_DIR="$SCRIPT_DIR/_lib"
. "$_LIB_DIR/jp.sh"

SOURCE=""
if have_jp; then
  SOURCE=$(echo "$INPUT" | jp '.source // "startup"')
fi

# Build the additionalContext payload as plain text first, then JSON-escape
# the whole thing at the end. Plain text is easier to read while iterating
# on the hook, and Claude renders it as-is in the conversation view.
CTX=""

# 1. Branch + uncommitted count (always)
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  BR=$(git branch --show-current 2>/dev/null || echo "(detached)")
  COUNT=$(git status --short 2>/dev/null | wc -l | tr -d ' ')
  CTX+="[harness] git: branch=$BR, uncommitted=$COUNT file(s)"$'\n'
fi

# 1b. One-shot daily pill (harness version + open-feature reminder).
# `mkdir -p .harness/state` then check the stamp file. Today's pill fires
# once per UTC day per project; subsequent SessionStarts that day stay
# silent on this line so the model doesn't see the same banner thirty
# times per coding day.
mkdir -p .harness/state 2>/dev/null || true
STAMP_FILE=".harness/state/session-pill.stamp"
ACTIVE_TASK_FILE=".harness/state/active-task.txt"
SUGGESTED_TASK_FILE=".harness/state/suggested-task.txt"
TODAY=$(date -u +%Y-%m-%d)
LAST=""
[ -f "$STAMP_FILE" ] && LAST=$(cat "$STAMP_FILE" 2>/dev/null || echo "")
if [ "$LAST" != "$TODAY" ]; then
  HARNESS_VER=""
  if [ -f .harness/config.json ] && have_jp; then
    HARNESS_VER=$(jp '.version // empty' .harness/config.json 2>/dev/null || echo "")
  fi
  if [ -z "$HARNESS_VER" ] && [ -f .harness/installed.json ] && have_jp; then
    HARNESS_VER=$(jp '.version // empty' .harness/installed.json 2>/dev/null || echo "")
  fi
  if [ -z "$HARNESS_VER" ]; then
    HARNESS_VER="unknown"
  fi
  CTX+="[harness] pill (one/day): kit=$HARNESS_VER · date=$TODAY"$'\n'
  printf '%s' "$TODAY" > "$STAMP_FILE" 2>/dev/null || true
fi

# 2. Current feature (from .harness/feature_list.json) — picks the first entry with
#    passes=false so the model resumes the in-flight work, not a finished
#    one. Skipped if file missing or jp unavailable.
ACTIVE_TASK_ID=""
if [ -f .harness/feature_list.json ] && have_jp; then
  FIRST_OPEN=$(echo '{}' | jp '.placeholder // empty' 2>/dev/null || true) # warm jp
  # Use a transient script — we want { id, title } of first passes:false entry.
  if have_jq; then
    FEAT_DATA=$(jq -r 'first((if type == "array" then . else .features end)[] | select(.passes == false)) | select(.) | [.id, .title] | @tsv' \
      .harness/feature_list.json 2>/dev/null || true)
    ACTIVE_TASK_ID=$(printf '%s' "$FEAT_DATA" | cut -f1)
    ACTIVE_TASK_TITLE=$(printf '%s' "$FEAT_DATA" | cut -f2-)
    [ -n "$ACTIVE_TASK_ID" ] && FEAT="[harness] feature: $ACTIVE_TASK_ID — $ACTIVE_TASK_TITLE"
  else
    # Node fallback path: emit (id, title) via a one-liner.
    FEAT_DATA=$(node -e "
      const f = JSON.parse(require('fs').readFileSync('.harness/feature_list.json', 'utf8'));
      const arr = Array.isArray(f) ? f : (f.features || []);
      const open = arr.find(x => x.passes === false);
      if (open) process.stdout.write(String(open.id || '') + '\t' + String(open.title || ''));
    " 2>/dev/null || true)
    ACTIVE_TASK_ID=$(printf '%s' "$FEAT_DATA" | cut -f1)
    ACTIVE_TASK_TITLE=$(printf '%s' "$FEAT_DATA" | cut -f2-)
    [ -n "$ACTIVE_TASK_ID" ] && FEAT="[harness] feature: $ACTIVE_TASK_ID — $ACTIVE_TASK_TITLE"
  fi
  if [ -n "$FEAT" ]; then
    CTX+="$FEAT"$'\n'
  fi
fi
if [ -n "$ACTIVE_TASK_ID" ]; then
  printf '%s' "$ACTIVE_TASK_ID" > "$SUGGESTED_TASK_FILE" 2>/dev/null || true
else
  : > "$SUGGESTED_TASK_FILE" 2>/dev/null || true
fi

EXPLICIT_ACTIVE_TASK="${AHK_ACTIVE_TASK:-${AHK_ACTIVE_TASK_ID:-}}"
if [ -n "$EXPLICIT_ACTIVE_TASK" ]; then
  printf '%s' "$EXPLICIT_ACTIVE_TASK" > "$ACTIVE_TASK_FILE" 2>/dev/null || true
else
  # A feature-list entry is only a suggestion. Leaving it in active-task.txt
  # makes Stop/PreToolUse treat ordinary read-only turns as task completion.
  : > "$ACTIVE_TASK_FILE" 2>/dev/null || true
fi

# 3. Project operating memory summary. This is the curated, repo-local
#    memory layer: phase, scope, open risks, and recent semantic events.
#    It deliberately avoids dumping raw telemetry or transcript content.
if [ "${AHK_DISABLE_MEMORY:-0}" != "1" ] && \
   command -v node >/dev/null 2>&1 && \
   [ -f .harness/scripts/project-memory.mjs ]; then
  MEM_SUMMARY=$(node .harness/scripts/project-memory.mjs summarize 2>/dev/null || true)
  if [ -n "$MEM_SUMMARY" ]; then
    CTX+="$MEM_SUMMARY"$'\n'
  fi
fi

# 4. PROGRESS.md tail (resume only — fresh sessions don't need it).
if [ "$SOURCE" = "resume" ] && [ -f .harness/PROGRESS.md ]; then
  TAIL=$(tail -3 .harness/PROGRESS.md 2>/dev/null | sed 's/^/  /')
  if [ -n "$TAIL" ]; then
    CTX+="[harness] PROGRESS.md tail:"$'\n'"$TAIL"$'\n'
  fi
fi

# 5. Re-injection from compaction snapshot. The PreCompact hook writes
#    .harness/compaction-snapshot.json before the model loses context.
#    On `source: compact` we read it back and inline the most useful
#    fields so the post-compaction model knows where it was.
if [ "$SOURCE" = "compact" ] && [ -f .harness/compaction-snapshot.json ] && have_jp; then
  SNAP_BRANCH=$(jp '.branch // empty' .harness/compaction-snapshot.json 2>/dev/null || true)
  SNAP_SHA=$(jp '.sha // empty' .harness/compaction-snapshot.json 2>/dev/null || true)
  SNAP_FEAT=$(jp '.feature // empty' .harness/compaction-snapshot.json 2>/dev/null || true)
  SNAP_TS=$(jp '.compacted_at // empty' .harness/compaction-snapshot.json 2>/dev/null || true)
  CTX+="[harness] post-compaction snapshot (taken $SNAP_TS):"$'\n'
  [ -n "$SNAP_BRANCH" ] && CTX+="  branch=$SNAP_BRANCH"$'\n'
  [ -n "$SNAP_SHA" ] && CTX+="  sha=$SNAP_SHA"$'\n'
  [ -n "$SNAP_FEAT" ] && CTX+="  current-feature=$SNAP_FEAT"$'\n'
fi

# 6. Layer rule reminder (always — short, deterministic). Lets the model
#    re-establish the forward-only rule without reading CLAUDE.md again.
if [ -f .harness/config.json ] && have_jp; then
  LAYERS=$(jp '.domains[0].layers[]' .harness/config.json 2>/dev/null | tr '\n' ' ' | sed 's/ $//' | tr ' ' '>')
  LAYERS=${LAYERS//>/ → }
  if [ -n "$LAYERS" ]; then
    CTX+="[harness] layer rule (forward-only): $LAYERS"$'\n'
  fi
fi

if [ -z "$CTX" ]; then
  # Nothing meaningful to inject. Exit clean with no output — Claude
  # treats this as "hook ran but had nothing to say".
  exit 0
fi

# Keep a tiny last-context snapshot for hook observability. Some Claude Code
# stream-json versions report hook success but omit stdout in hook_response
# events; this file lets the real-runtime E2E prove the same payload was
# produced without relying on transcript shape.
printf '%s' "$CTX" > .harness/state/session-start-last-context.txt 2>/dev/null || true

# Emit the JSON envelope. Use Node's JSON.stringify for the escape so we
# don't have to hand-roll \n / \" handling.
if command -v node >/dev/null 2>&1; then
  node -e "
    const ctx = process.argv[1];
    const out = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } };
    process.stdout.write(JSON.stringify(out));
  " "$CTX"
elif have_jq; then
  jq -nc --arg ctx "$CTX" '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
else
  # Last-resort: emit as plain stdout. Claude Code accepts plain text from
  # SessionStart hooks (it's treated as additionalContext too).
  printf '%s' "$CTX"
fi
exit 0

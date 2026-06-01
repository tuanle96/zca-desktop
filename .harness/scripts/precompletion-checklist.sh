#!/usr/bin/env bash
# Stop hook — LangChain's "PreCompletionChecklist" / Ralph Wiggum loop.
# On first stop: run deterministic checks; if any fail, re-inject *structured*
# failure context (not just check names) via stderr and exit 2. On second
# stop (stop_hook_active=true), exit 0 to allow real exit.
#
# Optional headless recovery: when enabled, spawn `claude -p` in the background
# for one turn of recovery on failure. Costs tokens; off by default. Configure
# via .harness/config.json `.recovery.headless` (persistent), or override per-run
# with AHK_HEADLESS_RECOVER=1 (env var wins).
set -e

INPUT=$(cat)

# Resolve the directory this hook lives in (used to find _lib/json-pick.mjs).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
_LIB_DIR="$SCRIPT_DIR/_lib"
# have_jq / have_jp / jp shared across all hook scripts. AHK_DISABLE_JQ=1
# forces the Node fallback, used by tests to exercise the jq-less code path
# on machines that have jq installed locally.
. "$_LIB_DIR/jp.sh"
. "$_LIB_DIR/telemetry.sh" 2>/dev/null || true

emit_stop_telemetry() {
  [ "${AHK_DISABLE_TELEMETRY:-}" = "1" ] && return 0
  command -v node >/dev/null 2>&1 || return 0
  local event="$1"
  local rule="$2"
  local failures="${3:-}"
  local task_id="${AHK_ACTIVE_TASK:-${AHK_ACTIVE_TASK_ID:-}}"
  if [ -z "$task_id" ] && have_jp; then
    task_id=$(printf '%s' "$INPUT" | jp '.task_id // .taskId // .active_task // .activeTask // empty' 2>/dev/null || true)
  fi
  local line
  line=$(node -e '
    const [event, rule, failures, taskId] = process.argv.slice(1);
    const row = {
      schemaVersion: 1,
      ts: new Date().toISOString(),
      event,
      rule,
      hook: "Stop",
    };
    if (failures) row.failures = failures.split(/\s+/).filter(Boolean);
    if (taskId) row.task_id = taskId;
    process.stdout.write(JSON.stringify(row));
  ' "$event" "$rule" "$failures" "$task_id" 2>/dev/null || true)
  [ -n "$line" ] && telemetry_append "$line" 2>/dev/null || true
}

# CRITICAL: avoid infinite loops. If the hook already ran, do not block again.
if have_jp; then
  if [ "$(echo "$INPUT" | jp '.stop_hook_active // false')" = "true" ]; then
    emit_stop_telemetry "precompletion_loop_guard" "stop_hook_active" ""
    exit 0
  fi
fi

# Capture structured output per check. We use temp files so we can quote the
# tail back to Claude verbatim — names alone are not enough context for the
# agent to act on.
TMPDIR_HOOK=$(mktemp -d -t ahk-stop-hook.XXXXXX)
# Preserve the script's exit code through the cleanup trap — otherwise the
# trailing `rm` resets the final status to 0 and Claude never sees the block.
trap 'rc=$?; rm -rf "$TMPDIR_HOOK"; exit $rc' EXIT

run_check() {
  local name="$1"
  shift
  local out="$TMPDIR_HOOK/$name.out"
  if "$@" >"$out" 2>&1; then
    return 0
  else
    echo "$name" >> "$TMPDIR_HOOK/failed.list"
    return 1
  fi
}

run_structural_check() {
  if [ -f .harness/runners/structural-check.mjs ]; then
    node .harness/runners/structural-check.mjs
  elif [ -f .harness/runners/structural-test.mjs ]; then
    node .harness/runners/structural-test.mjs
  elif [ -f .harness/runners/structural_check.go ]; then
    go run .harness/runners/structural_check.go
  elif [ -f .harness/runners/structural_test.py ]; then
    python .harness/runners/structural_test.py
  elif [ -f package.json ] && grep -q '"harness:check"' package.json 2>/dev/null; then
    npm run --silent harness:check
  else
    echo "No structural test command found for configured engine."
    return 1
  fi
}

task_stop_mode() {
  local mode="${AHK_TASK_EVIDENCE_STOP_GATE:-}"
  if [ -z "$mode" ] && [ -f .harness/config.json ] && have_jp; then
    mode=$(jp '.taskContracts.stopActiveEvidence // "on-claim"' .harness/config.json 2>/dev/null || echo "on-claim")
  fi
  if [ -z "$mode" ]; then
    mode="on-claim"
  fi
  printf '%s' "$mode"
}

completion_gate_required() {
  local mode
  mode=$(task_stop_mode)
  if [ "$mode" = "always" ]; then
    return 0
  fi
  if [ "$mode" != "on-claim" ]; then
    return 1
  fi
  if [ ! -f .harness/scripts/task-evidence-check.mjs ] || ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  local transcript_path=""
  if have_jp; then
    transcript_path=$(echo "$INPUT" | jp '.transcript_path // empty' 2>/dev/null || true)
  fi
  if [ -n "$transcript_path" ]; then
    node .harness/scripts/task-evidence-check.mjs \
      --completion-intent \
      --stop-mode="$mode" \
      "--completion-transcript=$transcript_path" \
      >/dev/null 2>&1
  else
    node .harness/scripts/task-evidence-check.mjs \
      --completion-intent \
      --stop-mode="$mode" \
      >/dev/null 2>&1
  fi
}

run_task_evidence_check() {
  if [ -f .harness/scripts/task-evidence-check.mjs ] && command -v node >/dev/null 2>&1; then
    TASK_STOP_MODE=$(task_stop_mode)
    TRANSCRIPT_PATH=""
    if have_jp; then
      TRANSCRIPT_PATH=$(echo "$INPUT" | jp '.transcript_path // empty' 2>/dev/null || true)
    fi
    if [ -n "$TRANSCRIPT_PATH" ]; then
      node .harness/scripts/task-evidence-check.mjs \
        --active-task \
        --stop-mode="$TASK_STOP_MODE" \
        --completion-transcript="$TRANSCRIPT_PATH"
    else
      node .harness/scripts/task-evidence-check.mjs \
        --active-task \
        --stop-mode="$TASK_STOP_MODE"
    fi
  else
    echo "No task evidence checker found."
    return 1
  fi
}

active_task_id() {
  if [ -n "${AHK_ACTIVE_TASK:-}" ]; then
    printf '%s' "$AHK_ACTIVE_TASK" | tr -d '[:space:]'
    return 0
  fi
  if [ -f .harness/state/active-task.txt ]; then
    head -n 1 .harness/state/active-task.txt | tr -d '[:space:]'
    return 0
  fi
  return 0
}

run_advisor_required_check() {
  if [ ! -f .harness/config.json ]; then
    return 0
  fi
  if ! have_jp; then
    echo "Cannot enforce advisor gate: install jq or keep node available for .harness/scripts/_lib/json-pick.mjs."
    return 1
  fi

  ADVISOR_ENABLED=$(jp '.advisor.enabled' .harness/config.json 2>/dev/null || echo null)
  ADVISOR_BLOCK_ON_SKIP=$(jp '.advisor.blockOnSkip' .harness/config.json 2>/dev/null || echo null)
  if [ "$ADVISOR_ENABLED" = "null" ] || [ -z "$ADVISOR_ENABLED" ]; then
    ADVISOR_ENABLED=true
  fi
  if [ "$ADVISOR_BLOCK_ON_SKIP" = "null" ] || [ -z "$ADVISOR_BLOCK_ON_SKIP" ]; then
    ADVISOR_BLOCK_ON_SKIP=true
  fi
  if [ "$ADVISOR_ENABLED" != "true" ] || [ "$ADVISOR_BLOCK_ON_SKIP" != "true" ]; then
    return 0
  fi

  TASK_ID=$(active_task_id)
  if [ -z "$TASK_ID" ]; then
    return 0
  fi
  case "$TASK_ID" in
    *[!A-Za-z0-9._-]*)
      echo "Active task id '$TASK_ID' is invalid for advisor artifact lookup."
      return 1
      ;;
  esac

  ADVISOR_FILE=".harness/reviews/$TASK_ID/advisor-decision.json"
  if [ ! -f "$ADVISOR_FILE" ]; then
    echo "Missing mandatory advisor decision: $ADVISOR_FILE"
    echo "Invoke the advisor agent, then persist its JSON decision to that path."
    return 1
  fi

  if ! ADVISOR_DECISION=$(jp '.decision // empty' "$ADVISOR_FILE" 2>/dev/null); then
    echo "Advisor decision is not valid JSON: $ADVISOR_FILE"
    return 1
  fi
  ADVISOR_REVIEWER=$(jp '.reviewer // empty' "$ADVISOR_FILE" 2>/dev/null || true)
  ADVISOR_TASK_ID=$(jp '.taskId // empty' "$ADVISOR_FILE" 2>/dev/null || true)

  if [ "$ADVISOR_REVIEWER" != "advisor" ]; then
    echo "Advisor decision reviewer must be 'advisor' in $ADVISOR_FILE (got '$ADVISOR_REVIEWER')."
    return 1
  fi
  if [ "$ADVISOR_TASK_ID" != "$TASK_ID" ]; then
    echo "Advisor decision taskId must match active task '$TASK_ID' in $ADVISOR_FILE (got '$ADVISOR_TASK_ID')."
    return 1
  fi
  if [ "$ADVISOR_DECISION" != "pass" ]; then
    echo "Advisor decision must be pass before completion (got '$ADVISOR_DECISION') in $ADVISOR_FILE."
    return 1
  fi
}

print_task_evidence_guidance() {
  echo
  echo "Task/evidence recovery:"
  echo "  - Check the active task id in .harness/state/active-task.txt or AHK_ACTIVE_TASK."
  echo "  - Ensure .harness/task-contracts/<task>.json exists with acceptance checks."
  echo "  - Run the listed verification command(s), then write .harness/evidence/<task>.json."
  echo "  - If UI proof is required, run node .harness/scripts/verify-ui.mjs and reference its browser JSON summary."
  echo "  - Only after task-evidence-check passes, update .harness/feature_list.json passes=true for that feature."
}

print_advisor_guidance() {
  echo
  echo "Advisor recovery:"
  echo "  - Read the active task id in .harness/state/active-task.txt or AHK_ACTIVE_TASK."
  echo "  - Invoke the advisor agent before claiming done."
  echo "  - Persist its decision JSON to .harness/reviews/<task_id>/advisor-decision.json."
  echo "  - The JSON must match .harness/schemas/review-decision.schema.json with reviewer=advisor, taskId=<task_id>, and decision=pass."
}

hash_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

current_diff_hash() {
  {
    printf 'unstaged\n'
    git diff --binary -- . ':(exclude).harness/.state/**' ':(exclude).harness/telemetry.jsonl' 2>/dev/null || true
    printf 'staged\n'
    git diff --cached --binary -- . ':(exclude).harness/.state/**' ':(exclude).harness/telemetry.jsonl' 2>/dev/null || true
    printf 'untracked\n'
    git ls-files --others --exclude-standard 2>/dev/null \
      | grep -Ev '^\.harness/(\.state/|telemetry\.jsonl$)' \
      | sort \
      | while IFS= read -r f; do
        [ -f "$f" ] || continue
        printf '%s\n' "$f"
        git hash-object "$f" 2>/dev/null || true
      done
  } | hash_stdin
}

# Structural test. Skipped when `structuralTest.engine` is explicitly "none"
# (e.g. during scaffold of a polyglot repo where the adapter is not yet
# wired). Without this guard the check fails silently with an empty body
# because `npm run harness:check` has no matching script.
if [ -f .harness/config.json ] \
   && ! grep -qE '"engine"[[:space:]]*:[[:space:]]*"none"' .harness/config.json; then
  run_check structural-test run_structural_check || true
fi

# Lint.
if [ -f package.json ] && grep -q '"lint"' package.json; then
  run_check lint npm run --silent lint || true
elif [ -f pyproject.toml ] && command -v ruff >/dev/null 2>&1; then
  run_check ruff ruff check . || true
fi

# Task contract / evidence gate. By default this blocks features that changed
# to `passes: true` in the current diff and also gates the active task when the
# last assistant message claims completion. This keeps upgraded repos from
# being blocked by legacy completed items while still catching verbal "done"
# claims that forgot to flip feature state.
if [ -f .harness/config.json ] && have_jp; then
  TASK_CONTRACTS_ENABLED=$(jp '.taskContracts.enabled // false' .harness/config.json 2>/dev/null)
  if [ "$TASK_CONTRACTS_ENABLED" = "true" ]; then
    # Always use || true to prevent set -e from exiting early
    # Blocking happens at the end via failed.list check and exit 2
    run_check task-evidence run_task_evidence_check || true
  fi
fi

# Mandatory advisor gate. If advisor is enabled and the active-task completion
# gate is active, a structured pass decision must exist before completion can
# proceed. This is intentionally separate from task-evidence so claim-done
# reviews cannot be skipped by leaving feature state unchanged, while ordinary
# read-only stops do not get trapped by a stale active-task file.
if [ -f .harness/config.json ] && completion_gate_required; then
  run_check advisor-required run_advisor_required_check || true
fi

# CLAUDE.md size caps. Two complementary signals:
#   - maxInstructions (default 200): bullet/numbered-item count. Suits
#     ASCII-heavy English where a bullet ≈ a fixed token weight.
#   - maxTokens (default 0 = off): approximate token cap. Catches drift
#     in non-ASCII content (Vietnamese, CJK, etc.) where 200 bullets
#     may carry 2–3× more tokens than the HumanLayer baseline measured.
# Both checks fire independently — exceed either → block.
if [ -f .harness/config.json ] && have_jp; then
  CMD_PATH=$(jp '.claudeMd.path // "CLAUDE.md"' .harness/config.json)
  CMD_CAP=$(jp '.claudeMd.maxInstructions // 200' .harness/config.json)
  CMD_TOK_CAP=$(jp '.claudeMd.maxTokens // 0' .harness/config.json)
  if [ -f "$CMD_PATH" ] && [ "$CMD_CAP" -gt 0 ] 2>/dev/null; then
    CMD_COUNT=$(grep -cE '^[[:space:]]*([-*]|[0-9]+\.)[[:space:]]' "$CMD_PATH" 2>/dev/null || echo 0)
    if [ "$CMD_COUNT" -gt "$CMD_CAP" ]; then
      {
        echo "$CMD_PATH instruction count: $CMD_COUNT (cap: $CMD_CAP)"
        echo
        echo "HumanLayer measurement: agents stop following CLAUDE.md reliably"
        echo "beyond ~150-200 instructions. Your file exceeds the cap."
        echo
        echo "Fix options:"
        echo "  - extract sections to .harness/docs/ and link from CLAUDE.md"
        echo "  - use @-imports to load detailed context on demand"
        echo "  - delete obsolete rules (run /garbage-collection)"
        echo
        echo "Adjust the cap (with justification) in .harness/config.json:"
        echo "  .claudeMd.maxInstructions"
      } > "$TMPDIR_HOOK/claude-md-cap.out"
      echo "claude-md-cap" >> "$TMPDIR_HOOK/failed.list"
    fi
  fi
  if [ -f "$CMD_PATH" ] && [ "$CMD_TOK_CAP" -gt 0 ] 2>/dev/null \
     && command -v node >/dev/null 2>&1 \
     && [ -f "$SCRIPT_DIR/_lib/approx-tokens.mjs" ]; then
    CMD_TOK=$(node "$SCRIPT_DIR/_lib/approx-tokens.mjs" "$CMD_PATH" 2>/dev/null || echo 0)
    if [ "$CMD_TOK" -gt "$CMD_TOK_CAP" ]; then
      {
        echo "$CMD_PATH approximate token count: $CMD_TOK (cap: $CMD_TOK_CAP)"
        echo
        echo "Heuristic token cap — set because instruction count alone misses"
        echo "drift in non-ASCII content (Vietnamese, CJK) where a bullet can"
        echo "carry 2-3x more tokens than the HumanLayer baseline measured."
        echo
        echo "Adjust the cap (with justification) in .harness/config.json:"
        echo "  .claudeMd.maxTokens"
      } > "$TMPDIR_HOOK/claude-md-tokens.out"
      echo "claude-md-tokens" >> "$TMPDIR_HOOK/failed.list"
    fi
  fi
fi

# Multi-layer review trigger. When uncommitted/staged/untracked changes touch
# ≥2 layers within a single domain, the `architecture-reviewer` subagent
# should run before commit. Replaces the agent's self-judgment about "touches
# multiple layers" (the §4.3 #3 ambiguity in the harness-techniques research)
# with a mechanical count off `.harness/config.json` `domains[].layers` /
# `.root`. Fires once per stop; the loop guard (`stop_hook_active`) lets the
# next stop succeed after the agent has read the recommendation.
if [ -f .harness/config.json ] && have_jp && command -v git >/dev/null 2>&1; then
  CHANGED=$(
    {
      git diff --name-only -- . ':(exclude).harness/.state/**' 2>/dev/null || true
      git diff --name-only --cached -- . ':(exclude).harness/.state/**' 2>/dev/null || true
      git ls-files --others --exclude-standard 2>/dev/null || true
    } | grep -Ev '^\.harness/\.state/' | sort -u
  )
  if [ -n "$CHANGED" ]; then
    NUM_DOMAINS=$(jp '.domains | length' .harness/config.json 2>/dev/null || echo 0)
    MULTI_OUT="$TMPDIR_HOOK/multi-layer-review.out"
    : > "$MULTI_OUT"
    MULTI_HIT=0
    DIFF_HASH=""
    i=0
    while [ "$i" -lt "$NUM_DOMAINS" ]; do
      ROOT=$(jp ".domains[$i].root" .harness/config.json)
      DOMAIN=$(jp ".domains[$i].name" .harness/config.json)
      # Optional layerDirPattern — supports conventions where the layer
      # directory is not literally `{layer}`. Example: a Rust workspace
      # with crates named `unibot-types`, `unibot-crypto`, ... uses
      # `"layerDirPattern": "unibot-{layer}"`. Defaults to `{layer}`.
      LAYER_PATTERN=$(jp ".domains[$i].layerDirPattern // \"{layer}\"" .harness/config.json)
      TOUCHED_COUNT=0
      TOUCHED_NAMES=""
      while IFS= read -r layer; do
        [ -z "$layer" ] && continue
        LAYER_DIR=$(printf '%s' "$LAYER_PATTERN" | sed "s/{layer}/$layer/g")
        if echo "$CHANGED" | grep -qE "^${ROOT}/${LAYER_DIR}(/|$)"; then
          TOUCHED_COUNT=$((TOUCHED_COUNT + 1))
          TOUCHED_NAMES="$TOUCHED_NAMES $layer"
        fi
      done < <(jp ".domains[$i].layers[]" .harness/config.json)
      if [ "$TOUCHED_COUNT" -ge 2 ]; then
        echo "Domain '$DOMAIN' has changes spanning $TOUCHED_COUNT layers:$TOUCHED_NAMES" >> "$MULTI_OUT"
        MULTI_HIT=1
      fi
      i=$((i + 1))
    done
    if [ "$MULTI_HIT" = "1" ]; then
      DIFF_HASH=$(current_diff_hash)
      ACK_FILE=".harness/.state/multi-layer-review/${DIFF_HASH}.pass"
      if [ -f "$ACK_FILE" ] && [ "$(tr -d '[:space:]' < "$ACK_FILE")" = "PASS" ]; then
        :
      else
        {
          echo
          echo "Recommend invoking the 'architecture-reviewer' subagent before commit."
          echo "Mechanical detection — replaces self-judgment about 'touches multiple layers'."
          echo "After the reviewer reports PASS for this exact diff, acknowledge it with:"
          echo "  mkdir -p .harness/.state/multi-layer-review"
          echo "  printf 'PASS\\n' > $ACK_FILE"
          echo "Diff hash: $DIFF_HASH"
        } >> "$MULTI_OUT"
        echo "multi-layer-review" >> "$TMPDIR_HOOK/failed.list"
      fi
    fi
  fi
fi

# Non-blocking nudge: HTML-for-humans (golden principle #11 / ADR-0002).
# When the session produced one or more deliverable-shaped .md files at repo
# root (i.e. not CLAUDE.md / AGENTS.md / README.md / CHANGELOG.md), suggest
# `/deliver-html`. Pure heuristic — never blocks the stop. Skip with
# `AHK_DISABLE_HTML_NUDGE=1`.
if [ "${AHK_DISABLE_HTML_NUDGE:-0}" != "1" ] && command -v git >/dev/null 2>&1; then
  KIT_MDS="CLAUDE.md|AGENTS.md|README.md|CHANGELOG.md|LICENSE.md|CONTRIBUTING.md|CODE_OF_CONDUCT.md|SECURITY.md"
  NEW_MD=$(
    {
      git ls-files --others --exclude-standard 2>/dev/null
      git diff --name-only 2>/dev/null
      git diff --name-only --cached 2>/dev/null
    } \
    | sort -u \
    | grep -E '^[^/]+\.md$' \
    | grep -Ev "^(${KIT_MDS})$" \
    || true
  )
  if [ -n "$NEW_MD" ]; then
    NEW_HTML=$(
      {
        git ls-files --others --exclude-standard 2>/dev/null
        git diff --name-only 2>/dev/null
        git diff --name-only --cached 2>/dev/null
      } \
      | sort -u \
      | grep -E '^[^/]+\.html$' \
      || true
    )
    if [ -z "$NEW_HTML" ]; then
      {
        echo
        echo "[nudge] Repo root has new .md file(s) that look like human deliverables:"
        echo "$NEW_MD" | sed 's/^/  - /'
        echo
        echo "Golden principle #11: HTML for human deliverables, MD for agent files."
        echo "If these are reports/audits/plans/decision-docs, ship them via /deliver-html"
        echo "instead. Non-blocking — suppress with AHK_DISABLE_HTML_NUDGE=1."
      } >&2
    fi
  fi
fi

if [ ! -s "$TMPDIR_HOOK/failed.list" ]; then
  exit 0
fi

# Build a structured failure report for Claude. The agent gets: which checks
# failed, the last 50 lines of each failure, and the files most recently
# touched (so the agent can correlate failures with its own edits).
{
  echo
  echo "=== Pre-completion checklist failed ==="
	  while read -r failed; do
	    echo
	    echo "--- $failed ---"
	    tail -50 "$TMPDIR_HOOK/$failed.out" 2>/dev/null || true
	    if [ "$failed" = "task-evidence" ]; then
	      print_task_evidence_guidance
	    fi
	    if [ "$failed" = "advisor-required" ]; then
	      print_advisor_guidance
	    fi
	  done < "$TMPDIR_HOOK/failed.list"

  echo
  echo "--- recent changes (last 10 modified files) ---"
  if command -v git >/dev/null 2>&1; then
    git status --short 2>/dev/null | head -10 || true
    echo
    echo "--- last 3 commits ---"
    git log --oneline -3 2>/dev/null || true
  fi

  echo
  echo "Fix the failing check(s) and re-run them locally before declaring"
  echo "the task complete. Do NOT disable a check to make the hook pass."
} >&2

emit_precompletion_failures=$(tr '\n' ' ' < "$TMPDIR_HOOK/failed.list")
emit_stop_telemetry "precompletion_block" "precompletion-checklist" "$emit_precompletion_failures"

# Opt-in headless recovery. Spawns a one-turn `claude -p` to attempt the fix
# autonomously. Useful for unattended CI / cron contexts. Off by default
# because it costs tokens.
#
# Resolution order (first wins):
#   1. AHK_HEADLESS_RECOVER=1   (env-var override, per-run)
#   2. .harness/config.json `.recovery.headless: true`   (persistent)
HEADLESS_RECOVER=0
HEADLESS_SOURCE=""
if [ "${AHK_HEADLESS_RECOVER:-}" = "1" ]; then
  HEADLESS_RECOVER=1
  HEADLESS_SOURCE="AHK_HEADLESS_RECOVER"
elif [ -f .harness/config.json ] && have_jp; then
  CFG_VAL=$(jp '.recovery.headless // false' .harness/config.json 2>/dev/null)
  if [ "$CFG_VAL" = "true" ]; then
    HEADLESS_RECOVER=1
    HEADLESS_SOURCE=".harness/config.json:.recovery.headless"
  fi
fi
if [ "$HEADLESS_RECOVER" = "1" ] && command -v claude >/dev/null 2>&1; then
  FAILED_LIST=$(tr '\n' ' ' < "$TMPDIR_HOOK/failed.list")

  # Concurrency guard. Two Stop events in different sessions (e.g. user
  # working in two terminals, or an unattended CI rerun firing while a
  # previous recovery is still active) used to race and edit the same
  # files. The lock is a directory created atomically with `mkdir`; the
  # PID file inside lets us detect stale locks left by a crashed parent.
  mkdir -p .harness
  LOCK_DIR=".harness/recovery.lock"
  LOCK_STALE_MAX_SECS=${AHK_RECOVERY_LOCK_STALE_SECS:-1800}

  if mkdir "$LOCK_DIR" 2>/dev/null; then
    # We won the race — spawn the recovery turn. Snapshot the failure
    # context into the lock dir BEFORE the parent's EXIT trap deletes
    # TMPDIR_HOOK; otherwise the subshell's redirect to recover.out
    # races the parent's cleanup and the subshell dies before claude
    # can run. Everything the recovery needs (failed.list, per-check
    # output, recover.out) now lives inside LOCK_DIR — self-contained.
    cp -r "$TMPDIR_HOOK/." "$LOCK_DIR/snapshot/" 2>/dev/null || true
    (
      # Trap removes the lock on subshell EXIT (success, failure, or signal).
      trap 'rm -rf "$LOCK_DIR"' EXIT
      claude -p \
        "The pre-completion checklist failed: $FAILED_LIST. Read the failure output in $LOCK_DIR/snapshot and apply the smallest fix. Do not disable any check." \
        --max-turns 5 \
        >"$LOCK_DIR/recover.out" 2>&1
    ) &
    SUB_PID=$!
    # Parent writes metadata SYNCHRONOUSLY before printing the "spawned"
    # message so a second Stop firing immediately after never sees an
    # empty pid file. Subsecond races between mkdir and these writes are
    # closed by the bounded read-loop in the lock-held branch below.
    echo "$SUB_PID" > "$LOCK_DIR/pid"
    date +%s > "$LOCK_DIR/started_at"
    echo "$HEADLESS_SOURCE" > "$LOCK_DIR/source"
    echo "[ahk] headless recovery spawned (source=$HEADLESS_SOURCE, wrapper-pid=$SUB_PID, lock=$LOCK_DIR)" >&2
  else
    # Lock already held. Read who holds it and decide: live → skip,
    # stale → reclaim. We never block the user's Stop on the lock —
    # worst case we skip a recovery turn that the next Stop can retry.
    # Bounded wait for the pid file to materialize — closes the race
    # window between the parent's `mkdir` and its `echo $SUB_PID > pid`.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      [ -s "$LOCK_DIR/pid" ] && break
      sleep 0.05
    done
    EXISTING_PID=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
    STARTED_AT=$(cat "$LOCK_DIR/started_at" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    AGE=$((NOW - STARTED_AT))
    if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
      echo "[ahk] headless recovery skipped — another session already running (pid=$EXISTING_PID, age=${AGE}s, lock=$LOCK_DIR)" >&2
    elif [ "$AGE" -gt "$LOCK_STALE_MAX_SECS" ]; then
      echo "[ahk] headless recovery: removing stale lock (pid=$EXISTING_PID, age=${AGE}s > ${LOCK_STALE_MAX_SECS}s); next stop will retry. lock=$LOCK_DIR" >&2
      rm -rf "$LOCK_DIR"
    else
      echo "[ahk] headless recovery skipped — lock present with dead pid=$EXISTING_PID (age=${AGE}s, will reclaim after ${LOCK_STALE_MAX_SECS}s). lock=$LOCK_DIR" >&2
    fi
  fi
fi

if [ "${AHK_RUNTIME:-}" = "kiro" ]; then
  echo >&2
  echo "[ahk] Kiro Stop hooks are advisory: this turn already completed and cannot be hard-blocked." >&2
  echo "[ahk] Resolve the failing check(s) above before claiming the task is done." >&2
fi

exit 2

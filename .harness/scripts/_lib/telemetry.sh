#!/usr/bin/env bash
# _lib/telemetry.sh — source-only library. DO NOT execute directly.
#
# Provides telemetry_append <jsonl-line> — write one line to
# .harness/telemetry.jsonl and rotate when the file grows past
# AHK_TELEMETRY_MAX_LINES (default 5000).
#
# Why centralised:
#   - Two hooks append (telemetry-on-skill, notify-on-block). Rotation logic
#     written once = one place to fix when the file format evolves.
#   - harness-report.mjs only ever inspects the last 14 days; older lines are
#     pure I/O cost. Bounding lines bounds report time at O(1).
#
# Env vars:
#   AHK_DISABLE_TELEMETRY=1     → caller is expected to early-exit; this
#                                 helper does NOT re-check (avoids double
#                                 work) — gate in the caller.
#   AHK_TELEMETRY_MAX_LINES=N   → cap (default 5000). Set 0 to disable
#                                 rotation entirely (keep unbounded).

telemetry_append() {
  local line="$1"
  [ -z "$line" ] && return 0
  mkdir -p .harness
  printf '%s\n' "$line" >> .harness/telemetry.jsonl

  local limit="${AHK_TELEMETRY_MAX_LINES:-5000}"
  # 0 = caller opted out of rotation explicitly.
  [ "$limit" = "0" ] && return 0
  # Non-numeric → fall back to default rather than failing the hook.
  case "$limit" in
    ''|*[!0-9]*) limit=5000 ;;
  esac

  # wc -l is sub-millisecond on files we care about (< 1MB at the default
  # cap). Cheap enough to run every append; avoids needing a daemon.
  local lines
  lines=$(wc -l < .harness/telemetry.jsonl 2>/dev/null || echo 0)
  if [ "$lines" -gt "$limit" ]; then
    # tail to tmp + mv = atomic on POSIX. Reader can't catch a half-written
    # file mid-rotate.
    tail -n "$limit" .harness/telemetry.jsonl > .harness/telemetry.jsonl.tmp \
      && mv .harness/telemetry.jsonl.tmp .harness/telemetry.jsonl
  fi
}

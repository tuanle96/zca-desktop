#!/usr/bin/env bash
# _lib/jp.sh — source-only library. DO NOT execute directly.
#
# Provides three shared helpers used by every hook script that parses Claude
# Code's JSON stdin:
#
#   have_jq        — true iff jq is on PATH AND not disabled via env
#   have_jp        — true iff EITHER jq OR (node + _lib/json-pick.mjs) is usable
#   jp <expr> [f]  — run a jq-subset expression, preferring jq when present,
#                    else the Node fallback. Accepts optional file arg (some
#                    callers pass it; most read from stdin).
#
# Why this exists: the same ~14 lines were duplicated across 12 hook scripts.
# Single source of truth so fixing one bug (e.g. the "json-pick.mjs only
# supports one `// default` per expression" footgun documented in
# session-end.sh.hbs) only needs one edit, not twelve.
#
# Sourcing convention — the calling script MUST set _LIB_DIR before . :
#
#   SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
#   _LIB_DIR="$SCRIPT_DIR/_lib"
#   . "$_LIB_DIR/jp.sh"
#
# Env vars:
#   AHK_DISABLE_JQ=1 → pretend jq is missing; forces the Node fallback path.
#                      Lets us test the fallback on machines that have jq.

have_jq() {
  [ "${AHK_DISABLE_JQ:-}" = "1" ] && return 1
  command -v jq >/dev/null 2>&1
}

have_jp() {
  have_jq && return 0
  command -v node >/dev/null 2>&1 \
    && [ -f "$_LIB_DIR/json-pick.mjs" ] \
    && return 0
  return 1
}

jp() {
  if have_jq; then
    if [ -n "${2:-}" ]; then jq -r "$1" "$2"
    else jq -r "$1"
    fi
  else
    if [ -n "${2:-}" ]; then
      node "$_LIB_DIR/json-pick.mjs" "$1" "$2"
    else
      node "$_LIB_DIR/json-pick.mjs" "$1"
    fi
  fi
}

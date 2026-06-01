#!/usr/bin/env bash
# pre-push hook — Stripe "shift-feedback-left" pattern. Runs only the
# deterministic checks (structural test + linter + tests on changed files).
# Lives in .harness/scripts/ so it ships with the repo; install via install-git-hooks.sh.
set -eo pipefail

# Resolve script dir so we can find _lib/json-pick.mjs (Node fallback for jq).
# Without this fallback, `jq` missing on a fresh CI image silently disabled
# the baseline-monotonic guard — a known audit hole.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
_LIB_DIR="$SCRIPT_DIR/_lib"
. "$_LIB_DIR/jp.sh"

# Baseline monotonic guard. .harness/structural-baseline.json is decreasing-
# only — fixes REMOVE entries; no path should ADD them. Catches the "mask
# violations by baselining them" anti-pattern before code leaves the machine.
# Runs first because a grown baseline silently masks structural-test failures.
BASELINE_FILE=".harness/structural-baseline.json"
if [ -f "$BASELINE_FILE" ] \
   && have_jp \
   && git rev-parse --verify HEAD >/dev/null 2>&1 \
   && git cat-file -e "HEAD:$BASELINE_FILE" 2>/dev/null; then
  CURRENT_COUNT=$(jp 'length' "$BASELINE_FILE" 2>/dev/null || echo 0)
  HEAD_COUNT=$(git show "HEAD:$BASELINE_FILE" 2>/dev/null | jp 'length' 2>/dev/null || echo 0)
  if [ "$CURRENT_COUNT" -gt "$HEAD_COUNT" ]; then
    {
      echo
      echo "[pre-push] BLOCKED: structural-baseline.json grew vs HEAD"
      echo "  Previous: $HEAD_COUNT entries"
      echo "  Current:  $CURRENT_COUNT entries (+$((CURRENT_COUNT - HEAD_COUNT)))"
      echo
      echo "Baseline is decreasing-only. New violations should be FIXED,"
      echo "not appended to the baseline."
      echo
      echo "To bypass intentionally (e.g. legitimate refactor that re-baselines"
      echo "across a domain boundary):"
      echo "  git push --no-verify   # then document the reason in the commit"
    } >&2
    exit 2
  fi
fi

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
    echo "[pre-push] no structural test command found for configured engine" >&2
    return 1
  fi
}

# Structural test. Skipped when `structuralTest.engine` is explicitly "none"
# (e.g. during scaffold of a polyglot repo where the adapter is not yet
# wired). Without this guard the push fails silently when no adapter command
# is available.
if [ -f .harness/config.json ] \
   && grep -qE '"engine"[[:space:]]*:[[:space:]]*"none"' .harness/config.json; then
  echo "[pre-push] structural test skipped (structuralTest.engine: none)"
else
  echo "[pre-push] running structural test…"
  run_structural_check
fi

echo "[pre-push] running lint…"
if [ -f package.json ] && grep -q '"lint"' package.json; then
  npm run --silent lint
elif command -v ruff >/dev/null 2>&1; then
  ruff check .
fi

echo "[pre-push] OK"

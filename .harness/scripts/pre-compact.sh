#!/usr/bin/env bash
# PreCompact hook — write a small snapshot of state to
# .harness/compaction-snapshot.json BEFORE the context compactor runs.
# The companion SessionStart hook (matcher: compact) reads this snapshot
# back and re-injects the salient fields so the post-compaction model
# knows which feature it was working on, which branch, and how dirty
# the tree was.
#
# This is the kit's answer to the "I lost everything after compaction"
# failure mode that recurs in long sessions. Pair with:
#   - SessionStart matcher compact → re-inject
#   - PostCompact (not implemented; SessionStart does the work)
#
# Snapshot contents:
#   {
#     "compacted_at": "2026-05-16T19:00:00Z",
#     "branch": "main",
#     "sha": "abc1234",
#     "uncommitted": 7,
#     "feature": "auth-endpoint — POST /auth/login",
#     "trigger": "manual|auto",
#     "estimated_tokens_removed": 5000
#   }
#
# The hook NEVER blocks (exit 0 always). PreCompact can technically block
# compaction but doing so defeats the entire point.
set -eo pipefail

INPUT=$(cat)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
_LIB_DIR="$SCRIPT_DIR/_lib"
. "$_LIB_DIR/jp.sh"

TRIGGER=""
TOKENS=""
if have_jp; then
  TRIGGER=$(echo "$INPUT" | jp '.trigger // "auto"' 2>/dev/null || true)
  TOKENS=$(echo "$INPUT" | jp '.estimated_tokens_removed // 0' 2>/dev/null || true)
fi

mkdir -p .harness

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BR="(no-git)"
SHA="(no-git)"
COUNT=0
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  BR=$(git branch --show-current 2>/dev/null || echo "(detached)")
  SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "(none)")
  COUNT=$(git status --short 2>/dev/null | wc -l | tr -d ' ')
fi

FEAT=""
if [ -f .harness/feature_list.json ]; then
  if have_jq; then
    FEAT=$(jq -r 'first((if type == "array" then . else .features end)[] | select(.passes == false)) | "\(.id) — \(.title)"' \
      .harness/feature_list.json 2>/dev/null || true)
  elif command -v node >/dev/null 2>&1; then
    FEAT=$(node -e "
      const f = JSON.parse(require('fs').readFileSync('.harness/feature_list.json','utf8'));
      const arr = Array.isArray(f) ? f : (f.features || []);
      const o = arr.find(x => x.passes === false);
      if (o) process.stdout.write(o.id + ' — ' + o.title);
    " 2>/dev/null || true)
  fi
fi

# Compose JSON via Node when available — handles escaping right.
if command -v node >/dev/null 2>&1; then
  node -e "
    const fs = require('fs');
    const snap = {
      compacted_at: '$TS',
      branch: '$BR',
      sha: '$SHA',
      uncommitted: parseInt('$COUNT', 10) || 0,
      feature: process.argv[1] || '',
      trigger: '$TRIGGER' || 'auto',
      estimated_tokens_removed: parseInt('$TOKENS', 10) || 0
    };
    fs.writeFileSync('.harness/compaction-snapshot.json', JSON.stringify(snap, null, 2) + '\n');
  " "$FEAT"
elif have_jq; then
  jq -n --arg ts "$TS" --arg br "$BR" --arg sha "$SHA" \
        --argjson cnt "$COUNT" --arg feat "$FEAT" \
        --arg trig "${TRIGGER:-auto}" --argjson tok "${TOKENS:-0}" \
    '{compacted_at: $ts, branch: $br, sha: $sha, uncommitted: $cnt,
      feature: $feat, trigger: $trig, estimated_tokens_removed: $tok}' \
    > .harness/compaction-snapshot.json
else
  # No JSON tool available — write a minimal record. SessionStart compact
  # branch reads fields individually so partial records still work.
  cat > .harness/compaction-snapshot.json <<EOF
{
  "compacted_at": "$TS",
  "branch": "$BR",
  "sha": "$SHA",
  "uncommitted": $COUNT,
  "feature": "$FEAT",
  "trigger": "${TRIGGER:-auto}"
}
EOF
fi
exit 0

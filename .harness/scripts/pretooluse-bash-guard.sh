#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash) — denies a small, deterministic set of
# shell commands that would bypass the harness's safety net. Replaces the
# "don't disable the structural test" warning in CLAUDE.md with a hard
# guardrail (Hashimoto axiom: every failure becomes a permanent prevention).
#
# What's denied (and why):
#   1. `git (push|commit) --no-verify`     — bypasses pre-push baseline guard
#   2. `rm -rf .harness/`                  — wipes lockfile + baseline state
#   3. `rm -rf .claude/`                   — wipes skills/agents/hooks config
#   4. `chmod -x .harness/scripts/(structural-test|precompletion|pre-push)…`
#                                          — disables hook scripts via perm bit
#   5. `> .harness/structural-baseline.json` (truncation)
#                                          — wipes baseline without GC ritual
#   6. `jq … .harness/structural-baseline.json | … > ...`
#                                          — manual baseline grow (covered by
#                                            baseline-monotonic guard, but the
#                                            agent should not even try)
#   7. Setting `disableAllHooks: true` via sed/jq into .claude/settings.json
#   8. Direct writes to .harness/state/advisor-runs/ or manual subagent-stop.sh
#      invocation, which can forge advisor runtime proof.
#
# Allowed escape hatch: `AHK_ALLOW_BYPASS=1` environment variable. When
# present, the guard logs the attempt to .harness/bypass.log and lets the
# command through. Use only with explicit user intent (e.g. mass-rename
# refactor). The bypass leaves a paper trail so it can't be silent.
#
# Decision contract:
#   - Pattern match + no bypass → exit 0 + JSON permissionDecision: "deny"
#     with permissionDecisionReason explaining the rule.
#   - No match → exit 0 with no output (defer to model's auto-mode).
#   - Bypass env present → log + exit 0 (defer, command proceeds).
set -eo pipefail

INPUT=$(cat)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
_LIB_DIR="$SCRIPT_DIR/_lib"
. "$_LIB_DIR/jp.sh"

if ! have_jp; then
  # Without a JSON parser we can't read the command. Skip rather than
  # spuriously block — failing closed here would deny EVERY Bash call.
  exit 0
fi

CMD=""
if command -v node >/dev/null 2>&1; then
  CMD=$(node -e '
    const input = JSON.parse(process.argv[1] || "{}");
    const v = input.tool_input?.command || input.input?.command || input.arguments?.command || input.command || "";
    process.stdout.write(String(v || ""));
  ' "$INPUT" 2>/dev/null || true)
fi
if [ -z "$CMD" ]; then
  CMD=$(echo "$INPUT" | jp '.tool_input.command // empty')
fi
[ -z "$CMD" ] && exit 0

# Compose denial reason. Empty when allowed.
REASON=""

# Pattern 1: --no-verify on git push / commit
if echo "$CMD" | grep -qE '\bgit\s+(push|commit)\b.*--no-verify\b'; then
  REASON="git push/commit --no-verify bypasses the pre-push baseline-monotonic guard. The kit ships that guard because the path of least resistance for new violations is 'append them to the baseline' — which defeats the rule. Fix the underlying violation, then push without --no-verify."
fi

# Pattern 2: rm -rf .harness/ or .claude/
if echo "$CMD" | grep -qE '\brm\s+(-[rRf]+\s+|--recursive\s+)+\.?\.?/?\.harness(/|\s|$)'; then
  REASON="rm -rf .harness/ removes the lockfile + structural baseline. Use 'agent-harness-kit upgrade' to refresh installed files instead."
fi
if echo "$CMD" | grep -qE '\brm\s+(-[rRf]+\s+|--recursive\s+)+\.?\.?/?\.claude(/|\s|$)'; then
  REASON="rm -rf .claude/ removes every skill/agent/hook the kit wrote. Re-init with 'agent-harness-kit init' if you need a clean slate."
fi

# Pattern 3: chmod -x on hook scripts (silently disables them)
if echo "$CMD" | grep -qE '\bchmod\s+([-+]?[ugoa]?[-+=][rwxX]*)?-x\s+.harness/scripts/(structural-test|precompletion|pre-push|session-start|pretooluse)' \
   || echo "$CMD" | grep -qE '\bchmod\s+0?[0-6][0-6][0-6]\s+.harness/scripts/(structural-test|precompletion|pre-push|session-start|pretooluse)'; then
  REASON="chmod -x on a hook script silently disables the harness. If you need to skip the check this turn, set AHK_HOOK_MODE=warn for the session — that leaves an audit trail."
fi

# Pattern 4: truncating the structural baseline
if echo "$CMD" | grep -qE '(^|[;&|]\s*)(:|true|echo\s*("\["|\[\]|"|null))\s*>\s*\.harness/structural-baseline\.json' \
   || echo "$CMD" | grep -qE '>\s*\.harness/structural-baseline\.json\s*$'; then
  # The second pattern is broader (any redirect TO the baseline). Allow
  # 'mv' or 'cp' which produce non-truncating writes; this pattern catches
  # the `> baseline.json` shape only.
  REASON="Direct write to .harness/structural-baseline.json bypasses the monotonic guard. Append entries through the kit's own /garbage-collection skill, or fix the violation in code so the baseline shrinks."
fi

# Pattern 5: setting disableAllHooks via sed/jq
if echo "$CMD" | grep -qE '(sed|jq).*disableAllHooks.*true.*\.claude/settings\.json' \
   || echo "$CMD" | grep -qE '\.claude/settings\.json.*disableAllHooks.*true' \
   || echo "$CMD" | grep -qE 'disableAllHooks.*true.*\.claude/settings\.json'; then
  REASON="disableAllHooks: true defeats every protection the kit installs. If you need to temporarily disable a specific hook for debugging, remove it explicitly with a commit message explaining why."
fi

# Pattern 6: advisor runtime proof must come from the real SubagentStop hook,
# not from a shell redirection or manual invocation by the parent agent.
if echo "$CMD" | grep -qE '>\s*\.harness/state/advisor-runs/' \
   || echo "$CMD" | grep -qE '\.harness/state/advisor-runs/' \
   || echo "$CMD" | grep -qE '\.harness/scripts/subagent-stop\.sh'; then
  REASON="Advisor runtime proof is written only by the agent runtime's SubagentStop hook. Invoke the advisor subagent; do not create advisor-runs proof or run subagent-stop.sh manually."
fi

if [ -z "$REASON" ]; then
  # Command passed all checks — defer to the auto-mode classifier (or to
  # whatever permission rule the user has set). We do not return
  # permissionDecision: "allow" because that would auto-approve every
  # benign Bash call, robbing the user of explicit approvals when in
  # default mode.
  exit 0
fi

# Bypass escape hatch — leaves an audit trail.
if [ "${AHK_ALLOW_BYPASS:-}" = "1" ]; then
  mkdir -p .harness
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  SHA=$(git rev-parse --short HEAD 2>/dev/null || echo 'no-git')
  ESCAPED_CMD=${CMD//$'\n'/ }
  ESCAPED_CMD=${ESCAPED_CMD//\"/\\\"}
  printf '{"ts":"%s","sha":"%s","bypass":"AHK_ALLOW_BYPASS","reason":"%s","command":"%s"}\n' \
    "$TS" "$SHA" "${REASON//\"/\\\"}" "$ESCAPED_CMD" >> .harness/bypass.log
  exit 0
fi

# Emit deny. JSON via Node so escaping is honest.
if command -v node >/dev/null 2>&1; then
  node -e "
    const reason = process.argv[1];
    const out = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason
      }
    };
    process.stdout.write(JSON.stringify(out));
  " "$REASON"
elif have_jq; then
  jq -nc --arg r "$REASON" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
else
  # Fallback: exit 2 with stderr. Older Claude Code versions parse stderr
  # for denial reason when JSON unavailable.
  echo "$REASON" >&2
  exit 2
fi
exit 0

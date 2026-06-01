#!/usr/bin/env bash
# Notification hook — OS-native notification when Claude wants attention.
# macOS osascript / Linux notify-send / Windows skip.
# Never blocks. Always exits 0. Opt-out: AHK_DISABLE_NOTIFY=1.
set -eo pipefail

INPUT=$(cat)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
_LIB_DIR="$SCRIPT_DIR/_lib"
. "$_LIB_DIR/jp.sh"
. "$_LIB_DIR/telemetry.sh"

if [ "${AHK_DISABLE_NOTIFY:-}" = "1" ]; then
  exit 0
fi

TYPE=""
TITLE=""
BODY=""
if have_jp; then
  TYPE=$(echo "$INPUT"  | jp '.notification.type  // empty')
  TITLE=$(echo "$INPUT" | jp '.notification.title // empty')
  BODY=$(echo "$INPUT"  | jp '.notification.body  // empty')
fi

[ -z "$TITLE" ] && TITLE="Claude Code"
if [ -n "$TYPE" ]; then
  BODY="[$TYPE] ${BODY}"
fi
[ -z "$BODY" ] && BODY="Claude Code wants your attention."

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ESCAPED_TITLE=${TITLE//\"/\\\"}
ESCAPED_BODY=${BODY//\"/\\\"}
LINE=$(printf '{"schemaVersion":1,"ts":"%s","event":"notification","hook":"Notification","type":"%s","title":"%s","body":"%s"}' \
  "$TS" "$TYPE" "$ESCAPED_TITLE" "$ESCAPED_BODY")
telemetry_append "$LINE"

OS_KIND=$(uname -s 2>/dev/null || echo "Unknown")
case "$OS_KIND" in
  Darwin)
    OSA_TITLE=${TITLE//\"/\\\"}
    OSA_BODY=${BODY//\"/\\\"}
    osascript -e "display notification \"$OSA_BODY\" with title \"$OSA_TITLE\"" >/dev/null 2>&1 || true
    ;;
  Linux)
    if command -v notify-send >/dev/null 2>&1; then
      notify-send -a "Claude Code" "$TITLE" "$BODY" >/dev/null 2>&1 || true
    fi
    ;;
  *)
    :
    ;;
esac

exit 0

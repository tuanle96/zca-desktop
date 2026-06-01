#!/usr/bin/env bash
# Start the dev server and wait until it answers a readiness probe.
# Used by `/debug-flow` and by humans during interactive work.
set -euo pipefail

PORT="${PORT:-3000}"




HEALTH_PATH="${HEALTH_PATH:-/}"


echo "[dev-up] starting dev server on port $PORT…"
npm run dev &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" || true
  fi
}
trap cleanup EXIT INT TERM

# Wait for readiness (max 30s).
for i in $(seq 1 60); do
  if curl -fs "http://localhost:$PORT$HEALTH_PATH" >/dev/null 2>&1; then
    echo "[dev-up] ready at http://localhost:$PORT$HEALTH_PATH"
    break
  fi
  sleep 0.5
done

# Hand control back to the foreground process.
wait "$SERVER_PID"

#!/usr/bin/env bash
# Start or stop the local rs-sdk stack (engine, webclient bundler, gateway).
# Usage: bash scripts/dev-stack.sh [start|stop]
# Logs and PIDs go to measurements/raw/. Run it on Linux or in WSL2 as a non-root user.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$ROOT/vendor/rs-sdk/server"
RAW="$ROOT/measurements/raw"
PIDS="$RAW/dev-stack.pids"
BOT_PAGE_URL="http://localhost:8888/bot"
GATEWAY_PORT=7780
READY_TIMEOUT_S="${DEV_STACK_TIMEOUT_S:-1800}"

mkdir -p "$RAW"

# Each part runs in its own session (setsid), so its PID is also its process
# group ID. Stop signals the whole group, which includes the children of `bun run`.
start_part() {
  local name="$1" dir="$2" cmd="$3"
  setsid bash -c 'cd "$1" && eval "$2"' _ "$dir" "$cmd" >"$RAW/dev-stack-$name.log" 2>&1 </dev/null &
  echo "$name $!" >>"$PIDS"
  echo "started $name (pid $!), log $RAW/dev-stack-$name.log"
}

stop_stack() {
  [ -f "$PIDS" ] || { echo "dev stack not running (no $PIDS)"; return 0; }
  local name pid
  while read -r name pid; do
    kill -TERM -- "-$pid" 2>/dev/null && echo "stopping $name (pgid $pid)" || true
  done <"$PIDS"
  for _ in $(seq 1 20); do
    local alive=0
    while read -r name pid; do kill -0 -- "-$pid" 2>/dev/null && alive=1; done <"$PIDS"
    [ "$alive" = 0 ] && break
    sleep 0.5
  done
  while read -r name pid; do
    kill -KILL -- "-$pid" 2>/dev/null && echo "killed $name (pgid $pid)" || true
  done <"$PIDS"
  rm -f "$PIDS"
  echo "dev stack stopped"
}

part_died() {
  local name pid
  while read -r name pid; do
    if ! kill -0 -- "-$pid" 2>/dev/null; then echo "$name"; return 0; fi
  done <"$PIDS"
  return 1
}

wait_for() {
  local what="$1" check="$2" deadline=$((SECONDS + READY_TIMEOUT_S)) dead
  until eval "$check"; do
    if dead="$(part_died)"; then
      echo "dev stack failed: $dead exited; see $RAW/dev-stack-$dead.log" >&2
      stop_stack; exit 1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "dev stack failed: $what not ready after ${READY_TIMEOUT_S}s" >&2
      stop_stack; exit 1
    fi
    sleep 2
  done
  echo "$what ready"
}

http_ok() { [ "$(curl -s -o /dev/null -w '%{http_code}' "$BOT_PAGE_URL" || true)" = 200 ]; }

# A WebSocket upgrade answered with "101 Switching Protocols" proves the gateway accepts
# connections. curl then waits on the open socket until -m stops it (exit 28), so ignore its exit code.
ws_ok() {
  local code
  code="$(curl -s -o /dev/null -m 2 -w '%{http_code}' --http1.1 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: ZGV2LXN0YWNrLWNoZWNrIQ==' \
    "http://127.0.0.1:$GATEWAY_PORT/" 2>/dev/null || true)"
  [ "$code" = 101 ]
}

case "${1:-start}" in
  stop)
    stop_stack
    ;;
  start)
    if [ -f "$PIDS" ]; then
      echo "dev stack already started ($PIDS exists); run: bash scripts/dev-stack.sh stop" >&2
      exit 1
    fi
    command -v bun >/dev/null || { echo "bun not found on PATH" >&2; exit 1; }
    : >"$PIDS"
    trap 'echo "interrupted" >&2; stop_stack; exit 130' INT TERM
    # rs-sdk modifies the game content, so the first cache pack fails the upstream
    # checksum check. The rs-sdk Dockerfile and server/PATCHES.md set BUILD_VERIFY=false too.
    start_part engine "$SERVER/engine" "BUILD_VERIFY=false bun run start"
    start_part webclient "$SERVER/webclient" "bun install && bun run watch"
    # The gateway imports engine source files, so it starts after the engine's
    # `bun install` is complete and the bot page answers.
    wait_for "$BOT_PAGE_URL" http_ok
    wait_for "webclient bundle" '[ -s "$SERVER/webclient/out/bot/client.js" ]'
    start_part gateway "$SERVER/gateway" "GATEWAY_HOSTNAME=127.0.0.1 bun run gateway"
    wait_for "ws://localhost:$GATEWAY_PORT" ws_ok
    trap - INT TERM
    echo "dev stack ready"
    ;;
  *)
    echo "usage: bash scripts/dev-stack.sh [start|stop]" >&2
    exit 2
    ;;
esac

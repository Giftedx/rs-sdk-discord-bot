#!/usr/bin/env bash
# Daily check for a new client revision of the game server.
# deploy/systemd/rs-revision-check.timer runs it as rsbot.
#
# It fetches the bot page, computes its SHA-256 and compares the hash with the last hash in
# STATE_FILE (default /opt/rs-discord-bot/data/revision.txt). When the hash changes, it logs a
# line that starts with "REVISION CHANGED" (in the journal: journalctl -u rs-revision-check).
# A new revision can break the vendored rs-sdk; check the bot before you let it play.
#
# URL of the bot page: RS_BOT_PAGE_URL, else https://<RS_SERVER_HOST>/bot. The script reads
# these from the environment, else from ENV_FILE (default /opt/rs-discord-bot/secrets/bot.env).
# It reads only these two names from the file. It does not log the URL query, and it puts no
# secret on a command line.
#
# Exit status: 0 when the page did not change, or on the first run; 0 when it changed (the
# log line is the signal); 1 on an error.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/rs-discord-bot}"
STATE_FILE="${STATE_FILE:-$APP_DIR/data/revision.txt}"
ENV_FILE="${ENV_FILE:-$APP_DIR/secrets/bot.env}"

log() { echo "rs-revision-check: $*"; }
die() { echo "rs-revision-check: $*" >&2; exit 1; }

# Read one NAME=value line from the env file without running the file.
read_env() {
  local name="$1" line value
  [ -r "$ENV_FILE" ] || return 0
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$name=" "$ENV_FILE" | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#\"}"; value="${value%\"}"
  value="${value#\'}"; value="${value%\'}"
  printf '%s' "$value"
}

url="${RS_BOT_PAGE_URL:-$(read_env RS_BOT_PAGE_URL)}"
if [ -z "$url" ]; then
  host="${RS_SERVER_HOST:-$(read_env RS_SERVER_HOST)}"
  [ -n "$host" ] || die "set RS_BOT_PAGE_URL or RS_SERVER_HOST"
  url="https://$host/bot"
fi
case "$url" in
  https://*|http://*) ;;
  *) die "the bot page URL must start with https:// or http://" ;;
esac
shown="${url%%\?*}"

command -v curl >/dev/null || die "curl is not installed"
page="$(mktemp)"
trap 'rm -f "$page"' EXIT

# The URL goes to curl on stdin as a config line, so that it is not on the command line.
quoted="${url//\\/\\\\}"
quoted="${quoted//\"/\\\"}"
if ! printf 'url = "%s"\n' "$quoted" | curl --silent --show-error --fail --location \
    --max-time 60 --proto '=https,http' --output "$page" --config - ; then
  die "could not fetch $shown"
fi
[ -s "$page" ] || die "$shown returned an empty page"

hash="$(sha256sum "$page" | cut -d ' ' -f 1)"
last=""
if [ -r "$STATE_FILE" ]; then
  last="$(tail -n 1 "$STATE_FILE" | cut -d ' ' -f 2)"
fi

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -z "$last" ]; then
  log "first check of $shown: sha256 $hash"
  echo "$now $hash" >>"$STATE_FILE"
elif [ "$hash" != "$last" ]; then
  log "REVISION CHANGED: $shown sha256 $last -> $hash"
  echo "$now $hash" >>"$STATE_FILE"
else
  log "no change: $shown sha256 $hash"
fi

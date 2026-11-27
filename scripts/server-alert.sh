#!/usr/bin/env bash
# Posts one line to the Discord channel of the bot when a unit fails.
# deploy/systemd/rs-alert@.service runs it as rsbot through OnFailure= of the bot units.
#   server-alert.sh <unit name>
# It reads DISCORD_TOKEN and DISCORD_CHANNEL_ID from ENV_FILE (default
# /opt/rs-discord-bot/secrets/bot.env) without running the file, and sends the token only in
# an HTTP header from a file, never on a command line.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/rs-discord-bot}"
ENV_FILE="${ENV_FILE:-$APP_DIR/secrets/bot.env}"
unit="${1:-unknown unit}"
[[ "$unit" =~ ^[A-Za-z0-9@._-]{1,100}$ ]] || unit="unknown unit"

read_env() {
  local line value
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$ENV_FILE" | tail -n 1 || true)"
  value="${line#*=}"; value="${value%$'\r'}"; value="${value#\"}"; value="${value%\"}"
  value="${value#\'}"; value="${value%\'}"
  printf '%s' "$value"
}

token="$(read_env DISCORD_TOKEN)"
channel="$(read_env DISCORD_CHANNEL_ID)"
[ -n "$token" ] && [[ "$channel" =~ ^[0-9]{17,20}$ ]] || { echo "rs-alert: DISCORD_TOKEN or DISCORD_CHANNEL_ID is missing" >&2; exit 1; }

hdr="$(mktemp)"; trap 'rm -f "$hdr"' EXIT
chmod 600 "$hdr"
printf 'Authorization: Bot %s\n' "$token" > "$hdr"
body="{\"content\":\"Warning: the server unit ${unit} stopped with an error. The operator can read: journalctl -u ${unit}\",\"allowed_mentions\":{\"parse\":[]}}"
code="$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' -X POST -H @"$hdr" -H 'Content-Type: application/json' \
  --data "$body" "https://discord.com/api/v10/channels/$channel/messages" || true)"
echo "rs-alert: warning about $unit sent to Discord, HTTP status ${code:-none}"
[ "$code" = 200 ]

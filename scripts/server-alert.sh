#!/usr/bin/env bash
# Posts one line to a private operator channel (ALERT_CHANNEL_ID) when a unit fails, at most
# once per unit per hour. Without ALERT_CHANNEL_ID, it posts nothing.
# deploy/systemd/rs-alert@.service runs it as rsbot through OnFailure= of the bot units.
#   server-alert.sh <unit name>
#   server-alert.sh --revision     (from scripts/server-revision-check.sh: a new client revision)
# It reads DISCORD_TOKEN and ALERT_CHANNEL_ID (a private operator channel) from ENV_FILE (default
# /opt/rs-discord-bot/secrets/bot.env) without running the file, and sends the token only in
# an HTTP header from a file, never on a command line.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/rs-discord-bot}"
ENV_FILE="${ENV_FILE:-$APP_DIR/secrets/bot.env}"
unit="${1:-unknown unit}"
kind=failure
if [ "$unit" = --revision ]; then kind=revision; unit=revision; fi
[[ "$unit" =~ ^[A-Za-z0-9@._-]{1,100}$ ]] || unit="unknown unit"

read_env() {
  local line value
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$ENV_FILE" | tail -n 1 || true)"
  value="${line#*=}"; value="${value%$'\r'}"; value="${value#\"}"; value="${value%\"}"
  value="${value#\'}"; value="${value%\'}"
  printf '%s' "$value"
}

token="$(read_env DISCORD_TOKEN)"
# Alerts go to a private operator channel only, never to the channel where people play.
channel="$(read_env ALERT_CHANNEL_ID)"
if [ -z "$channel" ]; then echo "rs-alert: $unit ($kind); ALERT_CHANNEL_ID is not set, so no Discord message"; exit 0; fi
[ -n "$token" ] && [[ "$channel" =~ ^[0-9]{17,20}$ ]] || { echo "rs-alert: DISCORD_TOKEN or ALERT_CHANNEL_ID is not valid" >&2; exit 1; }
if [ "$channel" = "$(read_env DISCORD_CHANNEL_ID)" ]; then echo "rs-alert: ALERT_CHANNEL_ID is the player channel; no Discord message" >&2; exit 0; fi

# At most one message per unit per hour.
stamp="$APP_DIR/data/alert-$unit.last"
now="$(date +%s)"
if [ -f "$stamp" ] && [ $(( now - $(cat "$stamp" 2>/dev/null || echo 0) )) -lt 3600 ]; then
  echo "rs-alert: $unit ($kind) again; a message was sent less than an hour ago"
  exit 0
fi
echo "$now" > "$stamp"

hdr="$(mktemp)"; trap 'rm -f "$hdr"' EXIT
chmod 600 "$hdr"
printf 'Authorization: Bot %s\n' "$token" > "$hdr"
if [ "$kind" = revision ]; then
  text="Notice: the game server has a new client revision. a new game client revision; in split mode gamelink restarts with it (journalctl -u rs-revision-check). The operator can read: journalctl -u rs-revision-check"
else
  text="Warning: the server unit ${unit} stopped with an error. The operator can read: journalctl -u ${unit}"
fi
body="{\"content\":\"${text}\",\"allowed_mentions\":{\"parse\":[]}}"
code="$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' -X POST -H @"$hdr" -H 'Content-Type: application/json' \
  --data "$body" "https://discord.com/api/v10/channels/$channel/messages" || true)"
echo "rs-alert: message about $unit sent to Discord, HTTP status ${code:-none}"
[ "$code" = 200 ]

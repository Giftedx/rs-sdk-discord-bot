#!/usr/bin/env bash
# Posts one line to a private operator channel (ALERT_CHANNEL_ID) when a unit fails and stays
# down. A unit that systemd restarts and that runs again within ALERT_WAIT_SEC (default 300 s)
# gets no message: that is in the journal only. Without ALERT_CHANNEL_ID, it posts nothing.
# deploy/systemd/rs-alert@.service runs it as rsbot through OnFailure= of the bot units.
#   server-alert.sh <unit name>
# It reads DISCORD_TOKEN and ALERT_CHANNEL_ID (a private operator channel) from ENV_FILE (default
# /opt/rs-discord-bot/secrets/bot.env) without running the file, and sends the token only in
# an HTTP header from a file, never on a command line. At most one message per unit per hour.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/rs-discord-bot}"
ENV_FILE="${ENV_FILE:-$APP_DIR/secrets/bot.env}"
ALERT_WAIT_SEC="${ALERT_WAIT_SEC:-300}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
CURL="${CURL:-curl}"
unit="${1:-unknown unit}"
[[ "$unit" =~ ^[A-Za-z0-9@._-]{1,100}$ ]] || unit="unknown unit"
[[ "$ALERT_WAIT_SEC" =~ ^[0-9]{1,4}$ ]] || ALERT_WAIT_SEC=300

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
if [ -z "$channel" ]; then echo "rs-alert: $unit failed; ALERT_CHANNEL_ID is not set, so no Discord message"; exit 0; fi
[ -n "$token" ] && [[ "$channel" =~ ^[0-9]{17,20}$ ]] || { echo "rs-alert: DISCORD_TOKEN or ALERT_CHANNEL_ID is not valid" >&2; exit 1; }
if [ "$channel" = "$(read_env DISCORD_CHANNEL_ID)" ]; then echo "rs-alert: ALERT_CHANNEL_ID is the player channel; no Discord message" >&2; exit 0; fi

# A failure that systemd repairs is not for the operator. Wait, then look again.
echo "rs-alert: $unit failed; checking again in $ALERT_WAIT_SEC s"
sleep "$ALERT_WAIT_SEC"
state="$("$SYSTEMCTL" is-active "$unit" 2>/dev/null || true)"
state="${state%%$'\n'*}"
[[ "$state" =~ ^[a-z-]{1,20}$ ]] || state=unknown
if [ "$state" = active ]; then
  echo "rs-alert: $unit runs again; no Discord message"
  exit 0
fi

stamp="$APP_DIR/data/alert-$unit.last"
now="$(date +%s)"
if [ -f "$stamp" ] && [ $(( now - $(cat "$stamp" 2>/dev/null || echo 0) )) -lt 3600 ]; then
  echo "rs-alert: $unit is still down ($state); a message was sent less than an hour ago"
  exit 0
fi

hdr="$(mktemp)"; trap 'rm -f "$hdr"' EXIT
chmod 600 "$hdr"
printf 'Authorization: Bot %s\n' "$token" > "$hdr"
mins=$(( (ALERT_WAIT_SEC + 59) / 60 ))
text="Critical: the server unit ${unit} is down (${state}) and did not come back in ${mins} min. The operator can read: journalctl -u ${unit}"
body="{\"content\":\"${text}\",\"allowed_mentions\":{\"parse\":[]}}"
code="$("$CURL" -s --max-time 15 -o /dev/null -w '%{http_code}' -X POST -H @"$hdr" -H 'Content-Type: application/json' \
  --data "$body" "https://discord.com/api/v10/channels/$channel/messages" || true)"
echo "rs-alert: message about $unit sent to Discord, HTTP status ${code:-none}"
[ "$code" = 200 ] || exit 1
# The stamp only after a delivered message: a failed send must not hide the next alerts.
echo "$now" > "$stamp"

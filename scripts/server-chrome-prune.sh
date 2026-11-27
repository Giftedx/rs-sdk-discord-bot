#!/usr/bin/env bash
# Remove old Chrome for Testing copies. Run as root.
#
#   server-chrome-prune.sh            Dry run: list the versions under CHROME_ROOT and say which
#                                     ones the script would delete.
#   server-chrome-prune.sh --apply    Delete them.
#
# scripts/server-bootstrap.sh puts each version in CHROME_ROOT/<version>/chrome-linux64 and
# writes the one in use to RS_CHROME_PATH in /opt/rs-discord-bot/server.env. The script keeps
# that version and deletes all other version directories. It does not delete a version while a
# running process executes a file from it (a gamelink that has not restarted yet).
set -euo pipefail

CHROME_ROOT="${CHROME_ROOT:-/opt/rs-chrome}"
SERVER_ENV="${SERVER_ENV:-/opt/rs-discord-bot/server.env}"
PROC_DIR="${PROC_DIR:-/proc}"

die() { echo "server-chrome-prune: $*" >&2; exit 1; }
say() { echo "server-chrome-prune: $*"; }

apply=no
case "${1:-}" in
  "") ;;
  --apply) apply=yes ;;
  *) echo "usage: $0 [--apply]" >&2; exit 2 ;;
esac
[ "$(id -u)" -eq 0 ] || die "run this script as root"
[ -d "$CHROME_ROOT" ] || die "$CHROME_ROOT does not exist"

# Read one NAME=value line without running the file.
read_env() {
  local line value file="${1:-$SERVER_ENV}"
  [ -r "$file" ] || return 0
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?RS_CHROME_PATH=" "$file" | tail -n 1 || true)"
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#\"}"; value="${value%\"}"
  value="${value#\'}"; value="${value%\'}"
  printf '%s' "$value"
}

chrome_path="${RS_CHROME_PATH:-$(read_env)}"
[ -n "$chrome_path" ] || die "RS_CHROME_PATH is not set and not in $SERVER_ENV; nothing is deleted"
root="${CHROME_ROOT%/}"
case "$chrome_path" in
  "$root"/*) ;;
  *) die "RS_CHROME_PATH is not under $root; nothing is deleted" ;;
esac
rest="${chrome_path#"$root"/}"
keep="${rest%%/*}"
[[ "$keep" =~ ^[0-9A-Za-z._-]+$ ]] && [ "$keep" != . ] && [ "$keep" != .. ] || die "no version in RS_CHROME_PATH; nothing is deleted"
[ -x "$chrome_path" ] || die "RS_CHROME_PATH is not an executable file; nothing is deleted"

# In split mode gamelink runs the browser, and its RS_CHROME_PATH in gamelink.env wins. Keep that
# version too. A gamelink.env that exists but cannot be read stops the script.
GAMELINK_ENV="${GAMELINK_ENV:-/etc/rs-gamelink/gamelink.env}"
keep2=""
if [ -e "$GAMELINK_ENV" ]; then
  [ -r "$GAMELINK_ENV" ] || die "$GAMELINK_ENV exists but cannot be read; nothing is deleted"
  gl_path="$(read_env "$GAMELINK_ENV")"
  case "$gl_path" in
    "$root"/*) gl_rest="${gl_path#"$root"/}"; keep2="${gl_rest%%/*}" ;;
  esac
fi

# The version directories that running processes execute from.
in_use() {
  local exe
  for exe in "$PROC_DIR"/[0-9]*/exe; do
    exe="$(readlink "$exe" 2>/dev/null || true)"
    case "$exe" in
      "$root"/*) rest="${exe#"$root"/}"; echo "${rest%%/*}" ;;
    esac
  done | sort -u
}
busy="$(in_use)"

removed=0 kept=0
for dir in "$root"/*/; do
  [ -d "$dir" ] || continue
  dir="${dir%/}"
  name="${dir##*/}"
  size="$(du -sh "$dir" 2>/dev/null | cut -f1)"
  if [ "$name" = "$keep" ]; then
    say "keep   $name ($size): in RS_CHROME_PATH"
    kept=$((kept + 1))
  elif [ -n "$keep2" ] && [ "$name" = "$keep2" ]; then
    say "keep   $name ($size): in RS_CHROME_PATH of $GAMELINK_ENV"
  elif [ -L "$dir" ]; then
    say "skip   $name: a symbolic link"
  elif grep -qxF -- "$name" <<<"$busy"; then
    say "skip   $name ($size): a running process executes from it"
  elif [ "$apply" = yes ]; then
    rm -rf --one-file-system -- "$dir"
    say "delete $name ($size): done"
    removed=$((removed + 1))
  else
    say "delete $name ($size): dry run, use --apply"
    removed=$((removed + 1))
  fi
done
[ "$kept" -eq 1 ] || die "the version $keep of RS_CHROME_PATH is not a directory in $root"
if [ "$apply" = yes ]; then say "$removed deleted"; else say "$removed to delete (dry run)"; fi

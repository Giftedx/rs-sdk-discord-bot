#!/usr/bin/env bash
# Restore test of the newest backup of scripts/server-backup.sh. Run as root.
#
#   server-restore-test.sh [ARCHIVE]
#
# It extracts the archive (default: the newest rs-discord-bot-*.tar.gz in BACKUP_DIR) to a new
# temporary directory, checks that secrets/ and data/bot.sqlite are in it and that SQLite can
# open the database ("PRAGMA integrity_check" must give "ok"), prints the sizes and removes the
# temporary directory. It writes nothing to the live files of the bot.
# SQLite: sqlite3 if it is installed, else bun:sqlite through BUN (default /usr/local/bin/bun).
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/rs-discord-bot}"
BUN="${BUN:-/usr/local/bin/bun}"
DB_REL=data/bot.sqlite

die() { echo "rs-restore-test: $*" >&2; exit 1; }
say() { echo "rs-restore-test: $*"; }

[ "$#" -le 1 ] || { echo "usage: $0 [ARCHIVE]" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || die "run this script as root"

archive="${1:-}"
if [ -z "$archive" ]; then
  [ -d "$BACKUP_DIR" ] || die "$BACKUP_DIR does not exist"
  # The names sort by time, so the newest is last.
  name="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'rs-discord-bot-*.tar.gz' -printf '%f\n' | sort | tail -n 1)"
  [ -n "$name" ] || die "no backup in $BACKUP_DIR"
  archive="$BACKUP_DIR/$name"
fi
[ -f "$archive" ] || die "$archive is not a file"
say "archive $archive ($(stat -c %s "$archive") bytes)"

# The archive holds secrets/, data/ and, in split mode, rs-gamelink-etc/; refuse absolute paths and "..".
if tar -tzf "$archive" | grep -qE '(^/|(^|/)\.\.(/|$))'; then
  die "the archive holds an absolute path or '..'; not extracted"
fi

umask 077
tmp="$(mktemp -d "${TMPDIR:-/tmp}/rs-restore-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$archive" -C "$tmp" --no-same-owner --no-same-permissions

fail=0
if [ -d "$tmp/secrets" ]; then
  say "secrets/: $(find "$tmp/secrets" -type f | wc -l) files, $(du -sb "$tmp/secrets" | cut -f1) bytes"
else
  say "FAILED secrets/ is not in the archive"; fail=1
fi
# Split mode: the game account is in /etc/rs-gamelink, and the backup must hold it.
if [ -d "${GAMELINK_ETC:-/etc/rs-gamelink}" ]; then
  if [ -f "$tmp/rs-gamelink-etc/account.env" ]; then
    say "rs-gamelink-etc/: $(find "$tmp/rs-gamelink-etc" -type f | wc -l) files"
  else
    say "FAILED rs-gamelink-etc/account.env is not in the archive (split mode)"; fail=1
  fi
fi

db="$tmp/$DB_REL"
if [ -f "$db" ]; then
  say "$DB_REL: $(stat -c %s "$db") bytes"
  if command -v sqlite3 >/dev/null; then
    check="$(sqlite3 -readonly "$db" 'PRAGMA integrity_check;' 2>&1 || true)"
    tables="$(sqlite3 -readonly "$db" "SELECT count(*) FROM sqlite_master WHERE type = 'table';" 2>&1 || true)"
  elif [ -x "$BUN" ]; then
    js='import { Database } from "bun:sqlite";
const db = new Database(process.argv[2], { readonly: true });
const q = (s) => Object.values(db.query(s).get())[0];
console.log(q("PRAGMA integrity_check"));
console.log(q("SELECT count(*) FROM sqlite_master WHERE type = '"'"'table'"'"'"));'
    printf '%s\n' "$js" > "$tmp/check.mjs"
    out="$("$BUN" "$tmp/check.mjs" "$db" 2>&1 || true)"
    check="$(sed -n 1p <<<"$out")"
    tables="$(sed -n 2p <<<"$out")"
  else
    check="no sqlite3 and no $BUN"; tables=""
  fi
  if [ "$check" = ok ]; then
    say "$DB_REL: integrity_check ok, $tables tables"
  else
    say "FAILED $DB_REL: SQLite gives: $check"; fail=1
  fi
else
  say "FAILED $DB_REL is not in the archive"; fail=1
fi

say "extracted size: $(du -sb "$tmp" | cut -f1) bytes; the temporary directory is removed"
[ "$fail" -eq 0 ] && say "restore test passed" || say "restore test FAILED"
exit "$fail"

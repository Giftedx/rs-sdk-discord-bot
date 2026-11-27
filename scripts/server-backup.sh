#!/usr/bin/env bash
# Backup of the bot server. Run as root; deploy/systemd/rs-backup.timer runs it daily.
#
# It writes one tar.gz to BACKUP_DIR (default /var/backups/rs-discord-bot) with mode 600.
# The archive holds:
#   secrets/   the game account and the bot settings, with the tokens
#   data/      the notes, the scripts and the database of the bot
#   rs-gamelink-etc/  /etc/rs-gamelink in split mode: the game account and the socket token
# Each SQLite database (*.db, *.sqlite, *.sqlite3) is copied with "sqlite3 .backup", which
# gives a consistent copy while the bot runs. If sqlite3 is not installed, the script copies
# the file as it is. That copy can be inconsistent if the bot writes at the same time; the
# script logs a warning. Install sqlite3 to remove this risk.
# The script keeps the newest KEEP archives (default 14) and deletes the older ones.
#
# Restore:
#   1. sudo systemctl stop rs-discord-bot.service rs-gamelink.service
#   2. Look at the archive: sudo tar -tzf /var/backups/rs-discord-bot/rs-discord-bot-<time>.tar.gz
#   3. Extract it into the app directory:
#        sudo tar -xzpf /var/backups/rs-discord-bot/rs-discord-bot-<time>.tar.gz -C /opt/rs-discord-bot
#      This replaces secrets/ and data/. Databases are in data/ at their usual paths.
#   4. Make sure that the owner is correct:
#        sudo chown -R rsbot:rsbot /opt/rs-discord-bot/data
#        sudo chown -R rsbot:rsbot /opt/rs-discord-bot/secrets   (the owner that
#        scripts/server-bootstrap.sh gives, mode 700; tar -p keeps the modes)
#   5. Split mode only: the archive put rs-gamelink-etc/ in the app directory. Move it back to
#      /etc/rs-gamelink with its owners and modes, and delete the copy in the app directory:
#        sudo install -d -m 750 -o root -g rsgate /etc/rs-gamelink
#        sudo install -m 600 -o rsgame -g rsgame /opt/rs-discord-bot/rs-gamelink-etc/account.env /etc/rs-gamelink/
#        sudo install -m 640 -o root -g rsgate /opt/rs-discord-bot/rs-gamelink-etc/token /etc/rs-gamelink/
#        sudo install -m 640 -o root -g rsgame /opt/rs-discord-bot/rs-gamelink-etc/gamelink.env /etc/rs-gamelink/   (if it exists)
#        sudo rm -rf /opt/rs-discord-bot/rs-gamelink-etc
#   6. If a "*-wal" or "*-shm" file of an old database is next to a restored database, delete it.
#   7. sudo systemctl start rs-gamelink.service rs-discord-bot.service
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/rs-discord-bot}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/rs-discord-bot}"
KEEP="${KEEP:-14}"

log() { echo "rs-backup: $*"; }
die() { echo "rs-backup: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this script as root"
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || die "KEEP must be a positive number"
[ -d "$APP_DIR" ] || die "$APP_DIR does not exist"

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

name="rs-discord-bot-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
tmp="$BACKUP_DIR/.$name.part"
stage="$(mktemp -d "$BACKUP_DIR/.stage.XXXXXX")"
# A failed tar (a full disk) must not leave its part file. After the mv, $tmp no longer exists.
trap 'rm -rf "$stage" "$tmp"' EXIT
# Part files and stages of an earlier run that was killed.
find "$BACKUP_DIR" -maxdepth 1 \( -name '.rs-discord-bot-*.tar.gz.part' -o -name '.stage.*' \) ! -path "$stage" -exec rm -rf {} +

parts=()
for part in secrets data; do
  if [ -d "$APP_DIR/$part" ]; then
    cp -a "$APP_DIR/$part" "$stage/$part"
    parts+=("$part")
  else
    log "warning: $APP_DIR/$part does not exist; not in the backup"
  fi
done
# Split mode keeps the game account and the socket token in /etc/rs-gamelink.
GAMELINK_ETC="${GAMELINK_ETC:-/etc/rs-gamelink}"
if [ -d "$GAMELINK_ETC" ]; then
  cp -a "$GAMELINK_ETC" "$stage/rs-gamelink-etc"
  parts+=("rs-gamelink-etc")
fi
[ "${#parts[@]}" -gt 0 ] || die "nothing to back up"

# Replace the plain copy of each database with a consistent one. The list comes from the stage,
# which only root can write, and not from the live tree, which rsbot can change during the run.
# find does not follow symbolic links, so each $stage/$rel is a regular file in a real directory
# of the stage, and the writes below cannot leave the stage.
if [ -d "$stage/data" ]; then
  while IFS= read -r -d '' staged; do
    rel="${staged#"$stage"/}"
    db="$APP_DIR/$rel"
    # One file that is not a database, or a locked one, must not stop the whole backup. On a
    # failure the plain copy of cp -a above stays, with its -wal and -shm files.
    if command -v sqlite3 >/dev/null; then
      if sqlite3 "$db" ".backup '$stage/$rel.consistent'" && [ -s "$stage/$rel.consistent" ]; then
        mv -f "$stage/$rel.consistent" "$stage/$rel"
        rm -f "$stage/$rel-wal" "$stage/$rel-shm" "$stage/$rel-journal"
        log "database $rel: sqlite3 .backup"
      else
        rm -f "$stage/$rel.consistent"
        log "warning: sqlite3 .backup of $rel failed; $rel is a plain copy and can be inconsistent"
      fi
    elif [ -x "${BUN:-/usr/local/bin/bun}" ]; then
      # VACUUM INTO writes one consistent copy, also while the bot writes the database.
      if DB_SRC="$db" DB_DST="$stage/$rel.consistent" "${BUN:-/usr/local/bin/bun}" --no-env-file -e \
        'const { Database } = require("bun:sqlite"); const d = new Database(process.env.DB_SRC, { readonly: true }); d.run("VACUUM INTO ?", [process.env.DB_DST]); d.close();' && [ -s "$stage/$rel.consistent" ]; then
        mv -f "$stage/$rel.consistent" "$stage/$rel"
        rm -f "$stage/$rel-wal" "$stage/$rel-shm" "$stage/$rel-journal"
        log "database $rel: VACUUM INTO (bun:sqlite)"
      else
        rm -f "$stage/$rel.consistent"
        log "warning: VACUUM INTO of $rel failed; $rel is a plain copy and can be inconsistent"
      fi
    else
      log "warning: sqlite3 is not installed; $rel is a plain copy and can be inconsistent"
    fi
  done < <(find "$stage/data" -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -print0)
fi

tar -czf "$tmp" -C "$stage" "${parts[@]}"
chmod 600 "$tmp"
mv "$tmp" "$BACKUP_DIR/$name"
log "wrote $BACKUP_DIR/$name ($(stat -c %s "$BACKUP_DIR/$name") bytes)"

# The names sort by time, so the oldest are first.
mapfile -t all < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'rs-discord-bot-*.tar.gz' -printf '%f\n' | sort)
excess=$(( ${#all[@]} - KEEP ))
for (( i = 0; i < excess; i++ )); do
  rm -f "$BACKUP_DIR/${all[$i]}"
  log "deleted old backup ${all[$i]}"
done

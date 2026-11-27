#!/usr/bin/env bash
# Prepare the Ubuntu server for this project: system facts, packages, the user rsbot,
# Bun, the repository clone in /opt/rs-discord-bot, and Chrome for Testing.
#
# Requirements: Ubuntu 26.04 (the only tested version), and an admin SSH user whose sudo
# does not ask for a password. docs/deploy-server.md is the guide to this script.
#
# Usage (from your own machine, in a clone of this repository). The remote shell reads the
# whole script first, so no command in the script can read the rest of the script from stdin:
#   ssh <user>@<server> 'sudo bash -c "$(cat)" bootstrap prepare' < scripts/server-bootstrap.sh
#   git push over SSH to the bare repository /home/rsbot/repo.git as rsbot:
#     git push --receive-pack='sudo -u rsbot git-receive-pack' <user>@<server>:/home/rsbot/repo.git <branch>
#   ssh <user>@<server> 'sudo bash -c "$(cat)" bootstrap install <branch>' < scripts/server-bootstrap.sh
#   ssh <user>@<server> 'sudo bash -c "$(cat)" bootstrap chrome' < scripts/server-bootstrap.sh
#
# facts:   prints the CPU count, the memory, the disk, the kernel, the OS and two sysctl
#          values. It changes nothing.
# prepare: prints the facts, installs packages, creates rsbot (no sudo right),
#          installs Bun for rsbot, and creates the empty bare repository. The Bun installer
#          comes from https://bun.sh/install and runs as rsbot, not as root. This script
#          does not verify the installer.
# install: clones the branch with submodules to /opt/rs-discord-bot as rsbot (or updates
#          the clone) and runs bun install with the frozen lockfile and without a browser
#          download.
# chrome:  downloads Chrome for Testing CHROME_VERSION as root, checks the archive SHA-256,
#          extracts it to the root-owned /opt/rs-chrome/<version>/chrome-linux64, installs and
#          loads the AppArmor profile that this script holds (profile_text), sets
#          /home/rsbot/.cache to mode 700, and writes RS_CHROME_PATH to
#          /opt/rs-discord-bot/server.env. After a puppeteer update that brings a new Chrome,
#          change CHROME_VERSION and CHROME_ZIP_SHA256 (see the comment above them) and run it again.
# create-account-env <name>: run as rsbot, not root (see create_account_env). Writes
#          /opt/rs-discord-bot/secrets/account.env once; refuses to replace an existing file.
# Run the phases only as shown: root executes the script text that comes over SSH, never a
# copy in /opt/rs-discord-bot, which rsbot can write.
# Outside apt packages, /opt/rs-discord-bot and the home of rsbot, the script changes only
# /opt/rs-chrome and /etc/apparmor.d/rsbot-chrome-for-testing.
set -euo pipefail

BUN_VERSION=1.3.14
APP_USER=rsbot
APP_DIR=/opt/rs-discord-bot
BARE_REPO=/home/$APP_USER/repo.git

phase=${1:-}
if [ "$phase" = create-account-env ]; then
  if [ "$(id -u)" -eq 0 ]; then
    echo "run create-account-env as $APP_USER, not as root" >&2
    exit 2
  fi
elif [ "$(id -u)" -ne 0 ]; then
  echo "run as root (sudo bash -c \"\$(cat)\" bootstrap <phase>)" >&2
  exit 2
fi

as_app() { sudo -u "$APP_USER" -H bash -lc "$1"; }

facts() {
  echo "== facts"
  echo "nproc: $(nproc)"
  grep '^MemTotal:' /proc/meminfo
  df -h / | tail -n 1 | awk '{print "disk /: size " $2 ", used " $3 ", available " $4}'
  echo "kernel: $(uname -r)"
  cat /etc/os-release
  sysctl kernel.apparmor_restrict_unprivileged_userns kernel.unprivileged_userns_clone 2>&1 || true
}

# Chrome for Testing needs these libraries. Ubuntu 24.04 and later rename some of them with
# the suffix t64; for each entry, install the first name that apt knows and print the choice.
CHROME_LIBS=(
  "libasound2t64 libasound2"
  "libatk-bridge2.0-0t64 libatk-bridge2.0-0"
  "libatk1.0-0t64 libatk1.0-0"
  "libcups2t64 libcups2"
  "libdrm2"
  "libgbm1"
  "libgtk-3-0t64 libgtk-3-0"
  "libnss3"
  "libxcomposite1"
  "libxdamage1"
  "libxfixes3"
  "libxkbcommon0"
  "libxrandr2"
  "libpango-1.0-0"
  "libcairo2"
  "libxshmfence1"
  "fonts-liberation"
)

pick_package() {
  local name
  for name in $1; do
    if [ -n "$(apt-cache policy "$name" 2>/dev/null | awk '/Candidate:/ && $2 != "(none)" {print $2}')" ]; then
      echo "$name"
      return 0
    fi
  done
  return 1
}

prepare() {
  facts
  echo "== packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  local pkgs=(git unzip curl ca-certificates) entry chosen
  for entry in "${CHROME_LIBS[@]}"; do
    if chosen=$(pick_package "$entry"); then
      echo "library: wanted '$entry', using $chosen"
      pkgs+=("$chosen")
    else
      echo "library: no candidate for '$entry'" >&2
      exit 1
    fi
  done
  apt-get install -y -q --no-install-recommends "${pkgs[@]}"

  echo "== user $APP_USER"
  if ! id "$APP_USER" >/dev/null 2>&1; then
    useradd -m -s /bin/bash "$APP_USER"
  fi
  id "$APP_USER"
  if id -nG "$APP_USER" | tr ' ' '\n' | grep -qx -e sudo -e admin -e wheel; then
    echo "$APP_USER is in a sudo group" >&2
    exit 1
  fi

  echo "== bun $BUN_VERSION for $APP_USER"
  if ! as_app "test -x \$HOME/.bun/bin/bun && \$HOME/.bun/bin/bun --version" | grep -qx "$BUN_VERSION"; then
    as_app "curl -fsSL https://bun.sh/install -o \$HOME/bun-install.sh && bash \$HOME/bun-install.sh bun-v$BUN_VERSION && rm -f \$HOME/bun-install.sh"
  fi
  as_app "\$HOME/.bun/bin/bun --version"

  echo "== bare repository $BARE_REPO"
  if [ ! -d "$BARE_REPO" ]; then
    as_app "git init -q --bare $BARE_REPO"
  fi
  echo "prepare done"
}

install_app() {
  local branch=${1:?usage: install <branch>}
  echo "== clone $branch to $APP_DIR"
  if [ ! -d "$APP_DIR/.git" ]; then
    install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_DIR"
    as_app "git clone -q --recurse-submodules --branch '$branch' $BARE_REPO $APP_DIR"
  else
    as_app "cd $APP_DIR && git fetch -q origin && git checkout -q '$branch' && git reset -q --hard 'origin/$branch' && git submodule update -q --init --recursive"
  fi
  as_app "cd $APP_DIR && git log -1 --format='commit %h %s' && git -C vendor/rs-sdk log -1 --format='rs-sdk %h'"
  as_app "install -d -m 700 $APP_DIR/secrets && install -d -m 750 $APP_DIR/measurements/raw"

  echo "== bun install (no browser download)"
  # Chromium runs only from the root-owned copy of phase chrome. puppeteer downloads no browser
  # into the cache of rsbot, and a copy from an earlier run is removed.
  as_app "cd $APP_DIR && PUPPETEER_SKIP_DOWNLOAD=1 \$HOME/.bun/bin/bun install --frozen-lockfile"
  as_app "rm -rf \$HOME/.cache/puppeteer"
  echo "install done"
}

# Chrome for Testing in a root-owned directory, and the AppArmor profile that lets only that copy
# create user namespaces (the Chromium sandbox needs them; the sysctl
# kernel.apparmor_restrict_unprivileged_userns stays 1).
#
# Nothing in this phase that runs as root reads a program, a policy or a path from a place that
# rsbot can write. Its inputs are this script text (piped from your machine) and the archive
# from the official Chrome for Testing storage, which must match CHROME_ZIP_SHA256.
#
# CHROME_VERSION is the Chrome that the pinned puppeteer uses (PUPPETEER_REVISIONS.chrome in
# node_modules/puppeteer-core/lib/esm/puppeteer/revisions.js); src/deploy/bootstrap.test.ts
# checks that the two agree. Chrome for Testing publishes no SHA-256 for its archives. The value
# below is trust on first use: it is the SHA-256 of one download, whose MD5 matched the
# x-goog-hash header of the storage object. Verify it yourself with the procedure below
# before you rely on it.
# To change the version or to verify the value: set CHROME_VERSION, download
#   https://storage.googleapis.com/chrome-for-testing-public/<version>/linux64/chrome-linux64.zip
# on your machine, compare `openssl dgst -md5 -binary <zip> | base64` with the md5 of
# `curl -sI <url> | grep x-goog-hash`, put `sha256sum <zip>` in CHROME_ZIP_SHA256, and run phase chrome.
CHROME_VERSION=148.0.7778.97
CHROME_ZIP_SHA256=8a760543807c67d3836d530cc4bc2e39c93e217f1629ec6ea311415fdfa21a75
CHROME_ZIP_URL=https://storage.googleapis.com/chrome-for-testing-public/$CHROME_VERSION/linux64/chrome-linux64.zip
CHROME_ROOT=/opt/rs-chrome
PROFILE_NAME=rsbot-chrome-for-testing
PROFILE_DEST=/etc/apparmor.d/$PROFILE_NAME
SERVER_ENV=$APP_DIR/server.env

# The profile text. deploy/apparmor/rsbot-chrome-for-testing is the readable copy in the
# repository; src/deploy/bootstrap.test.ts checks that the two are identical.
profile_text() {
  cat <<'PROFILE'
# This profile allows everything and only exists to give the root-owned copy of
# Chrome for Testing a name instead of the label "unconfined", so that it can
# create the user namespaces of the Chromium sandbox while
# kernel.apparmor_restrict_unprivileged_userns stays 1.
# Same form as the chrome profile that Ubuntu 26.04 ships in /etc/apparmor.d/chrome.
# Installed by scripts/server-bootstrap.sh (phase chrome).
# This profile does not confine Chrome. Every local user who can run this binary
# can create user namespaces through it. See docs/security.md.
# Tested on Ubuntu 26.04 only.

abi <abi/5.0>,
include <tunables/global>

profile rsbot-chrome-for-testing /opt/rs-chrome/*/chrome-linux64/chrome flags=(unconfined) {
  userns,
  @{exec_path} mr,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/rsbot-chrome-for-testing>
}
PROFILE
}

# Fail if rsbot can write any directory on the path to the file or the file itself, or if
# anything under CHROME_ROOT is a symbolic link, not owned by root, writable by group or
# others, or setuid/setgid.
check_protected() {
  local target=$1 p=$1 bad=0
  while :; do
    if sudo -u "$APP_USER" test -w "$p"; then
      echo "writable by $APP_USER: $p" >&2
      bad=1
    else
      echo "not writable by $APP_USER: $p"
    fi
    [ "$p" = / ] && break
    p=$(dirname "$p")
  done
  local loose
  loose=$(find "$CHROME_ROOT" \( -type l -o ! -user root -o ! -group root -o -perm /022 -o -perm /6000 \) -print | head -n 5)
  if [ -n "$loose" ]; then
    echo "under $CHROME_ROOT: a symbolic link, not root-owned, writable by group or others, or setuid/setgid:" >&2
    echo "$loose" >&2
    bad=1
  fi
  if [ "$bad" -ne 0 ]; then
    echo "refusing to continue: $target is not protected from $APP_USER" >&2
    exit 1
  fi
}

install_chrome() {
  echo "== protected Chrome for Testing $CHROME_VERSION"
  local dest_dir=$CHROME_ROOT/$CHROME_VERSION/chrome-linux64
  local dest_bin=$dest_dir/chrome
  local marker=$CHROME_ROOT/$CHROME_VERSION/verified-sha256
  install -d -o root -g root -m 755 "$CHROME_ROOT"
  if [ -f "$marker" ] && [ "$(cat "$marker")" = "$CHROME_ZIP_SHA256" ] && [ -x "$dest_bin" ]; then
    echo "copy is current: $dest_dir (from the archive with SHA-256 $CHROME_ZIP_SHA256)"
  else
    local tmp
    tmp=$(mktemp -d "$CHROME_ROOT/.download.XXXXXX")
    curl -fsSL --proto '=https' -o "$tmp/chrome-linux64.zip" "$CHROME_ZIP_URL"
    echo "$CHROME_ZIP_SHA256  $tmp/chrome-linux64.zip" | sha256sum -c -
    unzip -q "$tmp/chrome-linux64.zip" -d "$tmp/x"
    if [ -n "$(find "$tmp/x" -type l -print -quit)" ]; then
      echo "refusing to continue: the archive holds a symbolic link" >&2
      rm -rf "$tmp"
      exit 1
    fi
    if [ "$(ls -A "$tmp/x")" != chrome-linux64 ]; then
      echo "refusing to continue: the archive holds more than chrome-linux64/" >&2
      rm -rf "$tmp"
      exit 1
    fi
    rm -rf "${CHROME_ROOT:?}/$CHROME_VERSION"
    install -d -o root -g root -m 755 "$CHROME_ROOT/$CHROME_VERSION"
    mv "$tmp/x/chrome-linux64" "$dest_dir"
    rm -rf "$tmp"
    echo "$CHROME_ZIP_SHA256" > "$marker"
    echo "extracted $CHROME_ZIP_URL to $dest_dir"
  fi
  chown -R root:root "$CHROME_ROOT"
  chmod -R u+rwX,go+rX,go-w,ug-s "$CHROME_ROOT"
  check_protected "$dest_bin"
  # Root never executes the downloaded binary. The version check runs as the service user,
  # which also proves that the service user can execute this copy.
  as_app "'$dest_bin' --version"

  echo "== AppArmor profile $PROFILE_NAME"
  local tmp_profile
  tmp_profile=$(mktemp)
  profile_text > "$tmp_profile"
  if ! cmp -s "$tmp_profile" "$PROFILE_DEST"; then
    install -o root -g root -m 644 "$tmp_profile" "$PROFILE_DEST"
    echo "installed $PROFILE_DEST"
  fi
  rm -f "$tmp_profile"
  sha256sum "$PROFILE_DEST"
  apparmor_parser -r "$PROFILE_DEST"
  # Read the whole output first: with pipefail, a grep that exits early can fail the pipe.
  local loaded
  loaded=$(aa-status)
  grep -q "^ *$PROFILE_NAME$" <<<"$loaded" || { echo "profile $PROFILE_NAME is not loaded" >&2; exit 1; }
  sysctl kernel.apparmor_restrict_unprivileged_userns

  echo "== cache directory and environment of $APP_USER"
  as_app 'mkdir -p "$HOME/.cache" && chmod 700 "$HOME/.cache" && stat -c "%A %U %n" "$HOME/.cache"'
  as_app "rm -rf \$HOME/.cache/puppeteer && test ! -e \$HOME/.cache/puppeteer && echo 'no puppeteer cache in the home of $APP_USER'"
  as_app "printf 'RS_CHROME_PATH=%s\n' '$dest_bin' > $SERVER_ENV && chmod 640 $SERVER_ENV && cat $SERVER_ENV"
  local line="[ -f $SERVER_ENV ] && set -a && . $SERVER_ENV && set +a"
  if ! as_app "grep -qxF '$line' \$HOME/.profile"; then
    as_app "printf '%s\n' '$line' >> \$HOME/.profile"
  fi
  as_app "echo RS_CHROME_PATH in a login shell: \$RS_CHROME_PATH"
  echo "chrome done"
}

# Write the account file: RS_ACCOUNT=<name> and RS_PASSWORD=<20 characters A-Za-z0-9 from
# /dev/urandom>. The rs-sdk client and engine refuse a password longer than 20 characters.
# The password goes only through pipes, a shell variable and the printf builtin into the file:
# never on a command line, never on the screen. umask 077 gives mode 600. noclobber makes
# the write fail if the file exists, so an existing account (and its password) is never replaced.
# Run as rsbot:
#   ssh <user>@<server> 'sudo -u rsbot bash -c "$(cat)" bootstrap create-account-env <name>' < scripts/server-bootstrap.sh
create_account_env() {
  local name=${1:?usage: create-account-env <name> [file]}
  local file=${2:-$APP_DIR/secrets/account.env}
  if ! [[ $name =~ ^[a-z0-9]{1,12}$ ]]; then
    echo "the account name must match ^[a-z0-9]{1,12}\$" >&2
    exit 1
  fi
  if [ -e "$file" ]; then
    echo "refusing to overwrite $file: the account exists already" >&2
    exit 1
  fi
  umask 077
  local pw
  pw=$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20 || true)
  if [ "${#pw}" -ne 20 ]; then
    echo "password generation failed" >&2
    exit 1
  fi
  ( set -o noclobber; printf 'RS_ACCOUNT=%s\nRS_PASSWORD=%s\n' "$name" "$pw" > "$file" ) || {
    echo "refusing to overwrite $file" >&2
    exit 1
  }
  pw=
  chmod 600 "$file"
  awk -F= '/^RS_ACCOUNT=/{print "RS_ACCOUNT=" $2} /^RS_PASSWORD=/{print "RS_PASSWORD length " length($2)}' "$file"
}

case "$phase" in
  create-account-env) create_account_env "${2:-}" "${3:-}" ;;
  facts) facts ;;
  prepare) prepare ;;
  install) install_app "${2:-}" ;;
  chrome) install_chrome ;;
  *) echo "usage: server-bootstrap.sh facts|prepare|install <branch>|chrome|create-account-env <name> [file]" >&2; exit 2 ;;
esac

#!/usr/bin/env bash
# Firewall of the bot server. Run as root.
#
#   server-firewall.sh apply [PORTS]   ufw: deny incoming, allow OpenSSH, enable.
#                                      Then the egress rules of the box users (see below).
#   server-firewall.sh egress [PORTS]  Only the egress rules. deploy/systemd/rsbox-egress.service
#                                     runs this at boot, because iptables rules do not persist.
#   server-firewall.sh game-egress    Egress rules of the game user (see "Game egress" below).
#   server-firewall.sh game-egress-refresh
#                                     The same, but if the game host does not resolve, keep the
#                                     rules that are there and exit 0. rsgame-egress.timer runs it.
#   server-firewall.sh status         Show ufw, all egress rules and the failed SSH logins of 24 h.
#   server-firewall.sh undo [box|game] [--ufw]
#                                     Remove the egress rules: of the box users, of the game user,
#                                     or (no word) both. With --ufw, also disable ufw.
#
# PORTS: one port, a range or a list, such as 7790, 7790-7795 or 7790,7792. Default 7790.
# A bot with GUILDS_FILE uses PROXY_PORT + 0, 1, 2 and so on: give the whole range.
# Egress rules: each box user (BOX_USERS, a list split by spaces or commas; default BOX_USER
# or rsbox) can open a connection only to 127.0.0.1 on PORTS (the proxies), over TCP. The
# kernel rejects every other packet that a process of a box user sends: other addresses, other loopback ports, UDP (also DNS),
# ICMP and all IPv6. Unix sockets are not IP traffic, so these rules do not apply to them.
#
# The rules are in their own chains (RSBOX-EGRESS and RSBOX-EGRESS6), with one jump from
# OUTPUT. ufw does not flush these chains. Each run rebuilds the chains, so a second run makes
# no other change.
#
# Game egress: the game user (GAME_USER, default rsgame) can send only:
#   - to loopback (the proxy, the CDP pipe of Chromium, systemd-resolved on 127.0.0.53);
#   - DNS (UDP and TCP 53) to the nameservers of /etc/resolv.conf;
#   - TCP to ports 443 and 7443 (GAME_PORTS) of the addresses of the game host;
#   - packets of connections that are already open (so a refresh does not cut the game).
# The game host is RS_SERVER_HOST (environment, else /etc/rs-gamelink/gamelink.env, else the
# default of src/shared/config.ts). "getent ahosts" gives its IPv4 and IPv6 addresses. The
# kernel rejects all other packets of the game user. The chains are RSGAME-EGRESS and
# RSGAME-EGRESS6; iptables-restore --noflush replaces each chain in one step.
# If the game host does not resolve and no game chain is there, the rules allow loopback and
# DNS only (fail closed), and the script exits 1.
set -euo pipefail

BOX_USERS="$(echo "${BOX_USERS:-${BOX_USER:-rsbox}}" | tr "," " ")"
CHAIN4=RSBOX-EGRESS
CHAIN6=RSBOX-EGRESS6
DEFAULT_PORT=7790
GAME_USER="${GAME_USER:-rsgame}"
GCHAIN4=RSGAME-EGRESS
GCHAIN6=RSGAME-EGRESS6
GAME_PORTS="${GAME_PORTS:-443,7443}"
GAMELINK_ENV="${GAMELINK_ENV:-/etc/rs-gamelink/gamelink.env}"
RESOLV_CONF="${RESOLV_CONF:-/etc/resolv.conf}"
DEFAULT_GAME_HOST=rs-sdk.maxbittker.com

die() { echo "server-firewall: $*" >&2; exit 1; }
say() { echo "server-firewall: $*"; }

need_root() { [ "$(id -u)" -eq 0 ] || die "run this script as root"; }

check_ports() {
  local spec="$1" part p
  [[ "$spec" =~ ^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$ ]] || die "ports must be like 7790, 7790-7795 or 7790,7792, not '$spec'"
  for part in ${spec//,/ }; do
    for p in ${part/-/ }; do
      [ "$p" -ge 1 ] && [ "$p" -le 65535 ] || die "port must be from 1 to 65535, not '$p'"
    done
  done
}

# iptables multiport form: 7790-7795 becomes 7790:7795.
multiport() { echo "${1//-/:}"; }

check_users() {
  local u
  [ -n "$BOX_USERS" ] || die "BOX_USERS is empty"
  for u in $BOX_USERS; do
    [[ "$u" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "not a user name: '$u'"
    id -u "$u" >/dev/null 2>&1 || die "user '$u' does not exist"
  done
}

apply_ufw() {
  command -v ufw >/dev/null || die "ufw is not installed (apt-get install ufw)"
  say "ufw: default deny incoming"
  ufw default deny incoming >/dev/null
  say "ufw: default allow outgoing"
  ufw default allow outgoing >/dev/null
  say "ufw: allow OpenSSH"
  ufw allow OpenSSH >/dev/null
  say "ufw: enable"
  ufw --force enable >/dev/null
}

# $1 = iptables or ip6tables, $2 = chain name
reset_chain() {
  local ipt="$1" chain="$2"
  if "$ipt" -w -n -L "$chain" >/dev/null 2>&1; then
    "$ipt" -w -F "$chain"
  else
    "$ipt" -w -N "$chain"
    say "$ipt: create chain $chain"
  fi
  local u
  for u in $BOX_USERS; do
    if ! "$ipt" -w -C OUTPUT -m owner --uid-owner "$u" -j "$chain" 2>/dev/null; then
      "$ipt" -w -I OUTPUT 1 -m owner --uid-owner "$u" -j "$chain"
      say "$ipt: add jump OUTPUT -> $chain for user $u"
    fi
  done
}

apply_egress() {
  local ports="$1"
  command -v iptables >/dev/null || die "iptables is not installed"
  command -v ip6tables >/dev/null || die "ip6tables is not installed"
  check_users

  reset_chain iptables "$CHAIN4"
  iptables -w -A "$CHAIN4" -o lo -d 127.0.0.1/32 -p tcp -m multiport --dports "$(multiport "$ports")" -j ACCEPT
  iptables -w -A "$CHAIN4" -p tcp -j REJECT --reject-with tcp-reset
  iptables -w -A "$CHAIN4" -j REJECT --reject-with icmp-port-unreachable
  say "iptables: $BOX_USERS may reach only 127.0.0.1 ports $ports/tcp; all else is rejected"

  reset_chain ip6tables "$CHAIN6"
  ip6tables -w -A "$CHAIN6" -p tcp -j REJECT --reject-with tcp-reset
  ip6tables -w -A "$CHAIN6" -j REJECT --reject-with icmp6-port-unreachable
  say "ip6tables: all IPv6 traffic of $BOX_USERS is rejected"
}

# $1 = iptables or ip6tables, $2 = chain, $3 = the users (default BOX_USERS)
remove_chain() {
  local ipt="$1" chain="$2" users="${3:-$BOX_USERS}"
  command -v "$ipt" >/dev/null || return 0
  local u
  for u in $users; do
    while "$ipt" -w -C OUTPUT -m owner --uid-owner "$u" -j "$chain" 2>/dev/null; do
      "$ipt" -w -D OUTPUT -m owner --uid-owner "$u" -j "$chain"
      say "$ipt: remove jump OUTPUT -> $chain for user $u"
    done
  done
  if "$ipt" -w -n -L "$chain" >/dev/null 2>&1; then
    "$ipt" -w -F "$chain"
    "$ipt" -w -X "$chain"
    say "$ipt: delete chain $chain"
  fi
}

# Read one NAME=value line from a file without running the file.
read_env_file() {
  local file="$1" name="$2" line value
  [ -r "$file" ] || return 0
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$name=" "$file" | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#\"}"; value="${value%\"}"
  value="${value#\'}"; value="${value%\'}"
  printf '%s' "$value"
}

game_host() {
  local host="${RS_SERVER_HOST:-$(read_env_file "$GAMELINK_ENV" RS_SERVER_HOST)}"
  host="${host:-$DEFAULT_GAME_HOST}"
  [[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] || die "not a host name: '$host'"
  printf '%s' "$host"
}

# GAME_PORTS plus any explicit port of RS_GATEWAY_URL and RS_BOT_PAGE_URL, so that a valid
# setting is never cut off by these rules.
game_ports() {
  local ports="$GAME_PORTS" name url hostport port
  for name in RS_GATEWAY_URL RS_BOT_PAGE_URL; do
    url="${!name:-$(read_env_file "$GAMELINK_ENV" "$name")}"
    [ -n "$url" ] || continue
    hostport="${url#*://}"; hostport="${hostport%%/*}"; hostport="${hostport%%\?*}"
    case "$hostport" in
      *:*) port="${hostport##*:}" ;;
      *) continue ;;
    esac
    [[ "$port" =~ ^[0-9]{1,5}$ ]] || continue
    case ",$ports," in *",$port,"*) ;; *) ports="$ports,$port" ;; esac
  done
  printf '%s' "$ports"
}

is_ipv4() { [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; }
is_ipv6() { [[ "$1" =~ ^[0-9A-Fa-f:]+$ ]] && [[ "$1" == *:* ]]; }

# $1 = 4 or 6. The nameservers of RESOLV_CONF of that family, one per line. Loopback
# nameservers are left out: the loopback rule covers them.
resolvers() {
  local fam="$1" ip
  [ -r "$RESOLV_CONF" ] || return 0
  while read -r ip; do
    ip="${ip%%%*}"
    if [ "$fam" = 4 ] && is_ipv4 "$ip" && [[ "$ip" != 127.* ]]; then echo "$ip"; fi
    if [ "$fam" = 6 ] && is_ipv6 "$ip" && [ "$ip" != ::1 ]; then echo "$ip"; fi
  done < <(awk '$1 == "nameserver" { print $2 }' "$RESOLV_CONF")
}

# $1 = host, $2 = 4 or 6. The addresses of the host of that family, sorted, one per line.
host_ips() {
  local host="$1" fam="$2" ip
  while read -r ip; do
    if [ "$fam" = 4 ] && is_ipv4 "$ip"; then echo "$ip"; fi
    if [ "$fam" = 6 ] && is_ipv6 "$ip"; then echo "$ip"; fi
  done < <(getent ahosts "$host" 2>/dev/null | awk '{ print $1 }' | sort -u)
}

# $1 = 4 or 6, $2 = chain, $3 = the game addresses (split by spaces), $4 = the resolvers.
# Prints the input for iptables-restore --noflush. The chain line empties the chain.
game_rules() {
  local fam="$1" chain="$2" ips="$3" dns="$4" mask=32 reject=icmp-port-unreachable ip
  [ "$fam" = 6 ] && { mask=128; reject=icmp6-port-unreachable; }
  echo "*filter"
  echo ":$chain - [0:0]"
  echo "-A $chain -o lo -j ACCEPT"
  echo "-A $chain -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"
  for ip in $dns; do
    echo "-A $chain -d $ip/$mask -p udp --dport 53 -j ACCEPT"
    echo "-A $chain -d $ip/$mask -p tcp --dport 53 -j ACCEPT"
  done
  for ip in $ips; do
    echo "-A $chain -d $ip/$mask -p tcp -m multiport --dports $(multiport "$GAME_PORTS") -j ACCEPT"
  done
  echo "-A $chain -p tcp -j REJECT --reject-with tcp-reset"
  echo "-A $chain -j REJECT --reject-with $reject"
  echo "COMMIT"
}

# $1 = iptables or ip6tables, $2 = chain
add_game_jump() {
  local ipt="$1" chain="$2"
  if ! "$ipt" -w -C OUTPUT -m owner --uid-owner "$GAME_USER" -j "$chain" 2>/dev/null; then
    "$ipt" -w -I OUTPUT 1 -m owner --uid-owner "$GAME_USER" -j "$chain"
    say "$ipt: add jump OUTPUT -> $chain for user $GAME_USER"
  fi
}

# $1 = egress or refresh
apply_game_egress() {
  local how="$1" host ips4 ips6 dns4 dns6
  local ipt
  for ipt in iptables ip6tables iptables-restore ip6tables-restore getent; do
    command -v "$ipt" >/dev/null || die "$ipt is not installed"
  done
  [[ "$GAME_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "not a user name: '$GAME_USER'"
  id -u "$GAME_USER" >/dev/null 2>&1 || die "user '$GAME_USER' does not exist"
  GAME_PORTS="$(game_ports)"
  check_ports "$GAME_PORTS"
  host="$(game_host)"
  ips4="$(host_ips "$host" 4 | tr '\n' ' ')"
  ips6="$(host_ips "$host" 6 | tr '\n' ' ')"
  dns4="$(resolvers 4 | tr '\n' ' ')"
  dns6="$(resolvers 6 | tr '\n' ' ')"
  if [ -z "${ips4// /}${ips6// /}" ]; then
    if iptables -w -n -L "$GCHAIN4" >/dev/null 2>&1; then
      say "warning: $host does not resolve; the game egress rules stay as they are"
      [ "$how" = refresh ] && return 0
      return 1
    fi
    say "warning: $host does not resolve; $GAME_USER gets loopback and DNS only"
  fi
  game_rules 4 "$GCHAIN4" "$ips4" "$dns4" | iptables-restore -w --noflush
  game_rules 6 "$GCHAIN6" "$ips6" "$dns6" | ip6tables-restore -w --noflush
  add_game_jump iptables "$GCHAIN4"
  add_game_jump ip6tables "$GCHAIN6"
  say "iptables: $GAME_USER may reach loopback, DNS (${dns4:-none} ) and $host [${ips4:-none} ] ports $GAME_PORTS/tcp"
  say "ip6tables: $GAME_USER may reach loopback, DNS (${dns6:-none} ) and $host [${ips6:-none} ] ports $GAME_PORTS/tcp"
  [ -n "${ips4// /}${ips6// /}" ]
}

show_status() {
  if command -v ufw >/dev/null; then ufw status verbose; else echo "ufw: not installed"; fi
  local ipt chain
  for chain in "$CHAIN4" "$CHAIN6" "$GCHAIN4" "$GCHAIN6"; do
    ipt=iptables; [[ "$chain" == *6 ]] && ipt=ip6tables
    echo "--- $ipt $chain"
    if "$ipt" -w -n -L "$chain" >/dev/null 2>&1; then
      "$ipt" -w -S OUTPUT | grep -- "-j $chain\$" || echo "no jump from OUTPUT to $chain"
      "$ipt" -w -n -v -L "$chain"
    else
      echo "chain $chain: not present"
    fi
  done
  show_ssh_failures
}

# Optional: the count of failed SSH logins in the last 24 hours. Password login is off, so
# fail2ban adds little; this count only shows how much the port is tried.
show_ssh_failures() {
  command -v journalctl >/dev/null || { echo "--- ssh: journalctl not found"; return 0; }
  local n
  n="$(journalctl -q -u ssh -u sshd --since '24 hours ago' -o cat 2>/dev/null     | grep -cE 'Failed (password|publickey)|Invalid user|Connection closed by authenticating user|maximum authentication attempts' || true)"
  echo "--- ssh: ${n:-0} failed logins in the last 24 hours"
}

mode="${1:-}"
case "$mode" in
  apply)
    need_root
    port="${2:-$DEFAULT_PORT}"; check_ports "$port"
    apply_ufw
    apply_egress "$port"
    if [ ! -e /etc/systemd/system/rsbox-egress.service ]; then
      say "to keep the egress rules after a reboot, install deploy/systemd/rsbox-egress.service"
    fi
    ;;
  egress)
    need_root
    port="${2:-$DEFAULT_PORT}"; check_ports "$port"
    apply_egress "$port"
    ;;
  game-egress)
    need_root
    apply_game_egress egress
    ;;
  game-egress-refresh)
    need_root
    apply_game_egress refresh
    ;;
  status)
    need_root
    show_status
    ;;
  undo)
    need_root
    shift
    scope=all ufw_off=no
    for arg in "$@"; do
      case "$arg" in
        box|game) scope="$arg" ;;
        --ufw) ufw_off=yes ;;
        *) die "undo takes box, game and --ufw, not '$arg'" ;;
      esac
    done
    if [ "$scope" != game ]; then
      remove_chain iptables "$CHAIN4"
      remove_chain ip6tables "$CHAIN6"
    fi
    if [ "$scope" != box ]; then
      remove_chain iptables "$GCHAIN4" "$GAME_USER"
      remove_chain ip6tables "$GCHAIN6" "$GAME_USER"
    fi
    if [ "$ufw_off" = yes ]; then
      say "ufw: disable"
      ufw --force disable >/dev/null
    else
      say "ufw is not changed (use 'undo --ufw' to disable it)"
    fi
    ;;
  *)
    echo "usage: $0 apply [PORTS] | egress [PORTS] | game-egress | game-egress-refresh | status | undo [box|game] [--ufw]" >&2
    exit 2
    ;;
esac

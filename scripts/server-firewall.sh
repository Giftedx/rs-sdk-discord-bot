#!/usr/bin/env bash
# Firewall of the bot server. Run as root.
#
#   server-firewall.sh apply [PORTS]   ufw: deny incoming, allow OpenSSH, enable.
#                                      Then the egress rules of the box users (see below).
#   server-firewall.sh egress [PORTS]  Only the egress rules. deploy/systemd/rsbox-egress.service
#                                     runs this at boot, because iptables rules do not persist.
#   server-firewall.sh status         Show ufw, the egress rules and the failed SSH logins of 24 h.
#   server-firewall.sh undo [--ufw]   Remove the egress rules. With --ufw, also disable ufw.
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
set -euo pipefail

BOX_USERS="$(echo "${BOX_USERS:-${BOX_USER:-rsbox}}" | tr "," " ")"
CHAIN4=RSBOX-EGRESS
CHAIN6=RSBOX-EGRESS6
DEFAULT_PORT=7790

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

remove_chain() {
  local ipt="$1" chain="$2"
  command -v "$ipt" >/dev/null || return 0
  local u
  for u in $BOX_USERS; do
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

show_status() {
  if command -v ufw >/dev/null; then ufw status verbose; else echo "ufw: not installed"; fi
  local ipt chain
  for ipt in iptables ip6tables; do
    chain="$CHAIN4"; [ "$ipt" = ip6tables ] && chain="$CHAIN6"
    echo "--- $ipt"
    if "$ipt" -w -n -L "$chain" >/dev/null 2>&1; then
      "$ipt" -w -S OUTPUT | grep -- "-j $chain" || echo "no jump from OUTPUT to $chain"
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
  status)
    need_root
    show_status
    ;;
  undo)
    need_root
    remove_chain iptables "$CHAIN4"
    remove_chain ip6tables "$CHAIN6"
    if [ "${2:-}" = "--ufw" ]; then
      say "ufw: disable"
      ufw --force disable >/dev/null
    else
      say "ufw is not changed (use 'undo --ufw' to disable it)"
    fi
    ;;
  *)
    echo "usage: $0 apply [PORTS] | egress [PORTS] | status | undo [--ufw]" >&2
    exit 2
    ;;
esac

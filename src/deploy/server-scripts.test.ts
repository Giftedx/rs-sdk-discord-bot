// Tests of scripts/server-firewall.sh (game egress), server-chrome-prune.sh and
// server-restore-test.sh. They run bash with stand-ins for id, iptables and getent, on temporary
// directories. They are skipped when bash is not found.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = (name: string) => fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url));
// Not the bash.exe of System32: that one starts WSL.
const found = Bun.which('bash');
const bash = found && !/[\\/]system32[\\/]/i.test(found) ? found : null;
const fwd = (p: string) => p.replace(/\\/g, '/');

function withDir(fn: (p: (n: string) => string, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'rs-srv-'));
  try { fn(n => fwd(join(dir, n)), dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function stub(p: (n: string) => string, name: string, body: string) {
  writeFileSync(p(`bin/${name}`), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p(`bin/${name}`), 0o755);
}

function run(args: string[], env: Record<string, string>, cwd?: string) {
  const r = Bun.spawnSync([bash!, ...args], { cwd, env: { ...process.env, ...env } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

function firewallStubs(p: (n: string) => string) {
  mkdirSync(p('bin'));
  stub(p, 'id', '[ "$1" = -u ] && echo 0; exit 0');
  stub(p, 'getent', 'printf "%s" "$GETENT_OUT"');
  const ipt = 'echo "$(basename "$0") $*" >>"$LOG"\ncase " $* " in *" -L "*) [ -n "$CHAIN_EXISTS" ]; exit;; *" -C "*) exit 1;; esac\nexit 0';
  stub(p, 'iptables', ipt);
  stub(p, 'ip6tables', ipt);
  const restore = '{ echo "== $(basename "$0") $*"; cat; } >>"$LOG"';
  stub(p, 'iptables-restore', restore);
  stub(p, 'ip6tables-restore', restore);
  writeFileSync(p('resolv.conf'), 'nameserver 127.0.0.53\nnameserver 10.0.0.2\nnameserver 2001:db8::53\noptions edns0\n');
  writeFileSync(p('gamelink.env'), 'RS_SERVER_HOST=game.example.org\n');
}

const GETENT = '203.0.113.5     STREAM game.example.org\n203.0.113.5     DGRAM\n2001:db8::5     STREAM\n';

function fwEnv(p: (n: string) => string, extra: Record<string, string> = {}) {
  return {
    PATH: `${join(p('bin'))}${delimiter}${process.env.PATH ?? ''}`,
    LOG: p('log'), RESOLV_CONF: p('resolv.conf'), GAMELINK_ENV: p('gamelink.env'), GETENT_OUT: GETENT,
    CHAIN_EXISTS: '', RS_SERVER_HOST: '', ...extra,
  };
}

test.skipIf(!bash)('game-egress allows loopback, the resolvers and the game host on 443 and 7443 only', () => {
  withDir(p => {
    firewallStubs(p);
    const r = run([script('server-firewall.sh'), 'game-egress'], fwEnv(p));
    expect(r.out).toContain('rsgame may reach');
    expect(r.code).toBe(0);
    const log = readFileSync(p('log'), 'utf8');
    for (const want of [
      '== iptables-restore -w --noflush\n*filter\n:RSGAME-EGRESS - [0:0]\n-A RSGAME-EGRESS -o lo -j ACCEPT\n',
      '-A RSGAME-EGRESS -d 10.0.0.2/32 -p udp --dport 53 -j ACCEPT',
      '-A RSGAME-EGRESS -d 203.0.113.5/32 -p tcp -m multiport --dports 443,7443 -j ACCEPT',
      '-A RSGAME-EGRESS6 -d 2001:db8::53/128 -p tcp --dport 53 -j ACCEPT',
      '-A RSGAME-EGRESS6 -d 2001:db8::5/128 -p tcp -m multiport --dports 443,7443 -j ACCEPT',
      '-A RSGAME-EGRESS6 -j REJECT --reject-with icmp6-port-unreachable',
      'iptables -w -I OUTPUT 1 -m owner --uid-owner rsgame -j RSGAME-EGRESS\n',
      'ip6tables -w -I OUTPUT 1 -m owner --uid-owner rsgame -j RSGAME-EGRESS6\n',
    ]) expect(log).toContain(want);
    expect(log).not.toContain('127.0.0.53');
    expect(log).not.toContain('RSBOX');
  });
});

test.skipIf(!bash)('a refresh with no answer from DNS keeps the rules; a first run fails closed', () => {
  withDir(p => {
    firewallStubs(p);
    const kept = run([script('server-firewall.sh'), 'game-egress-refresh'], fwEnv(p, { GETENT_OUT: '', CHAIN_EXISTS: '1' }));
    expect(kept.code).toBe(0);
    expect(kept.out).toContain('stay as they are');
    expect(readFileSync(p('log'), 'utf8')).not.toContain('restore');
    const closed = run([script('server-firewall.sh'), 'game-egress'], fwEnv(p, { GETENT_OUT: '' }));
    expect(closed.code).toBe(1);
    const log = readFileSync(p('log'), 'utf8');
    expect(log).toContain('-A RSGAME-EGRESS -o lo -j ACCEPT');
    expect(log).not.toContain('--dports 443,7443');
  });
});

test.skipIf(!bash)('undo game removes only the game chains, and a bad host name is refused', () => {
  withDir(p => {
    firewallStubs(p);
    const r = run([script('server-firewall.sh'), 'undo', 'game'], fwEnv(p, { CHAIN_EXISTS: '1' }));
    expect(r.code).toBe(0);
    const log = readFileSync(p('log'), 'utf8');
    expect(log).toContain('iptables -w -X RSGAME-EGRESS\n');
    expect(log).toContain('ip6tables -w -X RSGAME-EGRESS6\n');
    expect(log).not.toContain('RSBOX');
    const bad = run([script('server-firewall.sh'), 'game-egress'], fwEnv(p, { RS_SERVER_HOST: 'x;rm -rf' }));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('not a host name');
  });
});

test.skipIf(!bash)('chrome prune keeps the version of RS_CHROME_PATH and deletes the rest only with --apply', () => {
  withDir(p => {
    mkdirSync(p('bin'));
    stub(p, 'id', '[ "$1" = -u ] && echo 0; exit 0');
    for (const v of ['140.0.1', '141.0.2', '142.0.3']) {
      mkdirSync(p(`chrome/${v}/chrome-linux64`), { recursive: true });
      writeFileSync(p(`chrome/${v}/chrome-linux64/chrome`), '#!/bin/sh\n');
      chmodSync(p(`chrome/${v}/chrome-linux64/chrome`), 0o755);
    }
    mkdirSync(p('proc'));
    writeFileSync(p('server.env'), `RS_CHROME_PATH=${p('chrome/141.0.2/chrome-linux64/chrome')}\n`);
    const env = { PATH: `${join(p('bin'))}${delimiter}${process.env.PATH ?? ''}`, CHROME_ROOT: p('chrome'), SERVER_ENV: p('server.env'), PROC_DIR: p('proc'), RS_CHROME_PATH: '', GAMELINK_ENV: p('no-gamelink.env') };
    const dry = run([script('server-chrome-prune.sh')], env);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('keep   141.0.2');
    expect(dry.out).toContain('2 to delete (dry run)');
    expect(existsSync(p('chrome/140.0.1'))).toBe(true);
    const applied = run([script('server-chrome-prune.sh'), '--apply'], env);
    expect(applied.code).toBe(0);
    expect(existsSync(p('chrome/140.0.1'))).toBe(false);
    expect(existsSync(p('chrome/142.0.3'))).toBe(false);
    expect(existsSync(p('chrome/141.0.2/chrome-linux64/chrome'))).toBe(true);
    const outside = run([script('server-chrome-prune.sh'), '--apply'], { ...env, RS_CHROME_PATH: '/usr/bin/chrome' });
    expect(outside.code).toBe(1);
    expect(outside.out).toContain('nothing is deleted');
  });
});

test.skipIf(!bash)('restore test opens the database of the newest backup and leaves no files', () => {
  withDir((p, dir) => {
    mkdirSync(p('bin'));
    stub(p, 'id', '[ "$1" = -u ] && echo 0; exit 0');
    // Without sqlite3 on PATH the script uses bun:sqlite through BUN.
    mkdirSync(p('stage/secrets'), { recursive: true });
    mkdirSync(p('stage/data'));
    writeFileSync(p('stage/secrets/bot.env'), 'X=1\n');
    const db = new Database(join(dir, 'stage', 'data', 'bot.sqlite'));
    db.run('CREATE TABLE t (a INTEGER)');
    db.close();
    mkdirSync(p('bk'));
    mkdirSync(p('t'));
    // Relative paths: the tar of Git Bash reads "C:" as a remote host.
    const tar = (name: string, parts: string) => run(['-c', `tar -czf bk/${name} -C stage ${parts}`], {}, dir);
    expect(tar('rs-discord-bot-20260101T000000Z.tar.gz', 'secrets').code).toBe(0);
    expect(tar('rs-discord-bot-20260102T000000Z.tar.gz', 'secrets data').code).toBe(0);
    const env = { PATH: `${join(p('bin'))}${delimiter}${process.env.PATH ?? ''}`, BACKUP_DIR: 'bk', TMPDIR: 't', BUN: fwd(process.execPath) };
    const r = run([script('server-restore-test.sh')], env, dir);
    expect(r.out).toContain('rs-discord-bot-20260102T000000Z.tar.gz');
    expect(r.out).toContain('integrity_check ok, 1 tables');
    expect(r.out).toContain('restore test passed');
    expect(r.code).toBe(0);
    expect(run(['-c', 'ls -A t'], {}, dir).out.trim()).toBe('');
    const old = run([script('server-restore-test.sh'), 'bk/rs-discord-bot-20260101T000000Z.tar.gz'], env, dir);
    expect(old.code).toBe(1);
    expect(old.out).toContain('FAILED data/bot.sqlite is not in the archive');
  });
});

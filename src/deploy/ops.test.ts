// Checks of the systemd units and of scripts/server-revision-check.sh. The script test runs
// bash with stand-ins for curl and the alert script; it is skipped when bash is not found.
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(path(rel), 'utf8').replace(/\r\n/g, '\n');
const lines = (unit: string) => unit.split('\n').filter((l) => l !== '' && !l.startsWith('#'));

const split = read('../../deploy/systemd/rs-discord-bot.service');
const single = read('../../deploy/systemd/rs-discord-bot-single.service');
const BOX_LIMITS = [
  'ProtectProc=invisible',
  'ProcSubset=pid',
  'InaccessiblePaths=-/opt/rs-chrome -/etc/rs-gamelink/account.env',
  'ProtectSystem=strict',
];
// For a unit with User=, each of these sets NoNewPrivileges=yes (systemd.exec(5)), and then
// sudo cannot start the jobs as the box user.
const NO_NEW_PRIVS = ['RestrictSUIDSGID=', 'NoNewPrivileges=', 'RestrictNamespaces=', 'PrivateDevices=', 'LockPersonality=', 'SystemCallFilter=', 'MemoryDenyWriteExecute='];

test('the split-mode bot unit sets the box limits and keeps the old lines', () => {
  const l = lines(split);
  for (const want of [...BOX_LIMITS, 'Delegate=yes', 'OnFailure=rs-alert@%n.service', 'StartLimitIntervalSec=600', 'StartLimitBurst=3'])
    expect(l).toContain(want);
  expect(l.find((x) => x.startsWith('ReadWritePaths='))).toContain('/opt/rs-discord-bot/data');
  expect(l.filter((x) => NO_NEW_PRIVS.some((k) => x.startsWith(k)))).toEqual([]);
});

test('the one-process unit has none of the limits that break Chromium', () => {
  const l = lines(single);
  for (const key of ['ProtectProc', 'ProcSubset', 'InaccessiblePaths'])
    expect(l.some((x) => x.startsWith(`${key}=`))).toBe(false);
  for (const want of ['Delegate=yes', 'OnFailure=rs-alert@%n.service', 'StartLimitBurst=3', 'Conflicts=rs-discord-bot.service rs-gamelink.service'])
    expect(l).toContain(want);
});

test('the revision unit restarts gamelink only if it runs, with "$" escaped for systemd', () => {
  const unit = read('../../deploy/systemd/rs-revision-check.service');
  const post = lines(unit).find((x) => x.startsWith('ExecStartPost=+'));
  expect(post).toContain('systemctl try-restart rs-gamelink.service');
  expect(post).toContain('data/revision-restart');
  expect(post).not.toMatch(/[^$]\$f/);
});

// Not the bash.exe of System32: that one starts WSL.
const found = Bun.which('bash');
const bash = found && !/[\\/]system32[\\/]/i.test(found) ? found : null;
test.skipIf(!bash)('revision check: a changed hash writes the flag files and calls the alert once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-rev-'));
  const p = (n: string) => join(dir, n).replace(/\\/g, '/');
  try {
    // A curl stand-in that writes $PAGE_TEXT to the --output file.
    writeFileSync(p('curl'), '#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do if [ "$1" = --output ]; then printf "%s" "$PAGE_TEXT" >"$2"; fi; shift; done\ncat >/dev/null\n');
    writeFileSync(p('alert'), '#!/usr/bin/env bash\necho "$@" >>"$ALERT_LOG"\n');
    chmodSync(p('curl'), 0o755);
    chmodSync(p('alert'), 0o755);
    const run = (page: string) => {
      const r = Bun.spawnSync([bash!, path('../../scripts/server-revision-check.sh')], {
        env: {
          ...process.env, CURL: p('curl'), ALERT_SCRIPT: p('alert'), ALERT_LOG: p('alert.log'), PAGE_TEXT: page,
          STATE_FILE: p('revision.txt'), FLAG_FILE: p('revision-changed'), RESTART_FILE: p('revision-restart'),
          ENV_FILE: p('none.env'), RS_BOT_PAGE_URL: 'https://game.example.org/bot',
        },
      });
      expect(r.exitCode).toBe(0);
      return r.stdout.toString();
    };
    expect(run('page one')).toContain('first check');
    expect(existsSync(p('revision-changed'))).toBe(false);
    expect(run('page one')).toContain('no change');
    expect(existsSync(p('revision-restart'))).toBe(false);
    expect(run('page two')).toContain('REVISION CHANGED');
    expect(readFileSync(p('revision-changed'), 'utf8')).toMatch(/^\S+ [0-9a-f]{64} [0-9a-f]{64}\n$/);
    expect(existsSync(p('revision-restart'))).toBe(true);
    expect(readFileSync(p('alert.log'), 'utf8')).toBe('--revision\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

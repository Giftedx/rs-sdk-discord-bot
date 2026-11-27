// Checks of the systemd units, scripts/server-revision-check.sh and scripts/server-alert.sh. The
// script tests run bash with stand-ins for curl and systemctl; they are skipped when bash is not found.
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
test.skipIf(!bash)('revision check: a changed hash writes the flag files and posts no alert', () => {
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
    expect(existsSync(p('alert.log'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the alert unit gives the script time for its wait', () => {
  const alert = lines(read('../../deploy/systemd/rs-alert@.service'));
  expect(alert).toContain('TimeoutStartSec=420');
  expect(read('../../scripts/server-alert.sh')).toContain('ALERT_WAIT_SEC="${ALERT_WAIT_SEC:-300}"');
});

test.skipIf(!bash)('alert: no message when the unit runs again; one message when it stays down', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-alert-'));
  const p = (n: string) => join(dir, n).replace(/\\/g, '/');
  mkdirSync(join(dir, 'data'));
  try {
    writeFileSync(p('bot.env'), 'DISCORD_TOKEN=tok-123\nDISCORD_CHANNEL_ID=11111111111111111\nALERT_CHANNEL_ID=22222222222222222\n');
    // Stand-ins: systemctl prints $UNIT_STATE; curl logs its last argument (the URL) and answers 200.
    writeFileSync(p('systemctl'), '#!/usr/bin/env bash\necho "$UNIT_STATE"\n[ "$UNIT_STATE" = active ]\n');
    writeFileSync(p('curl'), '#!/usr/bin/env bash\nfor a; do last="$a"; done\necho "$last" >>"$CURL_LOG"\nprintf 200\n');
    chmodSync(p('systemctl'), 0o755);
    chmodSync(p('curl'), 0o755);
    const run = (state: string) => Bun.spawnSync([bash!, path('../../scripts/server-alert.sh'), 'rs-gamelink.service'], {
      env: {
        ...process.env, APP_DIR: dir.replace(/\\/g, '/'), ENV_FILE: p('bot.env'), ALERT_WAIT_SEC: '0',
        SYSTEMCTL: p('systemctl'), CURL: p('curl'), CURL_LOG: p('curl.log'), UNIT_STATE: state,
      },
    });

    const healed = run('active');
    expect(healed.exitCode).toBe(0);
    expect(healed.stdout.toString()).toContain('runs again; no Discord message');
    expect(existsSync(p('curl.log'))).toBe(false);

    const down = run('failed');
    expect(down.exitCode).toBe(0);
    expect(down.stdout.toString()).toContain('HTTP status 200');
    expect(readFileSync(p('curl.log'), 'utf8')).toBe('https://discord.com/api/v10/channels/22222222222222222/messages\n');

    const again = run('failed');
    expect(again.stdout.toString()).toContain('less than an hour ago');
    expect(readFileSync(p('curl.log'), 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

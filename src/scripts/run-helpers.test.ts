// Tests of the helpers in scripts/run-helpers.ts. They live here because `bun test` runs src/ only.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '../shared/config';
import {
  DEMO_PASSWORD_MIN,
  DemoModeError,
  LOCAL_EXAMPLE_ACCOUNT,
  boxChildCommand,
  boxChildEnv,
  checkDemoAllowed,
  classifyActionResult,
  loadModeConfig,
  makeRedact,
  newBootToken,
  provenance,
  readGitCommit,
  startCountingRelay,
} from '../../scripts/run-helpers';

const PASSWORD = 'Abcdefgh12345678';
const demoEnv = { RS_ACCOUNT: 'mybot1', RS_PASSWORD: PASSWORD, RS_ALLOW_DEMO: '1' };

test('mode local points at the local stack and needs no opt-in', () => {
  const c = loadModeConfig('local', { RS_ACCOUNT: LOCAL_EXAMPLE_ACCOUNT, RS_PASSWORD: 'x' });
  expect(c.gatewayUrl).toBe('ws://localhost:7780');
  expect(c.botPageUrl).toBe('http://localhost:8888/bot');
});

test('mode demo needs RS_ALLOW_DEMO=1', () => {
  expect(() => loadModeConfig('demo', { ...demoEnv, RS_ALLOW_DEMO: undefined })).toThrow(DemoModeError);
  expect(() => loadModeConfig('demo', { ...demoEnv, RS_ALLOW_DEMO: 'true' })).toThrow(DemoModeError);
  expect(loadModeConfig('demo', demoEnv).account.name).toBe('mybot1');
});

test('mode demo refuses the example account of the local stack', () => {
  expect(() => checkDemoAllowed({ ...demoEnv, RS_ACCOUNT: LOCAL_EXAMPLE_ACCOUNT })).toThrow(DemoModeError);
});

test('mode demo refuses a short password and does not print it', () => {
  const short = 'q'.repeat(DEMO_PASSWORD_MIN - 1);
  let message = '';
  try {
    checkDemoAllowed({ ...demoEnv, RS_PASSWORD: short });
  } catch (error) {
    expect(error).toBeInstanceOf(DemoModeError);
    message = (error as Error).message;
  }
  expect(message).not.toBe('');
  expect(message).not.toContain(short);
  expect(() => checkDemoAllowed({ ...demoEnv, RS_PASSWORD: undefined })).toThrow(DemoModeError);
});

test('an allowed demo configuration still passes the checks of loadConfig', () => {
  expect(() => loadModeConfig('demo', { ...demoEnv, RS_ACCOUNT: 'Not-Valid' })).toThrow(ConfigError);
});

test('the boot token has 32 characters and changes at each call', () => {
  const a = newBootToken();
  expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(newBootToken()).not.toBe(a);
});

test('redact replaces the boot token and a password of 4 or more characters', () => {
  const redact = makeRedact('boot-token-value', PASSWORD);
  expect(redact(`a boot-token-value b ${PASSWORD} c`)).toBe('a <boot token> b <game password> c');
  expect(makeRedact('boot-token-value', 'x')('box x')).toBe('box x');
});

test('the box child environment holds the boot token and never the game password', () => {
  const env = boxChildEnv({ account: 'mybot1', bootToken: 'boot-token-value', proxyPort: 7790, password: PASSWORD });
  expect(env.PASSWORD).toBe('boot-token-value');
  expect(env.GATEWAY_URL).toBe('ws://127.0.0.1:7790');
  expect(Object.keys(env).sort()).toEqual(
    ['AUTO_LAUNCH_BROWSER', 'BOT_USERNAME', 'GATEWAY_URL', 'HOME', 'PASSWORD', 'PATH', 'SHOW_CHAT', 'TELEMETRY'],
  );
  expect(Object.values(env)).not.toContain(PASSWORD);
  expect(() => boxChildEnv({ account: 'mybot1', bootToken: PASSWORD, proxyPort: 7790, password: PASSWORD })).toThrow();
});

test('a box child does not load a .env file from its working directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'box-child-env-'));
  try {
    writeFileSync(join(dir, '.env'), 'RS_PASSWORD=from-the-env-file');
    writeFileSync(join(dir, 'probe.ts'), "console.log(process.env.RS_PASSWORD ?? 'absent');");
    const env = boxChildEnv({ account: 'mybot1', bootToken: 'boot-token-value', proxyPort: 7790, password: PASSWORD });
    const child = Bun.spawn(boxChildCommand('probe.ts'), { cwd: dir, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(child.stdout as ReadableStream).text();
    expect(await child.exited).toBe(0);
    expect(out.trim()).toBe('absent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readGitCommit reads a loose ref, a packed ref, a detached HEAD and a worktree', () => {
  const sha = (c: string) => c.repeat(40);
  const files = (m: Record<string, string>) => (p: string) => m[p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')] ?? null;
  const root = '/r';
  expect(readGitCommit(root, {}, files({ '/r/.git/HEAD': 'ref: refs/heads/main\n', '/r/.git/refs/heads/main': `${sha('a')}\n` }))).toBe(sha('a'));
  expect(readGitCommit(root, {}, files({ '/r/.git/HEAD': 'ref: refs/heads/main', '/r/.git/packed-refs': `# pack\n${sha('b')} refs/heads/main\n` }))).toBe(sha('b'));
  expect(readGitCommit(root, {}, files({ '/r/.git/HEAD': sha('c') }))).toBe(sha('c'));
  expect(readGitCommit(root, {}, files({
    '/r/.git': 'gitdir: /m/.git/worktrees/w\n', '/m/.git/worktrees/w/HEAD': 'ref: refs/heads/x', '/m/.git/worktrees/w/commondir': '../..\n',
    '/m/.git/refs/heads/x': sha('d'),
  }))).toBe(sha('d'));
  expect(readGitCommit(root, { RS_GIT_COMMIT: sha('e') }, files({}))).toBe(sha('e'));
  expect(readGitCommit(root, {}, files({ '/r/.git/HEAD': 'ref: refs/../../etc/x' }))).toBeNull();
  expect(readGitCommit(root, {}, files({}))).toBeNull();
});

test('provenance takes the path of the started browser before the configured one', async () => {
  const b = { process: () => ({ spawnfile: '/opt/c/1/chrome' }), version: async () => 'Chrome/1' };
  expect(await provenance(b, '/cfg', 'x')).toEqual({ gitCommit: 'x', chromePath: '/opt/c/1/chrome', chromeVersion: 'Chrome/1' });
  expect(await provenance(null, '/cfg', null)).toEqual({ gitCommit: null, chromePath: '/cfg', chromeVersion: null });
});

test('classifyActionResult tells a gateway result from a refusal of the proxy', () => {
  const r = (result: unknown) => JSON.stringify({ type: 'sdk_action_result', actionId: 1, result });
  expect(classifyActionResult(r({ success: true, message: 'ok' }))).toBe('gateway');
  expect(classifyActionResult(r({ success: false, message: 'no path' }))).toBe('gateway');
  expect(classifyActionResult(r({ success: false, message: 'blocked by policy: logout_component' }))).toBe('proxy');
  expect(classifyActionResult(r({ success: false, message: 'upstream not connected' }))).toBe('proxy');
  expect(classifyActionResult(JSON.stringify({ type: 'sdk_state', state: {} }))).toBeNull();
  expect(classifyActionResult('not json')).toBeNull();
});

test('the counting relay passes messages both ways and counts the action results', async () => {
  const target = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req, srv) { return req.headers.get('origin') !== null ? new Response('no', { status: 403 }) : srv.upgrade(req) ? undefined : new Response('x'); },
    websocket: {
      message(ws, m) {
        ws.send(JSON.stringify({ type: 'sdk_state', state: { echo: String(m) } }));
        ws.send(JSON.stringify({ type: 'sdk_action_result', actionId: 1, result: { success: true } }));
        ws.send(JSON.stringify({ type: 'sdk_action_result', actionId: 2, result: { success: false, message: 'blocked by policy: x' } }));
      },
    },
  });
  const relay = startCountingRelay(target.port as number);
  try {
    const got: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => ws.send('hello'));
      ws.addEventListener('message', ev => { got.push(String(ev.data)); if (got.length === 3) resolve(); });
      ws.addEventListener('error', () => reject(new Error('socket error')));
      setTimeout(() => reject(new Error('timeout')), 5_000);
    });
    ws.close();
    expect(JSON.parse(got[0]!).state.echo).toBe('hello');
    expect(relay.counts()).toEqual({ gateway: 1, proxy: 1 });
  } finally {
    await relay.stop();
    await target.stop(true);
  }
});

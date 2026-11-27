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
  loadModeConfig,
  makeRedact,
  newBootToken,
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

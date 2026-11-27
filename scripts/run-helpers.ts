// Helpers shared by the scripts that run a game tab, the proxy and a box child.
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { loadConfig, type Config } from '../src/shared/config';

export const ROOT = resolve(dirname(import.meta.path), '..');
export const RAW = join(ROOT, 'measurements', 'raw');

export type Mode = 'local' | 'demo';

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function waitUntil(what: string, check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`${what}: not true after ${timeoutMs / 1000} s`);
    await sleep(500);
  }
}

export function parseMode(arg: string | undefined): Mode | null {
  return arg === 'local' || arg === 'demo' ? arg : null;
}

export class DemoModeError extends Error {}

// The account name of the documented local commands. Its password is public, so mode demo refuses it.
export const LOCAL_EXAMPLE_ACCOUNT = 'prooflocal';
export const DEMO_PASSWORD_MIN = 12;

// Mode demo logs in to a game server that someone else runs, and the first login with an
// unknown name creates that account. Refuse it unless the caller opted in, and refuse the
// values of the documented local commands. Messages name variables only, never a secret value.
export function checkDemoAllowed(env: Record<string, string | undefined>): void {
  if (env.RS_ALLOW_DEMO !== '1') {
    throw new DemoModeError('Mode demo connects to a game server that is not yours. Read docs/development.md, then set RS_ALLOW_DEMO=1. For development, use mode local.');
  }
  if (env.RS_ACCOUNT === LOCAL_EXAMPLE_ACCOUNT) {
    throw new DemoModeError(`Mode demo refuses the account name ${LOCAL_EXAMPLE_ACCOUNT}. It is the example name of the local stack.`);
  }
  if ((env.RS_PASSWORD ?? '').length < DEMO_PASSWORD_MIN) {
    throw new DemoModeError(`Mode demo needs an RS_PASSWORD of at least ${DEMO_PASSWORD_MIN} characters.`);
  }
}

// Mode local points the configuration at the local stack. Mode demo uses the configuration
// defaults and needs RS_ALLOW_DEMO=1 (see checkDemoAllowed).
export function loadModeConfig(mode: Mode, env: Record<string, string | undefined> = { ...process.env }): Config {
  if (mode === 'local') {
    return loadConfig({ ...env, RS_GATEWAY_URL: 'ws://localhost:7780', RS_BOT_PAGE_URL: 'http://localhost:8888/bot' });
  }
  checkDemoAllowed(env);
  return loadConfig(env);
}

// 24 random bytes give 32 base64url characters.
export function newBootToken(): string {
  return randomBytes(24).toString('base64url');
}

// A box child holds only the boot token, but remove both secrets in case an SDK version prints one.
// A password shorter than 4 characters (such as the local dummy "x") is not replaced:
// replacing it would change ordinary words in the output and hide the result.
const MIN_REDACTED_PASSWORD_LENGTH = 4;
export function makeRedact(bootToken: string, password: string): (text: string) => string {
  return text => {
    let result = text.split(bootToken).join('<boot token>');
    if (password.length >= MIN_REDACTED_PASSWORD_LENGTH) result = result.split(password).join('<game password>');
    return result;
  };
}

// The command line of a box child. Bun loads a .env file from the working directory into
// every process that it starts, a child with an explicit environment included. --no-env-file
// stops that, so a .env file in the repository root cannot add a variable to the child.
export function boxChildCommand(script: string): string[] {
  return [process.execPath, '--no-env-file', script];
}

// The explicit environment allow list of a box child. It holds the boot token, never the game password.
export function boxChildEnv(opts: { account: string; bootToken: string; proxyPort: number; password: string }): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    BOT_USERNAME: opts.account,
    PASSWORD: opts.bootToken,
    GATEWAY_URL: `ws://127.0.0.1:${opts.proxyPort}`,
    SHOW_CHAT: 'true',
    AUTO_LAUNCH_BROWSER: 'false',
    TELEMETRY: 'false',
  };
  if (Object.values(env).some(v => v === opts.password)) throw new Error('the game password is in the child environment');
  return env;
}

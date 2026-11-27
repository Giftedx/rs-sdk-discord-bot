// Helpers shared by the scripts that run a game tab, the proxy and a box child.

import { readFileSync } from 'node:fs';
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

// The security helpers live in src/ so that src/ code can import them too.
export { boxChildCommand, boxChildEnv, makeRedact, newBootToken } from '../src/shared/script-secrets';

// ---- Provenance of a measurement: the commit of the code and the browser that made it.

type ReadText = (path: string) => string | null;
const readTextOrNull: ReadText = p => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const SHA = /^[0-9a-f]{40}$/;

// The commit of HEAD, read from the files under .git (the server can have no git program).
// RS_GIT_COMMIT wins, for a copy without .git. Null when it is not known.
export function readGitCommit(root: string = ROOT, env: Record<string, string | undefined> = process.env, read: ReadText = readTextOrNull): string | null {
  const fromEnv = env.RS_GIT_COMMIT?.trim();
  if (fromEnv && SHA.test(fromEnv)) return fromEnv;
  let gitDir = join(root, '.git');
  let commonDir = gitDir;
  // A worktree has a .git file with "gitdir: <path>", and that directory has a "commondir" file.
  const dotGit = read(gitDir);
  if (dotGit !== null && dotGit.startsWith('gitdir:')) {
    gitDir = resolve(root, dotGit.slice('gitdir:'.length).trim());
    const common = read(join(gitDir, 'commondir'));
    commonDir = common === null ? gitDir : resolve(gitDir, common.trim());
  }
  const head = read(join(gitDir, 'HEAD'))?.trim();
  if (!head) return null;
  if (SHA.test(head)) return head;
  const m = /^ref: (refs\/[A-Za-z0-9._/-]+)$/.exec(head);
  if (!m || m[1]!.includes('..')) return null;
  const ref = m[1]!;
  for (const dir of [gitDir, commonDir]) {
    const loose = read(join(dir, ref))?.trim();
    if (loose && SHA.test(loose)) return loose;
  }
  const packed = read(join(commonDir, 'packed-refs')) ?? '';
  for (const line of packed.split(/\r?\n/)) {
    const [sha, name] = line.split(' ');
    if (name === ref && sha && SHA.test(sha)) return sha;
  }
  return null;
}

export interface Provenance { gitCommit: string | null; chromePath: string | null; chromeVersion: string | null }

// The browser that runs: the file that puppeteer started, else the configured path.
export async function provenance(
  browser: { process(): { spawnfile?: string } | null; version(): Promise<string> } | null,
  configuredChromePath: string | null,
  gitCommit: string | null = readGitCommit(),
): Promise<Provenance> {
  const spawned = browser?.process()?.spawnfile;
  const chromeVersion = browser ? await browser.version().catch(() => null) : null;
  return { gitCommit, chromePath: spawned || configuredChromePath, chromeVersion };
}

// ---- Counting relay: it sits between a box child and the proxy, and counts the
// sdk_action_result messages that reach the child. The proxy itself answers an action that it
// does not send to the gateway; those answers count as 'proxy'.

const PROXY_REFUSALS = [/^blocked by policy/, /^upstream not connected$/];

export function classifyActionResult(text: string): 'gateway' | 'proxy' | null {
  let msg: unknown;
  try { msg = JSON.parse(text); } catch { return null; }
  if (!msg || typeof msg !== 'object' || (msg as { type?: unknown }).type !== 'sdk_action_result') return null;
  const result = (msg as { result?: { success?: unknown; message?: unknown } }).result;
  const message = typeof result?.message === 'string' ? result.message : '';
  return result?.success === false && PROXY_REFUSALS.some(r => r.test(message)) ? 'proxy' : 'gateway';
}

export interface CountingRelay {
  port: number;
  counts(): { gateway: number; proxy: number };
  stop(): Promise<void>;
}

interface RelayData { upstream: WebSocket | null; queue: string[] }

export function startCountingRelay(targetPort: number): CountingRelay {
  const counts = { gateway: 0, proxy: 0 };
  const server = Bun.serve<RelayData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req, { data: { upstream: null, queue: [] } }) ? undefined : new Response('upgrade only', { status: 426 });
    },
    websocket: {
      open(ws) {
        const up = new WebSocket(`ws://127.0.0.1:${targetPort}`);
        ws.data.upstream = up;
        up.addEventListener('open', () => { for (const m of ws.data.queue.splice(0)) up.send(m); });
        up.addEventListener('message', ev => {
          const text = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString('utf8');
          const kind = classifyActionResult(text);
          if (kind) counts[kind]++;
          ws.send(text);
        });
        up.addEventListener('close', () => ws.close());
        up.addEventListener('error', () => ws.close());
      },
      message(ws, raw) {
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        const up = ws.data.upstream;
        if (up && up.readyState === WebSocket.OPEN) up.send(text); else ws.data.queue.push(text);
      },
      close(ws) { ws.data.upstream?.close(); },
    },
  });
  return {
    port: server.port as number,
    counts: () => ({ ...counts }),
    stop: async () => { await server.stop(true); },
  };
}

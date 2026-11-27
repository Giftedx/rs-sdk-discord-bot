// Live check of the served game client and of the gateway. Later work relies on the readings.
// Usage (local stack): RS_ACCOUNT=prooflocal RS_PASSWORD=x bun scripts/live-check.ts local
// (x is a dummy password for the local stack only. Never type a real password on the command line.)
// Usage (mode demo, a remote game server; read the rules in docs/development.md first):
//   ( set -a; . secrets/account.env; set +a; RS_ALLOW_DEMO=1 bun scripts/live-check.ts demo )
// The script holds one session of less than 3 minutes. It reads fields of the client and sends
// no game action. Its last action ends the session through the logout button of the client.
// Steps:
//   1. Mode demo only: GET https://<host>:7443/ with a deadline of 3 s.
//   2. Open a WebSocket to the relay URL (and, in mode demo, to wss://<host>:7443), record the
//      negotiated extensions and the time from a ping to its pong. Send no message.
//   3. Open the game tab. Read the page each 250 ms for at most 120 s.
//   4. Read the type of each client field that later work uses. Never read the credentials.
//   5. Hold the session for 30 s.
//   6. Log out through the page, then watch for 30 s that the page stays logged out.
//   7. Read the `status` field of GET /status/<account> of the gateway (gateway.ts): in mode
//      demo on https://<host>:7443, in mode local on the origin of RS_GATEWAY_URL.
// Linux only. Writes measurements/raw/live-check-<mode>-<ISO date>.json, also after a failed step.
// The file holds no account name. Every log line and the file pass through the redaction.
// The file also holds the git commit and the path and version of the Chrome that ran.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'puppeteer';
import { launchBrowser, openGameTab, type GameTab } from '../src/gamelink/game-tab';
import { RAW, loadModeConfig, makeRedact, parseMode, provenance, readGitCommit, sleep, type Provenance } from './run-helpers';

if (process.platform !== 'linux') {
  console.error(`live-check.ts runs on Linux only (this is ${process.platform})`);
  process.exit(2);
}
const args = process.argv.slice(2);
const mode = parseMode(args[0]);
if (!mode || args.length !== 1) {
  console.error('usage: bun scripts/live-check.ts local|demo   (mode demo needs RS_ALLOW_DEMO=1; see the header of this file)');
  process.exit(2);
}

const DIRECT_PORT = 7443;
const PROBE_DEADLINE_MS = 3_000;
const SOCKET_OPEN_DEADLINE_MS = 10_000;
const PONG_DEADLINE_MS = 5_000;
const LOGIN_POLL_MS = 250;
const LOGIN_DEADLINE_MS = 120_000;
const HOLD_MS = 30_000;
const LOGOUT_DEADLINE_MS = 15_000;
const STAY_OUT_MS = 30_000;
const STATUS_DEADLINE_MS = 5_000;

const config = loadModeConfig(mode);
const account = config.account.name;
const password = config.account.password;
// No boot token in this script; redact the password and the account name.
const redactPassword = makeRedact('\u0000no-boot-token\u0000', password);
const redact = (text: string) => redactPassword(text).split(account).join('<account>');
const log = (line: string) => console.error(redact(`[live-check ${new Date().toISOString()}] ${line}`));
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface LiveCheck {
  mode: 'local' | 'demo'; commit: string | null; startedAt: string;
  browser: Provenance | null;
  directProbe: { ok: boolean; status: number | null } | null;
  sockets: Array<{ route: 'relay' | 'direct'; opened: boolean; extensions: string; pongWithinMs: number | null }>;
  client: {
    typeofIngame: string; typeofSceneState: string; typeofLogoutTimer: string; typeofClickComponent: string;
    typeofIdleTimer: string; typeofLoginMes1: string; typeofLoginMes2: string;
    inGameAfterMs: number | null; sceneState2AfterMs: number | null; sceneStatesSeen: number[];
  };
  logout: { inGameFalseAfterMs: number | null; inGameAgainWithinMs: number | null };
  gatewayStatusAfterLogout: string | null;
  // The steps that failed, with a redacted message. Not part of a gate.
  errors: string[];
}

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
mkdirSync(RAW, { recursive: true });
const outPath = join(RAW, `live-check-${mode}-${stamp}.json`);

const result: LiveCheck = {
  mode,
  commit: readGitCommit(),
  startedAt: startedAt.toISOString(),
  browser: null,
  directProbe: null,
  sockets: [],
  client: {
    typeofIngame: 'not read', typeofSceneState: 'not read', typeofLogoutTimer: 'not read', typeofClickComponent: 'not read',
    typeofIdleTimer: 'not read', typeofLoginMes1: 'not read', typeofLoginMes2: 'not read',
    inGameAfterMs: null, sceneState2AfterMs: null, sceneStatesSeen: [],
  },
  logout: { inGameFalseAfterMs: null, inGameAgainWithinMs: null },
  gatewayStatusAfterLogout: null,
  errors: [],
};

function fail(step: string, err: unknown) {
  const line = `${step}: ${errText(err)}`;
  result.errors.push(redact(line));
  log(`FAILED ${line}`);
}

async function probeDirect(url: string): Promise<{ ok: boolean; status: number | null }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_DEADLINE_MS) });
    await res.body?.cancel().catch(() => {});
    return { ok: res.ok, status: res.status };
  } catch (err) {
    log(`direct probe: no answer (${errText(err)})`);
    return { ok: false, status: null };
  }
}

function checkSocket(route: 'relay' | 'direct', url: string): Promise<LiveCheck['sockets'][number]> {
  return new Promise(resolve => {
    const entry = { route, opened: false, extensions: '', pongWithinMs: null as number | null };
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      log(`${route} socket: ${errText(err)}`);
      resolve(entry);
      return;
    }
    let done = false;
    let pingAt = 0;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(openTimer);
      clearTimeout(pongTimer);
      try { ws.close(); } catch { /* already closed */ }
      resolve(entry);
    };
    const openTimer = setTimeout(() => { log(`${route} socket: not open after ${SOCKET_OPEN_DEADLINE_MS} ms`); finish(); }, SOCKET_OPEN_DEADLINE_MS);
    let pongTimer: ReturnType<typeof setTimeout> | undefined;
    ws.addEventListener('open', () => {
      clearTimeout(openTimer);
      entry.opened = true;
      entry.extensions = ws.extensions;
      // The pong event is not in the event map of the WebSocket type; use the untyped overload.
      (ws.addEventListener as (type: string, listener: () => void) => void)('pong', () => {
        entry.pongWithinMs = Math.round(performance.now() - pingAt);
        finish();
      });
      pongTimer = setTimeout(() => { log(`${route} socket: no pong within ${PONG_DEADLINE_MS} ms`); finish(); }, PONG_DEADLINE_MS);
      pingAt = performance.now();
      // Bun's WebSocket has ping(); the DOM type of WebSocket does not declare it.
      (ws as unknown as { ping(): void }).ping();
    });
    ws.addEventListener('error', () => { log(`${route} socket: error event`); finish(); });
    ws.addEventListener('close', ev => { if (!done) log(`${route} socket: closed with code ${ev.code}`); finish(); });
  });
}

const botPath = new URL(config.botPageUrl).pathname;
async function findGamePage(b: Browser): Promise<Page | null> {
  return (await b.pages()).find(p => { try { return new URL(p.url()).pathname === botPath; } catch { return false; } }) ?? null;
}

interface PageReading { ingame: unknown; sceneState: unknown }
type ClientWindow = { gameClient?: Record<string, unknown> };

// Reads only ingame and sceneState. Never the credentials.
function readClient(page: Page): Promise<PageReading | null> {
  return page.evaluate(() => {
    const gc = (window as unknown as ClientWindow).gameClient;
    return gc ? { ingame: gc.ingame, sceneState: gc.sceneState } : null;
  }).catch(() => null);
}

function noteScene(value: unknown) {
  if (typeof value !== 'number') return;
  const seen = result.client.sceneStatesSeen;
  if (seen[seen.length - 1] !== value) seen.push(value);
}

// GameTab.logout() clicks the logout button of the client until ingame is false. Returns the
// time until the page left the game, or null.
async function logoutAndWait(t: GameTab): Promise<number | null> {
  const start = Date.now();
  return (await t.logout(LOGOUT_DEADLINE_MS)) ? Date.now() - start : null;
}

let browser: Browser | null = null;
let tab: GameTab | null = null;
let exitCode = 1;

try {
  const host = config.serverHost;
  if (mode === 'demo') {
    log(`step 1: probe https://${host}:${DIRECT_PORT}/`);
    result.directProbe = await probeDirect(`https://${host}:${DIRECT_PORT}/`);
    log(`direct probe: ${JSON.stringify(result.directProbe)}`);
  }

  log('step 2: WebSocket extensions and ping');
  const routes: Array<['relay' | 'direct', string]> = [['relay', config.gatewayUrl]];
  if (mode === 'demo') routes.push(['direct', `wss://${host}:${DIRECT_PORT}`]);
  for (const [route, url] of routes) {
    try {
      const s = await checkSocket(route, url);
      result.sockets.push(s);
      log(`${route} socket: ${JSON.stringify(s)}`);
    } catch (err) {
      fail(`step 2 ${route}`, err);
    }
  }

  log('step 3: open the game tab');
  let page: Page | null = null;
  try {
    browser = await launchBrowser(config.chromePath ? { executablePath: config.chromePath } : {});
    result.browser = await provenance(browser, config.chromePath);
    tab = await openGameTab({ browser, botPageUrl: config.botPageUrl, account, password, fps: config.fps });
    page = await findGamePage(browser);
    if (!page) throw new Error('the game page is not among the pages of the browser');
    const start = Date.now();
    while (Date.now() - start < LOGIN_DEADLINE_MS) {
      const r = await readClient(page);
      if (r) {
        noteScene(r.sceneState);
        if (result.client.inGameAfterMs === null && r.ingame === true) result.client.inGameAfterMs = Date.now() - start;
        if (result.client.sceneState2AfterMs === null && r.sceneState === 2) result.client.sceneState2AfterMs = Date.now() - start;
      }
      if (result.client.inGameAfterMs !== null && result.client.sceneState2AfterMs !== null) break;
      await sleep(LOGIN_POLL_MS);
    }
    log(`in game after ${result.client.inGameAfterMs} ms, sceneState 2 after ${result.client.sceneState2AfterMs} ms`);
  } catch (err) {
    fail('step 3', err);
  }

  if (page && tab) {
    const t = tab;
    log('step 4: types of the client fields');
    try {
      const types = await page.evaluate(() => {
        const gc = (window as unknown as ClientWindow).gameClient;
        if (!gc) return null;
        return {
          typeofIngame: typeof gc.ingame,
          typeofSceneState: typeof gc.sceneState,
          typeofLogoutTimer: typeof gc.logoutTimer,
          typeofClickComponent: typeof gc.clickComponent,
          typeofIdleTimer: typeof gc.idleTimer,
          typeofLoginMes1: typeof gc.loginMes1,
          typeofLoginMes2: typeof gc.loginMes2,
        };
      });
      if (!types) throw new Error('window.gameClient is absent');
      Object.assign(result.client, types);
      log(`types: ${JSON.stringify(types)}`);
    } catch (err) {
      fail('step 4', err);
    }

    const inGame = (await readClient(page))?.ingame === true;
    if (inGame) {
      log(`step 5: hold the session for ${HOLD_MS / 1000} s`);
      const holdStart = Date.now();
      while (Date.now() - holdStart < HOLD_MS) {
        await sleep(1_000);
        const r = await readClient(page);
        if (r) noteScene(r.sceneState);
      }
      log(`scene states seen: ${JSON.stringify(result.client.sceneStatesSeen)}`);
    } else {
      log('step 5: not run, the page is not in game');
    }

    log('step 6: log out through the page');
    try {
      if (inGame || (await readClient(page))?.ingame === true) {
        result.logout.inGameFalseAfterMs = await logoutAndWait(t);
        log(`ingame false after ${result.logout.inGameFalseAfterMs} ms`);
        if (result.logout.inGameFalseAfterMs !== null) {
          const outStart = Date.now();
          while (Date.now() - outStart < STAY_OUT_MS) {
            await sleep(1_000);
            if ((await readClient(page))?.ingame === true) {
              result.logout.inGameAgainWithinMs = Date.now() - outStart;
              log(`in game again after ${result.logout.inGameAgainWithinMs} ms; log out again`);
              const again = await logoutAndWait(t);
              log(`second logout: ingame false after ${again} ms`);
              break;
            }
          }
          if (result.logout.inGameAgainWithinMs === null) log(`the page stayed logged out for ${STAY_OUT_MS / 1000} s`);
        }
      } else {
        log('step 6: no logout needed, the page is not in game');
      }
    } catch (err) {
      fail('step 6', err);
    }
  }

  log('step 7: status of the account at the gateway');
  try {
    const gatewayOrigin = mode === 'demo'
      ? `https://${config.serverHost}:${DIRECT_PORT}`
      : new URL(config.gatewayUrl.replace(/^ws/, 'http')).origin;
    const statusUrl = `${gatewayOrigin}/status/${encodeURIComponent(account)}`;
    const res = await fetch(statusUrl, { signal: AbortSignal.timeout(STATUS_DEADLINE_MS) });
    const body = (await res.json()) as { status?: unknown };
    result.gatewayStatusAfterLogout = typeof body.status === 'string' ? body.status : null;
    log(`gateway status: ${result.gatewayStatusAfterLogout}`);
  } catch (err) {
    fail('step 7', err);
  }

  const c = result.client;
  exitCode = result.errors.length === 0 && c.inGameAfterMs !== null && result.logout.inGameFalseAfterMs !== null ? 0 : 1;
} catch (err) {
  fail('run', err);
} finally {
  await tab?.close().catch(() => {});
  await browser?.close().catch(() => {});
  writeFileSync(outPath, redact(JSON.stringify(result, null, 2)) + '\n');
  log(`wrote ${outPath}; exit ${exitCode}`);
}
process.exit(exitCode);

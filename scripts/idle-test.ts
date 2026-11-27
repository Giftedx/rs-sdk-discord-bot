// Idle test and re-login test of the game tab.
// Usage (mode demo, a remote game server; read the rules in docs/development.md first).
// The subshell keeps the password out of the rest of the shell session. Add RS_ALLOW_DEMO=1
// before `bun` only after the person who runs the game server agreed:
//   ( set -a; . secrets/account.env; set +a; bun scripts/idle-test.ts demo idle|relogin [--quick] )
// Usage (local stack): RS_ACCOUNT=prooflocal RS_PASSWORD=x bun scripts/idle-test.ts local idle|relogin [--quick]
// (x is a dummy password for the local stack only. Never type a real password on the command line.)
//   idle:    open the game tab and send no action. Read inGame() every 30 s for 25 minutes.
//            Then repeat the 25 minutes and call keepAlive() every 4 minutes.
//   relogin: with the tab in game, leave the bot page (the session ends), wait reloginDelayMs()
//            (20 to 30 s), call reload() and measure the time until inGame() is true again.
//            Then close the tab without a logout, wait a fixed 15 s, open a new tab and
//            measure the same time.
// Every other wait before a new login is reloginDelayMs(): more than 10 s, with random jitter.
// stdout gets one JSON line per run. Progress goes to stderr. Page console lines go to
// measurements/raw/idle-<mode>-<phase>-<ISO date>-console.log, redacted.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'puppeteer';
import { launchBrowser, openGameTab, type GameTab } from '../src/gamelink/game-tab';
import { reloginDelayMs } from '../src/gamelink/relogin';
import { RAW, loadModeConfig, makeRedact, parseMode, sleep } from './run-helpers';

const log = (line: string) => console.error(`[idle-test ${new Date().toISOString()}] ${line}`);

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const mode = parseMode(positional[0]);
const phase = positional[1];
const quick = args.includes('--quick');
if (!mode || (phase !== 'idle' && phase !== 'relogin') || args.some(a => a.startsWith('--') && a !== '--quick')) {
  console.error('usage: bun scripts/idle-test.ts local|demo idle|relogin [--quick]');
  process.exit(2);
}

const RUN_MS = quick ? 120_000 : 25 * 60_000;
const POLL_MS = 30_000;
const KEEPALIVE_MS = quick ? 60_000 : 4 * 60_000;
// The fixed wait between closing the tab and opening a new one.
const CLOSED_TAB_WAIT_MS = 15_000;
// The bot page logs in once per page load. If a login fails (for example "already logged in"),
// load the page again after reloginDelayMs().
const LOGIN_ATTEMPT_MS = 30_000;
const LOGIN_DEADLINE_MS = 300_000;

const config = loadModeConfig(mode);
const account = config.account.name;
const password = config.account.password;
// No boot token in this script; redact the password only.
const redact = makeRedact('\u0000no-boot-token\u0000', password);

mkdirSync(RAW, { recursive: true });
const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
const consolePath = join(RAW, `idle-${mode}-${phase}-${stamp}-console.log`);
writeFileSync(consolePath, '');

let browser: Browser | null = null;
let tab: GameTab | null = null;
let exitCode = 1;

const botPath = new URL(config.botPageUrl).pathname;

async function findGamePage(b: Browser): Promise<Page | null> {
  return (await b.pages()).find(p => { try { return new URL(p.url()).pathname === botPath; } catch { return false; } }) ?? null;
}

function watchConsole(page: Page, label: string) {
  page.on('console', msg => {
    appendFileSync(consolePath, `${new Date().toISOString()} ${label} ${msg.type()}: ${redact(msg.text())}\n`);
  });
  page.on('pageerror', err => {
    appendFileSync(consolePath, `${new Date().toISOString()} ${label} pageerror: ${redact(err instanceof Error ? err.message : String(err))}\n`);
  });
}

// The login messages of the client (loginMes1, loginMes2), as the title screen shows them.
async function loginMessage(page: Page | null): Promise<string> {
  if (!page) return '';
  try {
    return await page.evaluate(() => {
      const gc = (window as unknown as { gameClient?: { loginMes1?: unknown; loginMes2?: unknown } }).gameClient;
      if (!gc) return '';
      return [gc.loginMes1, gc.loginMes2].filter(v => typeof v === 'string' && v !== '').join(' / ');
    });
  } catch { return ''; }
}

interface LoginResult {
  ms: number | null;
  attempts: number;
  messages: string[];
}

// Wait until the tab is in game. Load the page again after a failed attempt. `start` is the
// time the measured interval starts (the reload, or the open of the new tab).
async function waitForLogin(t: GameTab, b: Browser, start: number, label: string): Promise<LoginResult> {
  const messages: string[] = [];
  let attempts = 1;
  let attemptStart = Date.now();
  while (Date.now() - start < LOGIN_DEADLINE_MS) {
    if (await t.inGame().catch(() => false)) return { ms: Date.now() - start, attempts, messages };
    const m = await loginMessage(await findGamePage(b));
    if (m && messages[messages.length - 1] !== m) {
      messages.push(m);
      log(`${label}: login message "${m}"`);
    }
    if (Date.now() - attemptStart >= LOGIN_ATTEMPT_MS) {
      const delay = reloginDelayMs();
      log(`${label}: not in game after attempt ${attempts}; wait ${delay} ms and load the page again`);
      await sleep(delay);
      await t.reload();
      attempts++;
      attemptStart = Date.now();
    }
    await sleep(250);
  }
  return { ms: null, attempts, messages };
}

async function openTab(b: Browser, label: string): Promise<GameTab> {
  const t = await openGameTab({ browser: b, botPageUrl: config.botPageUrl, account, password, fps: config.fps });
  const page = await findGamePage(b);
  if (page) watchConsole(page, label);
  return t;
}

interface IdleRun {
  run: number;
  keepAlive: boolean;
  keepAlives: number;
  startedAt: string;
  minutes: number;
  samples: { s: number; inGame: boolean }[];
  firstNotInGameS: number | null;
  result: string;
  loginMessagesAtEnd: string;
}

async function idleRun(t: GameTab, b: Browser, run: number, keepAlive: boolean): Promise<IdleRun> {
  const start = Date.now();
  const samples: { s: number; inGame: boolean }[] = [];
  let firstNotInGameS: number | null = null;
  const end = start + RUN_MS;
  let nextPoll = start + POLL_MS;
  let nextKeepAlive = keepAlive ? start : Infinity;
  let keepAlives = 0;
  log(`run ${run}: ${RUN_MS / 60_000} min, keepAlive ${keepAlive ? `every ${KEEPALIVE_MS / 60_000} min` : 'off'}`);
  while (nextPoll <= end) {
    await sleep(Math.max(0, Math.min(nextPoll, nextKeepAlive) - Date.now()));
    if (Date.now() >= nextKeepAlive) {
      await t.keepAlive().catch(() => {});
      keepAlives++;
      nextKeepAlive += KEEPALIVE_MS;
    }
    if (Date.now() < nextPoll) continue;
    nextPoll += POLL_MS;
    const s = Math.round((Date.now() - start) / 1000);
    const ig = await t.inGame().catch(() => false);
    samples.push({ s, inGame: ig });
    if (!ig && firstNotInGameS === null) {
      firstNotInGameS = s;
      log(`run ${run}: first inGame() === false at ${s} s; login message "${await loginMessage(await findGamePage(b))}"`);
    }
  }
  return {
    run,
    keepAlive,
    keepAlives,
    startedAt: new Date(start).toISOString(),
    minutes: RUN_MS / 60_000,
    samples,
    firstNotInGameS,
    result: firstNotInGameS === null ? 'stayed in game' : `first inGame() === false at ${firstNotInGameS} s (${(firstNotInGameS / 60).toFixed(1)} min)`,
    loginMessagesAtEnd: await loginMessage(await findGamePage(b)),
  };
}

try {
  log(`mode ${mode}, phase ${phase}${quick ? ' (quick)' : ''}, account ${account}, bot page ${config.botPageUrl}`);
  browser = await launchBrowser(config.chromePath ? { executablePath: config.chromePath } : {});
  const b = browser;
  tab = await openTab(b, 'tab1');
  const first = await waitForLogin(tab, b, Date.now(), 'first login');
  if (first.ms === null) throw new Error(`the game tab is not in game after ${LOGIN_DEADLINE_MS / 1000} s (${first.messages.join('; ')})`);
  await tab.selfCheck();
  log(`game tab is in game after ${first.ms} ms`);

  if (phase === 'idle') {
    const run1 = await idleRun(tab, b, 1, false);
    console.log(JSON.stringify(run1));
    let between: LoginResult | null = null;
    if (!(await tab.inGame().catch(() => false))) {
      const delay = reloginDelayMs();
      log(`not in game after run 1; wait ${delay} ms and load the page again`);
      await sleep(delay);
      const start = Date.now();
      await tab.reload();
      between = await waitForLogin(tab, b, start, 'login before run 2');
      if (between.ms === null) throw new Error(`no login before run 2 (${between.messages.join('; ')})`);
      log(`in game again after ${between.ms} ms`);
    }
    const run2 = await idleRun(tab, b, 2, true);
    console.log(JSON.stringify({ ...run2, loginBeforeRun: between }));
  } else {
    // Leave the bot page so that the session ends, and wait before the new login.
    const gamePage = await findGamePage(b);
    if (!gamePage) throw new Error('the game page was not found');
    await gamePage.goto('about:blank');
    const delay = reloginDelayMs();
    log(`left the bot page; wait ${delay} ms before reload()`);
    await sleep(delay);
    let start = Date.now();
    await tab.reload();
    const reload = await waitForLogin(tab, b, start, 'reload');
    console.log(JSON.stringify({ test: 'reload', waitBeforeReloadMs: delay, ...reload }));
    if (reload.ms === null) log('reload: not in game before the deadline');

    log('closing the tab without a logout');
    await tab.close();
    tab = null;
    await sleep(CLOSED_TAB_WAIT_MS);
    start = Date.now();
    tab = await openTab(b, 'tab2');
    const reopen = await waitForLogin(tab, b, start, 'new tab');
    console.log(JSON.stringify({ test: 'close, wait 15 s, new tab', ...reopen }));
    if (reload.ms === null || reopen.ms === null) throw new Error('a login did not finish');
  }
  exitCode = 0;
} catch (error) {
  log(`failed: ${error instanceof Error ? redact(error.message) : 'unknown error'}`);
  exitCode = 1;
} finally {
  await tab?.close().catch(() => {});
  if (browser) {
    const proc = browser.process();
    await Promise.race([browser.close().catch(() => {}), sleep(10_000)]);
    if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
  log(`console lines: ${consolePath}`);
}
process.exit(exitCode);

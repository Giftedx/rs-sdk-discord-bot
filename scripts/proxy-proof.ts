// Proxy proof: run the unchanged rs-sdk template script in a child process
// through the gamelink proxy, and capture one frame from the game tab.
// Usage (mode demo, a remote game server; read the rules in docs/development.md first).
// The subshell keeps the password out of the rest of the shell session. Add RS_ALLOW_DEMO=1
// before `bun` only after the person who runs the game server agreed:
//   ( set -a; . secrets/account.env; set +a; bun scripts/proxy-proof.ts demo )
// Usage (local stack): RS_ACCOUNT=prooflocal RS_PASSWORD=x bun scripts/proxy-proof.ts local
// (x is a dummy password: the local stack has the login server off and accepts any password.)
// Never type a real password on the command line: it stays in the shell history.
// stdout gets one JSON line. Progress and the child's output tail go to stderr.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createActionPolicy } from '../src/gamelink/policy';
import { startProxy, type ProxyHandle } from '../src/gamelink/proxy';
import { launchBrowser, openGameTab, type GameTab } from '../src/gamelink/game-tab';
import type { Browser } from 'puppeteer';
import { RAW, ROOT, boxChildCommand, boxChildEnv, loadModeConfig, makeRedact, newBootToken, parseMode, waitUntil } from './run-helpers';

const IN_GAME_TIMEOUT_MS = 120_000;
const UPSTREAM_TIMEOUT_MS = 30_000;
const CHILD_TIMEOUT_MS = 120_000;
const CHILD_TAIL_LINES = 25;
// runScript prints this header only when the SDK holds a game state at the end of the run.
const STATE_MARKER = '── State ──';

const log = (line: string) => console.error(`[proxy-proof] ${line}`);

const mode = parseMode(process.argv[2]);
if (!mode) {
  console.error('usage: bun scripts/proxy-proof.ts local|demo');
  process.exit(2);
}

const config = loadModeConfig(mode);
const account = config.account.name;
const password = config.account.password;
const bootToken = newBootToken();
const redact = makeRedact(bootToken, password);

mkdirSync(RAW, { recursive: true });

let browser: Browser | null = null;
let tab: GameTab | null = null;
let proxy: ProxyHandle | null = null;
let child: ReturnType<typeof Bun.spawn> | null = null;
let upstreamPoll: ReturnType<typeof setInterval> | null = null;
let exitCode = 1;

try {
  log(`mode ${mode}, account ${account}, gateway ${config.gatewayUrl}, bot page ${config.botPageUrl}`);
  browser = await launchBrowser(config.chromePath ? { executablePath: config.chromePath } : {});
  tab = await openGameTab({ browser, botPageUrl: config.botPageUrl, account, password, fps: config.fps });
  const t = tab;
  await waitUntil('game tab inGame()', () => t.inGame(), IN_GAME_TIMEOUT_MS);
  await tab.selfCheck();
  log('game tab is in game');

  let tapFrames = 0;
  proxy = await startProxy({
    upstreamUrl: config.gatewayUrl,
    account,
    password,
    bootToken,
    listenPort: config.proxyPort,
    policy: createActionPolicy(),
    onState: () => { tapFrames++; },
  });
  const p = proxy;
  // Count transitions to "connected" to measure upstream connects.
  let upstreamConnects = 0;
  let wasConnected = false;
  upstreamPoll = setInterval(() => {
    const now = p.upstreamConnected();
    if (now && !wasConnected) upstreamConnects++;
    wasConnected = now;
  }, 100);
  await waitUntil('proxy upstreamConnected()', () => p.upstreamConnected(), UPSTREAM_TIMEOUT_MS);
  proxy.setJobActive(true);
  log(`proxy listens on 127.0.0.1:${proxy.port}, upstream connected`);

  // boxChildEnv throws if the game password is in the child environment.
  const childEnv = boxChildEnv({ account, bootToken, proxyPort: proxy.port, password });
  const passwordInChildEnv = Object.values(childEnv).some(v => v === password);

  log('starting child: bun scripts/proof-script.ts');
  child = Bun.spawn(boxChildCommand('scripts/proof-script.ts'), {
    cwd: ROOT,
    env: childEnv,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const c = child;
  const outputs = Promise.all([new Response(c.stdout as ReadableStream).text(), new Response(c.stderr as ReadableStream).text()]);
  let childTimer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>(r => { childTimer = setTimeout(() => r('timeout'), CHILD_TIMEOUT_MS); });
  const first = await Promise.race([c.exited, timedOut]);
  clearTimeout(childTimer);
  if (first === 'timeout') {
    log(`child still running after ${CHILD_TIMEOUT_MS / 1000} s; stopping it`);
    c.kill('SIGTERM');
    const killTimer = setTimeout(() => c.kill('SIGKILL'), 5_000);
    await c.exited;
    clearTimeout(killTimer);
  }
  const childExitCode = c.exitCode ?? -1;
  const [rawOut, rawErr] = await outputs;
  const childSawState = rawOut.includes(STATE_MARKER);
  // All child output that leaves this process goes through redact() first.
  const out = redact(rawOut);
  const err = redact(rawErr);
  writeFileSync(join(RAW, `proof-${mode}-child.log`), `${out}\n--- stderr ---\n${err}`);
  log(`child exited with code ${childExitCode}; output tail (full log measurements/raw/proof-${mode}-child.log):`);
  for (const line of out.trimEnd().split('\n').slice(-CHILD_TAIL_LINES)) console.error(`  | ${line}`);

  const png = await tab.frame('view');
  writeFileSync(join(RAW, `proof-${mode}.png`), png);
  log(`frame written to measurements/raw/proof-${mode}.png`);

  console.log(JSON.stringify({
    mode,
    childExitCode,
    childSawState,
    tapFrames,
    upstreamConnects,
    passwordInChildEnv,
    framePngBytes: png.byteLength,
  }));
  exitCode = childExitCode === 0 && tapFrames > 0 ? 0 : 1;
} catch (error) {
  log(`failed: ${redact(error instanceof Error ? error.message : String(error))}`);
  exitCode = 1;
} finally {
  if (upstreamPoll) clearInterval(upstreamPoll);
  if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
  await proxy?.stop().catch(() => {});
  await tab?.close().catch(() => {});
  await browser?.close().catch(() => {});
}
process.exit(exitCode);

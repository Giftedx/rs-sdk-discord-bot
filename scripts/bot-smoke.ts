// Smoke test of the bot on the local stack, without Discord and without a paid AI call.
// A scripted model drives the real agent loop: game_state, run_code, look, save_script,
// run_script, finish. The jobs run real rs-sdk code through the proxy in a child process.
// Then the script checks the job flag between jobs and logs out through the page.
// Usage (local stack only): RS_ACCOUNT=smokelocal RS_PASSWORD=x bun scripts/bot-smoke.ts
// It also checks the parts that main.ts wires around the loop: the browser profile on tmpfs,
// the seed scripts, the frame store behind the look tool, the SQLite spend record and a
// snapshot, and a drawn receipt card.
// stdout gets one JSON line. Exit code 0 when every check passed.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'puppeteer';
import { createJobRunner } from '../src/box/job-runner';
import { runInstruction, type AgentDeps } from '../src/agent/loop';
import { createStore } from '../src/agent/store';
import { seedStore } from '../src/box/seed';
import { isPng } from '../src/cards/icons';
import { launchBrowserWithProfile, type ProfiledBrowser } from '../src/gamelink/browser-profile';
import { openCardTab, type CardTab } from '../src/gamelink/card-tab';
import { createFrameStore } from '../src/gamelink/frame-store';
import { openGameTab, type GameTab } from '../src/gamelink/game-tab';
import { createBudget } from '../src/orchestrator/budget';
import { openDb } from '../src/orchestrator/db';
import { compactState } from '../src/orchestrator/wakes';
import { createActionPolicy } from '../src/gamelink/policy';
import { startProxy, type ProxyHandle } from '../src/gamelink/proxy';
import { createSupervisor, type Supervisor } from '../src/gamelink/supervisor';
import { formatWorldState } from '../vendor/rs-sdk/sdk/formatter';
import type { BotWorldState } from '../vendor/rs-sdk/sdk/types';
import { RAW, ROOT, loadModeConfig, newBootToken, waitUntil } from './run-helpers';

const log = (line: string) => console.error(`[bot-smoke] ${line}`);
const config = loadModeConfig('local');
const bootToken = newBootToken();
const dataDir = mkdtempSync(join(tmpdir(), 'bot-smoke-'));
// The box user must reach the job files under dataDir.
chmodSync(dataDir, 0o711);
mkdirSync(RAW, { recursive: true });

const checks: Record<string, boolean | string> = {};
let pb: ProfiledBrowser | null = null;
let cards: CardTab | null = null;
let tab: GameTab | null = null;
let sup: Supervisor | null = null;
let proxy: ProxyHandle | null = null;
let exitCode = 1;

const CHOP = `await bot.skipTutorial();
const tree = sdk.findNearbyLoc(/^tree$/i);
if (!tree) return 'no tree near';
const r = await bot.chopTree(tree);
return 'chop: ' + r.message;`;

try {
  pb = await launchBrowserWithProfile(config.chromePath ? { executablePath: config.chromePath } : {});
  checks.profileOnTmpfs = pb.profile.onTmpfs;
  const browser: Browser = pb.browser;
  tab = await openGameTab({ browser, botPageUrl: config.botPageUrl, account: config.account.name, password: config.account.password, fps: config.fps });
  const t = tab;
  sup = createSupervisor({ tab, idleGuard: true, log, checkMs: 1_000 });
  sup.start();
  const s = sup;
  await waitUntil('supervisor in_game', () => s.status() === 'in_game', 180_000);
  log('game tab in game');

  let lastState: BotWorldState | null = null;
  let lastAt = 0;
  proxy = await startProxy({
    upstreamUrl: config.gatewayUrl, account: config.account.name, password: config.account.password, bootToken,
    listenPort: 0, policy: createActionPolicy(), onState: (st, at) => { lastState = st as BotWorldState; lastAt = at; },
  });
  const p = proxy;
  await waitUntil('proxy upstream', () => p.upstreamConnected(), 30_000);
  await waitUntil('state tap', () => lastState !== null, 30_000);
  log('proxy up, state tap has a state');

  const flags: boolean[] = [];
  const runner = createJobRunner({
    rootDir: ROOT, scratchDir: join(dataDir, 'jobs'), account: config.account.name, bootToken, secrets: [config.account.password],
    proxy: { port: p.port, setJobActive: a => { flags.push(a); p.setJobActive(a); } },
    boxUser: process.env.BOX_USER || null,
    ...(process.env.BOX_USER ? { bunPath: process.env.BOX_BUN_PATH || '/usr/local/bin/bun' } : {}),
  });
  log(`jobs run as ${process.env.BOX_USER || 'the current user'}`);

  const script = [
    [{ type: 'tool_use', id: 'a1', name: 'game_state', input: {} }],
    [{ type: 'tool_use', id: 'a2', name: 'run_code', input: { code: CHOP, timeout_s: 120 } }],
    [{ type: 'tool_use', id: 'a3', name: 'look', input: {} },
     { type: 'tool_use', id: 'a4', name: 'save_script', input: { name: 'chop-one', description: 'Chop one tree', code: CHOP } }],
    [{ type: 'tool_use', id: 'a5', name: 'run_script', input: { name: 'chop-one', timeout_s: 120 } }],
    [{ type: 'tool_use', id: 'a6', name: 'finish', input: { summary: 'smoke done' } }],
  ];
  const store = createStore(dataDir);
  checks.seedScripts = seedStore(store, join(ROOT, 'seed')).length === 7 && store.listScripts().length === 7;
  const db = openDb(join(dataDir, 'bot.sqlite'));
  const budget = createBudget(db, 1, { context: () => ({ guild: 'smoke', instructionId: 1 }) });
  const frames = createFrameStore({ source: t, log, intervalMs: 2_000 });
  frames.start();
  await waitUntil('a stored frame', () => frames.latest() !== null, 30_000);
  db.addSnapshot('smoke', compactState(lastState));
  const toolResults: string[] = [];
  const deps: AgentDeps = {
    model: 'scripted', effort: 'low',
    callModel: async params => {
      const last = params.messages.at(-1);
      if (last && last.role === 'user' && Array.isArray(last.content)) toolResults.push(JSON.stringify(last.content));
      const content = script.shift() ?? [{ type: 'text', text: 'out of script' }];
      return { id: 'x', type: 'message', role: 'assistant', model: 'scripted', content, stop_reason: 'tool_use', usage: { input_tokens: 0, output_tokens: 0 } } as never;
    },
    runJob: (code, ms, signal) => runner.run(code, ms, signal),
    store, knowledge: [], apiReference: '',
    gameState: () => (lastState ? formatWorldState(lastState, Date.now() - lastAt, { brief: true }) : 'none'),
    frame: async () => frames.latest()?.png ?? null,
    spend: budget,
    maxTurns: 10, maxInstructionUsd: 1, onProgress: line => log(`progress: ${line}`),
  };
  const result = await runInstruction(deps, 'chop a tree', 'smoke', new AbortController().signal);
  writeFileSync(join(RAW, 'bot-smoke-tool-results.json'), JSON.stringify(toolResults, null, 2));
  if (result.lastFrame) writeFileSync(join(RAW, 'bot-smoke.png'), result.lastFrame);

  frames.stop();
  checks.frameStoreFrames = frames.all().length >= 2;
  checks.spendRows = (db.raw.query('SELECT COUNT(*) AS n FROM spend WHERE guild = ?').get('smoke') as { n: number }).n === result.turns;
  checks.snapshot = db.latestSnapshot('smoke') !== null;
  db.close();
  cards = await openCardTab(browser, { iconHost: new URL(config.botPageUrl).origin });
  const receipt = await cards.draw('instruction_receipt', { instruction: 'chop a tree', summary: result.summary, turns: result.turns, costUsd: result.usd });
  writeFileSync(join(RAW, 'bot-smoke-receipt.png'), receipt);
  checks.receiptCard = isPng(receipt);

  checks.finished = result.stopReason === 'finished';
  checks.gameStateHasPlayer = (toolResults[0] ?? '').includes('Position') || (toolResults[0] ?? '').includes('HP');
  checks.job1Ran = /exit code 0/.test(toolResults[1] ?? '');
  checks.job1Chopped = /chop: /.test(toolResults[1] ?? '');
  checks.lookImage = (toolResults[2] ?? '').includes('"type":"image"');
  checks.job2Ran = /exit code 0/.test(toolResults[3] ?? '');
  checks.flagOnlyDuringJobs = JSON.stringify(flags) === JSON.stringify([true, false, true, false]);
  checks.supervisorInGame = s.status() === 'in_game';

  // Between jobs the flag is off: a job-less child must get "blocked by policy".
  const blocked = await runner.run('const r = await sdk.sendWalk(3222, 3218); return JSON.stringify(r);', 30_000);
  checks.flagRestoredAfterJob = flags.at(-1) === false;
  checks.walkInsideJobAllowed = !/blocked by policy/.test(blocked.output);
  log(`walk job output tail: ${blocked.output.slice(-300).replace(/\n/g, ' | ')}`);

  // With a box user, a job must not read a file that only the bot user can read.
  if (process.env.BOX_USER) {
    const secretFile = join(dataDir, 'secret-probe.txt');
    writeFileSync(secretFile, 'probe-secret-value', { mode: 0o600 });
    const probe = await runner.run(`const f = await Bun.file(${JSON.stringify(secretFile)}).text().catch(e => 'DENIED ' + e.code); return f;`, 30_000);
    checks.boxCannotReadBotFile = /DENIED/.test(probe.output) && !probe.output.includes('probe-secret-value');
    const env = await runner.run(`return require('node:fs').readFileSync('/proc/${process.pid}/environ', 'utf8').length > 0 ? 'READ' : 'EMPTY';`, 30_000).catch(() => null);
    checks.boxCannotReadParentEnv = env !== null && /EACCES|permission denied/i.test(env.output);
  }

  checks.logout = await t.logout();
  const results = { checks, stopReason: result.stopReason, turns: result.turns };
  console.log(JSON.stringify(results));
  exitCode = Object.values(checks).every(v => v === true) ? 0 : 1;
} catch (err) {
  log(`failed: ${err instanceof Error ? err.message : String(err)}`);
  console.log(JSON.stringify({ checks, error: true }));
} finally {
  sup?.stop();
  await proxy?.stop().catch(() => {});
  await cards?.close().catch(() => {});
  await tab?.close().catch(() => {});
  await pb?.close().catch(() => {});
}
process.exit(exitCode);

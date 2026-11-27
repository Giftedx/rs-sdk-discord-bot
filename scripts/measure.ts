// Measure the RAM (Pss) and CPU of one game account: the game tab, frame capture,
// a second tab for a job card, and the box stand-in behind the proxy.
// Usage (mode demo, a remote game server; read the rules in docs/development.md first).
// The subshell keeps the password out of the rest of the shell session. Add RS_ALLOW_DEMO=1
// before `bun` only after the person who runs the game server agreed:
//   ( set -a; . secrets/account.env; set +a; bun scripts/measure.ts demo [--quick] )
// In every mode, the tool calls keepAlive() every 60 s, which resets the idle timer of the client.
// Usage (local stack): RS_ACCOUNT=prooflocal RS_PASSWORD=x bun scripts/measure.ts local [--quick]
// (x is a dummy password: the local stack has the login server off and accepts any password.)
// Never type a real password on the command line: it stays in the shell history.
// Linux only (/proc). Writes measurements/raw/measure-<mode>-<ISO date>.json and prints a table.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'puppeteer';
import { createActionPolicy } from '../src/gamelink/policy';
import { startProxy, type ProxyHandle } from '../src/gamelink/proxy';
import { launchBrowser, openGameTab, type GameTab } from '../src/gamelink/game-tab';
import { availableParallelism } from 'node:os';
import { browserCompanions, clockTicksPerSecond, readMeminfoKb, readProcInfo, readTreesPss, sampleTrees, type Sample } from '../src/measure/proc';
import { RAW, ROOT, boxChildCommand, boxChildEnv, loadModeConfig, makeRedact, newBootToken, parseMode, provenance, sleep, waitUntil } from './run-helpers';

const log = (line: string) => console.error(`[measure] ${line}`);

if (process.platform !== 'linux') {
  console.error(`measure.ts reads /proc and runs on Linux only (this is ${process.platform})`);
  process.exit(2);
}
const args = process.argv.slice(2);
const mode = parseMode(args.find(a => !a.startsWith('--')));
const quick = args.includes('--quick');
if (!mode || args.some(a => a.startsWith('--') && a !== '--quick')) {
  console.error('usage: bun scripts/measure.ts local|demo [--quick]');
  process.exit(2);
}

const SETTLE_MS = quick ? 10_000 : 60_000;
const WINDOW_MS = quick ? 10_000 : 30_000;
const SAMPLES = quick ? 1 : 3;
const FRAME_INTERVAL_MS = 5_000;
const CARD_INTERVAL_MS = 60_000;
const KEEPALIVE_INTERVAL_MS = 60_000;
const IN_GAME_TIMEOUT_MS = 120_000;
const UPSTREAM_TIMEOUT_MS = 30_000;
const BOX_READY_TIMEOUT_MS = 120_000;
// The cores this machine gives to processes; "CPU % of all cores" is "CPU % of 1 core" / CORES.
const CORES = availableParallelism();

const config = loadModeConfig(mode);
const account = config.account.name;
const password = config.account.password;
const bootToken = newBootToken();
const redact = makeRedact(bootToken, password);

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
mkdirSync(RAW, { recursive: true });
const outPath = join(RAW, `measure-${mode}-${stamp}.json`);
const boxLogPath = join(RAW, `measure-${mode}-${stamp}-box.log`);

// The page of the job card stand-in: draw a 600x300 canvas now and every 60 s, and encode it as PNG.
const CARD_HTML = `<!doctype html><canvas id="c" width="600" height="300"></canvas><script>
const c = document.getElementById('c'); const x = c.getContext('2d'); let n = 0;
function draw() {
  n++;
  x.fillStyle = 'hsl(' + (n * 37 % 360) + ',40%,20%)'; x.fillRect(0, 0, 600, 300);
  x.fillStyle = '#fff'; x.font = '28px sans-serif'; x.fillText('Job card ' + n + ' ' + new Date().toISOString(), 20, 50);
  for (let i = 0; i < 40; i++) { const h = (i * n * 13) % 200; x.fillRect(20 + i * 14, 280 - h, 10, h); }
  window.cardBytes = c.toDataURL('image/png').length; window.cardDraws = n;
}
draw(); setInterval(draw, ${CARD_INTERVAL_MS});
</script>`;

interface ScenarioResult {
  name: string;
  sampled: string;
  rootPids: number[];
  samples: Sample[];
  pssMbMean: number;
  cpuPercentMean: number;
  cpuPercentOfAllCoresMean: number;
  inGameAtEnd: boolean;
  gameTabVisibility: string;
  gameClientFps: number | null;
  tapFramesInWindows: number;
  tapFramesPerSecond: number | null;
}

let browser: Browser | null = null;
let tab: GameTab | null = null;
let gamePage: Page | null = null;
let cardPage: Page | null = null;
let proxy: ProxyHandle | null = null;
let box: ReturnType<typeof Bun.spawn> | null = null;
let frameTimer: ReturnType<typeof setInterval> | null = null;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let exitCode = 1;

const frames = { ok: 0, failed: 0 };
let frameBusy = false;
const tap: { bytes: number; at: number }[] = [];
const boxLines: string[] = [];
let boxReadyMs: number | null = null;
let boxExit: number | null = null;

function startFrameLoop() {
  frameTimer = setInterval(() => {
    if (frameBusy || !tab) return;
    frameBusy = true;
    tab.frame('view').then(() => { frames.ok++; }, () => { frames.failed++; }).finally(() => { frameBusy = false; });
  }, FRAME_INTERVAL_MS);
}
function stopFrameLoop() {
  if (frameTimer) clearInterval(frameTimer);
  frameTimer = null;
}

async function openCard(b: Browser) {
  cardPage = await b.newPage();
  await cardPage.setContent(CARD_HTML);
  // A new page can take the front; keep the game tab in front as the bot will.
  await gamePage?.bringToFront();
}
async function closeCard() {
  const p = cardPage;
  cardPage = null;
  if (p && !p.isClosed()) await p.close();
}

async function gameVisibility(): Promise<string> {
  try { return await gamePage!.evaluate(() => document.visibilityState); } catch { return 'unknown'; }
}

// The game client measures its own frame rate in gameClient.fps. It shows whether the tab draws at the requested rate.
async function gameClientFps(): Promise<number | null> {
  try {
    return await gamePage!.evaluate(() => {
      const v = (window as unknown as { gameClient?: { fps?: unknown } }).gameClient?.fps;
      return typeof v === 'number' ? v : null;
    });
  } catch { return null; }
}

async function pipeBoxOutput(stream: ReadableStream<Uint8Array>, name: string) {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = redact(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
      boxLines.push(`${name}: ${line}`);
      appendFileSync(boxLogPath, `${name}: ${line}\n`);
      const m = /^ready (\d+)$/.exec(line);
      if (name === 'stdout' && m && boxReadyMs === null) boxReadyMs = Number(m[1]);
    }
  }
  if (pending) {
    const line = redact(pending);
    boxLines.push(`${name}: ${line}`);
    appendFileSync(boxLogPath, `${name}: ${line}\n`);
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

async function runScenario(name: string, sampled: string, rootPids: number[], afterSettle?: () => void): Promise<ScenarioResult> {
  log(`${name}: settle ${SETTLE_MS / 1000} s`);
  await sleep(SETTLE_MS);
  afterSettle?.();
  const samples: Sample[] = [];
  let tapFramesInWindows = 0;
  let windowMsTotal = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const tapBefore = tap.length;
    const s = await sampleTrees(rootPids, WINDOW_MS);
    tapFramesInWindows += tap.length - tapBefore;
    windowMsTotal += s.windowMs;
    samples.push(s);
    log(`${name}: sample ${i + 1}/${SAMPLES}: Pss ${s.pssMb.toFixed(1)} MB, CPU ${s.cpuPercentOfOneCore.toFixed(1)} %, ` +
      `${s.processes} processes for Pss (${s.pssUnreadable} unreadable), ${s.cpuProcesses} for CPU, game fps ${await gameClientFps()}`);
  }
  const result: ScenarioResult = {
    name,
    sampled,
    rootPids,
    samples,
    pssMbMean: mean(samples.map(s => s.pssMb)),
    cpuPercentMean: mean(samples.map(s => s.cpuPercentOfOneCore)),
    cpuPercentOfAllCoresMean: mean(samples.map(s => s.cpuPercentOfOneCore)) / CORES,
    inGameAtEnd: await tab!.inGame().catch(() => false),
    gameTabVisibility: await gameVisibility(),
    gameClientFps: await gameClientFps(),
    tapFramesInWindows,
    tapFramesPerSecond: proxy ? tapFramesInWindows / (windowMsTotal / 1000) : null,
  };
  if (!result.inGameAtEnd) log(`${name}: WARNING the game tab is not in game at the end of the scenario`);
  return result;
}

let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  stopFrameLoop();
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  if (box && box.exitCode === null) {
    box.kill('SIGTERM');
    const t = setTimeout(() => box?.kill('SIGKILL'), 5_000);
    await box.exited;
    clearTimeout(t);
  }
  await proxy?.stop().catch(() => {});
  await closeCard().catch(() => {});
  await tab?.close().catch(() => {});
  if (browser) {
    const proc = browser.process();
    const closed = browser.close().catch(() => {});
    await Promise.race([closed, sleep(10_000)]);
    if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log(`${sig}: stopping`);
    void cleanup().finally(() => process.exit(130));
  });
}

function table(rows: ScenarioResult[]): string {
  const head = ['Scenario', 'Sampled', 'Pss MB', 'CPU % of 1 core', `CPU % of all ${CORES} cores`, 'Processes (Pss/CPU)', 'In game', 'Game fps'];
  const body = rows.map(r => {
    const last = r.samples[r.samples.length - 1]!;
    return [
      r.name,
      r.sampled,
      `${r.pssMbMean.toFixed(1)} (${Math.min(...r.samples.map(s => s.pssMb)).toFixed(1)}-${Math.max(...r.samples.map(s => s.pssMb)).toFixed(1)})`,
      `${r.cpuPercentMean.toFixed(1)} (${Math.min(...r.samples.map(s => s.cpuPercentOfOneCore)).toFixed(1)}-${Math.max(...r.samples.map(s => s.cpuPercentOfOneCore)).toFixed(1)})`,
      r.cpuPercentOfAllCoresMean.toFixed(2),
      `${last.processes}/${last.cpuProcesses}`,
      String(r.inGameAtEnd),
      r.gameClientFps === null ? 'n/a' : String(r.gameClientFps),
    ];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...body.map(b => b[i]!.length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(' | ')} |`;
  return [line(head), `|${widths.map(w => '-'.repeat(w + 2)).join('|')}|`, ...body.map(line)].join('\n');
}

try {
  log(`mode ${mode}${quick ? ' (quick)' : ''}, account ${account}, gateway ${config.gatewayUrl}, bot page ${config.botPageUrl}`);
  log(`settle ${SETTLE_MS / 1000} s, ${SAMPLES} samples of ${WINDOW_MS / 1000} s per scenario`);
  const meminfoStart = readMeminfoKb();
  const kernel = readFileSync('/proc/sys/kernel/osrelease', 'utf8').trim();

  browser = await launchBrowser(config.chromePath ? { executablePath: config.chromePath } : {});
  const b = browser;
  const browserPid = b.process()?.pid;
  if (!browserPid) throw new Error('the browser has no process ID');
  tab = await openGameTab({ browser: b, botPageUrl: config.botPageUrl, account, password, fps: config.fps });
  const t = tab;
  await waitUntil('game tab inGame()', () => t.inGame(), IN_GAME_TIMEOUT_MS);
  await tab.selfCheck();
  // openGameTab navigates one new page; find it by its bot URL path to read its visibility.
  const botPath = new URL(config.botPageUrl).pathname;
  gamePage = (await b.pages()).find(p => { try { return new URL(p.url()).pathname === botPath; } catch { return false; } }) ?? null;
  log(`game tab is in game, ${config.fps} frames per second, visibility ${await gameVisibility()}`);
  keepAliveTimer = setInterval(() => { void tab?.keepAlive().catch(() => {}); }, KEEPALIVE_INTERVAL_MS);

  // chrome_crashpad_handler leaves the browser tree (double fork); sample it with the browser.
  const companions = browserCompanions(browserPid);
  const companionInfo = companions.map(pid => {
    const exe = readProcInfo(pid)?.argv0 ?? '';
    return { pid, program: exe.slice(exe.lastIndexOf('/') + 1) };
  });
  log(`browser pid ${browserPid}; companions outside its tree: ${companionInfo.map(c => `${c.pid} ${c.program}`).join(', ') || 'none'}`);
  const browserRoots = [browserPid, ...companions];

  const results: ScenarioResult[] = [];
  results.push(await runScenario('tab', 'browser tree + companions', browserRoots));

  startFrameLoop();
  results.push(await runScenario('tab+frames', 'browser tree + companions', browserRoots));

  await openCard(b);
  results.push(await runScenario('tab+frames+card', 'browser tree + companions', browserRoots));

  // Scenario box: the tab stays open; the frame loop and the card tab stop.
  stopFrameLoop();
  await closeCard();
  proxy = await startProxy({
    upstreamUrl: config.gatewayUrl,
    account,
    password,
    bootToken,
    listenPort: config.proxyPort,
    policy: createActionPolicy(),
    onState: (state, at) => { tap.push({ bytes: Buffer.byteLength(JSON.stringify(state), 'utf8'), at }); },
  });
  const p = proxy;
  await waitUntil('proxy upstreamConnected()', () => p.upstreamConnected(), UPSTREAM_TIMEOUT_MS);
  log(`proxy listens on 127.0.0.1:${proxy.port}, upstream connected`);

  writeFileSync(boxLogPath, '');
  box = Bun.spawn(boxChildCommand('scripts/box-standin.ts'), {
    cwd: ROOT,
    env: boxChildEnv({ account, bootToken, proxyPort: proxy.port, password }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const bx = box;
  void bx.exited.then(code => { boxExit = code; });
  void pipeBoxOutput(bx.stdout as ReadableStream<Uint8Array>, 'stdout');
  void pipeBoxOutput(bx.stderr as ReadableStream<Uint8Array>, 'stderr');
  await waitUntil('box stand-in "ready"', () => {
    if (boxExit !== null) throw new Error(`the box stand-in exited with code ${boxExit} before "ready"`);
    return boxReadyMs !== null;
  }, BOX_READY_TIMEOUT_MS);
  // The start-up peak: Pss right after "ready", before the GC frees the parsed collision JSON.
  const boxAfterReady = readTreesPss([bx.pid]);
  log(`box stand-in pid ${bx.pid}: ready ${boxReadyMs} ms, Pss right after ready ${boxAfterReady.pssMb.toFixed(1)} MB`);
  results.push(await runScenario('box', 'box stand-in tree', [bx.pid]));

  startFrameLoop();
  await openCard(b);
  // Scenario all samples this process tree: this process (it hosts the proxy and drives the browser),
  // the browser with both tabs, and the box stand-in.
  let meminfoAll = meminfoStart;
  results.push(await runScenario('all', 'this process tree (proxy host, browser, box) + companions', [process.pid, ...companions],
    () => { meminfoAll = readMeminfoKb(); }));

  if (boxExit !== null) throw new Error(`the box stand-in exited with code ${boxExit} during the run`);

  const tapSpanS = tap.length > 1 ? (tap[tap.length - 1]!.at - tap[0]!.at) / 1000 : 0;
  const output = {
    provenance: await provenance(browser, config.chromePath),
    mode,
    quick,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    host: { kernel, cores: CORES, clockTicksPerSecond: clockTicksPerSecond() },
    browserCompanions: companionInfo,
    settleMs: SETTLE_MS,
    windowMs: WINDOW_MS,
    samplesPerScenario: SAMPLES,
    fps: config.fps,
    meminfoStartKb: meminfoStart,
    meminfoAllKb: meminfoAll,
    box: {
      readyMs: boxReadyMs,
      pssMbAfterReady: boxAfterReady.pssMb,
      lines: boxLines.filter(l => /^stdout: (imported|pathfinding|ready) /.test(l) || /Pathfinding initialized/.test(l)),
    },
    tap: {
      frames: tap.length,
      meanStateBytes: tap.length ? mean(tap.map(f => f.bytes)) : null,
      framesPerSecondOverRun: tapSpanS > 0 ? (tap.length - 1) / tapSpanS : null,
      note: 'bytes of JSON.stringify(state) as the tap receives it; the wire frame adds the {"type":"sdk_state","state":...} envelope',
    },
    frameLoop: frames,
    scenarios: results,
    notes: [
      'Pss is the sum of the Pss line of /proc/<pid>/smaps_rollup over the tree at the end of each window.',
      'CPU counts only processes present at both ends of a window (same PID and start time).',
      'Scenario box samples the box stand-in tree only. Scenario all samples this process tree: this process (it hosts the proxy, drives the browser and runs the tap), the browser and the box stand-in.',
      'Browser rows and scenario all also sample the browser companions: processes from the browser directory that started within 5 s of the browser and are outside its tree (chrome_crashpad_handler).',
      `CPU % of all cores = CPU % of 1 core / ${CORES} (os.availableParallelism()).`,
      `Each scenario settles ${SETTLE_MS} ms before its first window. Scenario all reads /proc/meminfo after its settle.`,
      'The tap in this process runs JSON.stringify on each state to measure its size; that CPU is in scenario all.',
    ],
  };
  writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);

  const mb = (kb: number) => (kb / 1024).toFixed(0);
  console.log(`${CORES} cores on this machine`);
  console.log(table(results));
  console.log(`box start-up peak: Pss ${boxAfterReady.pssMb.toFixed(1)} MB right after "ready" (before the box settle)`);
  console.log(`browser companions outside the tree, sampled with it: ${companionInfo.map(c => `${c.pid} ${c.program}`).join(', ') || 'none'}`);
  console.log('');
  console.log(`MemTotal ${mb(meminfoStart.memTotalKb)} MB; MemAvailable ${mb(meminfoStart.memAvailableKb)} MB at start, ${mb(meminfoAll.memAvailableKb)} MB in scenario all`);
  console.log(`box stand-in: ready ${boxReadyMs} ms after process start`);
  for (const l of output.box.lines) console.log(`  ${l}`);
  console.log(`tap: ${tap.length} sdk_state frames, mean ${output.tap.meanStateBytes?.toFixed(0)} bytes (state JSON), ` +
    `${output.tap.framesPerSecondOverRun?.toFixed(2)} frames per second over the run; per window: ` +
    results.filter(r => r.tapFramesPerSecond !== null).map(r => `${r.name} ${r.tapFramesPerSecond!.toFixed(2)}`).join(', '));
  console.log(`frame loop: ${frames.ok} frames, ${frames.failed} failed`);
  console.log(`samples: ${SAMPLES} x ${WINDOW_MS / 1000} s per scenario after ${SETTLE_MS / 1000} s settle; 'all' includes this process (proxy host)`);
  console.log(`written: ${outPath}`);
  exitCode = results.every(r => r.inGameAtEnd && r.pssMbMean > 0 && r.cpuPercentMean > 0) ? 0 : 1;
} catch (error) {
  log(`failed: ${error instanceof Error ? redact(error.message) : 'unknown error'}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

// Runs each seed script (seed/*.ts) on the local stack as a job, through the real proxy and
// job runner, with a short limit. The check sets each script's MAX_MS to SEED_CHECK_MS.
// Usage (local stack only): RS_ACCOUNT=seedlocal RS_PASSWORD=x bun scripts/seed-check.ts
// Optional: SEED_CHECK_MS (default 60000), SEED_ONLY=name,name, SEED_DIR (default seed/).
// The full output of each job goes to measurements/raw/seed-check-<name>.txt.
// stdout gets one JSON line per script and one summary line. Exit code 0 when every job exited 0.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'puppeteer';
import { createJobRunner } from '../src/box/job-runner';
import { readSeeds } from '../src/box/seed';
import { launchBrowser, openGameTab, type GameTab } from '../src/gamelink/game-tab';
import { createActionPolicy } from '../src/gamelink/policy';
import { startProxy, type ProxyHandle } from '../src/gamelink/proxy';
import { createSupervisor, type Supervisor } from '../src/gamelink/supervisor';
import { RAW, ROOT, loadModeConfig, newBootToken, waitUntil } from './run-helpers';

const log = (line: string) => console.error(`[seed-check] ${line}`);
const config = loadModeConfig('local');
const bootToken = newBootToken();
const dataDir = mkdtempSync(join(tmpdir(), 'seed-check-'));
chmodSync(dataDir, 0o711);
mkdirSync(RAW, { recursive: true });
const seedMs = Number(process.env.SEED_CHECK_MS ?? 60_000);
const only = (process.env.SEED_ONLY ?? '').split(',').map(s => s.trim()).filter(Boolean);
// skip-tutorial first: the other scripts need a player off the tutorial island.
const ORDER = ['skip-tutorial', 'walk-to', 'bank-deposit-all'];

export function resultLine(output: string): string {
  const lines = output.split('\n').map(l => l.trim());
  const at = lines.lastIndexOf('── Result ──');
  if (at >= 0) return lines.slice(at + 1).find(l => l.length > 0)?.slice(0, 300) ?? '';
  const err = lines.find(l => l.startsWith('── Error ──'));
  return (err ?? lines.filter(Boolean).at(-1) ?? '').slice(0, 300);
}

let browser: Browser | null = null;
let tab: GameTab | null = null;
let sup: Supervisor | null = null;
let proxy: ProxyHandle | null = null;
let exitCode = 1;

try {
  const seeds = readSeeds(process.env.SEED_DIR || join(ROOT, 'seed'))
    .filter(s => only.length === 0 || only.includes(s.name))
    .sort((a, b) => (ORDER.indexOf(a.name) + 1 || 99) - (ORDER.indexOf(b.name) + 1 || 99));
  browser = await launchBrowser(config.chromePath ? { executablePath: config.chromePath } : {});
  tab = await openGameTab({ browser, botPageUrl: config.botPageUrl, account: config.account.name, password: config.account.password, fps: config.fps });
  sup = createSupervisor({ tab, idleGuard: true, log, checkMs: 1_000 });
  sup.start();
  const s = sup;
  await waitUntil('supervisor in_game', () => s.status() === 'in_game', 180_000);
  proxy = await startProxy({
    upstreamUrl: config.gatewayUrl, account: config.account.name, password: config.account.password, bootToken,
    listenPort: 0, policy: createActionPolicy(),
  });
  const p = proxy;
  await waitUntil('proxy upstream', () => p.upstreamConnected(), 30_000);
  const runner = createJobRunner({
    rootDir: ROOT, scratchDir: join(dataDir, 'jobs'), account: config.account.name, bootToken, secrets: [config.account.password],
    proxy: { port: p.port, setJobActive: a => p.setJobActive(a) },
    boxUser: process.env.BOX_USER || null,
    ...(process.env.BOX_USER ? { bunPath: process.env.BOX_BUN_PATH || '/usr/local/bin/bun' } : {}),
  });
  log(`${seeds.length} seed scripts, MAX_MS=${seedMs}, jobs run as ${process.env.BOX_USER || 'the current user'}`);

  let failed = 0;
  for (const seed of seeds) {
    const body = seed.body.replace(/const MAX_MS = [^;]+;/, `const MAX_MS = ${seedMs};`);
    // A walk inside a script can last up to 2 minutes after MAX_MS runs out.
    const r = await runner.run(body, seedMs + 150_000);
    const line = { script: seed.name, exitCode: r.exitCode, timedOut: r.timedOut, seconds: Math.round(r.durationMs / 1000), result: resultLine(r.output) };
    writeFileSync(join(RAW, `seed-check-${seed.name}.txt`), r.output);
    if (r.exitCode !== 0) {
      failed++;
      log(`${seed.name} output tail:\n${r.output.slice(-1500)}`);
    }
    console.log(JSON.stringify(line));
  }
  console.log(JSON.stringify({ scripts: seeds.length, failed, supervisor: s.status() }));
  exitCode = failed === 0 ? 0 : 1;
  await tab.logout().catch(() => false);
} catch (err) {
  log(`failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  sup?.stop();
  await proxy?.stop().catch(() => {});
  await tab?.close().catch(() => {});
  await browser?.close().catch(() => {});
}
process.exit(exitCode);

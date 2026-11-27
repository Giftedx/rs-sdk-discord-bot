// The gamelink process: the game parts of every guild (browser, game tab, supervisor, proxy, frame
// store, card tab) behind an authenticated Unix socket (service.ts). It holds the game passwords
// and Chromium. It needs no Discord token and no API key. Start: bun src/gamelink/main.ts
// (docs/running-the-bot.md, "Split mode"). On SIGTERM it logs every account out of the game.
import { dirname, resolve } from 'node:path';
import { loadGameConfig } from '../bot/config';
import { sanitizeForDiscord } from '../shared/sanitize';
import { openLocalGameLink, readTokenFile, type GameLink } from './link';
import { serveGameLink, type ServiceHandle } from './service';

const ROOT = resolve(dirname(import.meta.path), '..', '..');
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

let token = '';
const cfg = (() => {
  try {
    const c = loadGameConfig(process.env, ROOT);
    token = readTokenFile(c.tokenFile);
    return c;
  } catch (err) {
    console.error(`configuration error: ${errText(err)}`);
    process.exit(2);
  }
})();
const secrets = [...cfg.guilds.map(g => g.game.account.password), token].filter(s => s.length >= 4);
const accounts = cfg.guilds.map(g => g.game.account.name);
const log = (line: string) => {
  let out = sanitizeForDiscord(`[gamelink ${new Date().toISOString()}] ${line}`, secrets);
  for (const a of accounts) out = out.split(a).join('<account>');
  console.error(out);
};

let link: GameLink | null = null;
let service: ServiceHandle | null = null;
let shuttingDown = false;

async function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down');
  await service?.stop().catch(() => {});
  await link?.close().catch(err => log(`stop failed: ${errText(err)}`));
  process.exit(code);
}
process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });
process.on('uncaughtException', err => { log(`uncaught exception: ${errText(err)}`); void shutdown(1); });
process.on('unhandledRejection', err => { log(`unhandled rejection: ${errText(err)}`); void shutdown(1); });

try {
  log(`${cfg.guilds.length} guild(s)`);
  link = await openLocalGameLink({ guilds: cfg.guilds, idleGuard: cfg.idleGuard, cards: cfg.cards, log });
  service = serveGameLink({ link, socketPath: cfg.socketPath, token, log });
  log(`listening on ${cfg.socketPath}`);
} catch (err) {
  log(`start failed: ${errText(err)}`);
  await shutdown(1);
}

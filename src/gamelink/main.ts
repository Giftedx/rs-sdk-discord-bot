// The gamelink process: the game parts of every guild (browser, game tab, supervisor, proxy, frame
// store, card tab) behind an authenticated Unix socket (service.ts). It holds the game passwords
// and Chromium. It needs no Discord token and no API key. Start: bun src/gamelink/main.ts
// (docs/running-the-bot.md, "Split mode"). On SIGTERM it logs every account out of the game.
// Operator signals: SIGHUP logs every tab out and in again; SIGUSR1 reconnects every proxy to the
// gateway. A lock file beside the socket stops a second gamelink.
import { dirname, resolve } from 'node:path';
import { loadGameConfig } from '../bot/config';
import { sanitizeForDiscord } from '../shared/sanitize';
import { openLocalGameLink, readTokenFile, reconnectAll, relogAll, type LocalGameLink } from './link';
import { acquireLock, lockPathFor, serveGameLink, type ServiceHandle } from './service';

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

let link: LocalGameLink | null = null;
let releaseLock: (() => void) | null = null;
let service: ServiceHandle | null = null;
let shuttingDown = false;

async function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  // A stop that hangs (a browser, a logout) must not keep the process alive.
  setTimeout(() => process.exit(code), 25_000).unref();
  log('shutting down');
  await service?.stop().catch(() => {});
  await link?.close().catch(err => log(`stop failed: ${errText(err)}`));
  releaseLock?.();
  process.exit(code);
}
process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });
let relogging = false;
process.on('SIGHUP', () => {
  if (!link || shuttingDown || relogging) return;
  relogging = true;
  log('SIGHUP: every tab logs out and in again');
  void relogAll(link, log).finally(() => { relogging = false; });
});
// Windows has no SIGUSR1.
if (process.platform !== 'win32') {
  process.on('SIGUSR1', () => {
    if (!link || shuttingDown) return;
    log('SIGUSR1: every proxy reconnects to the gateway');
    reconnectAll(link, log);
  });
}
process.on('uncaughtException', err => { log(`uncaught exception: ${errText(err)}`); void shutdown(1); });
process.on('unhandledRejection', err => { log(`unhandled rejection: ${errText(err)}`); void shutdown(1); });

try {
  releaseLock = acquireLock(lockPathFor(cfg.socketPath));
} catch (err) {
  log(`start refused: ${errText(err)}`);
  process.exit(2);
}

try {
  log(`${cfg.guilds.length} guild(s)`);
  link = await openLocalGameLink({ guilds: cfg.guilds, idleGuard: cfg.idleGuard, cards: cfg.cards, log, onBrowserGone: () => { void shutdown(1); } });
  service = serveGameLink({ link, socketPath: cfg.socketPath, token, log });
  log(`listening on ${cfg.socketPath}`);
} catch (err) {
  log(`start failed: ${errText(err)}`);
  await shutdown(1);
}

// The Discord bot. It serves one guild, or several from GUILDS_FILE. Each guild has its own job
// runner, store and queue (src/bot/guild.ts) and a game link (src/gamelink/link.ts). Without
// GAMELINK_SOCKET the game parts run in this process: one browser, one card tab. With it, they run
// in the gamelink process (src/gamelink/main.ts) and this process holds no game password.
// Start: bun src/bot/main.ts (docs/running-the-bot.md).
import Anthropic from '@anthropic-ai/sdk';
import { Client, Events, type Interaction, type Message } from 'discord.js';
import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createKnowledgePack } from '../agent/store';
import { prepareJobCgroup, type JobCgroup } from '../box/cgroup';
import { reactionInput } from '../discord/adapters';
import { connectGameLink, GameLinkError, gamelinkWaitReason } from '../gamelink/client';
import { openLocalGameLink, readTokenFile, type GameLink } from '../gamelink/link';
import { openDb } from '../orchestrator/db';
import { createWakeScheduler } from '../orchestrator/wakes';
import { redactNames, sanitizeForDiscord } from '../shared/sanitize';
import { discordClientOptions } from './client-options';
import { loadBotConfig } from './config';
import { startGuild, type Guild } from './guild';
import { createKeyedLock, mentionsBot, retryUntil, stripMentions, takeRevisionFlag } from './helpers';

const ROOT = resolve(dirname(import.meta.path), '..', '..');
const TICK_MS = 5_000;
const SNAPSHOT_KEEP_MS = 7 * 24 * 3_600_000;
const EVENT_KEEP_MS = 14 * 24 * 3_600_000;
const SHUTDOWN_CAP_MS = 25_000;

const cfg = (() => {
  try {
    return loadBotConfig(process.env, ROOT);
  } catch (err) {
    console.error(`configuration error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
})();
const gamelinkToken = (() => {
  if (!cfg.gamelink) return '';
  try {
    return readTokenFile(cfg.gamelink.tokenFile);
  } catch (err) {
    console.error(`configuration error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
})();
const secrets = [
  ...cfg.guilds.map(g => g.game.account.password), cfg.discordToken, gamelinkToken,
  process.env.ANTHROPIC_API_KEY ?? '', process.env.ANTHROPIC_AUTH_TOKEN ?? '',
].filter(s => s.length >= 4);
const accounts = cfg.guilds.map(g => g.game.account.name);
// The account name is half of the game login: it never goes to Discord.
const clean = (text: string) => sanitizeForDiscord(redactNames(text, accounts, 'my character'), secrets);
const log = (line: string) => {
  let out = clean(`[bot ${new Date().toISOString()}] ${line}`);
  for (const a of accounts) out = out.split(a).join('<account>');
  console.error(out);
};
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

mkdirSync(cfg.dataDir, { recursive: true });
const dbPath = join(cfg.dataDir, 'bot.sqlite');
const REVISION_FLAG = join(cfg.dataDir, 'revision-changed');
const db = openDb(dbPath);
// The box user must not read the database. SQLite gives -wal and -shm the mode of the main file.
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { chmodSync(p, 0o600); } catch { /* not created yet */ } }
const recovered = db.recoverAfterRestart();
if (recovered > 0) log(`${recovered} instruction(s) that ran at the last stop wait in the queue again`);

let cgroup: JobCgroup | null = null;
const cg = prepareJobCgroup();
if (!cg.ok) {
  log(`job limits are off: ${cg.reason}`);
} else {
  cgroup = cg.value;
  const lim = cfg.jobLimits;
  const base = cgroup.setLimits({ memoryBytes: lim.memoryBytes, pids: lim.pids });
  if (!base.ok) log(`job limits not set: ${base.reason}`);
  const cpu = cgroup.setLimits({ cpu: { quotaUs: lim.cpuPercent * 1_000, periodUs: 100_000 } });
  if (!cpu.ok) log(`job CPU limit not set: ${cpu.reason}`);
  log(`job cgroup ${cgroup.path}: memory ${lim.memoryBytes / 1_048_576} MB, ${lim.pids} processes, ${cpu.ok ? `${lim.cpuPercent}% CPU` : 'no CPU limit'} for all jobs together`);
}

let link: GameLink | null = null;
const guilds: Guild[] = [];
let shuttingDown = false;
let ticker: ReturnType<typeof setInterval> | null = null;

const makeClient = (content: boolean) => new Client(discordClientOptions(content));
let discord = makeClient(cfg.readAll);

async function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  // A stop that hangs (Discord, gamelink, a job) must not keep the process alive.
  // The cap still kills the job processes first, so no job acts while the request runs again.
  setTimeout(() => { try { cgroup?.killAll(); } catch { /* no cgroup */ } process.exit(code); }, SHUTDOWN_CAP_MS).unref();
  log('shutting down');
  if (ticker) clearInterval(ticker);
  await Promise.all(guilds.map(g => g.stop().catch(err => log(`[${g.name}] stop failed: ${errText(err)}`))));
  // A backstop for job processes that outlived the stop of their guild.
  if (cgroup) { const k = cgroup.killAll(); if (!k.ok) log(`job cgroup not emptied: ${k.reason}`); }
  await discord.destroy().catch(() => {});
  await link?.close().catch(() => {});
  try { db.close(); } catch { /* already closed */ }
  process.exit(code);
}
process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });
process.on('uncaughtException', err => { log(`uncaught exception: ${errText(err)}`); void shutdown(1); });
process.on('unhandledRejection', err => { log(`unhandled rejection: ${errText(err)}`); void shutdown(1); });

try {
  log(`${cfg.guilds.length} guild(s), model ${cfg.model}, effort ${cfg.effort}, jobs up to ${cfg.maxJobMin} min${cfg.notesReviewHourUtc !== null ? `, notes review ${cfg.notesReviewHourUtc}:00 UTC` : ''}${cfg.escalationModel ? `, escalation ${cfg.escalationModel}` : ''}`);
  if (cfg.gamelink) {
    if (process.env.RS_PASSWORD) log('WARNING: split mode, but RS_PASSWORD is in the environment of the bot. Do not load secrets/account.env in the bot.');
    log(`game parts in the gamelink process at ${cfg.gamelink.socketPath}`);
    // Gamelink can still be starting (a restart, a reboot). Wait up to 2 min for its socket,
    // so that systemd's start limit does not stop the bot. A refused token or a wrong account
    // stops at once.
    const gl = cfg.gamelink;
    link = await retryUntil(() => connectGameLink({
      socketPath: gl.socketPath, token: gamelinkToken, log,
      guilds: cfg.guilds.map(g => ({ name: g.name, account: g.game.account.name })),
    }), {
      deadlineMs: 120_000, delayMs: 3_000,
      shouldRetry: err => !(err instanceof GameLinkError) || /HTTP 5\d\d/.test(err.message),
      onRetry: (err, n) => { if (n === 1 || n % 10 === 0) log(`gamelink is not ready yet (${gamelinkWaitReason(err, gl.socketPath)}); waiting`); },
    });
  } else {
    link = await openLocalGameLink({ guilds: cfg.guilds, idleGuard: cfg.idleGuard, cards: cfg.cards, log, onBrowserGone: () => { void shutdown(1); } });
  }
  const knowledge = createKnowledgePack(ROOT);
  // Until the page bodies are read, the wiki search uses the titles only.
  void knowledge.bodyReady?.then(n => log(`wiki body index ready: ${n} item and shop pages`));
  const shared = {
    cfg, root: ROOT, link, anthropic: new Anthropic(), db, cgroup,
    knowledge,
    apiReference: readFileSync(join(ROOT, 'vendor', 'rs-sdk', 'sdk', 'API.md'), 'utf8'),
    secrets, clean, log,
    wakes: createWakeScheduler({ watchdogMs: cfg.watchdogMs, notesReviewHourUtc: cfg.notesReviewHourUtc }),
    withLock: createKeyedLock(),
  };
  for (const g of cfg.guilds) {
    guilds.push(await startGuild(shared, g));
  }
  if (!cfg.boxUser && cfg.guilds.some(g => !g.boxUser)) {
    log('WARNING: BOT_ALLOW_UNSANDBOXED=1. Jobs run as the bot user and can read its secret files. Use this for local development only.');
  }
} catch (err) {
  log(`start failed: ${errText(err)}`);
  await shutdown(1);
}

const byChannel = new Map(guilds.map(g => [g.channelId, g]));
let lastPrune = 0;
let lastRevision: string | null = null;
ticker = setInterval(() => {
  for (const g of guilds) {
    try { g.tick(); } catch (err) { log(`[${g.name}] tick failed: ${errText(err)}`); }
  }
  // scripts/server-revision-check.sh writes this file when the game client changed. Gamelink restarts
  // on its own (rs-revision-check.service); the bot logs the change once and draws the cards again.
  const revision = takeRevisionFlag(REVISION_FLAG, { read: p => readFileSync(p, 'utf8'), remove: p => rmSync(p, { force: true }) });
  // A flag that cannot be removed gives the same line at each tick: act on it once.
  if (revision !== null && revision !== lastRevision) {
    lastRevision = revision;
    log(`game revision changed: ${revision}`);
    for (const g of guilds) g.refreshCard();
  }
  if (Date.now() - lastPrune > 3_600_000) {
    lastPrune = Date.now();
    const n = db.pruneSnapshots(Date.now() - SNAPSHOT_KEEP_MS);
    if (n > 0) log(`pruned ${n} old snapshot(s)`);
    const e = db.pruneEvents(Date.now() - EVENT_KEEP_MS);
    if (e > 0) log(`pruned ${e} old event(s)`);
  }
}, TICK_MS);

const HISTORY_LINES = 8;
let readAll = cfg.readAll;

function attachHandlers(client: Client) {
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot || !client.user) return;
    const g = byChannel.get(message.channelId);
    if (!g) return;
    const botRoleId = message.guild?.members.me?.roles.botRole?.id ?? null;
    const mentioned = mentionsBot(message.mentions.users.keys(), message.mentions.roles.keys(), client.user.id, botRoleId);
    const direct = mentioned || message.mentions.repliedUser?.id === client.user.id;
    if (!readAll && !direct) return;
    // Without the Message Content intent, Discord sends the text only when the message mentions
    // the bot user. A mention of the bot role then arrives with no text at all.
    if (message.content === '' && message.attachments.size === 0) {
      if (direct) {
        await message.reply({
          content: `I cannot read that message. Mention me as a user: type @${client.user.username} and pick the entry with my picture, not the role.`,
          allowedMentions: { parse: [], repliedUser: false },
        }).catch(() => {});
      }
      return;
    }
    const botId = client.user.id;
    const loadHistory = async () => {
      const before = await message.channel.messages.fetch({ limit: HISTORY_LINES, before: message.id }).catch(() => null);
      return before
        ? [...before.values()].reverse().map(m => ({ author: m.member?.displayName ?? m.author.username, isBot: m.author.id === botId, text: m.content }))
        : [];
    };
    await g.onMessage(message, stripMentions(message.content), direct, loadHistory, client.user.username)
      .catch(err => log(`[${g.name}] message failed: ${errText(err)}`));
  });

  // A thumbs-up on a waiting request moves it up the queue (src/discord/queue-votes.ts).
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    const g = byChannel.get(reaction.message.channelId);
    if (!g) return;
    const input = await reactionInput(reaction, user);
    if (input) await g.onReaction(input).catch(err => log(`[${g.name}] reaction failed: ${errText(err)}`));
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isButton()) return;
    const g = interaction.channelId ? byChannel.get(interaction.channelId) : undefined;
    if (g) await g.onButton(interaction).catch(err => log(`[${g.name}] button failed: ${errText(err)}`));
  });

  client.once(Events.ClientReady, c => {
    log(`Discord ready as ${c.user.tag}${readAll ? ', reading every message of the channel' : ', answering mentions only'}`);
    for (const g of guilds) {
      void g.attach(client, why => { log(`[${g.name}] ${why}: exit so that systemd restarts the bot`); void shutdown(1); })
        .catch(err => log(`[${g.name}] attach failed: ${errText(err)}`));
    }
  });
  client.on(Events.Error, err => log(`Discord error: ${errText(err)}`));
}

attachHandlers(discord);
try {
  await discord.login(cfg.discordToken);
} catch (err) {
  // Close code 4014: the portal has the Message Content intent off. Go on with mentions only.
  if (readAll && /disallowed intents/i.test(errText(err))) {
    log('Discord refused the Message Content intent. Turn it on in the developer portal (Bot > Message Content Intent) so that I read every message. Until then I answer mentions only.');
    readAll = false;
    await discord.destroy().catch(() => {});
    discord = makeClient(false);
    attachHandlers(discord);
    await discord.login(cfg.discordToken).catch(async e => { log(`Discord login failed: ${errText(e)}`); await shutdown(1); });
  } else {
    log(`Discord login failed: ${errText(err)}`);
    await shutdown(1);
  }
}

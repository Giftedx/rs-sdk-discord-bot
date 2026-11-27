// The Discord bot in one process. It serves one guild, or several from GUILDS_FILE. Each guild
// has its own game tab, proxy, job runner, store and queue (src/bot/guild.ts). The guilds share
// one browser, one Anthropic client, one SQLite database, one card tab and the spend cap.
// Start: bun src/bot/main.ts (docs/running-the-bot.md).
import Anthropic from '@anthropic-ai/sdk';
import { Client, Events, GatewayIntentBits, type Interaction, type Message } from 'discord.js';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { knowledgeFiles, loadKnowledge } from '../agent/store';
import { prepareJobCgroup, type JobCgroup } from '../box/cgroup';
import { launchBrowserWithProfile, sweepStaleProfiles, type ProfiledBrowser } from '../gamelink/browser-profile';
import { openCardTab, type CardTab } from '../gamelink/card-tab';
import { openDb } from '../orchestrator/db';
import { createWakeScheduler } from '../orchestrator/wakes';
import { sanitizeForDiscord } from '../shared/sanitize';
import { loadBotConfig } from './config';
import { startGuild, type Guild } from './guild';
import { createKeyedLock, mentionsBot, stripMentions } from './helpers';

const ROOT = resolve(dirname(import.meta.path), '..', '..');
const TICK_MS = 5_000;
const SNAPSHOT_KEEP_MS = 7 * 24 * 3_600_000;

const cfg = (() => {
  try {
    return loadBotConfig(process.env, ROOT);
  } catch (err) {
    console.error(`configuration error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
})();
const secrets = [
  ...cfg.guilds.map(g => g.game.account.password), cfg.discordToken,
  process.env.ANTHROPIC_API_KEY ?? '', process.env.ANTHROPIC_AUTH_TOKEN ?? '',
].filter(s => s.length >= 4);
const accounts = cfg.guilds.map(g => g.game.account.name);
const clean = (text: string) => sanitizeForDiscord(text, secrets);
const log = (line: string) => {
  let out = clean(`[bot ${new Date().toISOString()}] ${line}`);
  for (const a of accounts) out = out.split(a).join('<account>');
  console.error(out);
};
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

mkdirSync(cfg.dataDir, { recursive: true });
const dbPath = join(cfg.dataDir, 'bot.sqlite');
const db = openDb(dbPath);
// The box user must not read the database. SQLite gives -wal and -shm the mode of the main file.
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { chmodSync(p, 0o600); } catch { /* not created yet */ } }
const swept = sweepStaleProfiles();
if (swept > 0) log(`removed ${swept} browser profile(s) left by an earlier run`);
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

let pb: ProfiledBrowser | null = null;
let cards: CardTab | null = null;
const guilds: Guild[] = [];
let shuttingDown = false;
let ticker: ReturnType<typeof setInterval> | null = null;

const discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

async function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down');
  if (ticker) clearInterval(ticker);
  await Promise.all(guilds.map(g => g.stop().catch(err => log(`[${g.name}] stop failed: ${errText(err)}`))));
  await discord.destroy().catch(() => {});
  await cards?.close().catch(() => {});
  await pb?.close().catch(() => {});
  try { db.close(); } catch { /* already closed */ }
  process.exit(code);
}
process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });
process.on('uncaughtException', err => { log(`uncaught exception: ${errText(err)}`); void shutdown(1); });
process.on('unhandledRejection', err => { log(`unhandled rejection: ${errText(err)}`); void shutdown(1); });

try {
  log(`${cfg.guilds.length} guild(s), model ${cfg.model}, effort ${cfg.effort}${cfg.escalationModel ? `, escalation ${cfg.escalationModel}` : ''}`);
  pb = await launchBrowserWithProfile(cfg.game.chromePath ? { executablePath: cfg.game.chromePath } : {});
  log(pb.profile.onTmpfs ? 'browser profile on tmpfs' : 'WARNING: /dev/shm is missing; the browser profile is on disk');
  if (cfg.cards) {
    cards = await openCardTab(pb.browser, { iconHost: new URL(cfg.game.botPageUrl).origin })
      .catch(err => { log(`card tab not open, posts go without cards: ${errText(err)}`); return null; });
  }
  const shared = {
    cfg, root: ROOT, browser: pb.browser, anthropic: new Anthropic(), db, cards, cgroup, discord,
    knowledge: loadKnowledge(knowledgeFiles(ROOT)),
    apiReference: readFileSync(join(ROOT, 'vendor', 'rs-sdk', 'sdk', 'API.md'), 'utf8'),
    secrets, clean, log,
    wakes: createWakeScheduler({ watchdogMs: cfg.watchdogMs }),
    withLock: createKeyedLock(),
  };
  for (const g of cfg.guilds) {
    log(`[${g.name}] game server ${g.game.serverHost}, proxy port ${g.game.proxyPort}`);
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
ticker = setInterval(() => {
  for (const g of guilds) {
    try { g.tick(); } catch (err) { log(`[${g.name}] tick failed: ${errText(err)}`); }
  }
  if (Date.now() - lastPrune > 3_600_000) {
    lastPrune = Date.now();
    const n = db.pruneSnapshots(Date.now() - SNAPSHOT_KEEP_MS);
    if (n > 0) log(`pruned ${n} old snapshot(s)`);
  }
}, TICK_MS);

discord.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot || !discord.user) return;
  const g = byChannel.get(message.channelId);
  if (!g) return;
  const botRoleId = message.guild?.members.me?.roles.botRole?.id ?? null;
  if (!mentionsBot(message.mentions.users.keys(), message.mentions.roles.keys(), discord.user.id, botRoleId)) return;
  // Without the Message Content intent, Discord sends the text only when the message mentions
  // the bot user. A mention of the bot role then arrives with no text at all.
  if (message.content === '' && message.attachments.size === 0) {
    await message.reply({
      content: `I cannot read that message. Mention me as a user: type @${discord.user.username} and pick the entry with my picture, not the role.`,
      allowedMentions: { parse: [], repliedUser: false },
    }).catch(() => {});
    return;
  }
  await g.onMessage(message, stripMentions(message.content));
});

discord.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isButton()) return;
  const g = interaction.channelId ? byChannel.get(interaction.channelId) : undefined;
  if (g) await g.onButton(interaction);
});

discord.once(Events.ClientReady, c => {
  log(`Discord ready as ${c.user.tag}`);
  for (const g of guilds) void g.attach(discord).catch(err => log(`[${g.name}] attach failed: ${errText(err)}`));
});
discord.on(Events.Error, err => log(`Discord error: ${errText(err)}`));
await discord.login(cfg.discordToken).catch(async err => { log(`Discord login failed: ${errText(err)}`); await shutdown(1); });

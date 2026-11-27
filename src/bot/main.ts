// The Discord bot in one process: game tab, supervisor, proxy, job runner, agent loop and
// Discord front end. Start: bun src/bot/main.ts (docs/running-the-bot.md).
import Anthropic from '@anthropic-ai/sdk';
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits,
  type GuildMember, type Interaction, type Message,
} from 'discord.js';
import { mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { Browser } from 'puppeteer';
import { createJobRunner } from '../box/job-runner';
import { runInstruction, type AgentDeps } from '../agent/loop';
import { createSpendTracker } from '../agent/spend';
import { createStore, knowledgeFiles, loadKnowledge } from '../agent/store';
import { launchBrowser, openGameTab, type GameTab } from '../gamelink/game-tab';
import { createActionPolicy } from '../gamelink/policy';
import { startProxy, type ProxyHandle } from '../gamelink/proxy';
import { createSupervisor, type Supervisor } from '../gamelink/supervisor';
import { sanitizeForDiscord } from '../shared/sanitize';
import { formatWorldState } from '../../vendor/rs-sdk/sdk/formatter';
import type { BotWorldState } from '../../vendor/rs-sdk/sdk/types';
import { loadBotConfig } from './config';
import { createQueue, type Instruction } from './queue';

const ROOT = resolve(dirname(import.meta.path), '..', '..');
const cfg = (() => {
  try {
    return loadBotConfig(process.env, ROOT);
  } catch (err) {
    console.error(`configuration error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
})();
const secrets = [cfg.game.account.password, cfg.discordToken, process.env.ANTHROPIC_API_KEY ?? '', process.env.ANTHROPIC_AUTH_TOKEN ?? ''].filter(s => s.length >= 4);
const clean = (text: string) => sanitizeForDiscord(text, secrets);
const log = (line: string) => console.error(clean(`[bot ${new Date().toISOString()}] ${line}`).split(cfg.game.account.name).join('<account>'));
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

mkdirSync(cfg.dataDir, { recursive: true });
const bootToken = randomBytes(24).toString('base64url');

let browser: Browser | null = null;
let tab: GameTab | null = null;
let supervisor: Supervisor | null = null;
let proxy: ProxyHandle | null = null;
let lastState: BotWorldState | null = null;
let lastStateAt = 0;
let current: { item: Instruction; abort: AbortController } | null = null;
let shuttingDown = false;

const discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

async function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down');
  current?.abort.abort();
  supervisor?.stop();
  await discord.destroy().catch(() => {});
  if (tab) {
    const out = await tab.logout().catch(() => false);
    log(out ? 'logged out of the game' : 'logout did not finish');
  }
  await proxy?.stop().catch(() => {});
  await tab?.close().catch(() => {});
  await browser?.close().catch(() => {});
  process.exit(code);
}
process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });

try {
  log(`game server ${cfg.game.serverHost}, model ${cfg.model}, effort ${cfg.effort}`);
  browser = await launchBrowser(cfg.game.chromePath ? { executablePath: cfg.game.chromePath } : {});
  tab = await openGameTab({ browser, botPageUrl: cfg.game.botPageUrl, account: cfg.game.account.name, password: cfg.game.account.password, fps: cfg.game.fps });
  supervisor = createSupervisor({ tab, idleGuard: cfg.idleGuard, log });
  supervisor.start();
  proxy = await startProxy({
    upstreamUrl: cfg.game.gatewayUrl,
    account: cfg.game.account.name,
    password: cfg.game.account.password,
    bootToken,
    listenPort: cfg.game.proxyPort,
    policy: createActionPolicy(),
    onState: (state, at) => { lastState = state as BotWorldState; lastStateAt = at; },
  });
} catch (err) {
  log(`start failed: ${errText(err)}`);
  await shutdown(1);
}

if (!cfg.boxUser) log('WARNING: BOX_USER is not set. Jobs run as the bot user and can read its secret files. See docs/running-the-bot.md.');
const runner = createJobRunner({
  rootDir: ROOT, scratchDir: join(cfg.dataDir, 'jobs'), account: cfg.game.account.name, bootToken, secrets, proxy: proxy!,
  boxUser: cfg.boxUser, ...(cfg.boxUser ? { bunPath: cfg.boxBunPath } : {}),
});
const store = createStore(cfg.dataDir);
const knowledge = loadKnowledge(knowledgeFiles(ROOT));
const apiReference = readFileSync(join(ROOT, 'vendor', 'rs-sdk', 'sdk', 'API.md'), 'utf8');
const spend = createSpendTracker(join(cfg.dataDir, 'spend.json'), cfg.monthlyCapUsd);
const anthropic = new Anthropic();
const queue = createQueue({ max: cfg.queueMax, userCooldownMs: cfg.userCooldownMs });

function gameState(): string {
  const head = `Game tab: ${supervisor?.status() ?? 'unknown'}. Gateway connection: ${proxy?.upstreamConnected() ? 'up' : 'down'}.`;
  if (!lastState) return `${head}\nNo game state yet.`;
  const text = formatWorldState(lastState, Date.now() - lastStateAt, { brief: true });
  return `${head}\n${text.length > 8_000 ? `${text.slice(0, 8_000)}\n[... cut ...]` : text}`;
}

async function frame(): Promise<Uint8Array | null> {
  if (!tab || supervisor?.status() !== 'in_game') return null;
  return tab.frame('view').catch(() => null);
}

const deps = (onProgress: (line: string) => void): AgentDeps => ({
  model: cfg.model,
  effort: cfg.effort,
  // Server-side fallback: if the model declines, the API runs the request on a fallback model.
  callModel: (params, signal) => anthropic.beta.messages.create(
    { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as typeof params,
    { signal },
  ),
  runJob: (code, timeoutMs, signal) => runner.run(code, timeoutMs, signal),
  store, knowledge, apiReference, gameState, frame, spend,
  maxTurns: cfg.maxTurns,
  maxInstructionUsd: cfg.maxInstructionUsd,
  onProgress,
});

function allowed(member: GuildMember | null): boolean {
  if (!cfg.allowedRoleId) return true;
  return member?.roles.cache.has(cfg.allowedRoleId) ?? false;
}

const stopRow = () => new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId('stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
);

async function runNext(): Promise<void> {
  if (shuttingDown || current) return;
  const item = queue.next();
  if (!item) return;
  const abort = new AbortController();
  current = { item, abort };
  const channel = await discord.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel || !channel.isSendable()) { log('the channel is not reachable'); queue.done(); current = null; return; }

  const lines: string[] = [];
  const header = `**Working on** (from ${item.userName}): ${item.text}`;
  const body = () => clean(`${header}\n${lines.slice(-8).map(l => `- ${l}`).join('\n')}`);
  const msg = await channel.send({ content: body(), components: [stopRow()], allowedMentions: { parse: [] } });
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleEdit = () => {
    if (editTimer) return;
    editTimer = setTimeout(() => { editTimer = null; void msg.edit({ content: body(), allowedMentions: { parse: [] } }).catch(() => {}); }, 3_000);
  };

  log(`instruction ${item.id} started`);
  const result = await runInstruction(deps(line => { lines.push(line); scheduleEdit(); }), item.text, item.userName, abort.signal)
    .catch(err => ({ summary: `Error: ${errText(err)}`, turns: 0, usd: 0, stopReason: 'error' as const, lastFrame: null }));
  if (editTimer) clearTimeout(editTimer);
  log(`instruction ${item.id} ended: ${result.stopReason}, ${result.turns} turns, $${result.usd.toFixed(3)}`);

  const png = (await frame()) ?? result.lastFrame;
  const files = png ? [new AttachmentBuilder(Buffer.from(png), { name: 'frame.png' })] : [];
  const footer = `${result.turns} turns, $${result.usd.toFixed(2)} (month: $${spend.spentUsd().toFixed(2)} of $${spend.capUsd.toFixed(2)})`;
  await msg.edit({
    content: clean(`**Done** (from ${item.userName}): ${item.text}\n${result.summary}\n-# ${footer}`),
    components: [], files, allowedMentions: { parse: [] },
  }).catch(err => log(`edit failed: ${errText(err)}`));

  queue.done();
  current = null;
  void runNext();
}

const HELP = [
  'Mention me with an instruction, for example: `@bot chop trees until level 10 woodcutting`.',
  'One instruction runs at a time. Others wait in a queue.',
  '`@bot status` shows the game state, the queue and the spend.',
  '`@bot stop` or the **Stop** button ends the current instruction.',
].join('\n');

discord.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot || message.channelId !== cfg.channelId || !discord.user) return;
  if (!message.mentions.users.has(discord.user.id)) return;
  const text = message.content.replace(/<@!?\d+>/g, '').trim();
  const reply = (content: string) => message.reply({ content: clean(content), allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
  if (!allowed(message.member)) { await reply('You do not have the role that can give instructions.'); return; }

  const cmd = text.toLowerCase();
  if (cmd === '' || cmd === 'help') { await reply(HELP); return; }
  if (cmd === 'stop') {
    if (!current) { await reply('Nothing runs now.'); return; }
    current.abort.abort();
    await reply('Stopping the current instruction.');
    return;
  }
  if (cmd === 'status') {
    const waiting = queue.waiting();
    const state = gameState();
    await reply([
      `**Now:** ${current ? current.item.text : 'nothing'}`,
      `**Queue:** ${waiting.length ? waiting.map((w, i) => `${i + 1}. ${w.text}`).join(' | ') : 'empty'}`,
      `**Spend this month:** $${spend.spentUsd().toFixed(2)} of $${spend.capUsd.toFixed(2)}`,
      '```', state.slice(0, 1_200), '```',
    ].join('\n'));
    return;
  }
  if (spend.overCap()) { await reply('The monthly spend cap is reached. I take no new instructions this month.'); return; }
  const added = queue.add(message.author.id, message.member?.displayName ?? message.author.username, text);
  if (!added.ok) {
    const why = { full: 'The queue is full. Try again later.', cooldown: 'Wait a little before your next instruction.', empty: 'Give me an instruction.', too_long: 'That instruction is too long.' }[added.reason];
    await reply(why);
    return;
  }
  await message.react(added.position <= 1 ? '✅' : '⏳').catch(() => {});
  void runNext();
});

discord.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isButton() || interaction.customId !== 'stop') return;
  if (!allowed(interaction.member as GuildMember | null)) {
    await interaction.reply({ content: 'You do not have the role that can stop instructions.', ephemeral: true }).catch(() => {});
    return;
  }
  if (!current) { await interaction.reply({ content: 'Nothing runs now.', ephemeral: true }).catch(() => {}); return; }
  current.abort.abort();
  await interaction.reply({ content: `Stopped by ${clean(interaction.user.username)}.`, allowedMentions: { parse: [] } }).catch(() => {});
});

discord.once(Events.ClientReady, c => log(`Discord ready as ${c.user.tag}`));
discord.on(Events.Error, err => log(`Discord error: ${errText(err)}`));
await discord.login(cfg.discordToken).catch(async err => { log(`Discord login failed: ${errText(err)}`); await shutdown(1); });

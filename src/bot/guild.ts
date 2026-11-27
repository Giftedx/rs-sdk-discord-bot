// One guild of the bot: its game tab, supervisor, proxy, job runner, store, frame store, queue,
// wakes and Discord output. main.ts makes one per guild and shares the browser, the Anthropic
// client, the database, the card tab and the job cgroup between them.
import type Anthropic from '@anthropic-ai/sdk';
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType,
  type ButtonInteraction, type Client, type GuildMember, type Message, type TextChannel,
} from 'discord.js';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Browser } from 'puppeteer';
import { runInstruction, type AgentDeps, type AgentJobResult, type InstructionResult, type WakeKind } from '../agent/loop';
import { createStore, type KnowledgeChunk } from '../agent/store';
import type { JobCgroup } from '../box/cgroup';
import { createJobRunner } from '../box/job-runner';
import { seedStore } from '../box/seed';
import { cardChannel, logThreadHost, postChannel } from '../discord/adapters';
import { AdventureLog } from '../discord/adventure-log';
import { MainPosts, type CardSubject } from '../discord/posts';
import { StatusCard, STATUS_ID, STOP_ID } from '../discord/status-card';
import { realTimers } from '../discord/types';
import { compactState as eventState, diffStates, eventText, type CompactState as EventState, type GameEvent } from '../events/diff';
import type { CardTab } from '../gamelink/card-tab';
import { createFrameStore } from '../gamelink/frame-store';
import { openGameTab, type GameTab } from '../gamelink/game-tab';
import { createActionPolicy } from '../gamelink/policy';
import { startProxy, type ProxyHandle } from '../gamelink/proxy';
import { createSupervisor, type Supervisor } from '../gamelink/supervisor';
import { createBudget } from '../orchestrator/budget';
import type { InstructionRow, OrchestratorDb } from '../orchestrator/db';
import { compactState as wakeState, type WakeScheduler } from '../orchestrator/wakes';
import { formatWorldState } from '../../vendor/rs-sdk/sdk/formatter';
import type { BotWorldState } from '../../vendor/rs-sdk/sdk/types';
import type { BotConfig, GuildConfig } from './config';
import { ADMIT_TEXT, cardFor, cardView, createAdmission, jobSignal, receiptEvent, type Receipt, type createKeyedLock } from './helpers';

export interface Shared {
  cfg: BotConfig;
  root: string;
  browser: Browser;
  anthropic: Anthropic;
  db: OrchestratorDb;
  cards: CardTab | null;
  cgroup: JobCgroup | null;
  discord: Client;
  knowledge: KnowledgeChunk[];
  apiReference: string;
  secrets: string[];
  clean(text: string): string;
  log(line: string): void;
  wakes: WakeScheduler;
  withLock: ReturnType<typeof createKeyedLock>;
}

const STATE_FRESH_MS = 30_000;
const SNAPSHOT_MS = 30_000;
const FRAME_FRESH_MS = 15_000;
const WAKES: readonly WakeKind[] = ['instruction', 'timer', 'trigger'];
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const HELP = [
  'Mention me with an instruction, for example: `@bot chop trees until level 10 woodcutting`.',
  'One instruction runs at a time. Others wait in a queue, which survives a restart.',
  '`@bot status` shows the game state, the queue, the timers and the spend.',
  '`@bot stop` or the **Stop** button ends the current instruction.',
  'The pinned status card shows the goal, the HP and a recent frame. Game events go to the adventure log thread.',
].join('\n');

const stopRow = () => new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId(STOP_ID).setLabel('Stop').setStyle(ButtonStyle.Danger),
);

export type Guild = Awaited<ReturnType<typeof startGuild>>;

export async function startGuild(sh: Shared, g: GuildConfig) {
  const { cfg, db } = sh;
  const log = (line: string) => sh.log(`[${g.name}] ${line}`);
  const clean = sh.clean;
  mkdirSync(g.dataDir, { recursive: true });
  const bootToken = randomBytes(24).toString('base64url');

  let tab: GameTab | null = null;
  let supervisor: Supervisor | null = null;
  let proxy: ProxyHandle | null = null;
  let lastState: BotWorldState | null = null;
  let lastStateAt = 0;

  const stopGame = async () => {
    supervisor?.stop();
    if (tab) {
      const out = await tab.logout().catch(() => false);
      log(out ? 'logged out of the game' : 'logout did not finish');
    }
    await proxy?.stop().catch(() => {});
    await tab?.close().catch(() => {});
  };

  try {
    tab = await openGameTab({ browser: sh.browser, botPageUrl: g.game.botPageUrl, account: g.game.account.name, password: g.game.account.password, fps: g.game.fps });
    supervisor = createSupervisor({ tab, idleGuard: cfg.idleGuard, log });
    supervisor.start();
    proxy = await startProxy({
      upstreamUrl: g.game.gatewayUrl,
      account: g.game.account.name,
      password: g.game.account.password,
      bootToken,
      listenPort: g.game.proxyPort,
      policy: createActionPolicy(),
      onState: (state, at) => { lastState = state as BotWorldState; lastStateAt = at; },
    });
  } catch (err) {
    await stopGame();
    throw err;
  }
  const gameTab = tab;
  const sup = supervisor;
  const prx = proxy;

  const runner = createJobRunner({
    rootDir: sh.root, scratchDir: join(g.dataDir, 'jobs'), account: g.game.account.name, bootToken, secrets: sh.secrets, proxy: prx,
    boxUser: g.boxUser, ...(g.boxUser ? { bunPath: cfg.boxBunPath } : {}),
    ...(sh.cgroup ? {
      onSpawn: (pid: number) => {
        const r = sh.cgroup!.addProcess(pid);
        if (!r.ok) log(`job not moved into the job cgroup: ${r.reason}`);
      },
    } : {}),
  });
  const store = createStore(g.dataDir);
  const added = seedStore(store, join(sh.root, 'seed'));
  log(added.length > 0 ? `seed scripts added: ${added.join(', ')}` : 'seed scripts: none new');
  const frames = createFrameStore({ source: gameTab, log });

  let current: { row: InstructionRow; abort: AbortController; job: ReturnType<typeof jobSignal> | null } | null = null;
  const budget = createBudget(db, cfg.monthlyCapUsd, {
    resetDay: cfg.spendResetDay,
    context: () => ({ guild: g.name, instructionId: current?.row.id ?? null }),
  });
  const admit = createAdmission({ max: cfg.queueMax, userCooldownMs: cfg.userCooldownMs });

  let channel: TextChannel | null = null;
  let card: StatusCard | null = null;
  let advLog: AdventureLog | null = null;
  let posts: MainPosts | null = null;
  let goal: string | null = null;
  let step: string | null = null;
  let prevEvents: EventState | null = null;
  let lastReceipt: Receipt | null = null;
  let lastSnapshotAt = 0;
  let stopping = false;

  const freshState = (): BotWorldState | null => (lastState && Date.now() - lastStateAt < STATE_FRESH_MS ? lastState : null);

  function gameState(): string {
    const head = `Game tab: ${sup.status()}. Gateway connection: ${prx.upstreamConnected() ? 'up' : 'down'}.`;
    if (!lastState) return `${head}\nNo game state yet.`;
    const text = formatWorldState(lastState, Date.now() - lastStateAt, { brief: true });
    return `${head}\n${text.length > 8_000 ? `${text.slice(0, 8_000)}\n[... cut ...]` : text}`;
  }

  // The look tool: the newest stored frame, or a new capture when the store has none that is fresh.
  async function frame(): Promise<Uint8Array | null> {
    const f = frames.latest();
    if (f && Date.now() - f.at < FRAME_FRESH_MS) return f.png;
    if (sup.status() !== 'in_game') return f?.png ?? null;
    return gameTab.frame('view').catch(() => f?.png ?? null);
  }

  async function draw(subject: CardSubject): Promise<Uint8Array | null> {
    if (!sh.cards) return null;
    const req = cardFor(subject, prevEvents, lastReceipt, new Date());
    if (!req) return null;
    return sh.cards.draw(req.kind, req.data as never);
  }

  function view() {
    const p = freshState()?.player;
    const b = budget.status();
    return cardView({
      goal,
      running: current?.row.text ?? null,
      step,
      hp: p ? { hp: p.hp, maxHp: p.maxHp } : null,
      queueLength: db.countWaiting(g.name),
      spend: { usedUsd: b.periodSpentUsd, capUsd: b.monthlyCapUsd },
      budgetNote: b.reason,
      tabStatus: sup.status(),
      frame: frames.latest()?.png ?? null,
    });
  }

  const guildSpendSince = (since: number) =>
    (db.raw.query('SELECT COALESCE(SUM(usd), 0) AS s FROM spend WHERE guild = ? AND time >= ?').get(g.name, since) as { s: number }).s;

  function emit(e: GameEvent, ownMessage = false): void {
    db.addEvent(g.name, e.kind, eventText(e));
    advLog?.add(eventText(e));
    if (ownMessage) posts?.record(e);
    else void posts?.onEvent(e);
  }

  const deps = (onProgress: (line: string) => void): AgentDeps => ({
    model: cfg.model,
    effort: cfg.effort,
    // Server-side fallback: if the model declines, the API runs the request on a fallback model.
    callModel: (params, signal) => sh.anthropic.beta.messages.create(
      { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as typeof params,
      { signal },
    ),
    // Guilds that share a box user run one job at a time: the runner kills every process of
    // the box user after a job.
    // Stop, the watchdog and triggers see the job (current.job) while it waits for the lock too.
    runJob: async (code, timeoutMs, signal) => {
      const js = jobSignal(signal);
      if (current) current.job = js;
      try {
        return await sh.withLock(g.boxUser ? `box:${g.boxUser}` : `guild:${g.name}`, async (): Promise<AgentJobResult> => {
          if (js.signal.aborted) {
            const why = js.reason();
            return { exitCode: -1, output: 'The job was stopped before it started.', timedOut: false, aborted: true, durationMs: 0, ...(why ? { stopReason: why } : {}) };
          }
          const r = await runner.run(code, timeoutMs, js.signal);
          const why = js.reason();
          return why ? { ...r, stopReason: why } : r;
        }, js.signal);
      } finally {
        if (current) current.job = null;
      }
    },
    store, knowledge: sh.knowledge, apiReference: sh.apiReference, gameState, frame, spend: budget,
    maxTurns: cfg.maxTurns,
    maxInstructionUsd: cfg.maxInstructionUsd,
    onProgress,
    setTimer: (minutes, note) => { db.addTimer(g.name, Date.now() + minutes * 60_000, note); log(`timer set for ${minutes} min`); },
    post: text => { advLog?.add(text); },
    setGoal: text => { goal = text; void card?.update(); },
    ...(cfg.escalationModel ? { escalationModel: cfg.escalationModel } : {}),
  });

  function allowed(member: GuildMember | null): boolean {
    if (!g.allowedRoleId) return true;
    return member?.roles.cache.has(g.allowedRoleId) ?? false;
  }

  async function runNext(): Promise<void> {
    if (stopping || current || !channel || budget.overCap()) return;
    const row = db.nextWaiting(g.name);
    if (!row || !db.startInstruction(row.id)) return;
    const abort = new AbortController();
    current = { row, abort, job: null };
    const wake = (WAKES as readonly string[]).includes(row.wake) ? row.wake as WakeKind : 'instruction';
    step = null;
    const ch = channel;

    const lines: string[] = [];
    const from = wake === 'instruction' ? `from ${row.user}` : `${wake} wake`;
    const header = `**Working on** (${from}): ${row.text}`;
    const body = () => clean(`${header}\n${lines.slice(-8).map(l => `- ${l}`).join('\n')}`);
    const msg = await ch.send({ content: body(), components: [stopRow()], allowedMentions: { parse: [] } }).catch(err => { log(`send failed: ${errText(err)}`); return null; });
    let editTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleEdit = () => {
      if (editTimer || !msg) return;
      editTimer = setTimeout(() => { editTimer = null; void msg.edit({ content: body(), allowedMentions: { parse: [] } }).catch(() => {}); }, 3_000);
    };

    log(`instruction ${row.id} started (${wake})`);
    if (sup.status() === 'in_game') frames.start();
    void card?.instructionStarted();
    const result: InstructionResult = await runInstruction(deps(line => { lines.push(line); step = line; scheduleEdit(); }), row.text, row.user, abort.signal, wake)
      .catch(err => ({ summary: `Error: ${errText(err)}`, turns: 0, usd: 0, model: cfg.model, escalated: false, stopReason: 'error' as const, lastFrame: null }));
    if (editTimer) clearTimeout(editTimer);
    log(`instruction ${row.id} ended: ${result.stopReason}, ${result.turns} turns, $${result.usd.toFixed(3)}${result.escalated ? `, escalated to ${result.model}` : ''}`);
    db.finishInstruction(row.id, result.stopReason === 'aborted' ? 'stopped' : 'done', result.summary.slice(0, 2_000), result.usd);

    lastReceipt = { instruction: row.text.slice(0, 300), summary: result.summary.slice(0, 600), turns: result.turns, costUsd: result.usd };
    const files: AttachmentBuilder[] = [];
    const receiptPng = sh.cards ? await draw({ kind: 'instruction_done', instruction: row.text, outcome: result.summary }).catch(err => { log(`receipt card not drawn: ${errText(err)}`); return null; }) : null;
    if (receiptPng) files.push(new AttachmentBuilder(Buffer.from(receiptPng), { name: 'receipt.png' }));
    const png = (await frame()) ?? result.lastFrame;
    if (png) files.push(new AttachmentBuilder(Buffer.from(png), { name: 'frame.png' }));
    frames.stop();
    const b = budget.status();
    const footer = `${result.turns} turns, $${result.usd.toFixed(2)} (period: $${b.periodSpentUsd.toFixed(2)} of $${b.monthlyCapUsd.toFixed(2)})`;
    const done = { content: clean(`**Done** (${from}): ${row.text}\n${result.summary}\n-# ${footer}`), components: [], files, allowedMentions: { parse: [] as [] } };
    if (msg) await msg.edit(done).catch(err => log(`edit failed: ${errText(err)}`));
    else await ch.send(done).catch(() => {});
    emit(receiptEvent(row.text, `${result.stopReason}: ${result.summary}`), true);

    current = null;
    step = null;
    void card?.instructionEnded();
    void runNext();
  }

  function statusText(): string {
    const waiting = db.listQueue(g.name).filter(r => r.status === 'waiting');
    const timers = db.listTimers(g.name);
    const b = budget.status();
    return [
      `**Now:** ${current ? current.row.text : 'nothing'}${goal ? ` (goal: ${goal})` : ''}`,
      `**Queue:** ${waiting.length ? waiting.map((w, i) => `${i + 1}. ${w.text}`).join(' | ') : 'empty'}`,
      `**Timers:** ${timers.length ? timers.map(t => `${new Date(t.due).toISOString().slice(11, 16)} UTC ${t.note}`).join(' | ') : 'none'}`,
      `**Spend:** $${b.periodSpentUsd.toFixed(2)} of $${b.monthlyCapUsd.toFixed(2)} this period, $${b.todaySpentUsd.toFixed(2)} of $${b.dailyAllowanceUsd.toFixed(2)} today${b.reason ? ` (${b.reason})` : ''}`,
      '```', gameState().slice(0, 1_200), '```',
    ].join('\n');
  }

  return {
    name: g.name,
    channelId: g.channelId,
    account: g.game.account.name,

    async attach(discord: Client): Promise<void> {
      const ch = await discord.channels.fetch(g.channelId).catch(() => null);
      if (!ch || ch.type !== ChannelType.GuildText) { log('the channel is not a reachable text channel'); return; }
      channel = ch;
      card = new StatusCard({ channel: cardChannel(ch), view, secrets: sh.secrets, timers: realTimers, log });
      await card.init().catch(err => log(`status card failed: ${errText(err)}`));
      advLog = new AdventureLog({ host: logThreadHost(ch), secrets: sh.secrets, timers: realTimers, log, name: cfg.logThreadName });
      posts = new MainPosts({
        channel: postChannel(ch), secrets: sh.secrets, timers: realTimers, log,
        maxPerHour: cfg.postsPerHour, recapHourUtc: cfg.recapHourUtc, spendSince: guildSpendSince, draw,
      });
      posts.start();
      void runNext();
    },

    // Called every few seconds by main.ts.
    tick(): void {
      if (stopping) return;
      const now = Date.now();
      const state = freshState();
      const inGame = sup.status() === 'in_game';
      const ws = inGame ? wakeState(state) : null;
      if (ws && now - lastSnapshotAt >= SNAPSHOT_MS) { db.addSnapshot(g.name, ws); lastSnapshotAt = now; }
      const es = inGame && state ? eventState(state) : null;
      if (es) {
        for (const e of diffStates(prevEvents, es)) emit(e);
        prevEvents = es;
      }
      const actions = sh.wakes.tick({
        guild: g.name, now, state: ws,
        instructionRunning: current !== null,
        jobRunning: runner.isRunning(),
        hasWaiting: db.countWaiting(g.name) > 0,
        dueTimers: db.dueTimers(g.name, now).map(t => ({ id: t.id, note: t.note })),
        budgetOk: budget.status().canWake,
      });
      for (const a of actions) {
        if (a.type === 'abort_job') { log(`job stopped: ${a.reason}`); current?.job?.abort(a.reason); }
        else if (a.type === 'event') { db.addEvent(g.name, a.event, a.text); advLog?.add(a.text); }
        else if (a.type === 'wake') {
          if (a.timerId !== undefined) db.deleteTimer(a.timerId);
          db.enqueueInstruction(g.name, a.user, a.text, a.kind);
          log(`${a.kind} wake queued`);
        }
      }
      if (current && inGame && !frames.active) frames.start();
      if ((!current || !inGame) && frames.active) frames.stop();
      void runNext();
    },

    async onMessage(message: Message, text: string): Promise<void> {
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
      if (cmd === 'status') { await reply(statusText()); return; }
      if (budget.overCap()) { await reply('The monthly spend cap is reached. I take no new instructions this period.'); return; }
      const ok = admit(message.author.id, text, db.countWaiting(g.name));
      if (!ok.ok) { await reply(ADMIT_TEXT[ok.reason]); return; }
      db.enqueueInstruction(g.name, message.member?.displayName ?? message.author.username, ok.text);
      await message.react(current ? '⏳' : '✅').catch(() => {});
      void card?.update();
      void runNext();
    },

    async onButton(interaction: ButtonInteraction): Promise<void> {
      if (interaction.customId === STATUS_ID) {
        if (!allowed(interaction.member as GuildMember | null)) {
          await interaction.reply({ content: 'You do not have the role that can see the status.', ephemeral: true }).catch(() => {});
          return;
        }
        await interaction.reply({ content: clean(statusText()), ephemeral: true, allowedMentions: { parse: [] } }).catch(() => {});
        return;
      }
      if (interaction.customId !== STOP_ID) return;
      if (!allowed(interaction.member as GuildMember | null)) {
        await interaction.reply({ content: 'You do not have the role that can stop instructions.', ephemeral: true }).catch(() => {});
        return;
      }
      if (!current) { await interaction.reply({ content: 'Nothing runs now.', ephemeral: true }).catch(() => {}); return; }
      current.abort.abort();
      await interaction.reply({ content: `Stopped by ${clean(interaction.user.username)}.`, allowedMentions: { parse: [] } }).catch(() => {});
    },

    async stop(): Promise<void> {
      if (stopping) return;
      stopping = true;
      current?.abort.abort();
      frames.stop();
      card?.stopTimer();
      posts?.stop();
      await advLog?.flush().catch(() => {});
      advLog?.stop();
      await stopGame();
    },
  };
}

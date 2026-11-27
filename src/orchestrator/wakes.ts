// The wake rules of docs/design.md section 6, as pure logic. The caller feeds one tick per guild
// with the newest compact state, the queue facts and the clock, and carries out the actions.
// A job end needs no rule here: the agent loop already waits for the job.
import type { BotWorldState } from '../../vendor/rs-sdk/sdk/types';
import { REVIEW_TEXT, type WakeKind } from '../agent/loop';

export interface CompactState {
  hp: number;
  maxHp: number;
  x: number;
  z: number;
  level: number;
  inCombat: boolean;
  skills: Record<string, { level: number; xp: number }>;
  inventory: Record<string, number>;
  /** The number of used inventory slots. Absent in old snapshots. */
  slots?: number;
  /** The client's death signal (PlayerState.lastDeathTick): the game tick of the last death, or null. Absent on old clients. */
  deathTick?: number | null;
}

export const INVENTORY_SLOTS = 28;

/** NOTES_REVIEW_HOUR_UTC: unset or empty means off, else a whole hour 0..23. Throws on a bad value. */
export function parseNotesReviewHour(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 23) throw new Error('NOTES_REVIEW_HOUR_UTC must be a whole hour from 0 to 23');
  return n;
}

/** The small state that the snapshots table holds. Null when the player is not in the game. */
export function compactState(s: BotWorldState | null | undefined): CompactState | null {
  if (!s || !s.inGame || !s.player) return null;
  const p = s.player;
  const skills: CompactState['skills'] = {};
  for (const k of s.skills ?? []) skills[k.name] = { level: k.baseLevel, xp: k.experience };
  const inventory: CompactState['inventory'] = {};
  for (const i of s.inventory ?? []) inventory[i.name] = (inventory[i.name] ?? 0) + i.count;
  const out: CompactState = { hp: p.hp, maxHp: p.maxHp, x: p.worldX, z: p.worldZ, level: p.level, inCombat: !!p.combat?.inCombat, skills, inventory, slots: (s.inventory ?? []).length };
  if (p.lastDeathTick !== undefined) out.deathTick = p.lastDeathTick;
  return out;
}

/** One value that changes when XP, position or inventory changes. */
export function progressKey(s: CompactState): string {
  let xp = 0;
  for (const k of Object.values(s.skills)) xp += k.xp;
  const inv = Object.keys(s.inventory).sort().map(k => `${k}:${s.inventory[k]}`).join(',');
  return `${xp}|${s.x},${s.z},${s.level}|${inv}`;
}

export interface WakeOptions {
  lowHpFraction?: number;
  /** The low-HP trigger arms again when HP is at or above this fraction. */
  lowHpRearmFraction?: number;
  watchdogMs?: number;
  maxWakesPerHour?: number;
  spawn?: { x: number; z: number; level?: number };
  /** A move to within this many tiles of the spawn point counts as a respawn. */
  spawnRadius?: number;
  /** The player must come from at least this far away for a respawn to count. */
  respawnFromDistance?: number;
  /** A respawn counts only if combat was seen this recently. */
  combatMemoryMs?: number;
  /** One death makes one trigger, even if HP 0 and the respawn both show. */
  deathCooldownMs?: number;
  /** At most one full-inventory wake in this time. */
  fullInventoryCooldownMs?: number;
  /** The UTC hour of the daily notes review wake. Null means off. */
  notesReviewHourUtc?: number | null;
}

const DEFAULTS: Required<WakeOptions> = {
  lowHpFraction: 0.3,
  lowHpRearmFraction: 0.4,
  watchdogMs: 5 * 60_000,
  maxWakesPerHour: 6,
  spawn: { x: 3222, z: 3218, level: 0 },
  spawnRadius: 3,
  respawnFromDistance: 10,
  combatMemoryMs: 120_000,
  deathCooldownMs: 60_000,
  fullInventoryCooldownMs: 30 * 60_000,
  notesReviewHourUtc: null,
};

const DAY_MS = 86_400_000;
/** The start of the newest review window at or before now: today at hourUtc:00, or yesterday. */
export function reviewWindowStart(now: number, hourUtc: number): number {
  const at = Math.floor(now / DAY_MS) * DAY_MS + hourUtc * 3_600_000;
  return at <= now ? at : at - DAY_MS;
}

export interface DueTimer { id: number; note: string }

export interface WakeInput {
  guild: string;
  now: number;
  /** The newest compact state, or null when none is available. */
  state: CompactState | null;
  /** An instruction (of any wake kind) runs now. */
  instructionRunning: boolean;
  /** A job runs in the box now. */
  jobRunning: boolean;
  /** At least one instruction waits in the queue. */
  hasWaiting: boolean;
  /** The timers of this guild that are due, oldest first. */
  dueTimers: DueTimer[];
  /** False when the budget allows no new wake (month cap or daily allowance). */
  budgetOk: boolean;
  /** When the last review wake was queued, from the database, so a restart does not repeat it. */
  lastReviewAt?: number | null;
}

export type TriggerKind = 'low_hp' | 'death' | 'inventory_full';

export const FULL_INVENTORY_TEXT = 'The inventory is full (28 of 28 slots) and no job runs. Bank, drop or use items, then go on with the current goal.';

export type WakeAction =
  | { type: 'wake'; kind: Extract<WakeKind, 'timer' | 'trigger' | 'review'>; user: string; text: string; timerId?: number; trigger?: TriggerKind }
  | { type: 'abort_job'; reason: string }
  | { type: 'event'; event: string; text: string };

interface GuildState {
  prev: CompactState | null;
  lowHpArmed: boolean;
  lastCombatAt: number | null;
  lastDeathAt: number | null;
  jobWasRunning: boolean;
  progress: string | null;
  progressAt: number;
  wakes: number[];
  lastFullAt: number | null;
  // Fires once when the inventory gets full; arms again only after it has room.
  fullArmed: boolean;
  lastReviewAt: number | null;
}

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

export function createWakeScheduler(options: WakeOptions = {}) {
  const o = { ...DEFAULTS, ...options };
  const guilds = new Map<string, GuildState>();

  const get = (guild: string, now: number): GuildState => {
    let g = guilds.get(guild);
    if (!g) {
      g = { prev: null, lowHpArmed: true, lastCombatAt: null, lastDeathAt: null, jobWasRunning: false, progress: null, progressAt: now, wakes: [], lastFullAt: null, fullArmed: true, lastReviewAt: null };
      guilds.set(guild, g);
    }
    return g;
  };

  const atSpawn = (s: CompactState) => (o.spawn.level === undefined || s.level === o.spawn.level) && dist(s, o.spawn) <= o.spawnRadius;

  function triggers(g: GuildState, s: CompactState, now: number): { kind: TriggerKind; text: string }[] {
    const out: { kind: TriggerKind; text: string }[] = [];
    const prev = g.prev;
    if (s.inCombat) g.lastCombatAt = now;
    const deathFresh = g.lastDeathAt !== null && now - g.lastDeathAt < o.deathCooldownMs;

    const zeroHp = s.maxHp > 0 && s.hp <= 0 && (prev === null || prev.hp > 0);
    // The client's own signal: lastDeathTick changes on each death. With it, no respawn guess.
    const signal = prev !== null && prev.deathTick !== undefined && s.deathTick !== undefined;
    const clientDeath = signal && s.deathTick !== null && s.deathTick !== prev!.deathTick;
    const respawn = !signal && prev !== null && !atSpawn(prev) && dist(prev, o.spawn) >= o.respawnFromDistance && atSpawn(s)
      && g.lastCombatAt !== null && now - g.lastCombatAt <= o.combatMemoryMs;
    if ((zeroHp || clientDeath || respawn) && !deathFresh) {
      g.lastDeathAt = now;
      g.lowHpArmed = true;
      out.push({ kind: 'death', text: zeroHp || clientDeath ? 'The player died (HP 0).' : 'The player respawned at the spawn point after combat. It probably died.' });
      return out;
    }

    if (s.maxHp > 0 && s.hp > 0) {
      const f = s.hp / s.maxHp;
      if (f >= o.lowHpRearmFraction) g.lowHpArmed = true;
      else if (f < o.lowHpFraction && g.lowHpArmed) {
        g.lowHpArmed = false;
        out.push({ kind: 'low_hp', text: `HP is low: ${s.hp}/${s.maxHp}.` });
      }
    }
    return out;
  }

  function canRateWake(g: GuildState, now: number): boolean {
    g.wakes = g.wakes.filter(t => now - t < 3_600_000);
    return g.wakes.length < o.maxWakesPerHour;
  }

  return {
    options: o,
    tick(input: WakeInput): WakeAction[] {
      const { now, state } = input;
      const g = get(input.guild, now);
      if (state && (state.slots ?? 0) < INVENTORY_SLOTS) g.fullArmed = true;
      const actions: WakeAction[] = [];

      // Watchdog: a job that changes no progress measure for watchdogMs is stopped.
      if (input.jobRunning) {
        const key = state ? progressKey(state) : null;
        if (!g.jobWasRunning || (key !== null && key !== g.progress)) {
          g.progress = key;
          g.progressAt = now;
        } else if (now - g.progressAt >= o.watchdogMs) {
          const mins = Math.round(o.watchdogMs / 60_000);
          actions.push({ type: 'abort_job', reason: `No change in XP, position or inventory for ${mins} minutes` });
          actions.push({ type: 'event', event: 'watchdog', text: `The watchdog stopped a job: no progress for ${mins} minutes.` });
          g.progressAt = now;
        }
      }
      g.jobWasRunning = input.jobRunning;

      const fired = state ? triggers(g, state, now) : [];
      if (state) g.prev = state;

      let started = false;
      for (const t of fired) {
        actions.push({ type: 'event', event: t.kind, text: t.text });
        if (input.instructionRunning) {
          // The AI is awake. Stop the job so the loop reads the new state now.
          // Low HP out of combat stops nothing: the job may be the walk away from danger.
          const fighting = !!state?.inCombat || (g.lastCombatAt !== null && now - g.lastCombatAt < 10_000);
          if (input.jobRunning && (t.kind === 'death' || fighting)) actions.push({ type: 'abort_job', reason: t.text });
          continue;
        }
        if (started) continue;
        if (!input.budgetOk) { actions.push({ type: 'event', event: 'wake_skipped', text: `No wake for "${t.kind}": the budget allows no wake.` }); continue; }
        if (!canRateWake(g, now)) { actions.push({ type: 'event', event: 'wake_skipped', text: `No wake for "${t.kind}": at most ${o.maxWakesPerHour} timer and trigger wakes per hour.` }); continue; }
        g.wakes.push(now);
        started = true;
        actions.push({ type: 'wake', kind: 'trigger', user: 'trigger', text: t.text, trigger: t.kind });
      }

      if (started || input.instructionRunning || !input.budgetOk) return actions;

      // A waiting request runs first: guild.ts starts it on each tick. No wake jumps ahead of it.
      if (input.hasWaiting) return actions;

      // A full inventory with no job: one trigger wake when it gets full (and at most one per
      // cooldown); it arms again only after the inventory has room.
      if (state && g.fullArmed && !input.jobRunning && (state.slots ?? 0) >= INVENTORY_SLOTS
        && (g.lastFullAt === null || now - g.lastFullAt >= o.fullInventoryCooldownMs)) {
        g.lastFullAt = now;
        g.fullArmed = false;
        if (!canRateWake(g, now)) {
          actions.push({ type: 'event', event: 'wake_skipped', text: `No wake for "inventory_full": at most ${o.maxWakesPerHour} timer and trigger wakes per hour.` });
        } else {
          g.wakes.push(now);
          actions.push({ type: 'wake', kind: 'trigger', user: 'trigger', text: FULL_INVENTORY_TEXT, trigger: 'inventory_full' });
          return actions;
        }
      }

      // A timer that cannot fire now stays due and fires on a later tick.
      const timer = input.dueTimers[0];
      if (timer && canRateWake(g, now)) {
        g.wakes.push(now);
        actions.push({ type: 'wake', kind: 'timer', user: 'timer', text: timer.note, timerId: timer.id });
        return actions;
      }

      // The daily notes review: once per window. It waits while the rate limit is full.
      if (o.notesReviewHourUtc !== null && !input.jobRunning) {
        const start = reviewWindowStart(now, o.notesReviewHourUtc);
        const last = Math.max(g.lastReviewAt ?? -Infinity, input.lastReviewAt ?? -Infinity);
        if (last < start && canRateWake(g, now)) {
          g.wakes.push(now);
          g.lastReviewAt = now;
          actions.push({ type: 'wake', kind: 'review', user: 'review', text: REVIEW_TEXT });
        }
      }
      return actions;
    },
  };
}

export type WakeScheduler = ReturnType<typeof createWakeScheduler>;

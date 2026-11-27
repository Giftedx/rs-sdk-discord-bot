// The wake rules of docs/design.md section 6, as pure logic. The caller feeds one tick per guild
// with the newest compact state, the queue facts and the clock, and carries out the actions.
// A job end needs no rule here: the agent loop already waits for the job.
import type { BotWorldState } from '../../vendor/rs-sdk/sdk/types';
import type { WakeKind } from '../agent/loop';

export interface CompactState {
  hp: number;
  maxHp: number;
  x: number;
  z: number;
  level: number;
  inCombat: boolean;
  skills: Record<string, { level: number; xp: number }>;
  inventory: Record<string, number>;
}

/** The small state that the snapshots table holds. Null when the player is not in the game. */
export function compactState(s: BotWorldState | null | undefined): CompactState | null {
  if (!s || !s.inGame || !s.player) return null;
  const p = s.player;
  const skills: CompactState['skills'] = {};
  for (const k of s.skills ?? []) skills[k.name] = { level: k.baseLevel, xp: k.experience };
  const inventory: CompactState['inventory'] = {};
  for (const i of s.inventory ?? []) inventory[i.name] = (inventory[i.name] ?? 0) + i.count;
  return { hp: p.hp, maxHp: p.maxHp, x: p.worldX, z: p.worldZ, level: p.level, inCombat: !!p.combat?.inCombat, skills, inventory };
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
};

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
}

export type TriggerKind = 'low_hp' | 'death';

export type WakeAction =
  | { type: 'start_instruction' }
  | { type: 'wake'; kind: Extract<WakeKind, 'timer' | 'trigger'>; user: string; text: string; timerId?: number; trigger?: TriggerKind }
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
}

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

export function createWakeScheduler(options: WakeOptions = {}) {
  const o = { ...DEFAULTS, ...options };
  const guilds = new Map<string, GuildState>();

  const get = (guild: string, now: number): GuildState => {
    let g = guilds.get(guild);
    if (!g) {
      g = { prev: null, lowHpArmed: true, lastCombatAt: null, lastDeathAt: null, jobWasRunning: false, progress: null, progressAt: now, wakes: [] };
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
    const respawn = prev !== null && !atSpawn(prev) && dist(prev, o.spawn) >= o.respawnFromDistance && atSpawn(s)
      && g.lastCombatAt !== null && now - g.lastCombatAt <= o.combatMemoryMs;
    if ((zeroHp || respawn) && !deathFresh) {
      g.lastDeathAt = now;
      g.lowHpArmed = true;
      out.push({ kind: 'death', text: zeroHp ? 'The player died (HP 0).' : 'The player respawned at the spawn point after combat. It probably died.' });
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
          if (input.jobRunning) actions.push({ type: 'abort_job', reason: t.text });
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

      if (input.hasWaiting) {
        actions.push({ type: 'start_instruction' });
        return actions;
      }

      // A timer that cannot fire now stays due and fires on a later tick.
      const timer = input.dueTimers[0];
      if (timer && canRateWake(g, now)) {
        g.wakes.push(now);
        actions.push({ type: 'wake', kind: 'timer', user: 'timer', text: timer.note, timerId: timer.id });
      }
      return actions;
    },
    /** Forget the state of one guild, for example after the account logs in again. */
    reset(guild: string): void { guilds.delete(guild); },
  };
}

export type WakeScheduler = ReturnType<typeof createWakeScheduler>;

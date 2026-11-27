// Small pure parts of the bot wiring, kept here so that they have unit tests.
import type { CardDataMap, CardKind } from '../cards/templates';
import type { CompactState as EventState, GameEvent } from '../events/diff';
import type { CardSubject } from '../discord/posts';
import type { CardView } from '../discord/status-card';
import { MAX_INSTRUCTION_CHARS } from './queue';

// A lock per key. Guilds that share a box user share one key, because the job runner kills
// every process of the box user after a job.
export function createKeyedLock() {
  const tails = new Map<string, Promise<void>>();
  // With a signal, an abort ends the wait at once. fn then runs without the lock and must check
  // the signal first. The chain stays in order: the next waiter still waits for `before`.
  return async function withLock<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const before = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>(r => { release = r; });
    const tail = before.then(() => mine);
    tails.set(key, tail);
    if (signal && !signal.aborted) {
      let onAbort: () => void = () => {};
      const aborted = new Promise<void>(r => { onAbort = r; signal.addEventListener('abort', onAbort, { once: true }); });
      await Promise.race([before, aborted]);
      signal.removeEventListener('abort', onAbort);
    } else if (!signal) {
      await before;
    }
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

export type AdmitResult = { ok: true; text: string } | { ok: false; reason: 'full' | 'cooldown' | 'empty' | 'too_long' };

// The checks of a new instruction. The queue itself is in the database.
export function createAdmission(opts: { max: number; userCooldownMs: number; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const lastByUser = new Map<string, number>();
  return (userId: string, text: string, waiting: number): AdmitResult => {
    const t = text.trim();
    if (t === '') return { ok: false, reason: 'empty' };
    if (t.length > MAX_INSTRUCTION_CHARS) return { ok: false, reason: 'too_long' };
    const last = lastByUser.get(userId);
    if (last !== undefined && now() - last < opts.userCooldownMs) return { ok: false, reason: 'cooldown' };
    if (waiting >= opts.max) return { ok: false, reason: 'full' };
    lastByUser.set(userId, now());
    return { ok: true, text: t };
  };
}

export const ADMIT_TEXT: Record<Exclude<AdmitResult, { ok: true }>['reason'], string> = {
  full: 'The queue is full. Try again later.',
  cooldown: 'Wait a little before your next instruction.',
  empty: 'Give me an instruction.',
  too_long: 'That instruction is too long.',
};

export interface ViewInput {
  goal: string | null;
  running: string | null;
  step: string | null;
  hp: { hp: number; maxHp: number } | null;
  queueLength: number;
  spend: { usedUsd: number; capUsd: number };
  budgetNote: string | null;
  tabStatus: string;
  frame: Uint8Array | null;
}

export function cardView(v: ViewInput): CardView {
  const note = v.tabStatus !== 'in_game' ? `game tab: ${v.tabStatus}` : v.budgetNote ?? undefined;
  return {
    goal: v.goal ?? v.running ?? 'Waiting for an instruction.',
    step: v.running ? v.step ?? 'Starting.' : 'Idle.',
    hp: v.hp,
    queueLength: v.queueLength,
    spend: v.spend,
    running: v.running !== null,
    ...(note ? { note } : {}),
    ...(v.frame ? { frame: v.frame } : {}),
  };
}

export interface Receipt { instruction: string; summary: string; turns: number; costUsd: number }

export type CardRequest = { [K in CardKind]: { kind: K; data: CardDataMap[K] } }[CardKind];

// The card for a post, or null when the subject has no card.
export function cardFor(subject: CardSubject, state: EventState | null, receipt: Receipt | null, at: Date): CardRequest | null {
  switch (subject.kind) {
    case 'level_up':
      return { kind: 'level_up', data: { skill: subject.skill, level: subject.level, xp: state?.skills[subject.skill]?.xp ?? 0 } };
    case 'death':
      return {
        kind: 'death',
        data: { place: state ? `${state.x}, ${state.z}, level ${state.plane}` : 'unknown', time: `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC` },
      };
    case 'instruction_done':
      return receipt ? { kind: 'instruction_receipt', data: receipt } : null;
    case 'recap': {
      const r = subject.recap;
      return {
        kind: 'daily_recap',
        data: {
          date: at.toISOString().slice(0, 10),
          counts: [
            { label: 'Level-ups', value: r.levelUps },
            { label: 'Items', value: r.items },
            { label: 'Deaths', value: r.deaths },
            { label: 'Instructions', value: r.instructions },
          ],
        },
      };
    }
    default:
      return null;
  }
}

export function receiptEvent(instruction: string, outcome: string): GameEvent {
  return { kind: 'instruction_done', instruction: instruction.slice(0, 200), outcome: outcome.slice(0, 300) };
}

// Each job gets its own controller, so the orchestrator can stop the job and not the instruction.
export function jobSignal(instruction: AbortSignal): { signal: AbortSignal; abort(reason: string): void; reason(): string | null } {
  const ctl = new AbortController();
  let why: string | null = null;
  const onAbort = () => ctl.abort();
  if (instruction.aborted) ctl.abort(); else instruction.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctl.signal,
    abort(reason: string) { if (!ctl.signal.aborted) { why = reason; ctl.abort(); } },
    reason: () => why,
  };
}

// A message is for the bot when it mentions the bot user or the role that Discord made for the
// bot (that role has the bot's name, and the mention list of Discord offers both).
export function mentionsBot(userIds: Iterable<string>, roleIds: Iterable<string>, botId: string, botRoleId: string | null): boolean {
  for (const id of userIds) if (id === botId) return true;
  if (botRoleId !== null) for (const id of roleIds) if (id === botRoleId) return true;
  return false;
}

// The instruction text without user and role mentions.
export function stripMentions(content: string): string {
  return content.replace(/<@[!&]?\d+>/g, '').trim();
}

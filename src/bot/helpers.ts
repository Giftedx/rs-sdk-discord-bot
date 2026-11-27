// Small pure parts of the bot wiring, kept here so that they have unit tests.
import type { CardDataMap, CardKind, ReceiptItem, ReceiptSkill } from '../cards/templates';
import { lostItems, totalLevel, type CompactState as EventState, type GameEvent } from '../events/diff';
import type { CardSubject } from '../discord/posts';
import type { CardView, SkillSample } from '../discord/status-card';
import { MAX_INSTRUCTION_CHARS } from './queue';
import { sanitizeForDiscord } from '../shared/sanitize';

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
  /** Why the tab is out of the game, for example the login message of the server. */
  tabReason?: string | null;
  frame: Uint8Array | null;
  inventory?: { used: number; max: number } | null;
  xpSamples?: SkillSample[];
  lastEvent?: string | null;
  script?: string | null;
}

/** The status of the game tab in one line, with the reason when the tab is out of the game. */
export function tabLine(status: string, reason: string | null | undefined): string {
  return status !== 'in_game' && reason ? `${status} (${reason.slice(0, 200)})` : status;
}

export function cardView(v: ViewInput): CardView {
  const note = v.tabStatus !== 'in_game' ? `game tab: ${tabLine(v.tabStatus, v.tabReason)}` : v.budgetNote ?? undefined;
  return {
    goal: v.goal ?? v.running ?? 'Waiting for an instruction.',
    step: v.running ? v.step ?? 'Starting.' : 'Idle.',
    hp: v.hp,
    queueLength: v.queueLength,
    spend: v.spend,
    running: v.running !== null,
    ...(note ? { note } : {}),
    ...(v.frame ? { frame: v.frame } : {}),
    ...(v.inventory ? { inventory: v.inventory } : {}),
    ...(v.xpSamples && v.xpSamples.length > 1 ? { xpSamples: v.xpSamples } : {}),
    ...(v.lastEvent ? { lastEvent: v.lastEvent } : {}),
    ...(v.running && v.script ? { script: v.script } : {}),
  };
}

export interface Receipt {
  instruction: string;
  summary: string;
  turns: number;
  costUsd: number;
  durationMs?: number;
  skills?: ReceiptSkill[];
  inventory?: ReceiptItem[];
}

const RECEIPT_ROWS = 12;

/** The receipt card data of a finished instruction. The texts come from people and the AI, so
 *  clean() (secrets, the account name, mentions) runs on them before they are cut. */
export function buildReceipt(v: {
  instruction: string; summary: string; turns: number; costUsd: number; durationMs: number;
  changes: { skills: ReceiptSkill[]; inventory: ReceiptItem[] };
}, clean: (text: string) => string): Receipt {
  return {
    instruction: clean(v.instruction).slice(0, 300), summary: clean(v.summary).slice(0, 600), turns: v.turns, costUsd: v.costUsd,
    durationMs: v.durationMs,
    ...(v.changes.skills.length > 0 ? { skills: v.changes.skills } : {}),
    ...(v.changes.inventory.length > 0 ? { inventory: v.changes.inventory } : {}),
  };
}

/** The skills and items that changed between the start and the end of an instruction. */
export function receiptChanges(before: EventState | null, after: EventState | null): { skills: ReceiptSkill[]; inventory: ReceiptItem[] } {
  if (!before || !after) return { skills: [], inventory: [] };
  const skills: ReceiptSkill[] = [];
  for (const [name, a] of Object.entries(after.skills)) {
    const b = before.skills[name];
    if (b && a.xp > b.xp) skills.push({ name, before: b.level, after: a.level, xp: a.xp - b.xp });
  }
  const inventory: ReceiptItem[] = [];
  for (const name of new Set([...Object.keys(before.inventory), ...Object.keys(after.inventory)])) {
    const b = before.inventory[name] ?? 0;
    const a = after.inventory[name] ?? 0;
    if (a !== b) inventory.push({ name, before: b, after: a });
  }
  return {
    skills: skills.sort((x, y) => y.xp - x.xp).slice(0, RECEIPT_ROWS),
    inventory: inventory.sort((x, y) => Math.abs(y.after - y.before) - Math.abs(x.after - x.before) || x.name.localeCompare(y.name)).slice(0, RECEIPT_ROWS),
  };
}

type DeathEvent = Extract<GameEvent, { kind: 'death' }>;

/**
 * Adds the lost items and a guess of the killer to death events. At hp 0 the items can still be in
 * the inventory, so a death at hp 0 waits for the respawn (at most holdMs), and the inventory after
 * the respawn is compared with the last inventory while alive.
 */
export function createDeathEnricher(opts: { holdMs?: number; now?: () => number } = {}) {
  const holdMs = opts.holdMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let alive: { inventory: Record<string, number>; killer?: string } | null = null;
  let pending: { e: DeathEvent; at: number; before: Record<string, number> | null } | null = null;
  const withLost = (e: DeathEvent, before: Record<string, number> | null, after: EventState | null): DeathEvent => {
    const lost = before && after ? lostItems(before, after.inventory) : [];
    return lost.length > 0 ? { ...e, lost } : e;
  };
  return (events: GameEvent[], s: EventState, killerNow: string | undefined): GameEvent[] => {
    const out: GameEvent[] = [];
    for (const e of events) {
      if (e.kind !== 'death') { out.push(e); continue; }
      const killer = killerNow ?? alive?.killer;
      const base: DeathEvent = killer ? { ...e, killer } : { ...e };
      const before = alive?.inventory ?? null;
      if (s.hp > 0) out.push(withLost(base, before, s));
      else pending = { e: base, at: now(), before };
    }
    if (pending && s.hp > 0) { out.push(withLost(pending.e, pending.before, s)); pending = null; }
    else if (pending && now() - pending.at >= holdMs) { out.push(pending.e); pending = null; }
    if (s.hp > 0 && !pending) {
      const killer = killerNow ?? (s.inCombat ? alive?.killer : undefined);
      alive = killer ? { inventory: s.inventory, killer } : { inventory: s.inventory };
    }
    return out;
  };
}

/** The script name from a progress line of the loop, or null for new code and other lines. */
export function scriptFromProgress(line: string): string | null | undefined {
  const m = /^Running saved script `([^`]{1,100})`\.$/.exec(line);
  if (m) return m[1]!;
  return line === 'Running new code.' ? null : undefined;
}

/** The short context that goes before each wake of the AI. */
export function wakeContextText(v: {
  goal: string | null;
  queue: string[];
  tab: string;
  hp: { hp: number; maxHp: number } | null;
  position: { x: number; z: number; plane: number } | null;
  inventoryUsed: number | null;
  routineOnly: boolean;
}): string {
  return [
    `Goal: ${v.goal ?? 'none set'}.`,
    `Queue: ${v.queue.length === 0 ? 'empty' : `${v.queue.length} waiting, next: ${v.queue[0]!.slice(0, 200)}`}.`,
    `Game tab: ${v.tab}.`,
    v.hp ? `HP ${v.hp.hp}/${v.hp.maxHp}.` : 'No fresh game state.',
    ...(v.position ? [`Position ${v.position.x}, ${v.position.z}, level ${v.position.plane}.`] : []),
    ...(v.inventoryUsed !== null ? [`Inventory ${v.inventoryUsed}/28.`] : []),
    ...(v.routineOnly ? ['The budget is low: do only routine work, keep it short.'] : []),
  ].join(' ');
}

/** Reads and removes the flag file of the revision check. Null when there is no flag. */
export function takeRevisionFlag(path: string, fs: { read(p: string): string; remove(p: string): void }): string | null {
  let text: string;
  try { text = fs.read(path); } catch { return null; }
  try { fs.remove(path); } catch { /* the next tick tries again; the line is the same */ }
  return text.trim().split('\n')[0]!.slice(0, 300);
}

export type CardRequest = { [K in CardKind]: { kind: K; data: CardDataMap[K] } }[CardKind];

// The card for a post, or null when the subject has no card.
export function cardFor(subject: CardSubject, state: EventState | null, receipt: Receipt | null, at: Date): CardRequest | null {
  switch (subject.kind) {
    case 'level_up':
      return {
        kind: 'level_up',
        data: {
          skill: subject.skill, level: subject.level, xp: state?.skills[subject.skill]?.xp ?? 0, from: subject.from,
          ...(state && Object.keys(state.skills).length > 0 ? { totalLevel: totalLevel(state) } : {}),
        },
      };
    case 'death':
      return {
        kind: 'death',
        data: {
          place: state ? `${state.x}, ${state.z}, level ${state.plane}` : 'unknown', time: `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
          ...(subject.lost && subject.lost.length > 0 ? { items: subject.lost.slice(0, 12) } : {}),
          ...(subject.killer ? { killer: subject.killer } : {}),
        },
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
          ...(r.xpBySkill && r.xpBySkill.length > 0 ? { xp: r.xpBySkill.slice(0, 12) } : {}),
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
  // The job signal carries the reason of the instruction abort, so the runner sees a 'shutdown'.
  const onAbort = () => ctl.abort(instruction.reason);
  if (instruction.aborted) onAbort(); else instruction.addEventListener('abort', onAbort, { once: true });
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

// At most `max` events per key in a sliding window.
export function createRateLimit(max: number, windowMs: number, now: () => number = Date.now) {
  const seen = new Map<string, number[]>();
  return (key: string): boolean => {
    const t = now();
    const list = (seen.get(key) ?? []).filter(x => x > t - windowMs);
    if (list.length >= max) { seen.set(key, list); return false; }
    list.push(t);
    seen.set(key, list);
    return true;
  };
}

// The "Last:" line of the status card: the newest event that is not an item gain, short.
// A finished request shows as "Finished: <request>", from the stored event data (its text holds the
// whole summary).
export function cardLastEvent(rows: { type: string; text: string; data?: unknown }[], secrets: string[] = [], max = 90): string | null {
  const r = rows.find(x => x.type !== 'item_gain' && x.type !== 'wake_skipped');
  if (!r) return null;
  let raw = r.text;
  const d = r.data as { instruction?: unknown; outcome?: unknown } | null | undefined;
  if (r.type === 'instruction_done' && d && typeof d.instruction === 'string') {
    const outcome = typeof d.outcome === 'string' ? d.outcome : '';
    raw = `${/^(finished|done)\b/i.test(outcome) ? 'Finished' : 'Ended'}: ${d.instruction}`;
  }
  // Hide the secrets first, then shorten: a cut through a secret would leave a part that no longer matches.
  const t = sanitizeForDiscord(raw, secrets, Number.MAX_SAFE_INTEGER).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20))}…`;
}

// Runs fn; after a failure waits delaysMs[i] and tries again. After the last delay the error goes
// to the caller, so the count of tries is delaysMs.length + 1.
export async function retryBackoff<T>(
  fn: () => Promise<T>,
  opts: { delaysMs: readonly number[]; onRetry?: (err: unknown, n: number) => void; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  for (let n = 1; ; n++) {
    try {
      return await fn();
    } catch (err) {
      const delay = opts.delaysMs[n - 1];
      if (delay === undefined) throw err;
      opts.onRetry?.(err, n);
      await sleep(delay);
    }
  }
}

// Retries fn until it works or the deadline passes. shouldRetry(err) false stops at once.
export async function retryUntil<T>(
  fn: () => Promise<T>,
  opts: { deadlineMs: number; delayMs: number; shouldRetry: (err: unknown) => boolean; onRetry?: (err: unknown, n: number) => void; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const end = now() + opts.deadlineMs;
  for (let n = 1; ; n++) {
    try {
      return await fn();
    } catch (err) {
      if (!opts.shouldRetry(err) || now() + opts.delayMs > end) throw err;
      opts.onRetry?.(err, n);
      await sleep(opts.delayMs);
    }
  }
}

// Bun says "Was there a typo in the url or port?" for a Unix socket that does not exist yet.
// That text sends the operator to the wrong place while gamelink starts, so name the cause.
export function gamelinkWaitReason(err: unknown, socketPath: string): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'FailedToOpenSocket' || code === 'ENOENT') return `no socket at ${socketPath} yet`;
  if (code === 'ConnectionRefused' || code === 'ECONNREFUSED') return `nothing listens on ${socketPath} yet`;
  return err instanceof Error ? err.message : String(err);
}

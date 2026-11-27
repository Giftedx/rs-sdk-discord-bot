// Spend control over the database: the monthly cap, the daily allowance and a SpendTracker
// that the agent loop can use in place of the JSON file tracker of src/agent/spend.ts.
// All day and period boundaries are UTC.
import { costUsd, type UsageLike } from '../agent/spend';
import type { OrchestratorDb } from './db';

const DAY_MS = 86_400_000;

/** The start of the period that holds `at`. The period starts on `resetDay` (1..28) of a month. */
export function periodBounds(at: Date, resetDay = 1): { start: number; end: number; days: number } {
  const day = Math.min(Math.max(Math.round(resetDay), 1), 28);
  let y = at.getUTCFullYear();
  let m = at.getUTCMonth();
  if (at.getUTCDate() < day) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  const start = Date.UTC(y, m, day);
  const end = Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, day);
  return { start, end, days: Math.round((end - start) / DAY_MS) };
}

export function dayBounds(at: Date): { start: number; end: number } {
  const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return { start, end: start + DAY_MS };
}

/**
 * The allowance of the day that holds `at`. Allowance that earlier days of the period did not use
 * moves forward: (cap - spent before today) / days left in the period, today included.
 * With no spend before today on the first day, it is the cap over the days of the period.
 */
export function dailyAllowanceUsd(monthlyCapUsd: number, at: Date, resetDay = 1, spentBeforeTodayUsd = 0): number {
  const p = periodBounds(at, resetDay);
  const daysLeft = Math.max(1, Math.round((p.end - dayBounds(at).start) / DAY_MS));
  return Math.max(0, monthlyCapUsd - spentBeforeTodayUsd) / daysLeft;
}

/** At or above this part of the monthly cap the bot uses only the routine (small) model. */
export const ROUTINE_ONLY_FRACTION = 0.8;

export type WakeBlock = 'month_cap' | 'day_allowance';

export interface BudgetStatus {
  /** The guild of this budget, or null for one budget over all guilds. */
  guild: string | null;
  /** The cap of this budget: the share of the guild, or the global cap. */
  monthlyCapUsd: number;
  periodSpentUsd: number;
  dailyAllowanceUsd: number;
  todaySpentUsd: number;
  /** The cap and the period spend over all guilds. */
  globalCapUsd: number;
  globalSpentUsd: number;
  /** True at 80% of the guild cap or of the global cap: use the small model and no escalation. */
  routineOnly: boolean;
  canWake: boolean;
  blocked: WakeBlock | null;
  reason: string | null;
}

export function budgetStatus(input: {
  monthlyCapUsd: number;
  periodSpentUsd: number;
  todaySpentUsd: number;
  at: Date;
  resetDay?: number;
  guild?: string | null;
  /** The global cap and spend when this budget is the share of one guild. Omitted: this budget is the global one. */
  global?: { capUsd: number; spentUsd: number };
}): BudgetStatus {
  const cap = input.monthlyCapUsd;
  const global = input.global ?? { capUsd: cap, spentUsd: input.periodSpentUsd };
  const before = Math.max(0, input.periodSpentUsd - input.todaySpentUsd);
  const allowance = dailyAllowanceUsd(cap, input.at, input.resetDay, before);
  let blocked: WakeBlock | null = null;
  let reason: string | null = null;
  if (global.spentUsd >= global.capUsd) {
    blocked = 'month_cap';
    reason = `The monthly spend cap ($${global.capUsd.toFixed(2)}) is reached.`;
  } else if (input.periodSpentUsd >= cap) {
    blocked = 'month_cap';
    reason = `This server used its monthly share ($${cap.toFixed(2)}).`;
  } else if (input.todaySpentUsd >= allowance) {
    blocked = 'day_allowance';
    reason = `Today used its allowance ($${allowance.toFixed(2)}). Wakes start again tomorrow (UTC).`;
  }
  const routineOnly = input.periodSpentUsd >= ROUTINE_ONLY_FRACTION * cap
    || global.spentUsd >= ROUTINE_ONLY_FRACTION * global.capUsd;
  return {
    guild: input.guild ?? null,
    monthlyCapUsd: cap,
    periodSpentUsd: input.periodSpentUsd,
    dailyAllowanceUsd: allowance,
    todaySpentUsd: input.todaySpentUsd,
    globalCapUsd: global.capUsd,
    globalSpentUsd: global.spentUsd,
    routineOnly,
    canWake: blocked === null,
    blocked,
    reason,
  };
}

/** The models of the next wake. In routine-only mode the main loop uses the small model and escalation is off. */
export function modelsFor(
  status: Pick<BudgetStatus, 'routineOnly'>,
  m: { model: string; escalationModel: string | null; smallModel: string },
): { model: string; escalationModel: string | null } {
  return status.routineOnly ? { model: m.smallModel, escalationModel: null } : { model: m.model, escalationModel: m.escalationModel };
}

export interface SpendContext { guild: string | null; instructionId: number | null }

/**
 * A spend tracker with the same shape as createSpendTracker, but it records each call in the
 * spend table. `overCap` is the monthly cap only: a running instruction may finish past the
 * daily allowance, which only blocks new wakes (see `status().canWake`).
 *
 * With `guild` set, this budget is the share of that guild: monthlyCapUsd / guildCount (default 1),
 * counted over the spend rows of that guild. The global cap over all guilds still holds.
 * `capUsd` and `spentUsd()` are then the values of the guild.
 */
export function createBudget(db: OrchestratorDb, monthlyCapUsd: number, opts: {
  resetDay?: number;
  now?: () => Date;
  context?: () => SpendContext;
  guild?: string;
  guildCount?: number;
} = {}) {
  const now = opts.now ?? (() => new Date());
  const guild = opts.guild ?? null;
  const context = opts.context ?? (() => ({ guild, instructionId: null }));
  const share = guild === null ? monthlyCapUsd : monthlyCapUsd / Math.max(1, Math.round(opts.guildCount ?? 1));
  const guildSum = db.raw.query('SELECT COALESCE(SUM(usd), 0) AS s FROM spend WHERE guild = ? AND time >= ? AND time < ?');
  const between = (from: number, to: number): number => guild === null
    ? db.spendBetween(from, to)
    : (guildSum.get(guild, from, to) as { s: number }).s;
  const period = () => periodBounds(now(), opts.resetDay);
  const globalSpent = () => { const p = period(); return db.spendBetween(p.start, p.end); };
  const ownSpent = () => { const p = period(); return between(p.start, p.end); };
  return {
    add(model: string, usage: UsageLike): number {
      const usd = costUsd(model, usage);
      const c = context();
      db.recordSpend({
        guild: c.guild ?? guild,
        instructionId: c.instructionId,
        model,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        usd,
        time: now().getTime(),
      });
      return usd;
    },
    spentUsd(): number { return ownSpent(); },
    capUsd: share,
    overCap(): boolean { return ownSpent() >= share || globalSpent() >= monthlyCapUsd; },
    status(): BudgetStatus {
      const at = now();
      const d = dayBounds(at);
      return budgetStatus({
        monthlyCapUsd: share,
        periodSpentUsd: ownSpent(),
        todaySpentUsd: between(d.start, d.end),
        at,
        resetDay: opts.resetDay,
        guild,
        global: { capUsd: monthlyCapUsd, spentUsd: globalSpent() },
      });
    },
  };
}

export type Budget = ReturnType<typeof createBudget>;

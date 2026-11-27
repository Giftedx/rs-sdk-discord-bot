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

/** The monthly cap shared out over the days of the period. With resetDay 1 that is the days in the month. */
export function dailyAllowanceUsd(monthlyCapUsd: number, at: Date, resetDay = 1): number {
  return monthlyCapUsd / periodBounds(at, resetDay).days;
}

export type WakeBlock = 'month_cap' | 'day_allowance';

export interface BudgetStatus {
  monthlyCapUsd: number;
  periodSpentUsd: number;
  dailyAllowanceUsd: number;
  todaySpentUsd: number;
  canWake: boolean;
  blocked: WakeBlock | null;
  reason: string | null;
}

export function budgetStatus(input: { monthlyCapUsd: number; periodSpentUsd: number; todaySpentUsd: number; at: Date; resetDay?: number }): BudgetStatus {
  const allowance = dailyAllowanceUsd(input.monthlyCapUsd, input.at, input.resetDay);
  let blocked: WakeBlock | null = null;
  let reason: string | null = null;
  if (input.periodSpentUsd >= input.monthlyCapUsd) {
    blocked = 'month_cap';
    reason = `The monthly spend cap ($${input.monthlyCapUsd.toFixed(2)}) is reached.`;
  } else if (input.todaySpentUsd >= allowance) {
    blocked = 'day_allowance';
    reason = `Today used its allowance ($${allowance.toFixed(2)}). Wakes start again tomorrow (UTC).`;
  }
  return {
    monthlyCapUsd: input.monthlyCapUsd,
    periodSpentUsd: input.periodSpentUsd,
    dailyAllowanceUsd: allowance,
    todaySpentUsd: input.todaySpentUsd,
    canWake: blocked === null,
    blocked,
    reason,
  };
}

export interface SpendContext { guild: string | null; instructionId: number | null }

/**
 * A spend tracker with the same shape as createSpendTracker, but it records each call in the
 * spend table. `overCap` is the monthly cap only: a running instruction may finish past the
 * daily allowance, which only blocks new wakes (see `status().canWake`).
 */
export function createBudget(db: OrchestratorDb, monthlyCapUsd: number, opts: {
  resetDay?: number;
  now?: () => Date;
  context?: () => SpendContext;
} = {}) {
  const now = opts.now ?? (() => new Date());
  const context = opts.context ?? (() => ({ guild: null, instructionId: null }));
  const periodSpent = () => { const p = periodBounds(now(), opts.resetDay); return db.spendBetween(p.start, p.end); };
  return {
    add(model: string, usage: UsageLike): number {
      const usd = costUsd(model, usage);
      const c = context();
      db.recordSpend({
        guild: c.guild,
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
    spentUsd(): number { return periodSpent(); },
    capUsd: monthlyCapUsd,
    overCap(): boolean { return periodSpent() >= monthlyCapUsd; },
    status(): BudgetStatus {
      const at = now();
      const d = dayBounds(at);
      return budgetStatus({ monthlyCapUsd, periodSpentUsd: periodSpent(), todaySpentUsd: db.spendBetween(d.start, d.end), at, resetDay: opts.resetDay });
    },
  };
}

export type Budget = ReturnType<typeof createBudget>;

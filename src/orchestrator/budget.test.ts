import { describe, expect, test } from 'bun:test';
import { budgetStatus, createBudget, dailyAllowanceUsd, periodBounds } from './budget';
import { openDb } from './db';
import { costUsd } from '../agent/spend';

const d = (s: string) => new Date(s);

describe('budget', () => {
  test('the daily allowance is the monthly cap over the days in the month', () => {
    expect(dailyAllowanceUsd(30, d('2026-11-15T12:00:00Z'))).toBeCloseTo(1);
    expect(dailyAllowanceUsd(31, d('2026-12-01T00:00:00Z'))).toBeCloseTo(1);
    expect(dailyAllowanceUsd(28, d('2026-02-10T00:00:00Z'))).toBeCloseTo(1);
  });

  test('a reset day moves the period', () => {
    const p = periodBounds(d('2026-11-10T00:00:00Z'), 15);
    expect(new Date(p.start).toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(new Date(p.end).toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(p.days).toBe(31);
    const jan = periodBounds(d('2027-01-03T00:00:00Z'), 5);
    expect(new Date(jan.start).toISOString()).toBe('2026-12-05T00:00:00.000Z');
  });

  test('status blocks wakes at the daily allowance and at the monthly cap', () => {
    const at = d('2026-11-15T12:00:00Z');
    expect(budgetStatus({ monthlyCapUsd: 30, periodSpentUsd: 5, todaySpentUsd: 0.5, at }).canWake).toBe(true);
    const day = budgetStatus({ monthlyCapUsd: 30, periodSpentUsd: 5, todaySpentUsd: 1, at });
    expect(day).toMatchObject({ canWake: false, blocked: 'day_allowance' });
    const month = budgetStatus({ monthlyCapUsd: 30, periodSpentUsd: 30, todaySpentUsd: 0, at });
    expect(month).toMatchObject({ canWake: false, blocked: 'month_cap' });
    expect(month.reason).toContain('monthly');
  });

  test('createBudget records each call in the db and works as a SpendTracker', () => {
    const db = openDb(':memory:');
    let now = d('2026-11-15T12:00:00Z');
    const b = createBudget(db, 30, { now: () => now, context: () => ({ guild: 'g1', instructionId: 7 }) });
    const usage = { input_tokens: 100_000, output_tokens: 10_000 };
    const c = b.add('claude-opus-5-5', usage);
    expect(c).toBeCloseTo(costUsd('claude-opus-5-5', usage));
    expect(b.spentUsd()).toBeCloseTo(c);
    expect(b.overCap()).toBe(false);
    expect(b.status().canWake).toBe(true);
    b.add('claude-opus-5-5', usage);
    expect(b.status()).toMatchObject({ canWake: false, blocked: 'day_allowance' });
    now = d('2026-11-16T00:00:01Z');
    expect(b.status().canWake).toBe(true);
    now = d('2026-12-01T00:00:00Z');
    expect(b.spentUsd()).toBe(0);
    const row = db.raw.query('SELECT guild, instruction_id FROM spend LIMIT 1').get() as { guild: string; instruction_id: number };
    expect(row).toEqual({ guild: 'g1', instruction_id: 7 });
  });
});

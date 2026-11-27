import { describe, expect, test } from 'bun:test';
import { budgetStatus, createBudget, dailyAllowanceUsd, modelsFor, periodBounds } from './budget';
import { openDb } from './db';
import { costUsd } from '../agent/spend';

const d = (s: string) => new Date(s);
// 100k input + 10k output tokens of Opus 5.5 cost $0.60.
const usage = { input_tokens: 100_000, output_tokens: 10_000 };

describe('budget', () => {
  test('on the first day of the period the allowance is the cap over the days of the period', () => {
    expect(dailyAllowanceUsd(30, d('2026-11-01T12:00:00Z'))).toBeCloseTo(1);
    expect(dailyAllowanceUsd(31, d('2026-12-01T00:00:00Z'))).toBeCloseTo(1);
    expect(dailyAllowanceUsd(28, d('2026-02-01T00:00:00Z'))).toBeCloseTo(1);
  });

  test('unused allowance moves to the next days of the period', () => {
    // Nothing spent on Nov 1..14: the cap is shared over the 16 days left.
    expect(dailyAllowanceUsd(30, d('2026-11-15T12:00:00Z'))).toBeCloseTo(30 / 16);
    // $14 spent before today: $16 over 16 days.
    expect(dailyAllowanceUsd(30, d('2026-11-15T12:00:00Z'), 1, 14)).toBeCloseTo(1);
    // The last day gets all that is left.
    expect(dailyAllowanceUsd(30, d('2026-11-30T23:00:00Z'), 1, 25)).toBeCloseTo(5);
    // Overspent before today: no allowance.
    expect(dailyAllowanceUsd(30, d('2026-11-20T00:00:00Z'), 1, 31)).toBe(0);
    // A reset day: the period Nov 17 .. Dec 17 has 30 days, 13 left on Dec 4.
    expect(dailyAllowanceUsd(30, d('2026-12-04T00:00:00Z'), 17, 4)).toBeCloseTo(2);
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
    // $14.5 before today, $16 left over 16 days: allowance $1.
    expect(budgetStatus({ monthlyCapUsd: 30, periodSpentUsd: 15, todaySpentUsd: 0.5, at }).canWake).toBe(true);
    const day = budgetStatus({ monthlyCapUsd: 30, periodSpentUsd: 15, todaySpentUsd: 1, at });
    expect(day).toMatchObject({ canWake: false, blocked: 'day_allowance' });
    expect(day.dailyAllowanceUsd).toBeCloseTo(1);
    const month = budgetStatus({ monthlyCapUsd: 30, periodSpentUsd: 30, todaySpentUsd: 0, at });
    expect(month).toMatchObject({ canWake: false, blocked: 'month_cap', guild: null, globalCapUsd: 30, globalSpentUsd: 30 });
    expect(month.reason).toContain('monthly');
  });

  test('at 80% of the cap the status is routine only', () => {
    const at = d('2026-11-15T12:00:00Z');
    expect(budgetStatus({ monthlyCapUsd: 30, periodSpentUsd: 23.9, todaySpentUsd: 0, at }).routineOnly).toBe(false);
    expect(budgetStatus({ monthlyCapUsd: 30, periodSpentUsd: 24, todaySpentUsd: 0, at }).routineOnly).toBe(true);
    // The global cap also counts: the guild is low, all guilds together are at 80%.
    const g = budgetStatus({ monthlyCapUsd: 15, periodSpentUsd: 1, todaySpentUsd: 0, at, guild: 'a', global: { capUsd: 30, spentUsd: 24 } });
    expect(g).toMatchObject({ routineOnly: true, canWake: true, guild: 'a' });
  });

  test('modelsFor picks the small model and no escalation in routine-only mode', () => {
    const m = { model: 'claude-sonnet-5-5', escalationModel: 'claude-opus-5-5', smallModel: 'claude-haiku-5-5' };
    expect(modelsFor({ routineOnly: false }, m)).toEqual({ model: 'claude-sonnet-5-5', escalationModel: 'claude-opus-5-5' });
    expect(modelsFor({ routineOnly: true }, m)).toEqual({ model: 'claude-haiku-5-5', escalationModel: null });
  });

  test('createBudget records each call in the db and works as a SpendTracker', () => {
    const db = openDb(':memory:');
    let now = d('2026-11-01T12:00:00Z');
    const b = createBudget(db, 30, { now: () => now, context: () => ({ guild: 'g1', instructionId: 7 }) });
    const c = b.add('claude-opus-5-5', usage);
    expect(c).toBeCloseTo(costUsd('claude-opus-5-5', usage));
    expect(b.spentUsd()).toBeCloseTo(c);
    expect(b.overCap()).toBe(false);
    expect(b.status().canWake).toBe(true);
    b.add('claude-opus-5-5', usage);
    expect(b.status()).toMatchObject({ canWake: false, blocked: 'day_allowance' });
    now = d('2026-11-02T00:00:01Z');
    expect(b.status().canWake).toBe(true);
    now = d('2026-12-01T00:00:00Z');
    expect(b.spentUsd()).toBe(0);
    const row = db.raw.query('SELECT guild, instruction_id FROM spend LIMIT 1').get() as { guild: string; instruction_id: number };
    expect(row).toEqual({ guild: 'g1', instruction_id: 7 });
  });

  test('each guild gets an equal share and the global cap still holds', () => {
    const db = openDb(':memory:');
    const now = () => d('2026-11-30T12:00:00Z');
    const a = createBudget(db, 2, { now, guild: 'a', guildCount: 2 });
    const b = createBudget(db, 2, { now, guild: 'b', guildCount: 2 });
    expect(a.capUsd).toBe(1);
    a.add('claude-opus-5-5', usage);
    expect(a.status()).toMatchObject({ guild: 'a', monthlyCapUsd: 1, globalCapUsd: 2, routineOnly: false, canWake: true });
    expect(a.status().periodSpentUsd).toBeCloseTo(0.6);
    expect(b.spentUsd()).toBe(0);
    a.add('claude-opus-5-5', usage);
    expect(a.overCap()).toBe(true);
    expect(a.status()).toMatchObject({ blocked: 'month_cap', routineOnly: true });
    expect(a.status().reason).toContain('share');
    // Guild b is untouched, but the global spend is $1.20 of $2: 60%.
    expect(b.status()).toMatchObject({ canWake: true, routineOnly: false, globalSpentUsd: expect.closeTo(1.2) });
    // Spend without a guild (for example a channel sort before routing) counts only globally.
    const shared = createBudget(db, 2, { now });
    shared.add('claude-opus-5-5', usage);
    shared.add('claude-opus-5-5', usage);
    expect(b.spentUsd()).toBe(0);
    expect(b.overCap()).toBe(true);
    expect(b.status()).toMatchObject({ blocked: 'month_cap', routineOnly: true });
    expect(b.status().reason).toContain('monthly spend cap');
  });
});

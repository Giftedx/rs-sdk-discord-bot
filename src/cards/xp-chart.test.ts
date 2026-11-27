import { describe, expect, test } from 'bun:test';
import { validateCardData } from './templates';
import { xpChartData } from './xp-chart';

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const s = (h: number, wc: number, fm: number, at = 100) => ({
  time: NOW - h * H,
  skills: { Woodcutting: { level: 30, xp: wc }, Firemaking: { level: 20, xp: fm }, Attack: { level: 5, xp: at } },
});

describe('xpChartData', () => {
  test('XP per hour for the total and the top skills, as valid card data', () => {
    const d = xpChartData([s(24, 0, 0), s(2, 1_000, 0), s(1, 3_000, 500), s(0, 3_000, 800)], NOW)!;
    expect(d.labels).toHaveLength(24);
    expect(d.labels.at(-1)).toBe('12');
    expect(d.series.map((x) => x.name)).toEqual(['Total', 'Woodcutting', 'Firemaking']);
    expect(d.series[0]!.values.slice(-3)).toEqual([1_000, 2_500, 300]);
    expect(d.series[1]!.values.slice(-3)).toEqual([1_000, 2_000, 0]);
    expect(d.series[0]!.values.reduce((a, b) => a + b, 0)).toBe(3_800);
    expect(validateCardData('xp_chart', d)).toEqual(d);
  });

  test('at most 3 skills; the gain is 0 before the first sample', () => {
    const first = s(3, 0, 0, 0);
    const last = { ...s(0, 30, 20, 10) };
    last.skills = { ...last.skills, Mining: { level: 1, xp: 5 } } as typeof last.skills;
    const d = xpChartData([first, last], NOW)!;
    expect(d.series.map((x) => x.name)).toEqual(['Total', 'Woodcutting', 'Firemaking', 'Attack']);
    expect(d.series[0]!.values.slice(0, 20).every((v) => v === 0)).toBe(true);
  });

  test('null without 2 samples or without XP gained', () => {
    expect(xpChartData([s(1, 0, 0)], NOW)).toBeNull();
    expect(xpChartData([s(2, 5, 5), s(1, 5, 5)], NOW)).toBeNull();
  });

  test('the card rejects a series that does not have one value per label, and no series', () => {
    expect(() => validateCardData('xp_chart', { title: 't', labels: ['a', 'b'], series: [{ name: 'Total', values: [1] }] })).toThrow();
    expect(() => validateCardData('xp_chart', { title: 't', labels: ['a', 'b'], series: [] })).toThrow();
  });
});

import { expect, test } from 'bun:test';
import { reloginDelayMs } from './relogin';

test('the re-login delay is always above 10 s, from 20 s to 30 s', () => {
  for (const r of [0, 0.25, 0.5, 0.999999, 1, -1, 2]) {
    const d = reloginDelayMs(() => r);
    expect(d).toBeGreaterThan(10_000);
    expect(d).toBeGreaterThanOrEqual(20_000);
    expect(d).toBeLessThanOrEqual(30_000);
  }
});

test('the re-login delay varies', () => {
  const values = new Set(Array.from({ length: 50 }, () => reloginDelayMs()));
  expect(values.size).toBeGreaterThan(1);
  expect(reloginDelayMs(() => 0)).not.toBe(reloginDelayMs(() => 0.5));
});

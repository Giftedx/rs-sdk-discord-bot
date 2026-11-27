// Records the API spend of each month in one JSON file, and refuses new work at the cap.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// USD per 1M tokens: input, output, cache read, cache write (1.25 x input).
const PRICES: Record<string, { in: number; out: number; cacheRead: number }> = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.1 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01 },
  'claude-fable-5-2': { in: 8, out: 40, cacheRead: 0.2 },
};
// A model that is not in the table counts at the highest price, so the cap still holds.
const FALLBACK = { in: 8, out: 40, cacheRead: 0.8 };

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function costUsd(model: string, u: UsageLike): number {
  const p = PRICES[model] ?? FALLBACK;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return (u.input_tokens * p.in + u.output_tokens * p.out + cacheRead * p.cacheRead + cacheWrite * p.in * 1.25) / 1_000_000;
}

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

export function createSpendTracker(file: string, monthlyCapUsd: number, now: () => Date = () => new Date()) {
  let state = { month: monthKey(now()), usd: 0 };
  if (existsSync(file)) {
    try {
      const v = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof v.month === 'string' && typeof v.usd === 'number') state = v;
    } catch { /* a broken file starts again at 0 */ }
  }
  const roll = () => { const m = monthKey(now()); if (state.month !== m) state = { month: m, usd: 0 }; };
  return {
    add(model: string, usage: UsageLike): number {
      roll();
      const c = costUsd(model, usage);
      state.usd += c;
      writeFileSync(file, JSON.stringify(state));
      return c;
    },
    spentUsd(): number { roll(); return state.usd; },
    capUsd: monthlyCapUsd,
    overCap(): boolean { roll(); return state.usd >= monthlyCapUsd; },
  };
}

export type SpendTracker = ReturnType<typeof createSpendTracker>;

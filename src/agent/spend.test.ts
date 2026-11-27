import { describe, expect, test } from 'bun:test';
import { costUsd } from './spend';

const u = { input_tokens: 1_000_000, output_tokens: 1_000_000 };

describe('costUsd', () => {
  test('the default models have a price, and an unknown model counts at the highest price', () => {
    expect(costUsd('claude-haiku-5-5', u)).toBeCloseTo(0.6);
    expect(costUsd('claude-sonnet-5-5', u)).toBeCloseTo(12);
    expect(costUsd('claude-opus-5-5', u)).toBeCloseTo(24);
    expect(costUsd('some-new-model', u)).toBeCloseTo(48);
  });
  test('cache reads and writes', () => {
    expect(costUsd('claude-sonnet-5-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(0.1 + 2.5);
  });
});

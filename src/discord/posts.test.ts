import { describe, expect, test } from 'bun:test';
import { FakeTimers } from './fake-timers';
import { MainPosts, isMilestone, msUntilUtcHour } from './posts';

const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);

function setup(o: { maxPerHour?: number; recapHourUtc?: number; spend?: number } = {}) {
  const timers = new FakeTimers(T0);
  const sent: string[] = [];
  const logs: string[] = [];
  const posts = new MainPosts({
    channel: { send: async (c) => void sent.push(c) },
    secrets: ['hunter22'],
    timers,
    log: (l) => logs.push(l),
    maxPerHour: o.maxPerHour,
    recapHourUtc: o.recapHourUtc,
    spendSince: o.spend === undefined ? undefined : () => o.spend!,
  });
  return { timers, sent, logs, posts };
}

describe('MainPosts', () => {
  test('milestones: each 10 levels of a skill, death, instruction receipt', () => {
    expect(isMilestone({ kind: 'level_up', skill: 'Attack', from: 9, level: 10 })).toBe(true);
    expect(isMilestone({ kind: 'level_up', skill: 'Attack', from: 8, level: 12 })).toBe(true);
    expect(isMilestone({ kind: 'level_up', skill: 'Attack', from: 10, level: 11 })).toBe(false);
    expect(isMilestone({ kind: 'death' })).toBe(true);
    expect(isMilestone({ kind: 'instruction_done', instruction: 'x', outcome: 'done' })).toBe(true);
    expect(isMilestone({ kind: 'item_gain', items: [{ name: 'Logs', count: 1 }] })).toBe(false);
    expect(isMilestone({ kind: 'total_level', total: 50 })).toBe(false);
  });

  test('posts milestones with sanitized text', async () => {
    const { sent, posts } = setup();
    await posts.onEvent({ kind: 'level_up', skill: 'Attack', from: 19, level: 20 });
    await posts.onEvent({ kind: 'instruction_done', instruction: 'say hunter22', outcome: 'done' });
    expect(sent[0]).toBe('Milestone: Attack reached level 20.');
    expect(sent[1]).toContain('Receipt:');
    expect(sent[1]).not.toContain('hunter22');
  });

  test('hard cap per hour', async () => {
    const { timers, sent, logs, posts } = setup();
    for (let i = 0; i < 6; i++) await posts.onEvent({ kind: 'death' });
    expect(sent).toHaveLength(4);
    expect(logs.some((l) => l.includes('cap'))).toBe(true);
    await timers.advance(3_600_001);
    await posts.onEvent({ kind: 'death' });
    expect(sent).toHaveLength(5);
  });

  test('daily recap at the set UTC hour from the last 24 h', async () => {
    const { timers, sent, posts } = setup({ recapHourUtc: 12, spend: 0.42, maxPerHour: 100 });
    await posts.onEvent({ kind: 'level_up', skill: 'Attack', from: 1, level: 3 });
    await posts.onEvent({ kind: 'item_gain', items: [{ name: 'Logs', count: 2 }, { name: 'Coins', count: 5 }] });
    await posts.onEvent({ kind: 'death' });
    await posts.onEvent({ kind: 'instruction_done', instruction: 'x', outcome: 'done' });
    posts.start();
    await timers.advance(2 * 3_600_000 - 1);
    expect(sent.some((s) => s.startsWith('Last 24 hours'))).toBe(false);
    await timers.advance(1);
    expect(sent.at(-1)).toBe('Last 24 hours: 2 level-ups, 7 items, 1 deaths, 1 instructions, spend $0.42.');
    // The next recap comes one day later and has no old events.
    await timers.advance(24 * 3_600_000);
    expect(sent.at(-1)).toBe('Last 24 hours: 0 level-ups, 0 items, 0 deaths, 0 instructions, spend $0.42.');
    posts.stop();
    expect(timers.pending()).toBe(0);
  });

  test('msUntilUtcHour and recap hour validation', () => {
    expect(msUntilUtcHour(T0, 12)).toBe(2 * 3_600_000);
    expect(msUntilUtcHour(T0, 10)).toBe(24 * 3_600_000);
    expect(msUntilUtcHour(T0, 9)).toBe(23 * 3_600_000);
    expect(() => setup({ recapHourUtc: 24 })).toThrow();
  });
  test('a drawn card goes with the post; a failed draw sends the text alone', async () => {
    const timers = new FakeTimers(T0);
    const sent: { c: string; png?: Uint8Array }[] = [];
    const logs: string[] = [];
    let fail = false;
    const posts = new MainPosts({
      channel: { send: async (c, png) => void sent.push({ c, png }) },
      secrets: [], timers, log: (l) => logs.push(l),
      draw: async (s) => { if (fail) throw new Error('page hung'); return s.kind === 'death' ? new Uint8Array([9]) : null; },
    });
    await posts.onEvent({ kind: 'death' });
    fail = true;
    await posts.onEvent({ kind: 'death' });
    expect(sent.map((x) => x.png?.[0])).toEqual([9, undefined]);
    expect(logs.some((l) => l.includes('card not drawn'))).toBe(true);
  });
  test('record counts an event for the recap and posts nothing', async () => {
    const { sent, posts } = setup();
    posts.record({ kind: 'instruction_done', instruction: 'x', outcome: 'done' });
    expect(sent).toEqual([]);
    expect(posts.recap().instructions).toBe(1);
  });
});

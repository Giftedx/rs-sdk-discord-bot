import { describe, expect, test } from 'bun:test';
import { FakeTimers } from './fake-timers';
import { MainPosts, isMilestone, passedMilestone, mergeLevelUps, msUntilUtcHour, xpGains } from './posts';

const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);

function setup(o: { maxPerHour?: number; recapHourUtc?: number; spend?: number; mergeWindowSec?: number } = {}) {
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
    mergeWindowSec: o.mergeWindowSec ?? 0,
  });
  return { timers, sent, logs, posts };
}

describe('MainPosts', () => {
  test('milestones: the levels of MILESTONE_LEVELS, death, instruction receipt', () => {
    expect(isMilestone({ kind: 'level_up', skill: 'Attack', from: 19, level: 20 })).toBe(false);
    expect(isMilestone({ kind: 'level_up', skill: 'Attack', from: 40, level: 52 })).toBe(true);
    expect(passedMilestone({ kind: 'level_up', skill: 'Attack', from: 20, level: 80 })).toBe(75);
    expect(isMilestone({ kind: 'level_up', skill: 'Attack', from: 19, level: 20 }, [20])).toBe(true);
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
    await posts.onEvent({ kind: 'level_up', skill: 'Attack', from: 24, level: 25 });
    await posts.onEvent({ kind: 'instruction_done', instruction: 'say hunter22', outcome: 'done' });
    expect(sent[0]).toBe('🎉 Milestone: Attack 25!');
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
    // The next day has no events, so no recap is posted.
    const n = sent.length;
    await timers.advance(24 * 3_600_000);
    expect(sent).toHaveLength(n);
    posts.stop();
    expect(timers.pending()).toBe(0);
  });

  test('stop() during a recap post does not arm the next recap', async () => {
    const timers = new FakeTimers(T0);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const posts = new MainPosts({
      channel: { send: () => gate }, secrets: [], timers, log: () => {}, recapHourUtc: 12, maxPerHour: 100,
    });
    posts.record({ kind: 'death' });
    posts.start();
    await timers.advance(2 * 3_600_000);
    posts.stop();
    release();
    await timers.advance(0);
    expect(timers.pending()).toBe(0);
    posts.start();
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

describe('MainPosts merge and recap from the events table', () => {
  test('level-ups within the merge window become one post', async () => {
    const { timers, sent, posts } = setup({ mergeWindowSec: 60 });
    expect(await posts.onEvent({ kind: 'level_up', skill: 'Attack', from: 9, level: 10 })).toBe(false);
    await timers.advance(30_000);
    await posts.onEvent({ kind: 'level_up', skill: 'Attack', from: 10, level: 11 });
    await posts.onEvent({ kind: 'level_up', skill: 'Strength', from: 19, level: 20 });
    expect(sent).toEqual([]);
    await timers.advance(30_000);
    await Promise.resolve();
    // Strength 19 to 20 is not a milestone (20 is not in MILESTONE_LEVELS); Attack passed 10.
    expect(sent).toEqual(['🎉 Milestone: Attack 10 (now 11)!']);
    // A later burst with no milestone posts nothing.
    await posts.onEvent({ kind: 'level_up', skill: 'Attack', from: 11, level: 12 });
    await timers.advance(60_000);
    expect(sent).toHaveLength(1);
    expect(timers.pending()).toBe(0);
  });

  test('a merged post counts once against the hourly cap', async () => {
    const { timers, sent, posts } = setup({ mergeWindowSec: 60, maxPerHour: 1 });
    for (const skill of ['Attack', 'Strength', 'Defence']) await posts.onEvent({ kind: 'level_up', skill, from: 9, level: 10 });
    await timers.advance(60_000);
    await Promise.resolve();
    await posts.onEvent({ kind: 'death' });
    expect(sent).toHaveLength(1);
  });

  test('stop drops waiting level-ups; flushLevels posts them', async () => {
    const { sent, posts, timers } = setup({ mergeWindowSec: 60 });
    await posts.onEvent({ kind: 'level_up', skill: 'Attack', from: 9, level: 10 });
    expect(await posts.flushLevels()).toBe(true);
    await posts.onEvent({ kind: 'level_up', skill: 'Magic', from: 9, level: 10 });
    posts.stop();
    expect(timers.pending()).toBe(0);
    expect(sent).toEqual(['🎉 Milestone: Attack 10!']);
  });

  test('mergeLevelUps keeps one entry per skill', () => {
    expect(mergeLevelUps([
      { kind: 'level_up', skill: 'A', from: 3, level: 4 },
      { kind: 'level_up', skill: 'A', from: 4, level: 6 },
      { kind: 'level_up', skill: 'B', from: 1, level: 2 },
    ])).toEqual([{ kind: 'level_up', skill: 'A', from: 3, level: 6 }, { kind: 'level_up', skill: 'B', from: 1, level: 2 }]);
  });

  test('death post has the lost items and the guessed killer', async () => {
    const { sent, posts } = setup();
    await posts.onEvent({ kind: 'death', killer: 'Giant rat', lost: [{ name: 'Bronze axe', count: 1 }] });
    expect(sent[0]).toBe('The account died. Probably killed by Giant rat. Lost: 1 x Bronze axe.');
  });

  test('a death post attaches the portrait after the card; a level-up does not', async () => {
    const timers = new FakeTimers(T0);
    const got: { png?: Uint8Array; extra?: Uint8Array[] }[] = [];
    const posts = new MainPosts({
      channel: { send: async (_c, png, opts) => void got.push({ png, extra: opts?.extra }) },
      secrets: [], timers, log: () => {}, mergeWindowSec: 0,
      draw: async () => new Uint8Array([1]),
      portrait: async () => new Uint8Array([2]),
    });
    await posts.onEvent({ kind: 'death' });
    await posts.onEvent({ kind: 'level_up', skill: 'Attack', from: 9, level: 10 });
    expect(got[0]).toEqual({ png: new Uint8Array([1]), extra: [new Uint8Array([2])] });
    expect(got[1]!.extra).toBeUndefined();
  });

  test('recap from stored events survives a restart and has XP per skill', async () => {
    const timers = new FakeTimers(T0);
    const sent: string[] = [];
    const since: number[] = [];
    const posts = new MainPosts({
      channel: { send: async (c) => void sent.push(c) },
      secrets: [], timers, log: () => {},
      eventsSince: (t) => {
        since.push(t);
        return [
          { time: T0 - 1000, type: 'level_up', data: { kind: 'level_up', skill: 'Attack', from: 4, level: 6 } },
          { time: T0 - 900, type: 'level_up' },
          { time: T0 - 800, type: 'item_gain', data: { kind: 'item_gain', items: [{ name: 'Logs', count: 3 }] } },
          { time: T0 - 700, type: 'death', data: null },
          { time: T0 - 600, type: 'instruction_done', data: { kind: 'instruction_done', instruction: 'x', outcome: 'done' } },
        ];
      },
      xpGainedSince: () => ({ Attack: 300, Woodcutting: 12_000, Magic: 0 }),
    });
    expect(await posts.postRecap()).toBe(true);
    expect(since).toEqual([T0 - 86_400_000]);
    expect(sent[0]).toBe('Last 24 hours: 3 level-ups, 3 items, 1 deaths, 1 instructions. XP: Woodcutting +12,000, Attack +300.');
    expect(posts.recap().xpBySkill).toEqual([{ skill: 'Woodcutting', xp: 12_000 }, { skill: 'Attack', xp: 300 }]);
  });

  test('recap is skipped with no stored events; a failed read falls back to memory', async () => {
    const timers = new FakeTimers(T0);
    const sent: string[] = [];
    const logs: string[] = [];
    let fail = false;
    const posts = new MainPosts({
      channel: { send: async (c) => void sent.push(c) },
      secrets: [], timers, log: (l) => logs.push(l),
      eventsSince: () => { if (fail) throw new Error('db locked'); return []; },
    });
    posts.record({ kind: 'death' });
    expect(await posts.postRecap()).toBe(false);
    expect(logs.some((l) => l.includes('recap skipped'))).toBe(true);
    fail = true;
    expect(await posts.postRecap()).toBe(true);
    expect(sent[0]).toContain('1 deaths');
  });

  test('xpGains compares the first and the last sample', () => {
    expect(xpGains([])).toEqual({});
    expect(xpGains([
      { time: 2, skills: { A: { level: 2, xp: 150 }, B: { level: 1, xp: 0 } } },
      { time: 1, skills: { A: { level: 1, xp: 50 }, B: { level: 1, xp: 0 } } },
    ])).toEqual({ A: 100 });
  });

  test('the recap carries the XP chart; main posts notify unless silent', async () => {
    const timers = new FakeTimers(T0);
    const calls: { png?: Uint8Array; extra?: Uint8Array[]; silent?: boolean }[] = [];
    const charts: string[][] = [];
    const chart = new Uint8Array([7]);
    const make = (silent?: boolean, drawChart = async (d: { series: { name: string }[] }) => { charts.push(d.series.map((s) => s.name)); return chart; }) => new MainPosts({
      channel: { send: async (_c, png, o) => void calls.push({ png, ...o }) },
      secrets: [], timers, log: () => {}, silent,
      eventsSince: () => [{ time: T0 - 1, type: 'death' }],
      xpSamplesSince: (since) => [
        { time: since, skills: { Mining: { level: 1, xp: 0 } } },
        { time: T0, skills: { Mining: { level: 5, xp: 400 } } },
      ],
      drawChart,
      draw: async () => new Uint8Array([1]),
    });
    expect(await make().postRecap()).toBe(true);
    expect(charts).toEqual([['Total', 'Mining']]);
    expect(calls[0]).toEqual({ png: new Uint8Array([1]), extra: [chart], silent: false });
    expect(await make(true, async () => { throw new Error('tab gone'); }).postRecap()).toBe(true);
    expect(calls[1]).toEqual({ png: new Uint8Array([1]), silent: true });
  });
});

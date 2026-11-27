import { describe, expect, test } from 'bun:test';
import { cardFor, cardView, createAdmission, createKeyedLock, createRateLimit, jobSignal, mentionsBot, receiptEvent, stripMentions } from './helpers';

const state = { hp: 5, maxHp: 10, x: 3222, z: 3218, plane: 0, skills: { Woodcutting: { level: 10, xp: 1200 } }, inventory: {}, inCombat: false };

describe('createKeyedLock', () => {
  test('one key runs one at a time; other keys run at once', async () => {
    const withLock = createKeyedLock();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const a = withLock('box', async () => { order.push('a start'); await gate; order.push('a end'); });
    const b = withLock('box', async () => { order.push('b'); });
    const c = withLock('other', async () => { order.push('c'); });
    await c;
    expect(order).toEqual(['a start', 'c']);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['a start', 'c', 'a end', 'b']);
  });
  test('a failed holder releases the key', async () => {
    const withLock = createKeyedLock();
    // An abort ends the wait at once, and the order of the other waiters stays.
    let open!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    const order: string[] = [];
    const first = withLock('w', async () => { await gate; order.push('first'); });
    const ac = new AbortController();
    const waiting = withLock('w', async () => { order.push(ac.signal.aborted ? 'aborted' : 'ran'); }, ac.signal);
    const third = withLock('w', async () => { order.push('third'); });
    ac.abort();
    await waiting;
    expect(order).toEqual(['aborted']);
    open();
    await Promise.all([first, third]);
    expect(order).toEqual(['aborted', 'first', 'third']);
    await expect(withLock('k', async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(await withLock('k', async () => 7)).toBe(7);
  });
});

describe('createAdmission', () => {
  test('checks text, cooldown and queue length', () => {
    let t = 0;
    const admit = createAdmission({ max: 2, userCooldownMs: 1_000, now: () => t });
    expect(admit('u', '  ', 0)).toEqual({ ok: false, reason: 'empty' });
    expect(admit('u', 'x'.repeat(1_001), 0)).toEqual({ ok: false, reason: 'too_long' });
    expect(admit('u', ' chop ', 0)).toEqual({ ok: true, text: 'chop' });
    expect(admit('u', 'again', 0)).toEqual({ ok: false, reason: 'cooldown' });
    t = 2_000;
    expect(admit('u', 'again', 2)).toEqual({ ok: false, reason: 'full' });
    expect(admit('v', 'fish', 1)).toEqual({ ok: true, text: 'fish' });
  });
});

describe('cardView', () => {
  const base = { goal: null, running: null, step: null, hp: null, queueLength: 0, spend: { usedUsd: 1, capUsd: 30 }, budgetNote: null, tabStatus: 'in_game', frame: null };
  test('idle', () => {
    const v = cardView(base);
    expect(v.running).toBe(false);
    expect(v.step).toBe('Idle.');
    expect(v.note).toBeUndefined();
    expect(v.frame).toBeUndefined();
  });
  test('running, with the tab status before the budget note', () => {
    const png = new Uint8Array([1]);
    const v = cardView({ ...base, running: 'chop', step: 'job 1', tabStatus: 'reloading', budgetNote: 'daily allowance used', frame: png });
    expect(v.goal).toBe('chop');
    expect(v.step).toBe('job 1');
    expect(v.note).toBe('game tab: reloading');
    expect(v.frame).toBe(png);
  });
});

describe('cardFor', () => {
  const at = new Date('2026-11-27T10:15:00Z');
  test('level up takes the xp from the state', () => {
    expect(cardFor({ kind: 'level_up', skill: 'Woodcutting', from: 9, level: 10 }, state, null, at))
      .toEqual({ kind: 'level_up', data: { skill: 'Woodcutting', level: 10, xp: 1200 } });
  });
  test('death names the tile and the time', () => {
    expect(cardFor({ kind: 'death' }, state, null, at)).toEqual({ kind: 'death', data: { place: '3222, 3218, level 0', time: '2026-11-27 10:15 UTC' } });
  });
  test('receipt only with a receipt', () => {
    const e = receiptEvent('chop', 'finished');
    expect(cardFor(e, null, null, at)).toBeNull();
    const r = { instruction: 'chop', summary: 'ok', turns: 3, costUsd: 0.1 };
    expect(cardFor(e, null, r, at)).toEqual({ kind: 'instruction_receipt', data: r });
  });
  test('recap and events without a card', () => {
    const recap = { levelUps: 2, items: 5, deaths: 0, instructions: 1, spendUsd: null };
    const c = cardFor({ kind: 'recap', recap }, null, null, at);
    expect(c?.kind).toBe('daily_recap');
    expect(cardFor({ kind: 'total_level', total: 50 }, null, null, at)).toBeNull();
  });
});

describe('jobSignal', () => {
  test('the orchestrator stops the job, not the instruction', () => {
    const instr = new AbortController();
    const js = jobSignal(instr.signal);
    js.abort('no progress');
    expect(js.signal.aborted).toBe(true);
    expect(js.reason()).toBe('no progress');
    expect(instr.signal.aborted).toBe(false);
  });
  test('the instruction signal stops the job with no reason', () => {
    const instr = new AbortController();
    const js = jobSignal(instr.signal);
    instr.abort();
    expect(js.signal.aborted).toBe(true);
    expect(js.reason()).toBeNull();
  });
});

describe('mentions', () => {
  test('a mention of the bot user or of the role of the bot counts', () => {
    expect(mentionsBot(['1'], [], '1', null)).toBe(true);
    expect(mentionsBot([], ['9'], '1', '9')).toBe(true);
    expect(mentionsBot([], ['8'], '1', '9')).toBe(false);
    expect(mentionsBot(['2'], ['9'], '1', null)).toBe(false);
  });
  test('stripMentions removes user and role mentions', () => {
    expect(stripMentions('<@&123> help')).toBe('help');
    expect(stripMentions('<@!12> <@34> chop trees')).toBe('chop trees');
  });
});

describe('createRateLimit', () => {
  test('allows max per window, per key', () => {
    let t = 0;
    const allow = createRateLimit(2, 60_000, () => t);
    expect([allow('a'), allow('a'), allow('a'), allow('b')]).toEqual([true, true, false, true]);
    t = 61_000;
    expect(allow('a')).toBe(true);
  });
});

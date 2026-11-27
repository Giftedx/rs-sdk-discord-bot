import { describe, expect, test } from 'bun:test';
import {
  cardFor, cardLastEvent, cardView, retryUntil, createAdmission, createDeathEnricher, createKeyedLock, createRateLimit, jobSignal, mentionsBot, receiptChanges, receiptEvent,
  scriptFromProgress, stripMentions, tabLine, takeRevisionFlag, wakeContextText,
} from './helpers';

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
  test('the reason of the tab, the inventory, xp samples, the last event and the script', () => {
    const samples = [{ time: 0, skills: {} }, { time: 60_000, skills: {} }];
    const v = cardView({ ...base, running: 'chop', tabStatus: 'login_refused', tabReason: 'Invalid username or password.', inventory: { used: 3, max: 28 }, xpSamples: samples, lastEvent: 'Got 1 x Logs.', script: 'chop-trees' });
    expect(v.note).toBe('game tab: login_refused (Invalid username or password.)');
    expect(v.inventory).toEqual({ used: 3, max: 28 });
    expect(v.xpSamples).toBe(samples);
    expect(v.lastEvent).toBe('Got 1 x Logs.');
    expect(v.script).toBe('chop-trees');
    const idle = cardView({ ...base, script: 'chop-trees', xpSamples: [samples[0]!] });
    expect(idle.script).toBeUndefined();
    expect(idle.xpSamples).toBeUndefined();
  });
});

describe('tabLine', () => {
  test('adds the reason only out of the game', () => {
    expect(tabLine('in_game', 'old')).toBe('in_game');
    expect(tabLine('reloading', null)).toBe('reloading');
    expect(tabLine('out_of_game', 'The server is being updated.')).toBe('out_of_game (The server is being updated.)');
  });
});

describe('receiptChanges', () => {
  test('lists the skills that gained xp and the items whose count changed', () => {
    const before = { ...state, skills: { Woodcutting: { level: 10, xp: 1200 }, Attack: { level: 1, xp: 0 } }, inventory: { 'Bronze axe': 1, Coins: 5 } };
    const after = { ...state, skills: { Woodcutting: { level: 11, xp: 1400 }, Attack: { level: 1, xp: 0 } }, inventory: { 'Bronze axe': 1, Logs: 7 } };
    expect(receiptChanges(before, after)).toEqual({
      skills: [{ name: 'Woodcutting', before: 10, after: 11, xp: 200 }],
      inventory: [{ name: 'Logs', before: 0, after: 7 }, { name: 'Coins', before: 5, after: 0 }],
    });
    expect(receiptChanges(null, after)).toEqual({ skills: [], inventory: [] });
  });
});

describe('createDeathEnricher', () => {
  const alive = { ...state, hp: 8, inCombat: true, inventory: { 'Bronze axe': 1, Logs: 3 } };
  test('a death at hp 0 waits for the respawn, then lists the lost items and the killer', () => {
    const enrich = createDeathEnricher();
    expect(enrich([], alive, 'Giant rat')).toEqual([]);
    expect(enrich([{ kind: 'death' }], { ...alive, hp: 0 }, undefined)).toEqual([]);
    expect(enrich([], { ...alive, hp: 10, inventory: { 'Bronze axe': 1 } }, undefined))
      .toEqual([{ kind: 'death', killer: 'Giant rat', lost: [{ name: 'Logs', count: 3 }] }]);
  });
  test('a death found at the respawn is enriched at once; other events pass', () => {
    const enrich = createDeathEnricher();
    enrich([], alive, undefined);
    const gain = { kind: 'item_gain' as const, items: [{ name: 'Coins', count: 1 }] };
    expect(enrich([{ kind: 'death' }, gain], { ...alive, hp: 10, inventory: { Coins: 1 } }, undefined))
      .toEqual([{ kind: 'death', lost: [{ name: 'Bronze axe', count: 1 }, { name: 'Logs', count: 3 }] }, gain]);
  });
  test('without a respawn the death posts after holdMs, with no lost items', () => {
    let t = 0;
    const enrich = createDeathEnricher({ holdMs: 1_000, now: () => t });
    enrich([], alive, 'Goblin');
    expect(enrich([{ kind: 'death' }], { ...alive, hp: 0 }, undefined)).toEqual([]);
    t = 1_000;
    expect(enrich([], { ...alive, hp: 0 }, undefined)).toEqual([{ kind: 'death', killer: 'Goblin' }]);
  });
});

describe('scriptFromProgress', () => {
  test('reads the saved script name, null for new code, undefined for other lines', () => {
    expect(scriptFromProgress('Running saved script `chop-trees`.')).toBe('chop-trees');
    expect(scriptFromProgress('Running new code.')).toBeNull();
    expect(scriptFromProgress('Looking at the game.')).toBeUndefined();
  });
});

describe('wakeContextText', () => {
  test('one short block with goal, queue, tab and state', () => {
    expect(wakeContextText({ goal: null, queue: ['mine copper', 'bank'], tab: 'in_game', hp: { hp: 5, maxHp: 10 }, position: { x: 1, z: 2, plane: 0 }, inventoryUsed: 4, routineOnly: true }))
      .toBe('Goal: none set. Queue: 2 waiting, next: mine copper. Game tab: in_game. HP 5/10. Position 1, 2, level 0. Inventory 4/28. The budget is low: do only routine work, keep it short.');
    expect(wakeContextText({ goal: 'level 20', queue: [], tab: 'reloading', hp: null, position: null, inventoryUsed: null, routineOnly: false }))
      .toBe('Goal: level 20. Queue: empty. Game tab: reloading. No fresh game state.');
  });
});

describe('takeRevisionFlag', () => {
  test('reads the first line and removes the file; null without a file', () => {
    const removed: string[] = [];
    const fs = { read: () => '2026-11-27T10:00Z aaa bbb\n', remove: (p: string) => { removed.push(p); } };
    expect(takeRevisionFlag('/x/revision-changed', fs)).toBe('2026-11-27T10:00Z aaa bbb');
    expect(removed).toEqual(['/x/revision-changed']);
    expect(takeRevisionFlag('/x/none', { read: () => { throw new Error('ENOENT'); }, remove: () => {} })).toBeNull();
  });
});

describe('cardFor', () => {
  const at = new Date('2026-11-27T10:15:00Z');
  test('level up takes the xp from the state', () => {
    expect(cardFor({ kind: 'level_up', skill: 'Woodcutting', from: 9, level: 10 }, state, null, at))
      .toEqual({ kind: 'level_up', data: { skill: 'Woodcutting', level: 10, xp: 1200, from: 9, totalLevel: 10 } });
  });
  test('death carries the lost items and the killer guess', () => {
    expect(cardFor({ kind: 'death', lost: [{ name: 'Bronze axe', count: 1 }], killer: 'Goblin' }, state, null, at)?.data)
      .toEqual({ place: '3222, 3218, level 0', time: '2026-11-27 10:15 UTC', items: [{ name: 'Bronze axe', count: 1 }], killer: 'Goblin' });
  });
  test('recap carries the xp per skill', () => {
    const recap = { levelUps: 0, items: 0, deaths: 0, instructions: 1, spendUsd: null, xpBySkill: [{ skill: 'Attack', xp: 300 }] };
    expect(cardFor({ kind: 'recap', recap }, null, null, at)?.data).toMatchObject({ xp: [{ skill: 'Attack', xp: 300 }] });
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

describe('cardLastEvent', () => {
  test('skips item gains, shortens a finished request, cuts long text at a word', () => {
    expect(cardLastEvent([{ type: 'item_gain', text: 'Got 1 x Logs.' }, { type: 'level_up', text: 'Woodcutting level 62 (was 61).' }])).toBe('Woodcutting level 62 (was 61).');
    expect(cardLastEvent([{ type: 'instruction_done', text: 'Instruction ended (finished: long summary (with brackets)): chop trees', data: { kind: 'instruction_done', instruction: 'chop trees', outcome: 'finished: long summary (with brackets)' } }])).toBe('Finished: chop trees');
    expect(cardLastEvent([{ type: 'instruction_done', text: 'x', data: { instruction: 'fish', outcome: 'time_cap' } }])).toBe('Ended: fish');
    const long = cardLastEvent([{ type: 'death', text: 'word '.repeat(40) }])!;
    expect(long.length).toBeLessThanOrEqual(90);
    expect(long.endsWith('…')).toBe(true);
    expect(cardLastEvent([{ type: 'item_gain', text: 'x' }])).toBeNull();
  });
});

describe('retryUntil', () => {
  test('retries until it works, stops on a final error, and gives up at the deadline', async () => {
    let t = 0;
    const clock = { now: () => t, sleep: async (ms: number) => { t += ms; } };
    let calls = 0;
    expect(await retryUntil(async () => { if (++calls < 3) throw new Error('down'); return 'ok'; }, { deadlineMs: 60_000, delayMs: 2_000, shouldRetry: () => true, ...clock })).toBe('ok');
    expect(calls).toBe(3);
    await expect(retryUntil(async () => { throw new Error('bad token'); }, { deadlineMs: 60_000, delayMs: 2_000, shouldRetry: () => false, ...clock })).rejects.toThrow('bad token');
    t = 0; calls = 0;
    await expect(retryUntil(async () => { calls++; throw new Error('down'); }, { deadlineMs: 10_000, delayMs: 2_000, shouldRetry: () => true, ...clock })).rejects.toThrow('down');
    expect(calls).toBe(6);
  });
});

describe('secrets and cuts', () => {
  test('cardLastEvent hides a secret before it cuts the text', () => {
    const secret = 'hunter2secretvalue';
    const text = `${'word '.repeat(16)}${secret} and more words after it`;
    const out = cardLastEvent([{ type: 'death', text }], [secret])!;
    expect(out).not.toContain('hunter2');
  });
});

import { describe, expect, test } from 'bun:test';
import { REVIEW_TEXT } from '../agent/loop';
import { compactState, createWakeScheduler, FULL_INVENTORY_TEXT, parseNotesReviewHour, reviewWindowStart, type CompactState, type WakeInput } from './wakes';

const MIN = 60_000;

const st = (over: Partial<CompactState> = {}): CompactState => ({
  hp: 40, maxHp: 40, x: 3200, z: 3200, level: 0, inCombat: false,
  skills: { Fishing: { level: 10, xp: 1200 } }, inventory: { 'Raw shrimps': 3 }, ...over,
});

const input = (over: Partial<WakeInput> = {}): WakeInput => ({
  guild: 'g1', now: 0, state: st(), instructionRunning: false, jobRunning: false, hasWaiting: false, dueTimers: [], budgetOk: true, ...over,
});

const types = (a: { type: string }[]) => a.map(x => x.type);

describe('compactState', () => {
  test('keeps hp, position, skills, inventory counts and combat', () => {
    const s = compactState({
      inGame: true,
      player: { hp: 5, maxHp: 10, worldX: 3222, worldZ: 3218, level: 0, combat: { inCombat: true } },
      skills: [{ name: 'Attack', level: 3, baseLevel: 2, experience: 150 }],
      inventory: [{ name: 'Coins', count: 10 }, { name: 'Coins', count: 5 }, { name: 'Bread', count: 1 }],
    } as never)!;
    expect(s).toEqual({ hp: 5, maxHp: 10, x: 3222, z: 3218, level: 0, inCombat: true, skills: { Attack: { level: 2, xp: 150 } }, inventory: { Coins: 15, Bread: 1 }, slots: 3 });
    expect(compactState({ inGame: false, player: null } as never)).toBeNull();
    expect(compactState(null)).toBeNull();
  });
});

describe('wake scheduler', () => {
  test('a waiting instruction starts only when none runs and the budget allows', () => {
    const w = createWakeScheduler();
    expect(types(w.tick(input({ hasWaiting: true })))).toEqual(['start_instruction']);
    expect(w.tick(input({ hasWaiting: true, instructionRunning: true }))).toEqual([]);
    expect(w.tick(input({ hasWaiting: true, budgetOk: false }))).toEqual([]);
  });

  test('a due timer wakes with its note as the instruction, user "timer", only when idle', () => {
    const w = createWakeScheduler();
    const due = [{ id: 4, note: 'check the job' }];
    expect(w.tick(input({ dueTimers: due, instructionRunning: true }))).toEqual([]);
    expect(types(w.tick(input({ dueTimers: due, hasWaiting: true })))).toEqual(['start_instruction']);
    expect(w.tick(input({ dueTimers: due }))).toEqual([{ type: 'wake', kind: 'timer', user: 'timer', text: 'check the job', timerId: 4 }]);
  });

  test('low HP fires once below 30% and arms again after recovery', () => {
    const w = createWakeScheduler();
    w.tick(input({ state: st({ hp: 40 }) }));
    const a = w.tick(input({ now: 1000, state: st({ hp: 10 }) }));
    expect(a.find(x => x.type === 'wake')).toMatchObject({ kind: 'trigger', trigger: 'low_hp', user: 'trigger' });
    expect(w.tick(input({ now: 2000, state: st({ hp: 9 }) })).some(x => x.type === 'wake')).toBe(false);
    w.tick(input({ now: 3000, state: st({ hp: 30 }) }));
    expect(w.tick(input({ now: 4000, state: st({ hp: 5 }) })).some(x => x.type === 'wake')).toBe(true);
  });

  test('death by HP 0 fires once; the respawn right after does not fire again', () => {
    const w = createWakeScheduler();
    w.tick(input({ state: st({ hp: 10, inCombat: true }) }));
    const a = w.tick(input({ now: 1000, state: st({ hp: 0, inCombat: true }) }));
    expect(a.find(x => x.type === 'wake')).toMatchObject({ trigger: 'death' });
    const b = w.tick(input({ now: 3000, state: st({ hp: 40, x: 3222, z: 3218 }) }));
    expect(b.some(x => x.type === 'wake')).toBe(false);
  });

  test('a jump to the spawn point after combat counts as a death', () => {
    const w = createWakeScheduler();
    w.tick(input({ state: st({ hp: 20, inCombat: true }) }));
    const a = w.tick(input({ now: 5000, state: st({ hp: 40, x: 3222, z: 3218 }) }));
    expect(a.find(x => x.type === 'wake')).toMatchObject({ trigger: 'death' });
  });

  test('a walk to the spawn point with no combat is not a death', () => {
    const w = createWakeScheduler();
    w.tick(input({ state: st() }));
    expect(w.tick(input({ now: 5000, state: st({ x: 3222, z: 3218 }) })).some(x => x.type === 'wake')).toBe(false);
  });

  test('low HP in combat during a running job stops the job instead of a new wake', () => {
    const w = createWakeScheduler();
    w.tick(input({ instructionRunning: true, jobRunning: true }));
    const a = w.tick(input({ now: 1000, instructionRunning: true, jobRunning: true, state: st({ hp: 5, inCombat: true }) }));
    expect(types(a)).toEqual(['event', 'abort_job']);
  });

  test('low HP out of combat does not stop the job: it may be the walk away from danger', () => {
    const w = createWakeScheduler();
    w.tick(input({ instructionRunning: true, jobRunning: true }));
    const a = w.tick(input({ now: 60_000, instructionRunning: true, jobRunning: true, state: st({ hp: 5, inCombat: false }) }));
    expect(types(a)).toEqual(['event']);
  });

  test('watchdog: no progress for 5 minutes while a job runs stops the job', () => {
    const w = createWakeScheduler();
    const run = (now: number, s = st()) => w.tick(input({ now, state: s, instructionRunning: true, jobRunning: true }));
    expect(run(0)).toEqual([]);
    expect(run(4 * MIN)).toEqual([]);
    expect(run(5 * MIN).find(x => x.type === 'abort_job')).toBeDefined();
    // It fires again only after another full period.
    expect(run(6 * MIN)).toEqual([]);
    // Progress resets the clock.
    expect(run(9 * MIN, st({ skills: { Fishing: { level: 10, xp: 1300 } } }))).toEqual([]);
    expect(run(13 * MIN, st({ skills: { Fishing: { level: 10, xp: 1300 } } }))).toEqual([]);
    expect(run(14 * MIN, st({ skills: { Fishing: { level: 10, xp: 1300 } } })).some(x => x.type === 'abort_job')).toBe(true);
  });

  test('watchdog clock starts again with each new job', () => {
    const w = createWakeScheduler({ watchdogMs: 2 * MIN });
    w.tick(input({ now: 0, jobRunning: true, instructionRunning: true }));
    w.tick(input({ now: 1 * MIN, jobRunning: false, instructionRunning: true }));
    expect(w.tick(input({ now: 2.5 * MIN, jobRunning: true, instructionRunning: true }))).toEqual([]);
    expect(w.tick(input({ now: 4.5 * MIN, jobRunning: true, instructionRunning: true })).some(x => x.type === 'abort_job')).toBe(true);
  });

  test('at most 6 timer and trigger wakes per hour per guild', () => {
    const w = createWakeScheduler();
    const due = [{ id: 1, note: 'n' }];
    let wakes = 0;
    for (let i = 0; i < 10; i++) if (w.tick(input({ now: i * MIN, dueTimers: due })).some(x => x.type === 'wake')) wakes++;
    expect(wakes).toBe(6);
    expect(w.tick(input({ guild: 'g2', now: 10 * MIN, dueTimers: due })).some(x => x.type === 'wake')).toBe(true);
    expect(w.tick(input({ now: 61 * MIN, dueTimers: due })).some(x => x.type === 'wake')).toBe(true);
    // A trigger past the limit leaves an event and no wake.
    const v = createWakeScheduler();
    for (let i = 0; i < 6; i++) v.tick(input({ now: i, dueTimers: due }));
    const t = v.tick(input({ now: 10, state: st({ hp: 5 }) }));
    expect(t.some(x => x.type === 'wake')).toBe(false);
    expect(t.find(x => x.type === 'event' && x.event === 'wake_skipped')).toBeDefined();
  });

  test('no wake when the budget is used up, but the trigger event is still kept', () => {
    const w = createWakeScheduler();
    w.tick(input({ budgetOk: false }));
    const a = w.tick(input({ now: 1000, budgetOk: false, state: st({ hp: 5 }), dueTimers: [{ id: 1, note: 'n' }] }));
    expect(a.some(x => x.type === 'wake')).toBe(false);
    expect(a.filter(x => x.type === 'event').map(x => (x as { event: string }).event)).toEqual(['low_hp', 'wake_skipped']);
  });
});

describe('client death signal', () => {
  test('a new lastDeathTick wakes once; the respawn guess is off with the signal', () => {
    const w = createWakeScheduler();
    w.tick(input({ now: 0, state: st({ deathTick: null }) }));
    const a = w.tick(input({ now: 1_000, state: st({ deathTick: 50 }) }));
    expect(a.filter(x => x.type === 'wake').map(x => (x as { trigger?: string }).trigger)).toEqual(['death']);
    expect(w.tick(input({ now: 2_000, state: st({ deathTick: 50 }) })).filter(x => x.type === 'wake')).toEqual([]);
    // Combat far away, then a jump to the spawn with the signal: no death guess.
    const v = createWakeScheduler();
    v.tick(input({ now: 0, state: st({ inCombat: true, x: 3100, z: 3100, deathTick: null }) }));
    expect(v.tick(input({ now: 1_000, state: st({ x: 3222, z: 3218, deathTick: null }) })).filter(x => x.type === 'wake')).toEqual([]);
  });

  test('compactState keeps lastDeathTick', () => {
    const s = compactState({ inGame: true, player: { hp: 1, maxHp: 1, worldX: 0, worldZ: 0, level: 0, combat: { inCombat: false }, lastDeathTick: 7 }, skills: [], inventory: [] } as never)!;
    expect(s.deathTick).toBe(7);
  });
});

describe('full inventory wake', () => {
  const full = (n = 28) => st({ slots: n });
  test('wakes once when the inventory gets full, again only after it had room, at most once per 30 min', () => {
    const w = createWakeScheduler();
    expect(w.tick(input({ now: 0, state: full() }))).toEqual([{ type: 'wake', kind: 'trigger', user: 'trigger', text: FULL_INVENTORY_TEXT, trigger: 'inventory_full' }]);
    expect(w.tick(input({ now: 29 * MIN, state: full() }))).toEqual([]);
    // Still full after the cooldown: no new wake until the inventory had room.
    expect(w.tick(input({ now: 30 * MIN, state: full() }))).toEqual([]);
    w.tick(input({ now: 31 * MIN, state: full(20) }));
    expect(types(w.tick(input({ now: 32 * MIN, state: full() })))).toEqual(['wake']);
  });

  test('no wake with 27 slots, a job, an instruction, a waiting request or no budget', () => {
    const w = createWakeScheduler();
    expect(w.tick(input({ state: full(27) }))).toEqual([]);
    expect(w.tick(input({ state: full(), jobRunning: true })).filter(x => x.type === 'wake')).toEqual([]);
    expect(w.tick(input({ state: full(), instructionRunning: true }))).toEqual([]);
    expect(w.tick(input({ state: full(), hasWaiting: true }))).toEqual([{ type: 'start_instruction' }]);
    expect(w.tick(input({ state: full(), budgetOk: false }))).toEqual([]);
    expect(types(w.tick(input({ state: full() })))).toEqual(['wake']);
  });

  test('the rate limit skips it once per cooldown, with an event', () => {
    const w = createWakeScheduler({ maxWakesPerHour: 0 });
    expect(w.tick(input({ now: 0, state: full() })).map(x => x.type === 'event' ? x.event : x.type)).toEqual(['wake_skipped']);
    expect(w.tick(input({ now: MIN, state: full() }))).toEqual([]);
  });
});

describe('daily notes review wake', () => {
  const H = 3_600_000;
  const DAY = 24 * H;
  const review = { type: 'wake', kind: 'review', user: 'review', text: REVIEW_TEXT } as const;
  test('parses NOTES_REVIEW_HOUR_UTC', () => {
    expect(parseNotesReviewHour(undefined)).toBeNull();
    expect(parseNotesReviewHour('')).toBeNull();
    expect(parseNotesReviewHour('4')).toBe(4);
    expect(() => parseNotesReviewHour('24')).toThrow(/NOTES_REVIEW_HOUR_UTC/);
    expect(() => parseNotesReviewHour('4.5')).toThrow(/NOTES_REVIEW_HOUR_UTC/);
  });

  test('the window starts at the hour today, or yesterday before the hour', () => {
    expect(reviewWindowStart(10 * DAY + 5 * H, 4)).toBe(10 * DAY + 4 * H);
    expect(reviewWindowStart(10 * DAY + 3 * H, 4)).toBe(9 * DAY + 4 * H);
  });

  test('off when no hour is set', () => {
    const w = createWakeScheduler();
    expect(w.tick(input({ now: 10 * DAY + 5 * H, state: null }))).toEqual([]);
  });

  test('once a day at the hour, counted by the rate limit, not over a database record', () => {
    const w = createWakeScheduler({ notesReviewHourUtc: 4, maxWakesPerHour: 1 });
    expect(w.tick(input({ now: 10 * DAY + 3 * H, state: null, lastReviewAt: 9 * DAY + 4 * H }))).toEqual([]);
    expect(w.tick(input({ now: 10 * DAY + 4 * H, state: null, lastReviewAt: 9 * DAY + 4 * H }))).toEqual([review]);
    // The review used the one wake of the hour: a due timer waits.
    expect(w.tick(input({ now: 10 * DAY + 4 * H + MIN, state: null, dueTimers: [{ id: 1, note: 'x' }] }))).toEqual([]);
    expect(w.tick(input({ now: 10 * DAY + 6 * H, state: null }))).toEqual([]);
    expect(types(w.tick(input({ now: 11 * DAY + 4 * H, state: null })))).toEqual(['wake']);
    // After a restart, the database record stops a second review on the same day.
    const v = createWakeScheduler({ notesReviewHourUtc: 4 });
    expect(v.tick(input({ now: 10 * DAY + 8 * H, state: null, lastReviewAt: 10 * DAY + 4 * H }))).toEqual([]);
  });

  test('no review while a job, an instruction or a waiting request runs, or without budget', () => {
    const w = createWakeScheduler({ notesReviewHourUtc: 0 });
    const now = 10 * DAY + H;
    expect(w.tick(input({ now, state: null, jobRunning: true }))).toEqual([]);
    expect(w.tick(input({ now, state: null, instructionRunning: true }))).toEqual([]);
    expect(w.tick(input({ now, state: null, budgetOk: false }))).toEqual([]);
    expect(w.tick(input({ now, state: null, hasWaiting: true }))).toEqual([{ type: 'start_instruction' }]);
    expect(w.tick(input({ now, state: null }))).toEqual([review]);
  });
});

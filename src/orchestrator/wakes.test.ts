import { describe, expect, test } from 'bun:test';
import { compactState, createWakeScheduler, type CompactState, type WakeInput } from './wakes';

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
    expect(s).toEqual({ hp: 5, maxHp: 10, x: 3222, z: 3218, level: 0, inCombat: true, skills: { Attack: { level: 2, xp: 150 } }, inventory: { Coins: 15, Bread: 1 } });
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

  test('a trigger during a running job stops the job instead of a new wake', () => {
    const w = createWakeScheduler();
    w.tick(input({ instructionRunning: true, jobRunning: true }));
    const a = w.tick(input({ now: 1000, instructionRunning: true, jobRunning: true, state: st({ hp: 5 }) }));
    expect(types(a)).toEqual(['event', 'abort_job']);
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

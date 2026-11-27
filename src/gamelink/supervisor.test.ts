import { describe, expect, test } from 'bun:test';
import { createSupervisor } from './supervisor';

function fakeTab(states: boolean[]) {
  const calls = { keepAlive: 0, reload: 0 };
  let i = 0;
  return {
    calls,
    tab: {
      inGame: async () => states[Math.min(i++, states.length - 1)] as boolean,
      keepAlive: async () => { calls.keepAlive++; },
      reload: async () => { calls.reload++; },
    },
  };
}

describe('supervisor', () => {
  test('in game with the idle guard on resets the idle timer', async () => {
    const f = fakeTab([true, true]);
    const s = createSupervisor({ tab: f.tab, idleGuard: true });
    await s.check();
    await s.check();
    expect(s.status()).toBe('in_game');
    expect(f.calls.keepAlive).toBe(2);
  });

  test('idle guard off sends no keepAlive', async () => {
    const f = fakeTab([true]);
    const s = createSupervisor({ tab: f.tab, idleGuard: false });
    await s.check();
    expect(f.calls.keepAlive).toBe(0);
  });

  test('reloads only after the grace time and the relogin wait', async () => {
    let t = 0;
    const f = fakeTab([true, false]);
    const s = createSupervisor({ tab: f.tab, idleGuard: false, outGraceMs: 60_000, reloginDelay: () => 20_000, now: () => t });
    await s.check();                 // in game
    t = 1_000; await s.check();      // out, grace starts
    expect(s.status()).toBe('out_of_game');
    t = 50_000; await s.check();     // still in grace
    expect(f.calls.reload).toBe(0);
    t = 61_000; await s.check();     // grace over, wait scheduled
    expect(f.calls.reload).toBe(0);
    t = 70_000; await s.check();     // wait not over
    expect(f.calls.reload).toBe(0);
    t = 81_000; await s.check();     // reload
    expect(f.calls.reload).toBe(1);
    t = 100_000; await s.check();    // new grace time after a reload
    expect(f.calls.reload).toBe(1);
  });

  test('an error from inGame counts as out of the game', async () => {
    const s = createSupervisor({
      tab: { inGame: async () => { throw new Error('page closed'); }, keepAlive: async () => {}, reload: async () => {} },
      idleGuard: false,
    });
    await s.check();
    expect(s.status()).toBe('starting');
  });
});

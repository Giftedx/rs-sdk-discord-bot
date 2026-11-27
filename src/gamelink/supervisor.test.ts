import { describe, expect, test } from 'bun:test';
import { backoffFactor, classifyLoginMessage, createSupervisor, nextFirstLoginAt } from './supervisor';

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

  test('stop() waits for a reload in flight, and a stopped supervisor reloads no more', async () => {
    let t = 0;
    let finish: () => void = () => {};
    let reloads = 0;
    let reloadDone = false;
    const s = createSupervisor({
      tab: {
        inGame: async () => false,
        keepAlive: async () => {},
        reload: () => { reloads++; return new Promise<void>(r => { finish = () => { reloadDone = true; r(); }; }); },
      },
      idleGuard: false, startDelayMs: 0, now: () => t,
    });
    const running = s.check();          // first login: the reload hangs
    expect(reloads).toBe(1);
    let stopped = false;
    const stopping = s.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);        // the reload is still in flight
    finish();
    await stopping;
    await running;
    expect(reloadDone).toBe(true);
    t = 1_000_000;
    await s.check();                    // stopped: no check, no reload
    expect(reloads).toBe(1);
  });

  test('an error from inGame counts as out of the game', async () => {
    const s = createSupervisor({
      tab: { inGame: async () => { throw new Error('page closed'); }, keepAlive: async () => {}, reload: async () => {} },
      idleGuard: false,
    });
    await s.check();
    expect(s.status()).toBe('starting');
  });

  test('back-off: delay * min(2^(n-1), 16) after n failed reloads; reset in the game', async () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(backoffFactor)).toEqual([1, 1, 2, 4, 8, 16, 16, 16]);
    let t = 0;
    let inGame = false;
    const reloads: number[] = [];
    const s = createSupervisor({
      tab: { inGame: async () => inGame, keepAlive: async () => {}, reload: async () => { reloads.push(t); } },
      idleGuard: false, outGraceMs: 10_000, reloginDelay: () => 20_000, now: () => t,
    });
    // Each round: the grace time ends, the wait is scheduled, then the reload comes.
    const round = async () => {
      const start = t;
      t = start + 10_000; await s.check();                  // grace over: wait scheduled
      const before = reloads.length;
      for (let i = 0; i < 400 && reloads.length === before; i++) { t += 1_000; await s.check(); }
      return reloads.at(-1)! - (start + 10_000);
    };
    await s.check();                                         // out since 0
    expect(await round()).toBe(20_000);                      // n = 0
    expect(await round()).toBe(20_000);                      // n = 1
    expect(await round()).toBe(40_000);                      // n = 2
    expect(await round()).toBe(80_000);                      // n = 3
    inGame = true; await s.check();
    expect(s.status()).toBe('in_game');
    inGame = false; await s.check();
    expect(await round()).toBe(20_000);                      // reset
  });

  test('start delay: no login before it, then one reload as the first login', async () => {
    let t = 1_000;
    const f = fakeTab([false]);
    const s = createSupervisor({ tab: f.tab, idleGuard: false, startDelayMs: 25_000, now: () => t });
    await s.check();
    t = 25_999; await s.check();
    expect(f.calls.reload).toBe(0);
    expect(s.status()).toBe('starting');
    t = 26_000; await s.check();
    expect(f.calls.reload).toBe(1);
    t = 30_000; await s.check();                             // in the new grace time
    expect(f.calls.reload).toBe(1);
  });

  test('first logins of several tabs are at least 15 s apart', () => {
    expect(nextFirstLoginAt(null, 0, 22_000)).toBe(22_000);
    expect(nextFirstLoginAt(22_000, 1_000, 20_000)).toBe(37_000);
    expect(nextFirstLoginAt(22_000, 10_000, 29_000)).toBe(39_000);
  });

  test('classifies the login messages of the client', () => {
    expect(classifyLoginMessage(' Invalid username or password.')).toBe('refused');
    expect(classifyLoginMessage('Your account has been disabled. Please check your message-centre for details.')).toBe('refused');
    expect(classifyLoginMessage('RuneScape has been updated! Please reload this page.')).toBe('updated');
    expect(classifyLoginMessage('The server is being updated. Please wait 1 minute and try again.')).toBe('other');
    expect(classifyLoginMessage('')).toBeNull();
    expect(classifyLoginMessage(null)).toBeNull();
  });

  test('a refused login stops all reloads and reports the reason', async () => {
    let t = 0;
    const f = fakeTab([false]);
    const lines: string[] = [];
    const s = createSupervisor({ tab: { ...f.tab, loginMessage: async () => 'Invalid username or password.' }, idleGuard: false, outGraceMs: 1_000, reloginDelay: () => 11_000, now: () => t, log: l => lines.push(l) });
    for (; t < 600_000; t += 5_000) await s.check();
    expect(f.calls.reload).toBe(0);
    expect(s.status()).toBe('login_refused');
    expect(s.reason()).toBe('Invalid username or password.');
    expect(lines.filter(l => l.includes('refused'))).toHaveLength(1);
  });

  test('an updated client reloads at once, one time; then the normal back-off', async () => {
    let t = 0;
    const f = fakeTab([false]);
    const s = createSupervisor({ tab: { ...f.tab, loginMessage: async () => 'RuneScape has been updated! Please reload this page.' }, idleGuard: false, outGraceMs: 60_000, reloginDelay: () => 20_000, now: () => t });
    await s.check();
    expect(f.calls.reload).toBe(1);
    expect(s.reason()).toMatch(/updated/);
    t = 5_000; await s.check();
    expect(f.calls.reload).toBe(1);
    t = 60_000; await s.check();                             // grace over: wait scheduled
    t = 80_000; await s.check();
    expect(f.calls.reload).toBe(2);
  });

  test('onInGame runs on each entry into the game; reason clears', async () => {
    let n = 0;
    const f = fakeTab([false, true, true, false, true]);
    const s = createSupervisor({ tab: { ...f.tab, loginMessage: async () => 'Connecting to server...' }, idleGuard: false, onInGame: () => { n++; } });
    await s.check();
    expect(s.reason()).toBe('Connecting to server...');
    for (let i = 0; i < 4; i++) await s.check();
    expect(n).toBe(2);
    expect(s.reason()).toBeNull();
  });
});

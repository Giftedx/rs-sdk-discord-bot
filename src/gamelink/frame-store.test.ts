import { expect, test } from 'bun:test';
import { createFrameStore, type FrameTimers } from './frame-store';

function fakeTimers() {
  const state = { fn: null as null | (() => void), ms: 0, cleared: 0 };
  const timers: FrameTimers = {
    setInterval: (fn, ms) => { state.fn = fn; state.ms = ms; return 1; },
    clearInterval: () => { state.fn = null; state.cleared++; },
  };
  return { state, timers };
}

const png = (n: number) => new Uint8Array([n]);
const flush = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };

test('inactive: a tick does nothing', async () => {
  let calls = 0;
  const { timers } = fakeTimers();
  const s = createFrameStore({ source: { frame: async () => png(calls++) }, timers });
  expect(await s.tick()).toBe(false);
  expect(calls).toBe(0);
  expect(s.latest()).toBeNull();
});

test('start captures a view frame now and every 5 s; keeps the last 12', async () => {
  let n = 0;
  const modes: string[] = [];
  const { state, timers } = fakeTimers();
  let t = 1000;
  const s = createFrameStore({ source: { frame: async m => { modes.push(m); return png(n++); } }, timers, now: () => t });
  s.start();
  expect(s.active).toBe(true);
  expect(state.ms).toBe(5_000);
  await flush();
  for (let i = 0; i < 14; i++) { t += 5_000; await s.tick(); }
  expect(s.all().length).toBe(12);
  expect(s.all()[0]!.png[0]).toBe(3);
  expect(s.latest()!.png[0]).toBe(14);
  expect(s.latest()!.at).toBe(71_000);
  expect(new Set(modes)).toEqual(new Set(['view']));
});

test('a tick while a capture runs is skipped', async () => {
  let release!: (v: Uint8Array) => void;
  let calls = 0;
  const { timers } = fakeTimers();
  const s = createFrameStore({ source: { frame: () => { calls++; return new Promise(r => { release = r; }); } }, timers });
  s.start();
  expect(await s.tick()).toBe(false);
  expect(calls).toBe(1);
  release(png(1));
  await flush();
  expect(s.all().length).toBe(1);
});

test('a failed capture is skipped and logged; the next one works', async () => {
  let fail = true;
  const lines: string[] = [];
  const { timers } = fakeTimers();
  const s = createFrameStore({
    source: { frame: async () => { if (fail) throw new Error('not ready'); return png(2); } },
    timers,
    log: l => lines.push(l),
  });
  s.start();
  await flush();
  expect(s.latest()).toBeNull();
  expect(lines.join()).toContain('not ready');
  fail = false;
  expect(await s.tick()).toBe(true);
  expect(s.latest()!.png[0]).toBe(2);
});

test('stop clears the timer; a capture that ends after stop is not stored; frames stay', async () => {
  let release!: (v: Uint8Array) => void;
  let first = true;
  const { state, timers } = fakeTimers();
  const s = createFrameStore({
    source: {
      frame: () => {
        if (first) { first = false; return Promise.resolve(png(1)); }
        return new Promise(r => { release = r; });
      },
    },
    timers,
  });
  s.start();
  await flush();
  const pending = s.tick();
  s.stop();
  expect(s.active).toBe(false);
  expect(state.cleared).toBe(1);
  release(png(9));
  expect(await pending).toBe(false);
  expect(s.all().map(f => f.png[0])).toEqual([1]);
  s.stop();
  expect(state.cleared).toBe(1);
});

test('the timer callback runs a tick', async () => {
  let calls = 0;
  const { state, timers } = fakeTimers();
  const s = createFrameStore({ source: { frame: async () => png(calls++) }, timers });
  s.start();
  await flush();
  state.fn!();
  await flush();
  expect(calls).toBe(2);
  expect(s.all().length).toBe(2);
});

test('a frame is dropped when the tab is out of the game after the capture', async () => {
  let inGame = false;
  const lines: string[] = [];
  const { timers } = fakeTimers();
  const s = createFrameStore({ source: { frame: async () => png(1), inGame: async () => inGame }, timers, log: l => lines.push(l) });
  s.start();
  await Bun.sleep(1);
  expect(s.latest()).toBeNull();
  expect(lines.some(l => l.includes('frame dropped'))).toBe(true);
  inGame = true;
  expect(await s.tick()).toBe(true);
  expect(s.latest()!.png[0]).toBe(1);
});

test('checkRig runs selfCheck once; a failure turns frames off with a clear log line', async () => {
  let checks = 0;
  const lines: string[] = [];
  const { state, timers } = fakeTimers();
  const s = createFrameStore({ source: { frame: async () => png(1), selfCheck: async () => { checks++; throw new Error('canvas 800x600'); } }, timers, log: l => lines.push(l) });
  s.start();
  expect(await s.checkRig()).toBe(false);
  expect(await s.checkRig()).toBe(false);
  expect(checks).toBe(1);
  expect(s.active).toBe(false);
  expect(s.disabled).toBe(true);
  expect(state.fn).toBeNull();
  s.start();
  expect(s.active).toBe(false);
  expect(lines.some(l => l.startsWith('FRAMES OFF') && l.includes('canvas 800x600'))).toBe(true);
});

test('checkRig passes without a selfCheck and when it succeeds', async () => {
  const { timers } = fakeTimers();
  expect(await createFrameStore({ source: { frame: async () => png(1) }, timers }).checkRig()).toBe(true);
  const ok = createFrameStore({ source: { frame: async () => png(1), selfCheck: async () => {} }, timers });
  expect(await ok.checkRig()).toBe(true);
  ok.start();
  expect(ok.active).toBe(true);
});

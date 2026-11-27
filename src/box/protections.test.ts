import { describe, expect, test } from 'bun:test';
import { bestFood, fleeTarget, startProtections, type ProtectionSdk } from './protections';

const item = (slot: number, name: string, eat = true) => ({
  slot, id: slot, name, count: 1, optionsWithIndex: eat ? [{ text: 'Eat', opIndex: 1 }] : [{ text: 'Use', opIndex: 1 }],
});

function player(hp: number, maxHp: number, extra: Record<string, unknown> = {}) {
  return {
    name: 'p', combatLevel: 3, hp, maxHp, x: 0, z: 0, worldX: 3200, worldZ: 3200, level: 0, runEnergy: 100, runWeight: 0,
    animId: -1, spotanimId: -1, isDead: false, lifeId: 0, respawnCount: 0, lastDeathTick: null,
    combat: { inCombat: true, targetIndex: 5, targetType: 'npc' as const, lastDamageTick: 1 }, ...extra,
  };
}

function rig(state: ReturnType<typeof player>, inventory: ReturnType<typeof item>[], npcs: unknown[] = []) {
  const eaten: string[] = [];
  const walks: [number, number][] = [];
  const logs: string[] = [];
  let tickFn: (() => void) | null = null;
  let cleared = false;
  let t = 0;
  const sdk = {
    getState: () => ({ player: state }),
    getInventory: () => inventory,
    getNearbyNpc: (i: number) => (npcs as { index: number }[]).find(n => n.index === i) ?? null,
    getNearbyNpcs: () => npcs,
    sendWalk: async (x: number, z: number) => { walks.push([x, z]); return { success: true }; },
  } as unknown as ProtectionSdk;
  const bot = { eatFood: async (f: unknown) => { eaten.push((f as { name: string }).name); return { success: true, hpGained: 3, message: '' }; } };
  const p = startProtections(bot, sdk, {
    log: l => logs.push(l), now: () => t,
    setTimer: fn => { tickFn = fn; return 1; }, clearTimer: () => { cleared = true; },
  });
  return { p, eaten, walks, logs, advance: (ms: number) => { t += ms; }, hasTimer: () => tickFn !== null, cleared: () => cleared };
}

describe('protections', () => {
  test('bestFood picks the food that heals the most and skips items without Eat', () => {
    expect(bestFood([item(0, 'Shrimps'), item(1, 'Lobster'), item(2, 'Bones', false)])?.name).toBe('Lobster');
    expect(bestFood([item(0, 'Bones', false)])).toBeNull();
    expect(bestFood([item(0, 'Strange fruit'), item(1, 'Shrimps')])?.name).toBe('Shrimps');
  });

  test('fleeTarget walks away from the attacker', () => {
    expect(fleeTarget({ worldX: 10, worldZ: 10 }, { x: 9, z: 10 }, 10)).toEqual({ x: 20, z: 10 });
    expect(fleeTarget({ worldX: 10, worldZ: 10 }, { x: 10, z: 10 }, 5)).toEqual({ x: 15, z: 10 });
  });

  test('above 40% HP nothing happens', async () => {
    const r = rig(player(9, 10), [item(0, 'Shrimps')]);
    await r.p.tick();
    expect(r.eaten).toEqual([]);
    expect(r.hasTimer()).toBe(true);
  });

  test('at 40% HP it eats the best food', async () => {
    const r = rig(player(4, 10), [item(0, 'Shrimps'), item(1, 'Trout')]);
    await r.p.tick();
    expect(r.eaten).toEqual(['Trout']);
    expect(r.p.status().eats).toBe(1);
  });

  test('at 25% HP with no food it runs from the attacker, at most once per interval', async () => {
    const npc = { kind: 'npc', index: 5, name: 'Goblin', x: 3199, z: 3200, distance: 1, inCombat: true };
    const r = rig(player(2, 10), [], [npc]);
    await r.p.tick();
    expect(r.walks).toEqual([[3210, 3200]]);
    await r.p.tick();
    expect(r.walks.length).toBe(1);
    r.advance(5_000);
    await r.p.tick();
    expect(r.walks.length).toBe(2);
    expect(r.logs.some(l => l.includes('ran from Goblin'))).toBe(true);
  });

  test('between 25% and 40% with no food it does not run', async () => {
    const r = rig(player(3, 10), []);
    await r.p.tick();
    expect(r.walks).toEqual([]);
  });

  test('off() stops the checks, on() starts them again, stop() clears the timer', async () => {
    const r = rig(player(1, 10), [item(0, 'Shrimps')]);
    r.p.off();
    await r.p.tick();
    expect(r.eaten).toEqual([]);
    r.p.on();
    await r.p.tick();
    expect(r.eaten).toEqual(['Shrimps']);
    r.p.stop();
    expect(r.cleared()).toBe(true);
    expect(r.p.status().enabled).toBe(false);
  });

  test('an error inside a check is caught and printed once', async () => {
    const logs: string[] = [];
    const sdk = { getState: () => { throw new Error('boom'); } } as unknown as ProtectionSdk;
    const p = startProtections({ eatFood: async () => ({ success: true, hpGained: 0, message: '' }) }, sdk, {
      log: l => logs.push(l), setTimer: () => 1, clearTimer: () => {},
    });
    await p.tick();
    await p.tick();
    expect(logs).toEqual(['[protections] error (shown once): boom']);
  });
});

import { describe, expect, test } from 'bun:test';
import type { BotWorldState } from '../../vendor/rs-sdk/sdk/types';
import { compactState, diffStates, eventText, guessKiller, lostItems, type CompactState } from './diff';

function snap(over: Partial<CompactState> = {}): CompactState {
  return {
    hp: 10,
    maxHp: 10,
    x: 3200,
    z: 3200,
    plane: 0,
    skills: { Attack: { level: 9, xp: 900 }, Woodcutting: { level: 1, xp: 0 } },
    inventory: { Logs: 2 },
    inCombat: false,
    ...over,
  };
}

describe('diffStates', () => {
  test('no events without a previous snapshot or with no change', () => {
    expect(diffStates(null, snap())).toEqual([]);
    expect(diffStates(snap(), snap())).toEqual([]);
  });

  test('level_up per skill', () => {
    const next = snap({ skills: { Attack: { level: 10, xp: 1200 }, Woodcutting: { level: 1, xp: 10 } } });
    expect(diffStates(snap(), next)).toEqual([{ kind: 'level_up', skill: 'Attack', from: 9, level: 10 }]);
  });

  test('total level milestone at each 25', () => {
    const prev = snap({ skills: { A: { level: 12, xp: 0 }, B: { level: 12, xp: 0 } } });
    const next = snap({ skills: { A: { level: 13, xp: 0 }, B: { level: 12, xp: 0 } } });
    expect(diffStates(prev, next)).toContainEqual({ kind: 'total_level', total: 25 });
    const after = snap({ skills: { A: { level: 14, xp: 0 }, B: { level: 12, xp: 0 } } });
    expect(diffStates(next, after).some((e) => e.kind === 'total_level')).toBe(false);
  });

  test('no total level event when a snapshot has no skills', () => {
    expect(diffStates(snap({ skills: {} }), snap()).some((e) => e.kind === 'total_level')).toBe(false);
  });

  test('death on hp 0, reported once', () => {
    const dead = snap({ hp: 0 });
    expect(diffStates(snap(), dead)).toEqual([{ kind: 'death' }]);
    expect(diffStates(dead, snap({ x: 3222, z: 3218 }))).toEqual([]);
  });

  test('death on a jump to max hp with a position jump', () => {
    expect(diffStates(snap({ hp: 3 }), snap({ hp: 10, x: 3100 }))).toEqual([{ kind: 'death' }]);
    expect(diffStates(snap({ hp: 3 }), snap({ hp: 10, x: 3205 }))).toEqual([]);
  });

  test('item_gain groups net gains only', () => {
    const next = snap({ inventory: { Logs: 5, Coins: 100, Bones: 1 } });
    const prev = snap({ inventory: { Logs: 2, Fish: 3 } });
    expect(diffStates(prev, next)).toEqual([
      {
        kind: 'item_gain',
        items: [
          { name: 'Bones', count: 1 },
          { name: 'Coins', count: 100 },
          { name: 'Logs', count: 3 },
        ],
      },
    ]);
  });

  test('eventText templates', () => {
    expect(eventText({ kind: 'level_up', skill: 'Attack', from: 9, level: 10 })).toBe('Attack level 10 (was 9).');
    expect(eventText({ kind: 'item_gain', items: [{ name: 'Logs', count: 3 }] })).toBe('Got 3 x Logs.');
    expect(eventText({ kind: 'instruction_done', instruction: 'chop trees', outcome: 'done' })).toBe(
      'Instruction ended (done): chop trees',
    );
  });
});

describe('compactState', () => {
  test('null when not in game', () => {
    expect(compactState({ inGame: false, player: null } as unknown as BotWorldState)).toBeNull();
  });

  test('maps the SDK fields', () => {
    const s = {
      inGame: true,
      player: { hp: 7, maxHp: 10, worldX: 3222, worldZ: 3218, level: 0, combat: { inCombat: true } },
      skills: [{ name: 'Attack', level: 12, baseLevel: 10, experience: 1200 }],
      inventory: [
        { slot: 0, id: 1, name: 'Logs', count: 1 },
        { slot: 1, id: 1, name: 'Logs', count: 1 },
        { slot: 2, id: 2, name: 'Coins', count: 50 },
      ],
    } as unknown as BotWorldState;
    expect(compactState(s)).toEqual({
      hp: 7,
      maxHp: 10,
      x: 3222,
      z: 3218,
      plane: 0,
      skills: { Attack: { level: 10, xp: 1200 } },
      inventory: { Logs: 2, Coins: 50 },
      inCombat: true,
    });
  });
});

describe('death details', () => {
  test('lostItems is the inventory before minus after', () => {
    expect(lostItems({ Logs: 3, 'Bronze axe': 1, Coins: 10 }, { Logs: 1, Coins: 20 })).toEqual([
      { name: 'Bronze axe', count: 1 },
      { name: 'Logs', count: 2 },
    ]);
  });

  test('guessKiller: the NPC of the newest hit, then the combat target', () => {
    const base = {
      player: { combat: { inCombat: true, targetIndex: 7, targetType: 'npc', lastDamageTick: 5 } },
      nearbyNpcs: [{ index: 3, name: 'Goblin' }, { index: 7, name: 'Giant rat' }],
    };
    const hit = (tick: number, sourceIndex: number) => ({ tick, type: 'damage_taken', damage: 1, sourceType: 'npc', sourceIndex, targetType: 'player', targetIndex: 0 });
    expect(guessKiller({ ...base, combatEvents: [hit(9, 3), hit(4, 7)] } as unknown as BotWorldState)).toBe('Goblin');
    expect(guessKiller({ ...base, combatEvents: [hit(9, 99)] } as unknown as BotWorldState)).toBe('Giant rat');
    expect(guessKiller({ player: null, nearbyNpcs: [], combatEvents: [] } as unknown as BotWorldState)).toBeUndefined();
  });

  test('death eventText without details', () => {
    expect(eventText({ kind: 'death' })).toBe('The account died.');
  });
});

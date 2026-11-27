import { describe, expect, test } from 'bun:test';
import { CARD_FRAME_MAX_BYTES, CARD_KINDS, CARD_PAGE_HTML, isCardFrame, CARD_PAGE_SCRIPT, CardDataError, cardIconIds, isCardKind, levelProgress, validateCardData, xpForLevel } from './templates';
import { SAMPLE_CARDS } from './samples';

describe('validateCardData', () => {
  test('accepts every sample card', () => {
    for (const kind of CARD_KINDS) expect(() => validateCardData(kind, SAMPLE_CARDS[kind])).not.toThrow();
  });

  test('rejects a non-object, a missing field and a wrong type', () => {
    expect(() => validateCardData('level_up', null)).toThrow(CardDataError);
    expect(() => validateCardData('level_up', [])).toThrow(CardDataError);
    expect(() => validateCardData('level_up', { skill: 'Attack', level: 2 })).toThrow(/xp/);
    expect(() => validateCardData('level_up', { skill: 'Attack', level: '2', xp: 1 })).toThrow(/level/);
    expect(() => validateCardData('death', { place: '', time: 'now' })).toThrow(/empty/);
  });

  test('rejects numbers out of range, fractions and NaN', () => {
    expect(() => validateCardData('level_up', { skill: 'A', level: 0, xp: 1 })).toThrow(/range/);
    expect(() => validateCardData('level_up', { skill: 'A', level: 2.5, xp: 1 })).toThrow(/integer/);
    expect(() => validateCardData('level_up', { skill: 'A', level: 2, xp: Number.NaN })).toThrow(/finite/);
    expect(() => validateCardData('status', { hp: 11, maxHp: 10, goal: 'g', skills: [] })).toThrow(/hp/);
  });

  test('receipt: accepts only done, stopped or failed as the end', () => {
    const base = { instruction: 'i', summary: 's', turns: 3, costUsd: 0 };
    expect(validateCardData('instruction_receipt', { ...base, ended: 'failed' }).ended).toBe('failed');
    expect(() => validateCardData('instruction_receipt', { ...base, ended: 'crashed' })).toThrow(/ended/);
  });

  test('isCardFrame takes only a PNG of at most CARD_FRAME_MAX_BYTES', () => {
    const png = (n: number) => { const b = new Uint8Array(n); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b; };
    expect(isCardFrame(png(100))).toBe(true);
    expect(isCardFrame(png(CARD_FRAME_MAX_BYTES))).toBe(true);
    expect(isCardFrame(png(CARD_FRAME_MAX_BYTES + 1))).toBe(false);
    expect(isCardFrame(new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0]))).toBe(false);
    expect(isCardFrame(new Uint8Array(3))).toBe(false);
  });

  test('accepts a fractional cost', () => {
    const r = validateCardData('instruction_receipt', { instruction: 'i', summary: 's', turns: 3, costUsd: 0.125 });
    expect(r.costUsd).toBe(0.125);
  });

  test('rejects too many entries', () => {
    const counts = Array.from({ length: 9 }, (_, i) => ({ label: `c${i}`, value: i }));
    expect(() => validateCardData('daily_recap', { date: 'd', counts })).toThrow(/more than 8/);
    const items = Array.from({ length: 29 }, (_, i) => ({ id: i, name: 'x', count: 1 }));
    expect(() => validateCardData('death', { place: 'p', time: 't', items })).toThrow(/more than 28/);
  });

  test('clamps long text and replaces control characters', () => {
    const r = validateCardData('level_up', { skill: `A${String.fromCharCode(0)}B${String.fromCharCode(0x202e)}c${'x'.repeat(100)}`, level: 2, xp: 1 });
    expect(r.skill.length).toBe(40);
    expect(r.skill.endsWith('…')).toBe(true);
    expect(r.skill.startsWith('A B')).toBe(true);
  });

  test('returns a copy without unknown fields', () => {
    const r = validateCardData('level_up', { skill: 'Attack', level: 2, xp: 83, extra: '<b>' }) as unknown as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(['level', 'progress', 'skill', 'xp']);
  });

  test('level card progress comes from the XP table, not from the input', () => {
    const r = validateCardData('level_up', { skill: 'Attack', level: 2, xp: 120, from: 1, totalLevel: 33, progress: { toNext: -1, pct: 999 } });
    // Level 2 starts at 83 xp and level 3 at 174.
    expect(r.progress).toEqual({ toNext: 54, pct: 40 });
    expect(r.from).toBe(1);
    expect(r.totalLevel).toBe(33);
    expect(validateCardData('level_up', { skill: 'Attack', level: 99, xp: 13_034_431 }).progress).toBeUndefined();
  });

  test('death card killer, receipt rows and recap xp', () => {
    const d = validateCardData('death', { place: 'p', time: 't', killer: 'Goblin\u202e', items: [{ name: 'Logs', count: 2 }] });
    expect(d.killer).toBe('Goblin');
    expect(d.items).toEqual([{ name: 'Logs', count: 2 }]);
    expect(cardIconIds('death', d)).toEqual([]);
    const r = validateCardData('instruction_receipt', {
      instruction: 'i', summary: 's', turns: 1, costUsd: 0, durationMs: 4_320_000,
      skills: [{ name: 'Woodcutting', before: 39, after: 40, xp: 4100 }],
      inventory: [{ name: 'Logs', before: 0, after: 27 }],
    });
    expect(r.skills).toHaveLength(1);
    expect(r.inventory![0]!.after).toBe(27);
    expect(() => validateCardData('instruction_receipt', { instruction: 'i', summary: 's', turns: 1, costUsd: 0, skills: [{ name: 'A', before: 0, after: 1, xp: 0 }] })).toThrow(/range/);
    const recap = validateCardData('daily_recap', { date: 'd', counts: [], xp: [{ skill: 'Attack', xp: 500 }] });
    expect(recap.xp).toEqual([{ skill: 'Attack', xp: 500 }]);
  });

  test('keeps markup in names as plain text data', () => {
    const name = '<img src=x onerror=alert(1)>';
    const r = validateCardData('death', { place: name, time: 't', items: [{ id: 1, name, count: 1 }] });
    expect(r.place).toBe(name);
  });

  test('rejects an unknown kind', () => {
    expect(() => validateCardData('nope' as never, {})).toThrow(/unknown card kind/);
    expect(isCardKind('status')).toBe(true);
    expect(isCardKind('nope')).toBe(false);
  });
});

describe('cardIconIds', () => {
  test('returns unique item ids for cards with items only', () => {
    const d = validateCardData('status', { hp: 1, maxHp: 1, goal: 'g', skills: [], items: [{ id: 5, name: 'a', count: 1 }, { id: 5, name: 'a', count: 2 }, { id: 7, name: 'b', count: 1 }] });
    expect(cardIconIds('status', d)).toEqual([5, 7]);
    expect(cardIconIds('level_up', validateCardData('level_up', SAMPLE_CARDS.level_up))).toEqual([]);
  });
  test('returns the item ids of the receipt rows', () => {
    expect(cardIconIds('instruction_receipt', validateCardData('instruction_receipt', SAMPLE_CARDS.instruction_receipt))).toEqual([1521, 995, 590]);
  });
  test('a death card takes a full inventory of 28 items', () => {
    const items = Array.from({ length: 28 }, (_, i) => ({ id: i, name: `item ${i}`, count: 1 }));
    expect(validateCardData('death', { place: 'p', time: 't', items }).items).toHaveLength(28);
  });
});

describe('card page', () => {
  test('the script never parses strings as HTML', () => {
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'Function(']) {
      expect(CARD_PAGE_SCRIPT.includes(bad)).toBe(false);
    }
  });

  test('the page has a CSP that blocks network loads and uses no external font', () => {
    expect(CARD_PAGE_HTML).toContain("default-src 'none'");
    expect(CARD_PAGE_HTML).toContain('img-src data:');
    expect(CARD_PAGE_HTML).not.toMatch(/https?:\/\//);
    expect(CARD_PAGE_HTML).not.toContain('@font-face');
  });
});

describe('xpForLevel', () => {
  test('standard table at levels 1, 2, 50 and 99', () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(83);
    expect(xpForLevel(50)).toBe(101_333);
    expect(xpForLevel(99)).toBe(13_034_431);
    expect(() => xpForLevel(0)).toThrow(RangeError);
    expect(() => xpForLevel(1.5)).toThrow(RangeError);
  });

  test('levelProgress', () => {
    expect(levelProgress(1, 0)).toEqual({ toNext: 83, pct: 0 });
    expect(levelProgress(50, 101_333)).toEqual({ toNext: xpForLevel(51) - 101_333, pct: 0 });
    expect(levelProgress(99, 13_034_431)).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import { CARD_KINDS, CARD_PAGE_HTML, CARD_PAGE_SCRIPT, CardDataError, cardIconIds, isCardKind, validateCardData } from './templates';
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

  test('accepts a fractional cost', () => {
    const r = validateCardData('instruction_receipt', { instruction: 'i', summary: 's', turns: 3, costUsd: 0.125 });
    expect(r.costUsd).toBe(0.125);
  });

  test('rejects too many entries', () => {
    const counts = Array.from({ length: 9 }, (_, i) => ({ label: `c${i}`, value: i }));
    expect(() => validateCardData('daily_recap', { date: 'd', counts })).toThrow(/more than 8/);
    const items = Array.from({ length: 9 }, (_, i) => ({ id: i, name: 'x', count: 1 }));
    expect(() => validateCardData('death', { place: 'p', time: 't', items })).toThrow(/more than 8/);
  });

  test('clamps long text and replaces control characters', () => {
    const r = validateCardData('level_up', { skill: `A${String.fromCharCode(0)}B${String.fromCharCode(0x202e)}c${'x'.repeat(100)}`, level: 2, xp: 1 });
    expect(r.skill.length).toBe(40);
    expect(r.skill.endsWith('…')).toBe(true);
    expect(r.skill.startsWith('A B')).toBe(true);
  });

  test('returns a copy without unknown fields', () => {
    const r = validateCardData('level_up', { skill: 'Attack', level: 2, xp: 83, extra: '<b>' }) as unknown as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(['level', 'skill', 'xp']);
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

import { describe, expect, test } from 'bun:test';
import { CardDataError, validateCardData } from '../cards/templates';
import { ago, bankData, bankSeen, bankText, equipmentData, geData, geSeen, inventoryData, pickInfoCard, skillsData, type InfoState } from './info-cards';

const state = (over: Partial<InfoState> = {}): InfoState => ({
  player: { combatLevel: 21 },
  skills: [{ name: 'Attack', level: 5, baseLevel: 5 }, { name: 'Hitpoints', level: 7, baseLevel: 12 }],
  inventory: [{ slot: 0, id: 1351, name: 'Bronze axe', count: 1 }, { slot: 27, id: 995, name: 'Coins', count: 120 }],
  equipment: [{ slot: 3, id: 1353, name: 'Steel axe', count: 1 }, { slot: 13, id: 882, name: 'Bronze arrow', count: 150 }, { slot: 6, id: 1, name: 'Arms', count: 1 }],
  ...over,
});

describe('pickInfoCard', () => {
  test('picks the card that the question asks for', () => {
    expect(pickInfoCard("what's in the bank?")).toBe('bank');
    expect(pickInfoCard('what are you wearing')).toBe('equipment');
    expect(pickInfoCard('what gear do we have equipped')).toBe('equipment');
    expect(pickInfoCard('what is in your inventory')).toBe('inventory');
    expect(pickInfoCard('show me your stats')).toBe('skills');
    expect(pickInfoCard('any GE offers done?')).toBe('ge');
    expect(pickInfoCard('how is the grand exchange going')).toBe('ge');
  });

  test('picks nothing for other questions, and does not match inside words', () => {
    expect(pickInfoCard('where are you?')).toBeNull();
    expect(pickInfoCard('what is the best axe')).toBeNull();
    expect(pickInfoCard('are you in a general store')).toBeNull();
    expect(pickInfoCard('are the bankers nice')).toBeNull();
  });
});

describe('card data from the state', () => {
  test('equipment maps the wear positions and skips slots that the screen does not show', () => {
    const e = equipmentData(state({ combatStyle: { currentStyle: 1, known: true, styles: [{ index: 0, name: 'Chop', type: 'Accurate' }, { index: 1, name: 'Hack', type: 'Aggressive' }] } }));
    expect(e.worn).toEqual([{ slot: 'weapon', id: 1353, name: 'Steel axe', count: 1 }, { slot: 'ammo', id: 882, name: 'Bronze arrow', count: 150 }]);
    expect(e.combatLevel).toBe(21);
    expect(e.style).toBe('Aggressive (Hack)');
    expect(() => validateCardData('equipment', e)).not.toThrow();
  });

  test('equipment has no style when the combat tab is unknown', () => {
    expect(equipmentData(state({ combatStyle: { currentStyle: 0, known: false, styles: [] } })).style).toBeUndefined();
  });

  test('inventory keeps the slots; skills keep the current and the real level', () => {
    const inv = inventoryData(state());
    expect(inv.items.map(i => i.slot)).toEqual([0, 27]);
    expect(() => validateCardData('inventory', inv)).not.toThrow();
    const sk = skillsData(state());
    expect(sk.skills[1]).toEqual({ name: 'Hitpoints', level: 7, base: 12 });
    expect(() => validateCardData('skills', sk)).not.toThrow();
  });

  test('the bank and the exchange are kept only while their window is open', () => {
    expect(bankSeen(state({ bank: { isOpen: false, items: [{ id: 1, name: 'Logs', count: 3 }] } }))).toBeNull();
    const items = Array.from({ length: 95 }, (_, i) => ({ id: i, name: `Item ${i}`, count: i + 1 }));
    const seen = bankSeen(state({ bank: { isOpen: true, items } }))!;
    expect(seen.items.length).toBe(95);
    const card = bankData(seen, 3 * 3_600_000);
    expect(card.items.length).toBe(80);
    expect(card.total).toBe(95);
    expect(card.seen).toBe('3 hours ago');
    expect(() => validateCardData('bank', card)).not.toThrow();
    expect(bankText(seen, 0)).toContain('Item 94 x95');

    expect(geSeen(state({ ge: null }))).toBeNull();
    const ge = geSeen(state({ ge: { isOpen: true, offers: [{ item: 1521, name: 'Oak logs', side: 'sell', quantity: 10, price: 22, filled: 99, state: 'open' }] } }))!;
    expect(ge.offers[0]!.filled).toBe(10);
    expect(() => validateCardData('ge', geData(ge, 60_000))).not.toThrow();
  });

  test('ago', () => {
    expect(ago(10_000)).toBe('just now');
    expect(ago(60_000)).toBe('1 minute ago');
    expect(ago(59 * 60_000)).toBe('59 minutes ago');
    expect(ago(3_600_000)).toBe('1 hour ago');
    expect(ago(72 * 3_600_000)).toBe('3 days ago');
  });
});

describe('validateCardData for the account cards', () => {
  test('refuses a wear slot twice, an unknown slot, an inventory slot twice and a bad offer', () => {
    expect(() => validateCardData('equipment', { worn: [{ slot: 'head', name: 'a', count: 1 }, { slot: 'head', name: 'b', count: 1 }] })).toThrow(/twice/);
    expect(() => validateCardData('equipment', { worn: [{ slot: 'tail', name: 'a', count: 1 }] })).toThrow(CardDataError);
    expect(() => validateCardData('inventory', { items: [{ slot: 2, name: 'a', count: 1 }, { slot: 2, name: 'b', count: 1 }] })).toThrow(/twice/);
    expect(() => validateCardData('inventory', { items: [{ slot: 28, name: 'a', count: 1 }] })).toThrow(/range/);
    expect(() => validateCardData('bank', { seen: 'now', items: [{ name: 'a', count: 1 }], total: 0 })).toThrow(/total/);
    const offer = { name: 'Logs', side: 'buy', quantity: 5, price: 1, filled: 6, state: 'open' };
    expect(() => validateCardData('ge', { seen: 'now', offers: [offer] })).toThrow(/filled/);
    expect(() => validateCardData('ge', { seen: 'now', offers: [{ ...offer, filled: 1, side: 'swap' }] })).toThrow(/side/);
  });
});

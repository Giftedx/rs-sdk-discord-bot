import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { armourPages, foodPages } from './catalog';
import { readWieldRules, type ObjConfig } from './wield';

const obj = (name: string, wearpos: string, params: Record<string, string>, members = false): ObjConfig =>
  ({ name, wearpos, params, file: '/s/x.obj', ...(members ? { members: 'yes' } : {}) });
const def = (n: number) => ({ stabdefence: String(n), slashdefence: String(n), crushdefence: String(n), magicdefence: '0', rangedefence: String(n) });

describe('armourPages', () => {
  const objs = new Map([
    ['adamant_platebody', obj('Adamant platebody', 'torso', def(60))],
    ['rune_platebody', obj('Rune platebody', 'torso', def(80))],
    ['rune_platebody_trim', obj('Rune platebody (t)', 'torso', def(80))],
    ['blue_body', obj('Dragonhide body', 'torso', { ...def(40), rangeattack: '15' })],
    ['red_body', obj('Dragonhide body', 'torso', { ...def(50), rangeattack: '20' })],
    ['boots_red', obj('Boots', 'feet', def(1))],
    ['boots_blue', obj('Boots', 'feet', def(1))],
    ['partyhat', obj('Partyhat', 'hat', {})],
  ]);
  const rules = new Map([['adamant_platebody', 'Defence 30'], ['rune_platebody', 'Defence 40, and the quest Dragon Slayer complete'],
    ['rune_platebody_trim', 'Defence 40, and the quest Dragon Slayer complete'], ['blue_body', 'Ranged 50 and Defence 40'], ['red_body', 'Ranged 60 and Defence 40']]);
  const pages = armourPages(objs, rules);
  const page = (s: string) => pages.find(p => p.source === s)?.text ?? '';

  test('the best body per Defence level counts only items that need Defence alone', () => {
    const best = page('knowledge/best-armour-bodies.md');
    expect(best).toContain('- Defence 30 to 39: Adamant platebody (Defence 30; defence total 240).');
    expect(best).toContain('- Defence 40 or more: Rune platebody (Defence 40, and the quest Dragon Slayer complete; defence total 320).');
    expect(best).not.toContain('Dragonhide');
  });

  test('copies with the same stats are one line; one name with other stats keeps its code name', () => {
    const bodies = page('knowledge/armour-bodies.md');
    expect(bodies.match(/Rune platebody/g)).toHaveLength(1);
    expect(bodies).toContain('- Dragonhide body (blue body): Ranged 50 and Defence 40');
    expect(bodies).toContain('- Dragonhide body (red body): Ranged 60 and Defence 40');
    expect(bodies.indexOf('Rune platebody')).toBeLessThan(bodies.indexOf('Adamant platebody'));
    expect(page('knowledge/armour-boots.md').match(/- Boots:/g)).toHaveLength(1);
    expect(pages.some(p => p.text.includes('Partyhat'))).toBe(false);
    expect(page('knowledge/armour-rune.md')).toContain('- Rune platebody: Defence 40, and the quest Dragon Slayer complete; defence +80/+80/+80/0/+80');
  });
});

describe('foodPages', () => {
  test('lists food by the hitpoints it heals, most first, with the Cooking level', () => {
    const dir = mkdtempSync(join(tmpdir(), 'food-'));
    mkdirSync(join(dir, 'player', 'configs', 'consumption'), { recursive: true });
    mkdirSync(join(dir, 'skill_cooking'), { recursive: true });
    writeFileSync(join(dir, 'player', 'configs', 'consumption', 'consume_normal.dbrow'),
      '[heal_12]\r\ntable=consume_table\r\ndata=consumable,lobster\r\ndata=stat_heal,hitpoints,12,0\r\n[heal_3]\r\ndata=consumable,shrimp\r\ndata=stat_heal,hitpoints,3,0\r\n[heal_0]\r\ndata=consumable,junk\r\ndata=stat_heal,hitpoints,0,0\r\n');
    writeFileSync(join(dir, 'skill_cooking', 'c.dbrow'), '[cook_lobster]\r\ndata=cooked,lobster\r\ndata=levelrequired,40\r\n');
    const objs = new Map([['lobster', obj('Lobster', '', {})], ['shrimp', obj('Shrimps', '', {})], ['junk', obj('Junk', '', {})]]);
    const [p] = foodPages(dir, objs);
    expect(p!.text).toContain('- Heals 12: Lobster (Cooking 40)\n- Heals 3: Shrimps');
    expect(p!.text).not.toContain('Junk');
  });
});

const sdk = join(import.meta.dir, '..', '..', 'vendor', 'rs-sdk');
test.skipIf(!existsSync(join(sdk, 'server', 'content', 'scripts')))('the real server: armour and food pages, each short enough for the search', () => {
  const r = readWieldRules(sdk);
  const pages = [...armourPages(r.objs, r.bySym), ...foodPages(join(sdk, 'server', 'content', 'scripts'), r.objs)];
  expect(pages.every(p => p.text.length <= 1_450)).toBe(true);
  const text = (s: string) => pages.find(p => p.source === s)!.text;
  expect(text('knowledge/best-armour-bodies.md')).toContain('- Defence 30 to 39: Adamant platebody (Defence 30; defence total 240).');
  expect(text('knowledge/food-healing-part1.md')).toContain('Lobster (Cooking 40)');
  // A topped pizza is made, not cooked: its level is in pizza.struct.
  const food = pages.filter(p => p.source.startsWith('knowledge/food-')).map(p => p.text).join('\n');
  expect(food).toContain('Meat pizza (Cooking 45)');
  expect(food).toContain('Anchovy pizza (Cooking 55)');
});

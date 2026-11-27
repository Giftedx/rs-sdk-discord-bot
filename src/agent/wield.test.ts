import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { meleeWeaponPages, readWieldRules, weaponCatalogPages, wieldNote, wieldRule } from './wield';

describe('wield rules', () => {
  test('wieldRule names the skills, the levels and the quest', () => {
    expect(wieldRule('levelrequire_attack', ['40', 'last_slot'])).toBe('Attack 40');
    expect(wieldRule('levelrequire_ranged_and_defence', ['70', '40', 'last_slot'])).toBe('Ranged 70 and Defence 40');
    expect(wieldRule('levelrequire_dragon_slayer_quest_defence', ['40', 'last_slot'])).toBe('Defence 40, and the quest Dragon Slayer complete');
    expect(wieldRule('levelrequire_regicide_quest_attack_strength', ['60', '30', 'last_slot'])).toBe('Attack 60 and Strength 30, and the quest Regicide complete');
    expect(wieldRule('levelrequire_iban_staff', ['last_slot'])).toBe('Magic 50 and Attack 50');
    expect(wieldRule('levelrequire_something_new', ['1'])).toBeNull();
  });

  test('readWieldRules reads one-line and block checks, and keeps each version of a shared name', () => {
    const sdk = mkdtempSync(join(tmpdir(), 'wield-'));
    const s = join(sdk, 'server', 'content', 'scripts');
    mkdirSync(join(s, 'levelrequire', 'scripts'), { recursive: true });
    mkdirSync(join(s, 'objs'), { recursive: true });
    writeFileSync(join(s, 'objs', 'a.obj'), '[rune_axe]\r\nname=Rune axe\r\n[viking_shield]\r\nname=Viking shield\r\n[blue_body]\r\nname=Dragonhide body\r\n[red_body]\r\nname=Dragonhide body\r\n');
    writeFileSync(join(s, 'levelrequire', 'scripts', 'tier40.rs2'), [
      '[opheld2,rune_axe] @levelrequire_attack(40, last_slot);',
      '[opheld2,viking_shield]',
      'if (%viking < ^viking_complete) {',
      '    return;',
      '}',
      '@levelrequire_defence(30, last_slot);',
      '[opheld2,blue_body] @levelrequire_ranged_and_defence(50, 40, last_slot);',
      '[opheld2,red_body] @levelrequire_ranged_and_defence(60, 40, last_slot);',
      '[opheld2,bronze_axe] @tutorial_island_equip(last_slot);',
    ].join('\r\n'));
    const { rules, unknown } = readWieldRules(sdk);
    expect(unknown).toEqual([]);
    expect(rules['wiki/items/rune-axe.md']).toBe('Attack 40');
    expect(rules['wiki/items/viking-shield.md']).toBe('Defence 30, and the quest The Fremennik Trials complete');
    expect(rules['wiki/items/dragonhide-body.md']).toBe('Ranged 50 and Defence 40 (blue body); or Ranged 60 and Defence 40 (red body)');
    expect(rules['wiki/items/bronze-axe.md']).toBeUndefined();
  });

  test('wieldNote warns when the page row is another number', () => {
    expect(wieldNote('Attack 40', '# Rune axe\n| Level Requirement | 41 |')).toContain('not the wield level. The server does not check that number');
    expect(wieldNote('Attack 40', '# Rune pickaxe\n| Level Requirement | 41 |')).toContain('is the Mining level to mine with it');
    expect(wieldNote('Ranged 40', '# Yew longbow\n| Level Requirement | 40 |')).toBe('> Server code: to wield or wear this item needs Ranged 40.');
  });

  test('meleeWeaponPages: the best weapon per Attack level, a free one too, and no fake items', () => {
    const o = (name: string, members: boolean, stab: number, str: number, file = '/s/melee/swords.obj') =>
      ({ name, wearpos: 'righthand', category: 'weapon_stab', members: members ? 'yes' : undefined, params: { stabattack: String(stab), strengthbonus: String(str) }, file });
    const objs = new Map([
      ['iron_sword', o('Iron sword', false, 6, 5)],
      ['rune_sword', o('Rune sword', false, 30, 30)],
      ['rune_halberd', o('Rune halberd', true, 48, 68)],
      ['poisoned_dagger_p', o('Poisoned dagger(p)', true, 255, 255)],
      ['pickaxe_handle', o('Pickaxe handle', false, 50, 0, '/s/macro events/configs/antimacro.obj')],
    ]);
    const rules = new Map([['rune_sword', 'Attack 40'], ['rune_halberd', 'Attack 40 and Strength 20']]);
    const stab = meleeWeaponPages(objs, rules).find(p => p.source === 'knowledge/best-melee-weapon-stab.md')!;
    expect(stab.text).toContain('- Attack 1 to 39: Iron sword (+6 stab, +5 strength, speed 4; no level needed).');
    expect(stab.text).toContain('- Attack 40 or more: Rune halberd (+48 stab, +68 strength, speed 4; members, needs Attack 40 and Strength 20). Free: Rune sword');
    expect(stab.text).not.toContain('Poisoned');
    expect(stab.text).not.toContain('Pickaxe handle');
  });

  test('weaponCatalogPages: one page per metal and per type, poisoned copies once, arrows need a bow', () => {
    const w = (name: string, category: string, params: Record<string, string>, wearpos = 'righthand') => ({ name, wearpos, category, params, file: '/s/x.obj' });
    const objs = new Map([
      ['rune_sword', w('Rune sword', 'weapon_stab', { stabattack: '38', strengthbonus: '39' })],
      ['adamant_sword', w('Adamant sword', 'weapon_stab', { stabattack: '23', strengthbonus: '24' })],
      ['adamant_dagger', w('Adamant dagger', 'weapon_stab', { stabattack: '15' })],
      ['adamant_dagger_p', w('Adamant dagger(p)', 'weapon_stab', { stabattack: '15' })],
      ['adamnt_warhammer', w('Adamnt warhammer', 'weapon_blunt', { crushattack: '35' })],
      ['adamant_arrow', w('Adamant arrow', 'arrows', { rangebonus: '31' }, 'quiver')],
    ]);
    const rules = new Map([['rune_sword', 'Attack 40'], ['adamant_sword', 'Attack 30'], ['adamant_dagger', 'Attack 30'], ['adamnt_warhammer', 'Attack 30']]);
    const pages = weaponCatalogPages(objs, rules);
    const page = (s: string) => pages.find(p => p.source === s)!.text;
    const adamant = page('knowledge/weapons-adamant-melee.md');
    expect(adamant).toContain('- Adamant sword: Attack 30; stab +23, strength +24, speed 4');
    expect(adamant).toContain('- Adamnt warhammer: Attack 30; crush +35, speed 4');
    expect(adamant.match(/Adamant dagger/g)).toHaveLength(1);
    expect(page('knowledge/weapons-adamant-ranged.md')).toContain('- Adamant arrow: the bow must allow it; ranged strength +31 (ammo)');
    const swords = page('knowledge/weapons-sword.md');
    expect(swords.indexOf('Adamant sword')).toBeLessThan(swords.indexOf('Rune sword'));
    expect(pages.every(p => p.text.length <= 1_450)).toBe(true);
  });

  const sdk = join(import.meta.dir, '..', '..', 'vendor', 'rs-sdk');
  test.skipIf(!existsSync(join(sdk, 'server', 'content', 'scripts', 'levelrequire')))('the real server: every check is read', () => {
    const { rules, unknown } = readWieldRules(sdk);
    expect(unknown).toEqual([]);
    expect(Object.keys(rules).length).toBeGreaterThan(300);
    expect(rules['wiki/items/rune-axe.md']).toBe('Attack 40');
    expect(rules['wiki/items/rune-platebody.md']).toBe('Defence 40, and the quest Dragon Slayer complete');
  });
});

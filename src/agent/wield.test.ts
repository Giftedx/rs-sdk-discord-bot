import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWieldRules, wieldNote, wieldRule } from './wield';

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

  const sdk = join(import.meta.dir, '..', '..', 'vendor', 'rs-sdk');
  test.skipIf(!existsSync(join(sdk, 'server', 'content', 'scripts', 'levelrequire')))('the real server: every check is read', () => {
    const { rules, unknown } = readWieldRules(sdk);
    expect(unknown).toEqual([]);
    expect(Object.keys(rules).length).toBeGreaterThan(300);
    expect(rules['wiki/items/rune-axe.md']).toBe('Attack 40');
    expect(rules['wiki/items/rune-platebody.md']).toBe('Defence 40, and the quest Dragon Slayer complete');
  });
});

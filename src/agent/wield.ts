// The wield checks of the server: the [opheld2,<obj>] scripts that call a levelrequire_* label.
// The wiki "Level Requirement" row is the item's levelrequire param, which the server reads only
// as the Mining level of a pickaxe and the Firemaking level of a log. So the wiki cannot tell
// which skill a wield needs, and for axes and pickaxes its number is not the wield level.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The wield rule of each wiki item page, by page source ("wiki/items/rune-axe.md"). */
export type WieldRules = Record<string, string>;

const QUEST: Record<string, string> = {
  dragon_slayer: 'Dragon Slayer', heroes: "Heroes' Quest", legends: "Legends' Quest",
  zanaris: 'Lost City', regicide: 'Regicide', viking: 'The Fremennik Trials',
};

/** The rule text of one levelrequire_* call, or null for a label that this code does not know. */
export function wieldRule(label: string, args: string[]): string | null {
  const a = args.filter(x => x !== 'last_slot' && x !== '$slot');
  let quest = '';
  let base = label.replace(/^levelrequire_/, '');
  const q = /^(dragon_slayer|heroes|legends|zanaris|regicide|viking)_quest_(.+)$/.exec(base);
  if (q) { quest = QUEST[q[1]!]!; base = q[2]!; }
  let levels: string;
  switch (base) {
    case 'attack': case 'attack_caps': levels = `Attack ${a[0]}`; break;
    case 'defence': case 'defence_caps': case 'helm': levels = `Defence ${a[0]}`; break;
    case 'ranged': case 'ranged_lower': levels = `Ranged ${a[0]}`; break;
    case 'magic': levels = `Magic ${a[0]}`; break;
    case 'magic_and_attack': levels = `Magic ${a[0]} and Attack ${a[1]}`; break;
    case 'magic_and_defence': levels = `Magic ${a[0]} and Defence ${a[1]}`; break;
    case 'ranged_and_defence': levels = `Ranged ${a[0]} and Defence ${a[1]}`; break;
    case 'attack_and_strength': case 'attack_strength': levels = `Attack ${a[0]} and Strength ${a[1]}`; break;
    case 'defence_and_strength': levels = `Defence ${a[0]} and Strength ${a[0]}`; break;
    case 'iban_staff': levels = 'Magic 50 and Attack 50'; break;
    default: return null;
  }
  return quest ? `${levels}, and the quest ${quest} complete` : levels;
}

const slugify = (n: string) => n.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function walk(dir: string, ext: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out); else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

/**
 * Reads the wield checks from the server scripts of an rs-sdk checkout. The key is the wiki page
 * of the item, named as the wiki generator names it (the slug of the item name).
 */
export function readWieldRules(sdkDir: string): { rules: WieldRules; unknown: string[]; bySym: Map<string, string>; objs: Map<string, ObjConfig> } {
  const scripts = join(sdkDir, 'server', 'content', 'scripts');
  const objs = readObjs(scripts);
  const names = new Map([...objs].filter(([, o]) => o.name).map(([s, o]) => [s, o.name!]));
  const rules: WieldRules = {};
  const unknown: string[] = [];
  const bySym = new Map<string, string>();
  const byPage = new Map<string, { sym: string; rule: string }[]>();
  for (const f of walk(join(scripts, 'levelrequire'), '.rs2')) {
    const lines = readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const head = /^\[opheld2,([a-z0-9_]+)\]\s*(.*)$/.exec(line);
      if (!head) return;
      const sym = head[1]!;
      // The block runs to the next "[" line. A quest check can come before the level check.
      const block = [head[2]!];
      for (let j = i + 1; j < lines.length && !lines[j]!.startsWith('['); j++) block.push(lines[j]!);
      const text = block.join('\n');
      const call = /@(levelrequire_[a-z_]+)\(([^)]*)\)/.exec(text);
      // The tutorial items (bronze axe, dagger, pickaxe) have no level check.
      if (!call) { if (!/@tutorial_island_equip/.test(text)) unknown.push(sym); return; }
      let rule = wieldRule(call[1]!, call[2]!.split(',').map(s => s.trim()));
      if (rule === null) { unknown.push(`${sym}: ${call[1]}`); return; }
      const viking = /%viking\s*<\s*\^viking_complete/.test(text);
      if (viking && !rule.includes('quest')) rule += `, and the quest ${QUEST.viking} complete`;
      bySym.set(sym, rule);
      const page = `wiki/items/${slugify(names.get(sym) || sym.replace(/_/g, ' '))}.md`;
      (byPage.get(page) ?? byPage.set(page, []).get(page)!).push({ sym, rule });
    });
  }
  // Objects with one name share a page: the four colours of "Dragonhide body" are one page.
  for (const [page, list] of byPage) {
    const distinct = new Set(list.map(x => x.rule));
    rules[page] = distinct.size === 1 ? list[0]!.rule : list.map(x => `${x.rule} (${x.sym.replace(/_/g, ' ')})`).join('; or ');
  }
  return { rules, unknown, bySym, objs };
}

/** The fields of one [obj] config that the weapon table needs. A param line counts as a field. */
export interface ObjConfig { name?: string; wearpos?: string; category?: string; members?: string; params: Record<string, string>; file: string }

/** Reads every .obj config under the scripts folder: symbol -> fields. */
export function readObjs(scriptsDir: string): Map<string, ObjConfig> {
  const objs = new Map<string, ObjConfig>();
  for (const f of walk(scriptsDir, '.obj')) {
    let cur: ObjConfig | null = null;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\[([a-z0-9_]+)\]/.exec(line);
      if (m) { cur = { params: {}, file: f }; objs.set(m[1]!, cur); continue; }
      if (!cur) continue;
      const p = /^param=([a-z_]+),(.*)$/.exec(line);
      if (p) { cur.params[p[1]!] = p[2]!.trim(); continue; }
      const kv = /^(name|wearpos|category|members)=(.*)$/.exec(line);
      if (kv) cur[kv[1] as 'name'] = kv[2]!.trim();
    }
  }
  return objs;
}

const MELEE = new Set(['weapon_stab', 'weapon_slash', 'weapon_spear', 'weapon_blunt', 'weapon_axe', 'weapon_spiked',
  'weapon_polearm', 'weapon_2h_sword', 'weapon_claws', 'weapon_pickaxe', 'weapon_scythe']);
const STYLES = [
  { key: 'stabattack', title: 'stab' },
  { key: 'slashattack', title: 'slash' },
  { key: 'crushattack', title: 'crush' },
  { key: 'strengthbonus', title: 'strength (max hit)' },
] as const;
const TIERS = [1, 5, 10, 20, 30, 40, 50, 60];

/**
 * Knowledge pages made from the item configs: for each attack style, the best melee weapons that
 * each Attack level can wield. A free weapon and a members weapon are both named.
 */
export function meleeWeaponPages(objs: Map<string, ObjConfig>, bySym: Map<string, string>): { source: string; text: string }[] {
  const num = (o: ObjConfig, k: string) => Number(o.params[k] ?? 0) || 0;
  // Not real weapons: the random-event items (broken pickaxe, pickaxe handle), the test configs,
  // and the staff item poisoned_dagger_p (255 on every bonus, see player/scripts/appearance.rs2).
  const notReal = (sym: string, o: ObjConfig) => /[\\/](macro events|_test)[\\/]/.test(o.file) || sym === 'poisoned_dagger_p'
    || STYLES.some(s => num(o, s.key) >= 200);
  const weapons = [...objs].filter(([sym, o]) => o.wearpos === 'righthand' && MELEE.has(o.category ?? '') && o.name && !notReal(sym, o))
    .map(([sym, o]) => {
      const rule = bySym.get(sym) ?? 'Attack 1';
      const attack = Number(/Attack (\d+)/.exec(rule)?.[1] ?? 1);
      return { sym, o, rule, attack };
    });
  const label = (w: typeof weapons[number], key: string) => {
    // Only a members weapon is tagged: the rest are free.
    const extra = [...(w.o.members === 'yes' ? ['members'] : []), w.rule === 'Attack 1' ? 'no level needed' : `needs ${w.rule}`];
    // The attackrate param defaults to 4 (skill_combat/configs/combat.param).
    const bonus = key === 'strengthbonus' ? '' : `+${num(w.o, key)} ${key.replace('attack', '')}, `;
    return `${w.o.name} (${bonus}+${num(w.o, 'strengthbonus')} strength, speed ${w.o.params.attackrate ?? '4'}; ${extra.join(', ')})`;
  };
  return STYLES.map(({ key, title }) => {
    // One entry per tier; tiers with the same answer merge into one range ("Attack 40 to 59").
    const rows: { from: number; to: number | null; text: string }[] = [];
    TIERS.forEach((t, i) => {
      const can = weapons.filter(w => w.attack <= t && num(w.o, key) > 0)
        .sort((a, b) => num(b.o, key) - num(a.o, key) || num(b.o, 'strengthbonus') - num(a.o, 'strengthbonus'));
      const best = can[0];
      if (!best) return;
      const free = can.find(w => w.o.members !== 'yes');
      const text = free && free !== best ? `${label(best, key)}. Free: ${label(free, key)}` : label(best, key);
      const to = i + 1 < TIERS.length ? TIERS[i + 1]! - 1 : null;
      const last = rows[rows.length - 1];
      if (last && last.text === text) last.to = to;
      else rows.push({ from: t, to, text });
    });
    const lines = rows.map(r => `- Attack ${r.from}${r.to === null ? ' or more' : ` to ${r.to}`}: ${r.text}.`);
    return {
      source: `knowledge/best-melee-weapon-${title.split(' ')[0]}.md`,
      text: [`## Best melee weapon for ${title} at each Attack level`, '',
        `From the server configs. Higher bonus is better. Speed: ticks per attack, lower is faster. No "members" tag means free.`, '',
        ...lines].join('\n'),
    };
  });
}

/**
 * The line that the search puts at the top of a wiki item page: the wield rule from the server
 * code, and a warning when the page's "Level Requirement" row shows another number.
 */
export function wieldNote(rule: string, pageText: string): string {
  const row = /\| Level Requirement \| (\d+) \|/.exec(pageText)?.[1];
  const first = /\d+/.exec(rule)?.[0];
  const pickaxe = /^# .*pickaxe/im.test(pageText);
  let warn = '';
  if (row !== undefined && row !== first) {
    warn = pickaxe
      ? ` The "Level Requirement" row (${row}) on this page is the Mining level to mine with it, from the inventory or the hand. It is not the wield level.`
      : ` The "Level Requirement" row (${row}) on this page is not the wield level. The server does not check that number for this item.`;
  }
  return `> Server code: to wield or wear this item needs ${rule}.${warn}`;
}

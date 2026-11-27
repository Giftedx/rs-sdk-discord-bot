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

export function walk(dir: string, ext: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  // Sorted: the order of readdirSync differs between file systems, and the pages must not.
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
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
 * The search shows at most 1500 characters of a page, so a longer page splits into parts. A page
 * is "## title", "", one head line, "", then one row per line; each part keeps the title and head.
 */
export function fitPage(p: { source: string; text: string }): { source: string; text: string }[] {
  if (p.text.length <= 1_450) return [p];
  const [title, , head, , ...rows] = p.text.split('\n');
  const parts: string[][] = [[]];
  for (const row of rows) {
    const cur = parts[parts.length - 1]!;
    if (cur.length && [title, head, ...cur, row].join('\n').length > 1_350) parts.push([row]);
    else cur.push(row);
  }
  return parts.map((part, i) => ({
    source: p.source.replace(/\.md$/, `-part${i + 1}.md`),
    text: [`${title} (part ${i + 1} of ${parts.length})`, '', head!, '', ...part].join('\n'),
  }));
}

export const METAL = /^(bronze|iron|steel|black|mithril|adamant|adamnt|adam|rune|dragon)\s+(.+)$/i;
const METALS = ['bronze', 'iron', 'steel', 'black', 'mithril', 'adamant', 'rune', 'dragon'];
const POISON = /\s*\((p|kp|p\+|p\+\+)\)$/i;
const RANGED = new Set(['weapon_thrown', 'weapon_javelin', 'weapon_bow', 'weapon_crossbow']);
const plural = (kind: string) => kind.endsWith('knife') ? `${kind.slice(0, -4)}knives` : /(s|staff)$/.test(kind) ? (kind.endsWith('staff') ? `${kind}s` : kind) : `${kind}s`;

/**
 * Knowledge pages made from the item configs: every weapon (and arrow) with its wield level and
 * bonuses, one page per metal ("Adamant melee weapons") and one page per type ("Swords"). A
 * poisoned copy, such as "Adamant dagger(p)", is the same weapon and is not listed again.
 */
export function weaponCatalogPages(objs: Map<string, ObjConfig>, bySym: Map<string, string>): { source: string; text: string }[] {
  const num = (o: ObjConfig, k: string) => Number(o.params[k] ?? 0) || 0;
  type W = { name: string; kind: string; metal: string | null; ranged: boolean; line: string; level: number };
  const seen = new Set<string>();
  const list: W[] = [];
  for (const [sym, o] of objs) {
    if (!o.name || /[\\/](macro events|_test)[\\/]/.test(o.file) || sym === 'poisoned_dagger_p') continue;
    const weapon = o.wearpos === 'righthand' && (o.category ?? '').startsWith('weapon_');
    const ammo = o.wearpos === 'quiver' && /arrow|bolt/i.test(o.name);
    if (!weapon && !ammo) continue;
    const base = o.name.replace(POISON, '').trim();
    if (seen.has(base.toLowerCase())) continue;
    seen.add(base.toLowerCase());
    const m = METAL.exec(base);
    const metal = m ? (/^adam/i.test(m[1]!) ? 'adamant' : m[1]!.toLowerCase()) : null;
    const kind = (m ? m[2]! : base).toLowerCase();
    const ranged = ammo || RANGED.has(o.category ?? '');
    const rule = bySym.get(sym) ?? '';
    const level = Number(/(?:Attack|Ranged|Magic) (\d+)/.exec(rule)?.[1] ?? 1);
    const bonuses = ranged
      ? [['range', num(o, 'rangeattack')], ['ranged strength', num(o, 'rangebonus')]]
      : [['stab', num(o, 'stabattack')], ['slash', num(o, 'slashattack')], ['crush', num(o, 'crushattack')], ['magic', num(o, 'magicattack')], ['strength', num(o, 'strengthbonus')]];
    const shown = bonuses.filter(([, v]) => v !== 0).map(([k, v]) => `${k} ${(v as number) > 0 ? '+' : ''}${v}`);
    const speed = weapon && !ammo ? `, speed ${o.params.attackrate ?? '4'}` : '';
    // An arrow has no wield level: the bow decides which arrows it can fire.
    const needs = rule || (ammo ? 'the bow must allow it' : 'no level needed');
    const line = `- ${base}: ${needs}${o.members === 'yes' ? ' (members)' : ''}; ${shown.join(', ') || 'no bonuses'}${speed}${ammo ? ' (ammo)' : ''}`;
    list.push({ name: base, kind, metal, ranged, line, level });
  }
  const byLevel = (a: W, b: W) => a.level - b.level || a.name.localeCompare(b.name);
  const head = 'From the server item configs and wield checks. Speed: ticks per attack, lower is faster. A higher bonus is better.';
  const out: { source: string; text: string }[] = [];
  const pages = { push(p: { source: string; text: string }) { out.push(...fitPage(p)); } };
  for (const metal of METALS) {
    for (const ranged of [false, true]) {
      const items = list.filter(w => w.metal === metal && w.ranged === ranged).sort((a, b) => a.kind.localeCompare(b.kind));
      if (!items.length) continue;
      const what = ranged ? 'ranged weapons and ammo' : 'melee weapons';
      const title = `${metal[0]!.toUpperCase()}${metal.slice(1)} ${what}`;
      pages.push({ source: `knowledge/weapons-${metal}-${ranged ? 'ranged' : 'melee'}.md`, text: [`## ${title}: every ${metal} ${ranged ? 'ranged weapon' : 'weapon'}, its level and bonuses`, '', head, '', ...items.map(w => w.line)].join('\n') });
    }
  }
  // One page per metal weapon type, sorted by level, so "best sword at Attack 56" is the last one that the level allows.
  const kinds = [...new Set(list.filter(w => w.metal).map(w => w.kind))].sort();
  for (const kind of kinds) {
    const items = list.filter(w => w.kind === kind || w.kind.endsWith(` ${kind}`) && !kinds.includes(w.kind)).sort(byLevel);
    pages.push({ source: `knowledge/weapons-${kind.replace(/\s+/g, '-')}.md`, text: [`## ${plural(kind)[0]!.toUpperCase()}${plural(kind).slice(1)}: every ${kind}, its level and bonuses, lowest level first`, '', head, '', ...items.map(w => w.line)].join('\n') });
  }
  const groups: [string, string, (w: W) => boolean][] = [
    ['bows', 'Bows and crossbows', w => !w.metal && /bow/.test(w.kind)],
    ['staffs', 'Staffs and battlestaffs', w => !w.metal && /staff/.test(w.kind)],
    ['special', 'Special melee weapons (not made of a metal)', w => !w.metal && !w.ranged && !/staff/.test(w.kind)],
  ];
  for (const [slug, title, pick] of groups) {
    const items = list.filter(pick).sort(byLevel);
    if (items.length) pages.push({ source: `knowledge/weapons-${slug}.md`, text: [`## ${title}: every one, its level and bonuses, lowest level first`, '', head, '', ...items.map(w => w.line)].join('\n') });
  }
  return out;
}

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

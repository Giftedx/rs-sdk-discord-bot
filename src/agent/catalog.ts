// Knowledge pages made from the server configs: all armour by slot, by metal and by style, and
// all food by the hitpoints it heals. Like the weapon pages in wield.ts, they come from the data
// that the server runs, so they cannot drift from the game the way the hand-written wiki did.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fitPage, METAL, walk, type ObjConfig } from './wield';

type Page = { source: string; text: string };

const SLOTS: [string, string, string][] = [
  ['hat', 'helmets', 'Helmets and hats'],
  ['torso', 'bodies', 'Body armour (platebodies, chainbodies, robe tops)'],
  ['legs', 'legs', 'Leg armour (platelegs, plateskirts, chaps)'],
  ['lefthand', 'shields', 'Shields and books'],
  ['hands', 'gloves', 'Gloves, gauntlets and vambraces'],
  ['feet', 'boots', 'Boots'],
  ['back', 'capes', 'Capes and cloaks'],
  ['front', 'amulets', 'Amulets and necklaces'],
];
const DEF = ['stabdefence', 'slashdefence', 'crushdefence', 'magicdefence', 'rangedefence'];
const ATT: [string, string][] = [['stabattack', 'stab'], ['slashattack', 'slash'], ['crushattack', 'crush'], ['magicattack', 'magic'], ['rangeattack', 'range']];
const num = (o: ObjConfig, k: string) => Number(o.params[k] ?? 0) || 0;
const sign = (v: number) => `${v > 0 ? '+' : ''}${v}`;
const notReal = (sym: string, o: ObjConfig) => /[\\/](macro events|_test)[\\/]/.test(o.file) || sym === 'poisoned_dagger_p';

interface Armour { sym: string; name: string; slot: string; metal: string | null; rule: string; level: number; members: boolean; line: string; defTotal: number; ranged: boolean; magic: boolean; prayer: boolean }

/** Every wearable item that is not a weapon or ammo and has a bonus, one line each. */
function armourList(objs: Map<string, ObjConfig>, bySym: Map<string, string>): Armour[] {
  const rows: Armour[] = [];
  for (const [sym, o] of objs) {
    if (!o.name || !o.wearpos || !SLOTS.some(s => s[0] === o.wearpos) || notReal(sym, o)) continue;
    const def = DEF.map(k => num(o, k));
    const att = ATT.map(([k, label]) => [label, num(o, k)] as const).filter(([, v]) => v !== 0);
    const str = num(o, 'strengthbonus');
    const prayer = num(o, 'prayerbonus');
    if (!def.some(v => v !== 0) && !att.length && !str && !prayer) continue;
    const rule = bySym.get(sym) ?? '';
    const m = METAL.exec(o.name);
    const extra = [
      ...(att.length ? [`attack ${att.map(([l, v]) => `${l} ${sign(v)}`).join(', ')}`] : []),
      ...(str ? [`strength ${sign(str)}`] : []),
      ...(prayer ? [`prayer ${sign(prayer)}`] : []),
    ];
    const stats = `defence ${def.map(sign).join('/')}${extra.length ? `; ${extra.join('; ')}` : ''}`;
    rows.push({
      sym, name: o.name, slot: o.wearpos, metal: m ? (/^adam/i.test(m[1]!) ? 'adamant' : m[1]!.toLowerCase()) : null,
      rule, level: Number(/(\d+)/.exec(rule)?.[1] ?? 1), members: o.members === 'yes',
      line: `${rule || 'no level needed'}${o.members === 'yes' ? ' (members)' : ''}; ${stats}`,
      defTotal: def.reduce((a, b) => a + b, 0),
      ranged: /Ranged/.test(rule) || num(o, 'rangeattack') > 0, magic: /Magic/.test(rule) || num(o, 'magicattack') > 0, prayer: prayer > 0,
    });
  }
  // One line per item: copies with the same name and the same stats (dyed boots, glory charges,
  // trimmed and gold armour) are one line; the same name with other stats keeps its code name.
  const out: Armour[] = [];
  const byKey = new Map<string, Armour>();
  for (const a of rows) {
    const base = a.name.replace(/\s*\((t|g|\d)\)$/i, '').trim();
    const key = `${base.toLowerCase()}|${a.line}`;
    if (byKey.has(key)) continue;
    const a2 = { ...a, name: base };
    byKey.set(key, a2);
    out.push(a2);
  }
  const names = new Map<string, number>();
  for (const a of out) names.set(a.name.toLowerCase(), (names.get(a.name.toLowerCase()) ?? 0) + 1);
  return out.map(a => ({ ...a, line: `- ${a.name}${(names.get(a.name.toLowerCase()) ?? 0) > 1 ? ` (${a.sym.replace(/_/g, ' ')})` : ''}: ${a.line}` }));
}

const HEAD = 'From the server item configs and wield checks. Defence bonuses are stab/slash/crush/magic/range. Higher is better. Trimmed (t) and gold (g) versions have the same stats.';

export function armourPages(objs: Map<string, ObjConfig>, bySym: Map<string, string>): Page[] {
  const list = armourList(objs, bySym);
  // Highest level first: a long page splits into parts, and the best items should be in part 1.
  const order = (a: Armour, b: Armour) => b.level - a.level || b.defTotal - a.defTotal || a.name.localeCompare(b.name);
  const page = (slug: string, title: string, items: Armour[]): Page[] =>
    items.length ? fitPage({ source: `knowledge/armour-${slug}.md`, text: [`## ${title}: every one, its level and bonuses, highest level first`, '', HEAD, '', ...items.sort(order).map(a => a.line)].join('\n') }) : [];
  // The best item of each slot that each Defence level can wear: only items that need Defence (or
  // nothing). An item that also needs Ranged or Magic is on the ranged or magic page.
  const TIERS = [1, 5, 10, 20, 30, 40, 45, 50, 60, 70];
  const label = (a: Armour) => `${a.name} (${a.rule || 'no level needed'}${a.members ? ', members' : ''}; defence total ${a.defTotal})`;
  const best = SLOTS.flatMap(([slot, slug, title]) => {
    const can = list.filter(a => a.slot === slot && !/Ranged|Magic|Attack|Strength/.test(a.rule) && a.defTotal > 0);
    const rows: { from: number; to: number | null; text: string }[] = [];
    TIERS.forEach((t, i) => {
      // On a tie, the plain item before its trimmed copy (the code name ends in _trim or _gold).
      const copy = (a: Armour) => (/_(trim|gold)$/.test(a.sym) ? 1 : 0);
      const ok = can.filter(a => a.level <= t).sort((a, b) => b.defTotal - a.defTotal || a.level - b.level || copy(a) - copy(b) || a.name.localeCompare(b.name));
      if (!ok[0]) return;
      const free = ok.find(a => !a.members);
      const text = free && free !== ok[0] ? `${label(ok[0])}. Free: ${label(free)}` : label(ok[0]);
      const to = i + 1 < TIERS.length ? TIERS[i + 1]! - 1 : null;
      const last = rows[rows.length - 1];
      if (last && last.text === text) last.to = to; else rows.push({ from: t, to, text });
    });
    if (!rows.length) return [];
    return fitPage({
      source: `knowledge/best-armour-${slug}.md`,
      text: [`## Best ${title.split(' (')[0]!.toLowerCase()} at each Defence level`, '',
        'From the server item configs and wield checks. "Defence total" adds the five defence bonuses: higher is better. Some items also need a quest, as shown.', '',
        ...rows.map(r => `- Defence ${r.from}${r.to === null ? ' or more' : ` to ${r.to}`}: ${r.text}.`)].join('\n'),
    });
  });
  return [
    ...best,
    ...SLOTS.flatMap(([slot, slug, title]) => page(slug, title, list.filter(a => a.slot === slot))),
    ...['bronze', 'iron', 'steel', 'black', 'mithril', 'adamant', 'rune', 'dragon'].flatMap(m =>
      page(m, `${m[0]!.toUpperCase()}${m.slice(1)} armour`, list.filter(a => a.metal === m))),
    ...page('ranged', 'Ranged armour (leather, studded, dragonhide, coifs)', list.filter(a => a.ranged)),
    ...page('magic', 'Magic armour and robes (magic attack bonus)', list.filter(a => a.magic)),
    ...page('prayer', 'Prayer gear (prayer bonus: prayer lasts longer)', list.filter(a => a.prayer)),
  ];
}

/** The dbrow rows of every .dbrow file under a folder: one map of column -> values per row. */
function readRows(dir: string): Map<string, string[][]>[] {
  const rows: Map<string, string[][]>[] = [];
  for (const f of walk(dir, '.dbrow')) {
    let cur: Map<string, string[][]> | null = null;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      if (/^\[/.test(line)) { cur = new Map(); rows.push(cur); continue; }
      const m = /^data=([a-z_]+),(.*)$/.exec(line);
      if (!m || !cur) continue;
      (cur.get(m[1]!) ?? cur.set(m[1]!, []).get(m[1]!)!).push(m[2]!.split(',').map(s => s.trim()));
    }
  }
  return rows;
}

/**
 * The food page: every item that heals hitpoints, by the amount, with the Cooking level for food
 * that is cooked. A pie, pizza or cake heals the amount per bite.
 */
export function foodPages(scriptsDir: string, objs: Map<string, ObjConfig>): Page[] {
  const cookLevel = new Map<string, number>();
  for (const r of readRows(join(scriptsDir, 'skill_cooking'))) {
    const level = Number(r.get('levelrequired')?.[0]?.[0] ?? NaN);
    for (const c of r.get('cooked') ?? []) if (Number.isFinite(level) && c[0]) cookLevel.set(c[0], Math.max(level, 1));
  }
  // Food made from parts (a topped pizza) has its level in a .struct: param=product and
  // param=levelrequired. The higher level wins, as the cook step and the make step both apply.
  for (const f of walk(join(scriptsDir, 'skill_cooking'), '.struct')) {
    for (const block of readFileSync(f, 'utf8').split(/^\[/m)) {
      const product = /^param=product,([a-z0-9_]+)\s*$/m.exec(block)?.[1];
      const level = Number(/^param=levelrequired,(\d+)\s*$/m.exec(block)?.[1] ?? NaN);
      if (product && Number.isFinite(level)) cookLevel.set(product, Math.max(level, cookLevel.get(product) ?? 1));
    }
  }
  const heals = new Map<number, string[]>();
  const seen = new Set<string>();
  for (const r of readRows(join(scriptsDir, 'player', 'configs', 'consumption'))) {
    const hp = (r.get('stat_heal') ?? []).find(h => h[0] === 'hitpoints');
    const n = Number(hp?.[1] ?? 0);
    if (!(n > 0)) continue;
    for (const [sym] of r.get('consumable') ?? []) {
      const o = objs.get(sym!);
      if (!o?.name || seen.has(o.name.toLowerCase())) continue;
      seen.add(o.name.toLowerCase());
      const cook = cookLevel.get(sym!);
      const label = `${o.name}${cook ? ` (Cooking ${cook})` : ''}${o.members === 'yes' ? ' (members)' : ''}`;
      (heals.get(n) ?? heals.set(n, []).get(n)!).push(label);
    }
  }
  const lines = [...heals].sort((a, b) => b[0] - a[0]).map(([n, items]) => `- Heals ${n}: ${items.sort().join(', ')}`);
  if (!lines.length) return [];
  return fitPage({
    source: 'knowledge/food-healing.md',
    text: ['## Food and drink that heals: every item by the hitpoints it heals, most first', '',
      'From the server consume configs. A pie, pizza or cake heals this much per bite. "Cooking N" is the level to cook it.', '', ...lines].join('\n'),
  });
}

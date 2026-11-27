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
export function readWieldRules(sdkDir: string): { rules: WieldRules; unknown: string[] } {
  const scripts = join(sdkDir, 'server', 'content', 'scripts');
  const names = new Map<string, string>();
  for (const f of walk(scripts, '.obj')) {
    let cur = '';
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\[([a-z0-9_]+)\]/.exec(line);
      if (m) cur = m[1]!;
      else if (cur && line.startsWith('name=')) names.set(cur, line.slice(5).trim());
    }
  }
  const rules: WieldRules = {};
  const unknown: string[] = [];
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
      const page = `wiki/items/${slugify(names.get(sym) || sym.replace(/_/g, ' '))}.md`;
      (byPage.get(page) ?? byPage.set(page, []).get(page)!).push({ sym, rule });
    });
  }
  // Objects with one name share a page: the four colours of "Dragonhide body" are one page.
  for (const [page, list] of byPage) {
    const distinct = new Set(list.map(x => x.rule));
    rules[page] = distinct.size === 1 ? list[0]!.rule : list.map(x => `${x.rule} (${x.sym.replace(/_/g, ' ')})`).join('; or ');
  }
  return { rules, unknown };
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

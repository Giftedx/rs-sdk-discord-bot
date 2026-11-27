// Templates for drawn cards. The card tab loads CARD_PAGE_HTML once and calls
// window.renderCard(kind, data, icons) for each card. The page script builds the DOM with
// createElement and textContent only, because item names and player names are untrusted.

export type CardKind = 'level_up' | 'death' | 'instruction_receipt' | 'daily_recap' | 'status' | 'xp_chart';

export const CARD_KINDS: readonly CardKind[] = ['level_up', 'death', 'instruction_receipt', 'daily_recap', 'status', 'xp_chart'];

export interface CardItem {
  /** The item id, for the icon. Without it the card shows the name. */
  id?: number;
  name: string;
  count: number;
}

export interface LevelUpCard {
  skill: string;
  level: number;
  xp: number;
  /** The level before. */
  from?: number;
  totalLevel?: number;
  /** Set by validateCardData from level and xp; input is ignored. Absent at level 99 and above. */
  progress?: { toNext: number; pct: number };
}

export interface DeathCard {
  place: string;
  // Preformatted by the caller, for example "2026-11-27 14:05 UTC".
  time: string;
  items?: CardItem[];
  /** A guess from the game state. The card says so. */
  killer?: string;
}

export interface ReceiptSkill {
  name: string;
  before: number;
  after: number;
  xp: number;
}

export interface ReceiptItem {
  /** The item id, for the icon. */
  id?: number;
  name: string;
  before: number;
  after: number;
}

export interface InstructionReceiptCard {
  /** Who asked, or the kind of wake. The card shows it as the speaker of the instruction. */
  by?: string;
  /** How the instruction ended. Absent means done. */
  ended?: 'done' | 'stopped' | 'failed';
  instruction: string;
  summary: string;
  turns: number;
  costUsd: number;
  durationMs?: number;
  /** Only the skills that changed. */
  skills?: ReceiptSkill[];
  /** Only the items whose count changed. */
  inventory?: ReceiptItem[];
}

export interface DailyRecapCard {
  date: string;
  counts: { label: string; value: number }[];
  /** XP gained per skill. */
  xp?: { skill: string; xp: number }[];
}

export interface StatusCard {
  hp: number;
  maxHp: number;
  goal: string;
  skills: { name: string; level: number; xp: number }[];
  items?: CardItem[];
}

/** XP gained per hour. Each series has one value per label. The first series is the total. */
export interface XpChartCard {
  title: string;
  /** One short label per hour, for example "14". */
  labels: string[];
  series: { name: string; values: number[] }[];
}

export interface CardDataMap {
  level_up: LevelUpCard;
  death: DeathCard;
  instruction_receipt: InstructionReceiptCard;
  daily_recap: DailyRecapCard;
  status: StatusCard;
  xp_chart: XpChartCard;
}

/** The width of each card and its largest height. The picture is as high as its content. */
export const CARD_SIZES: Readonly<Record<CardKind, { width: number; height: number }>> = {
  level_up: { width: 560, height: 280 },
  death: { width: 560, height: 400 },
  // 548 holds the 512 by 334 game view at its own size, in its frame.
  instruction_receipt: { width: 548, height: 900 },
  daily_recap: { width: 600, height: 560 },
  status: { width: 720, height: 600 },
  xp_chart: { width: 600, height: 400 },
};

/** The smallest height of a card picture. */
export const CARD_MIN_HEIGHT = 120;

export const CARD_DEVICE_SCALE = 2;

/** The largest game frame that the receipt card takes. In base64 it stays below the 1 MB request
 *  limit of the gamelink interface. A larger frame goes to Discord as its own picture. */
export const CARD_FRAME_MAX_BYTES = 700_000;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** True for a PNG of at most CARD_FRAME_MAX_BYTES. */
export function isCardFrame(b: Uint8Array): boolean {
  return b.length >= 8 && b.length <= CARD_FRAME_MAX_BYTES && PNG_SIGNATURE.every((v, i) => b[i] === v);
}

export class CardDataError extends Error {}

const LIMITS = {
  name: 40,
  place: 80,
  time: 40,
  goal: 200,
  instruction: 300,
  summary: 600,
  date: 40,
  deathItems: 28,
  statusItems: 28,
  skills: 24,
  counts: 8,
  receiptRows: 12,
  chartPoints: 25,
  chartSeries: 4,
  chartLabel: 8,
};

export const MAX_LEVEL = 99;

/** The standard RuneScape XP table: the XP at which a level starts. Levels 1 to 126. */
export function xpForLevel(level: number): number {
  if (!Number.isInteger(level) || level < 1 || level > 126) throw new RangeError(`level out of range: ${level}`);
  let points = 0;
  for (let l = 1; l < level; l++) points += Math.floor(l + 300 * 2 ** (l / 7));
  return Math.floor(points / 4);
}

/** XP to the next level and the percent done in this level, or null at level 99 and above. */
export function levelProgress(level: number, xp: number): { toNext: number; pct: number } | null {
  if (level >= MAX_LEVEL) return null;
  const start = xpForLevel(level);
  const end = xpForLevel(level + 1);
  const toNext = Math.max(0, end - xp);
  const pct = Math.max(0, Math.min(100, Math.floor(((xp - start) / (end - start)) * 100)));
  return { toNext, pct };
}

type Obj = Record<string, unknown>;

function obj(v: unknown, where: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new CardDataError(`${where}: not an object`);
  return v as Obj;
}

// Control and format characters other than newline become spaces, so a name cannot hide text,
// reverse its direction or break the layout.
function str(o: Obj, key: string, max: number, where: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new CardDataError(`${where}.${key}: not a string`);
  const clean = v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, c => (c === '\n' ? c : ' ')).trim();
  if (clean.length === 0) throw new CardDataError(`${where}.${key}: empty`);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function num(o: Obj, key: string, where: string, min = 0, max = Number.MAX_SAFE_INTEGER, int = true): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new CardDataError(`${where}.${key}: not a finite number`);
  if (int && !Number.isInteger(v)) throw new CardDataError(`${where}.${key}: not an integer`);
  if (v < min || v > max) throw new CardDataError(`${where}.${key}: out of range ${min}..${max}`);
  return v;
}

function arr(o: Obj, key: string, max: number, where: string, optional: boolean): unknown[] | undefined {
  const v = o[key];
  if (v === undefined && optional) return undefined;
  if (!Array.isArray(v)) throw new CardDataError(`${where}.${key}: not an array`);
  if (v.length > max) throw new CardDataError(`${where}.${key}: more than ${max} entries`);
  return v;
}

function items(o: Obj, max: number, where: string): CardItem[] | undefined {
  return arr(o, 'items', max, where, true)?.map((e, i) => {
    const it = obj(e, `${where}.items[${i}]`);
    const w = `${where}.items[${i}]`;
    const out: CardItem = { name: str(it, 'name', LIMITS.name, w), count: num(it, 'count', w, 1, 2_147_483_647) };
    if (it.id !== undefined) out.id = num(it, 'id', w, 0, 999_999);
    return out;
  });
}

function optStr(o: Obj, key: string, max: number, where: string): string | undefined {
  return o[key] === undefined ? undefined : str(o, key, max, where);
}

function optNum(o: Obj, key: string, where: string, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return o[key] === undefined ? undefined : num(o, key, where, min, max);
}

function rows<T>(o: Obj, key: string, max: number, where: string, one: (r: Obj, w: string) => T): T[] | undefined {
  return arr(o, key, max, where, true)?.map((e, i) => one(obj(e, `${where}.${key}[${i}]`), `${where}.${key}[${i}]`));
}

// Returns a clean copy of the data, or throws CardDataError. Strings are trimmed and clamped.
export function validateCardData<K extends CardKind>(kind: K, data: unknown): CardDataMap[K] {
  const w = kind;
  const o = obj(data, w);
  let out: CardDataMap[CardKind];
  switch (kind) {
    case 'level_up': {
      const l: LevelUpCard = { skill: str(o, 'skill', LIMITS.name, w), level: num(o, 'level', w, 1, 126), xp: num(o, 'xp', w, 0, 200_000_000) };
      const from = optNum(o, 'from', w, 1, 126);
      if (from !== undefined) l.from = from;
      const total = optNum(o, 'totalLevel', w, 1, 3_000);
      if (total !== undefined) l.totalLevel = total;
      const p = levelProgress(l.level, l.xp);
      if (p) l.progress = p;
      out = l;
      break;
    }
    case 'death': {
      const d: DeathCard = { place: str(o, 'place', LIMITS.place, w), time: str(o, 'time', LIMITS.time, w) };
      const it = items(o, LIMITS.deathItems, w);
      if (it) d.items = it;
      const killer = optStr(o, 'killer', LIMITS.name, w);
      if (killer) d.killer = killer;
      out = d;
      break;
    }
    case 'instruction_receipt': {
      const r: InstructionReceiptCard = {
        instruction: str(o, 'instruction', LIMITS.instruction, w),
        summary: str(o, 'summary', LIMITS.summary, w),
        turns: num(o, 'turns', w, 0, 10_000),
        costUsd: num(o, 'costUsd', w, 0, 10_000, false),
      };
      const by = optStr(o, 'by', LIMITS.name, w);
      if (by) r.by = by;
      if (o.ended !== undefined) {
        if (o.ended !== 'done' && o.ended !== 'stopped' && o.ended !== 'failed') throw new CardDataError(`${w}.ended: not done, stopped or failed`);
        r.ended = o.ended;
      }
      const dur = optNum(o, 'durationMs', w, 0, 30 * 86_400_000);
      if (dur !== undefined) r.durationMs = dur;
      const sk = rows(o, 'skills', LIMITS.receiptRows, w, (k, kw) => ({
        name: str(k, 'name', LIMITS.name, kw), before: num(k, 'before', kw, 1, 126), after: num(k, 'after', kw, 1, 126), xp: num(k, 'xp', kw, 0, 200_000_000),
      }));
      if (sk) r.skills = sk;
      const inv = rows(o, 'inventory', LIMITS.receiptRows, w, (k, kw) => {
        const row: ReceiptItem = { name: str(k, 'name', LIMITS.name, kw), before: num(k, 'before', kw, 0, 2_147_483_647), after: num(k, 'after', kw, 0, 2_147_483_647) };
        if (k.id !== undefined) row.id = num(k, 'id', kw, 0, 999_999);
        return row;
      });
      if (inv) r.inventory = inv;
      out = r;
      break;
    }
    case 'daily_recap': {
      const d: DailyRecapCard = {
        date: str(o, 'date', LIMITS.date, w),
        counts: arr(o, 'counts', LIMITS.counts, w, false)!.map((e, i) => {
          const c = obj(e, `${w}.counts[${i}]`);
          return { label: str(c, 'label', LIMITS.name, `${w}.counts[${i}]`), value: num(c, 'value', `${w}.counts[${i}]`) };
        }),
      };
      const xp = rows(o, 'xp', LIMITS.skills, w, (k, kw) => ({ skill: str(k, 'skill', LIMITS.name, kw), xp: num(k, 'xp', kw, 0, 200_000_000) }));
      if (xp) d.xp = xp;
      out = d;
      break;
    }
    case 'status': {
      const maxHp = num(o, 'maxHp', w, 1, 10_000);
      const s: StatusCard = {
        hp: num(o, 'hp', w, 0, maxHp),
        maxHp,
        goal: str(o, 'goal', LIMITS.goal, w),
        skills: arr(o, 'skills', LIMITS.skills, w, false)!.map((e, i) => {
          const k = obj(e, `${w}.skills[${i}]`);
          const kw = `${w}.skills[${i}]`;
          return { name: str(k, 'name', LIMITS.name, kw), level: num(k, 'level', kw, 1, 126), xp: num(k, 'xp', kw, 0, 200_000_000) };
        }),
      };
      const it = items(o, LIMITS.statusItems, w);
      if (it) s.items = it;
      out = s;
      break;
    }
    case 'xp_chart': {
      const labels = arr(o, 'labels', LIMITS.chartPoints, w, false)!.map((v, i) => str({ v }, 'v', LIMITS.chartLabel, `${w}.labels[${i}]`));
      if (labels.length < 2) throw new CardDataError(`${w}.labels: fewer than 2 entries`);
      const series = arr(o, 'series', LIMITS.chartSeries, w, false)!.map((e, i) => {
        const sw = `${w}.series[${i}]`;
        const so = obj(e, sw);
        const values = arr(so, 'values', LIMITS.chartPoints, sw, false)!.map((v, j) => num({ v }, 'v', `${sw}.values[${j}]`, 0, 200_000_000));
        if (values.length !== labels.length) throw new CardDataError(`${sw}.values: not one value per label`);
        return { name: str(so, 'name', LIMITS.name, sw), values };
      });
      if (series.length === 0) throw new CardDataError(`${w}.series: empty`);
      out = { title: str(o, 'title', LIMITS.date, w), labels, series } satisfies XpChartCard;
      break;
    }
    default:
      throw new CardDataError(`unknown card kind: ${String(kind)}`);
  }
  return out as CardDataMap[K];
}

export function isCardKind(v: unknown): v is CardKind {
  return typeof v === 'string' && (CARD_KINDS as readonly string[]).includes(v);
}

// The item ids whose icons the card shows, without duplicates.
export function cardIconIds(kind: CardKind, data: CardDataMap[CardKind]): number[] {
  let list: { id?: number }[] = [];
  if (kind === 'death' || kind === 'status') list = (data as DeathCard | StatusCard).items ?? [];
  else if (kind === 'instruction_receipt') list = (data as InstructionReceiptCard).inventory ?? [];
  return [...new Set(list.flatMap(i => (i.id === undefined ? [] : [i.id])))];
}


// The look is the game interface of 2004: brown stone panels, square corners, orange titles,
// yellow numbers and a black text shadow, with the light parchment of the chat box.
// The font is a system font: Arial, else Liberation Sans. The page loads no font file.
const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#1d1a16;color:#fff;font:bold 15px/1.3 Arial,"Liberation Sans",Helvetica,sans-serif;font-feature-settings:"tnum" 1;overflow:hidden}
.card{position:relative;width:100%;padding:10px;display:flex;flex-direction:column;gap:9px;overflow:hidden;text-shadow:1px 1px 0 #000;
background:repeating-linear-gradient(45deg,rgba(255,255,255,.025) 0 2px,transparent 2px 6px),repeating-linear-gradient(-45deg,rgba(0,0,0,.07) 0 3px,transparent 3px 8px),#3e3529;
border:2px solid #000;box-shadow:inset 0 0 0 2px #6e6352,inset 0 0 0 4px #221d17}
.head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:2px 4px 0}
.kicker{font-size:17px;color:#ff981f;white-space:nowrap}
.card.death .kicker,.kicker.red{color:#ff3a2a}
.meta{font-size:13px;color:#c9b98f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.well{background:#2b251e;border:1px solid #14110d;box-shadow:inset 1px 1px 0 #000,1px 1px 0 #5c5244;padding:8px 10px;display:flex;flex-direction:column;gap:7px;min-width:0}
.label{display:flex;justify-content:space-between;gap:8px;font-size:13px;color:#ff981f}
.label .v{color:#ffff00}
.title{font-size:24px;line-height:1.15;color:#ffff00;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:anywhere}
.title.one{-webkit-line-clamp:1}.title.red{color:#ff3a2a}
.sub{color:#ffffff;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 4px}
.sub.o{color:#ff981f}
.clamp{overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;overflow-wrap:anywhere;white-space:pre-wrap}
.clamp2{-webkit-line-clamp:2}.clamp3{-webkit-line-clamp:3}.clamp11{-webkit-line-clamp:11}
.view{line-height:0;border:2px solid #000;box-shadow:0 0 0 2px #6e6352,0 0 0 3px #14110d;margin:3px 3px 1px;align-self:center}
.view img{width:512px;height:334px;image-rendering:pixelated;display:block}
.chat{background:linear-gradient(#e2d5b3,#d3c39b);border:2px solid #000;box-shadow:inset 0 0 0 2px #a8946a;color:#000;text-shadow:none;padding:7px 11px 8px;font-size:14px;line-height:1.38;display:flex;flex-direction:column;gap:3px}
.chat .said{color:#0000e0}.chat .who{color:#000}.chat .game{color:#000;font-weight:normal}
.chat .big{color:#000080;font-size:16px;text-align:center}.chat .mid{text-align:center}
.drops{display:flex;flex-wrap:wrap;gap:5px}
.drop{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 9px 0 5px;background:#2b251e;border:1px solid #14110d;box-shadow:inset 1px 1px 0 #000,1px 1px 0 #5c5244;font-size:13.5px;white-space:nowrap;max-width:100%}
.drop .nm{color:#fff;overflow:hidden;text-overflow:ellipsis}
.drop img{width:24px;height:22px;object-fit:contain;image-rendering:pixelated;flex:none}
.drop .ph{width:22px;height:20px;background:#14110d;flex:none}
.drop .lv{color:#ffff00}
.up{color:#00ff00}.down{color:#ff3a2a}
.stats{display:grid;gap:6px}
.stat{display:flex;flex-direction:column;gap:2px;padding:7px 10px;background:#2b251e;border:1px solid #14110d;box-shadow:inset 1px 1px 0 #000,1px 1px 0 #5c5244;min-width:0}
.stat .v{font-size:21px;color:#ffff00;white-space:nowrap}
.stat .l{font-size:12.5px;color:#ff981f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.badge{flex:none;display:inline-flex;align-items:center;justify-content:center}
.badge img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated;filter:drop-shadow(1px 1px 0 #000)}
.badge .ini{width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--sk);color:#000;text-shadow:none;border:1px solid #000;line-height:1}
.bar{position:relative;flex:1;height:14px;background:#14110d;border:1px solid #000;overflow:hidden}
.bar.thin{height:10px}.bar.hp{background:#b40000}
.well>.bar{flex:none}
.bar>div{height:100%;background:var(--fill,#00b400);box-shadow:inset 0 1px 0 rgba(255,255,255,.25)}
.items{display:grid;gap:2px;justify-content:start}
.slot{position:relative;width:44px;height:38px;background:#2e2820;border:1px solid #1a1611;display:flex;align-items:center;justify-content:center}
.tight .slot{height:34px}
.slot.empty{background:#332c23;border-color:#2a241c}
.slot img{max-width:36px;max-height:30px;image-rendering:pixelated;margin-top:4px;filter:drop-shadow(1px 1px 0 #000)}
.slot .c{position:absolute;left:2px;top:0;font-size:11px;color:#ffff00}
.slot .c.k{color:#fff}.slot .c.m{color:#00ff80}
.slot .nm{font-size:8.5px;line-height:1.05;text-align:center;padding:0 2px;color:#c9b98f;overflow-wrap:anywhere;max-height:34px;overflow:hidden}
.rows{display:flex;flex-direction:column;gap:6px}
.r{display:flex;align-items:center;gap:8px;font-size:14px;min-width:0;height:22px}
.r .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff}
.r .d{text-align:right;white-space:nowrap}
.more{font-size:12.5px;color:#c9b98f}
.cols{display:flex;gap:9px;align-items:flex-start}.cols>.well{flex:1;min-width:0}
.sk{display:grid;grid-template-columns:repeat(3,1fr);gap:3px}
.skt{display:flex;align-items:center;gap:6px;height:30px;padding:0 8px 0 4px;background:#2e2820;border:1px solid #1a1611;min-width:0}
.skt .nm{flex:1;min-width:0;font-size:12.5px;color:#ff981f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.skt .lv{font-size:14px;color:#ffff00}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;padding:0 4px;font-size:13px}
.legend span{display:inline-flex;align-items:center;gap:6px;color:#fff;white-space:nowrap}
.dot{display:inline-block;width:10px;height:10px;border:1px solid #000}
svg text{fill:#ff981f;font-size:11px;font-family:inherit;font-weight:bold}
`;

// Plain JavaScript that runs in the card page. It must never parse a string as HTML.
export const CARD_PAGE_SCRIPT = `
(function(){
  // The SVG namespace; built in parts so the page holds no URL.
  var NS = ['http:', '', 'www.w3.org', '2000', 'svg'].join('/');
  function el(tag, cls, text){
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = String(text);
    return e;
  }
  function svgEl(tag, attrs){
    var e = document.createElementNS(NS, tag);
    Object.keys(attrs).forEach(function(k){ e.setAttribute(k, String(attrs[k])); });
    return e;
  }
  function css(e, text){ e.style.cssText = text; return e; }
  function fmt(n){ return Number(n).toLocaleString('en-US'); }
  function signed(n){ return (n > 0 ? '+' : n < 0 ? '\\u2212' : '') + fmt(Math.abs(n)); }
  var ARROW = ' \\u2192 ';
  var DOT = ' \\u00b7 ';

  // The skill icons of the game client, cut from its sprite sheets by loadSkillIcons. By skill key.
  var SKILL_IMG = {};
  var SKILL_COLORS = {
    attack: '#e65a4f', strength: '#4fc46a', defence: '#5b8fe6', hitpoints: '#e8566f', ranged: '#9cc44f',
    prayer: '#efe6bf', magic: '#7a86f0', cooking: '#bb63d8', woodcutting: '#c08447', fletching: '#3fb3aa',
    fishing: '#5fb0ea', firemaking: '#f2903a', crafting: '#d2a273', smithing: '#a3a9b4', mining: '#b0937a',
    herblore: '#52c452', agility: '#6474e0', thieving: '#b073d4', runecraft: '#e0bb4c', slayer: '#c0504a',
    farming: '#78b544', construction: '#d0a878'
  };

  function skillKey(name){ return String(name).toLowerCase().replace(/[^a-z]/g, ''); }
  function skillColor(name){ return SKILL_COLORS[skillKey(name)] || '#9aa0aa'; }
  function badge(name, size){
    var b = el('span','badge');
    b.style.setProperty('--sk', skillColor(name));
    b.style.width = size + 'px'; b.style.height = size + 'px';
    var src = SKILL_IMG[skillKey(name)];
    if (src) b.appendChild(img(src, name));
    else { var ini = el('span','ini',String(name).charAt(0).toUpperCase()); ini.style.fontSize = Math.round(size * 0.55) + 'px'; b.appendChild(ini); }
    return b;
  }
  function head(c, label, right){
    var h = el('div','head');
    h.appendChild(el('div','kicker',label));
    if (right) h.appendChild(el('div','meta',right));
    c.appendChild(h);
  }
  function stat(v, l){ var s = el('div','stat'); s.appendChild(el('div','v',v)); s.appendChild(el('div','l',l)); return s; }
  function stats(list, cols){ var g = el('div','stats'); g.style.gridTemplateColumns = 'repeat(' + cols + ',1fr)'; list.forEach(function(x){ g.appendChild(stat(x[0], x[1])); }); return g; }
  function bar(pct, fill, cls){
    var b = el('div', 'bar' + (cls ? ' ' + cls : ''));
    var f = el('div'); f.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (fill) b.style.setProperty('--fill', fill);
    b.appendChild(f); return b;
  }
  function well(label, value){
    var p = el('div','well');
    if (label) { var l = el('div','label'); l.appendChild(el('span','',label)); if (value !== undefined) l.appendChild(el('span','v',value)); p.appendChild(l); }
    return p;
  }
  function iconSrc(icons, id){
    var src = id === undefined ? undefined : icons[String(id)];
    return typeof src === 'string' && src.indexOf('data:image/png;base64,') === 0 ? src : null;
  }
  function img(src, alt){ var i = document.createElement('img'); i.alt = alt; i.src = src; return i; }
  // The stack sizes of the game: yellow below 100K, white in K, green in M.
  function stack(n){
    if (n >= 10000000) return { t: Math.floor(n / 1000000) + 'M', c: 'c m' };
    if (n >= 100000) return { t: Math.floor(n / 1000) + 'K', c: 'c k' };
    return { t: String(n), c: 'c' };
  }
  function slot(it, icons){
    var cell = el('div','slot');
    var src = iconSrc(icons, it.id);
    if (src) cell.appendChild(img(src, it.name)); else cell.appendChild(el('div','nm',it.name));
    if (it.count > 1) { var s = stack(it.count); cell.appendChild(el('div', s.c, s.t)); }
    return cell;
  }
  function slots(list, icons, cols, fill){
    var g = el('div','items');
    g.style.gridTemplateColumns = 'repeat(' + cols + ',44px)';
    list.forEach(function(it){ g.appendChild(slot(it, icons)); });
    for (var i = list.length; i < fill; i++) g.appendChild(el('div','slot empty'));
    return g;
  }
  function drop(lead, parts){
    var d = el('span','drop');
    d.appendChild(lead);
    parts.forEach(function(p){ d.appendChild(el('span', p[1], p[0])); });
    return d;
  }
  function more(box, n){ if (n > 0) box.appendChild(el('div','more','and ' + n + ' more')); }
  function line(cls, parts){
    var l = el('div', cls);
    parts.forEach(function(p){ l.appendChild(el('span', p[1], p[0])); });
    return l;
  }

  var R = {
    level_up: function(c, d){
      head(c, 'Level up', d.totalLevel ? 'Total level ' + fmt(d.totalLevel) : null);
      var chat = el('div','chat');
      var top = css(el('div'), 'display:flex;align-items:center;gap:12px');
      top.appendChild(badge(d.skill, 44));
      var words = css(el('div'), 'flex:1;min-width:0;display:flex;flex-direction:column;gap:3px');
      words.appendChild(el('div','big clamp clamp2','Congratulations, you just advanced ' + (/^[aeiou]/i.test(d.skill) ? 'an ' : 'a ') + d.skill + ' level.'));
      var lv = d.from && d.from < d.level - 1 ? 'Your ' + d.skill + ' level went from ' + d.from + ' to ' + d.level + '.' : 'Your ' + d.skill + ' level is now ' + d.level + '.';
      words.appendChild(el('div','mid clamp clamp2',lv));
      top.appendChild(words);
      chat.appendChild(top);
      c.appendChild(chat);
      var p = well();
      var l = el('div','label');
      if (d.progress) {
        l.appendChild(el('span','','Next: level ' + (d.level + 1)));
        l.appendChild(el('span','v',fmt(d.progress.toNext) + ' XP to go'));
        p.appendChild(l);
        p.appendChild(bar(Math.max(2, d.progress.pct), null, 'thin'));
      } else {
        l.appendChild(el('span','','Maximum level'));
        l.appendChild(el('span','v',fmt(d.xp) + ' XP'));
        p.appendChild(l);
        p.appendChild(bar(100, null, 'thin'));
      }
      c.appendChild(p);
    },
    death: function(c, d, icons){
      head(c, 'Oh dear, you are dead!', d.time);
      if (d.killer) c.appendChild(el('div','sub o','Probably killed by ' + d.killer));
      c.appendChild(el('div','sub',d.place));
      var list = d.items || [];
      var p = well('Items lost', list.length ? fmt(list.length) : 'none');
      if (list.length) p.appendChild(slots(list, icons, 11, 0));
      else p.appendChild(el('div','more','Nothing was lost.'));
      c.appendChild(p);
    },
    instruction_receipt: function(c, d, icons, frame){
      var meta = [];
      if (d.durationMs !== undefined) { var m = Math.round(d.durationMs / 60000); meta.push(m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : Math.max(1, m) + ' min'); }
      meta.push(fmt(d.turns) + (d.turns === 1 ? ' turn' : ' turns'));
      meta.push('$' + Number(d.costUsd).toFixed(2));
      head(c, d.ended === 'failed' ? 'Request failed' : d.ended === 'stopped' ? 'Request stopped' : 'Request complete', meta.join(DOT));
      if (d.ended === 'failed' || d.ended === 'stopped') c.firstChild.firstChild.classList.add('red');
      if (frame) { var v = el('div','view'); v.appendChild(img(frame, 'Game view')); c.appendChild(v); }
      var chat = el('div','chat');
      chat.appendChild(line('clamp clamp3', [[(d.by || 'Request') + ': ', 'who'], [d.instruction, 'said']]));
      // 11 lines hold the 600 characters that the summary may have.
      chat.appendChild(el('div','game clamp clamp11',d.summary));
      c.appendChild(chat);
      var MAX = 8;
      var list = [];
      (d.skills || []).forEach(function(x){
        var parts = [[x.name, 'nm']];
        if (x.after > x.before) parts.push([x.before + ARROW + x.after, 'lv']); else parts.push([String(x.after), 'lv']);
        if (x.xp > 0) parts.push(['+' + fmt(x.xp) + ' xp', 'up']);
        list.push(drop(badge(x.name, 22), parts));
      });
      (d.inventory || []).forEach(function(x){
        var src = iconSrc(icons, x.id);
        var n = x.after - x.before;
        list.push(drop(src ? img(src, x.name) : el('span','ph'), [[x.name, 'nm'], [signed(n), n > 0 ? 'up' : 'down']]));
      });
      if (list.length) {
        var box = el('div','drops');
        list.slice(0, MAX).forEach(function(x){ box.appendChild(x); });
        if (list.length > MAX) box.appendChild(css(el('span','drop more','and ' + (list.length - MAX) + ' more'), 'padding:0 9px'));
        c.appendChild(box);
      }
    },
    daily_recap: function(c, d){
      var when = new Date(d.date + 'T00:00:00Z');
      var nice = isNaN(when.getTime()) ? d.date : when.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
      head(c, 'Daily recap', 'UTC day');
      c.appendChild(css(el('div','title one',nice), 'padding:0 4px'));
      c.appendChild(stats(d.counts.map(function(x){ return [fmt(x.value), x.label]; }), Math.min(4, Math.max(1, d.counts.length))));
      if (d.xp && d.xp.length) {
        var list = d.xp.slice().sort(function(a, b){ return b.xp - a.xp; });
        var total = list.reduce(function(a, x){ return a + x.xp; }, 0);
        var top = list[0].xp || 1;
        var p = well('XP gained', '+' + fmt(total));
        var rs = el('div','rows');
        var MAX = 6;
        list.slice(0, MAX).forEach(function(x){
          var r = el('div','r');
          r.appendChild(badge(x.skill, 22));
          r.appendChild(css(el('span','nm',x.skill), 'flex:none;width:110px'));
          r.appendChild(bar(Math.max(2, x.xp / top * 100), null, 'thin'));
          r.appendChild(css(el('span','d up','+' + fmt(x.xp)), 'min-width:72px'));
          rs.appendChild(r);
        });
        more(rs, list.length - MAX);
        p.appendChild(rs); c.appendChild(p);
      }
    },
    status: function(c, d, icons){
      var total = d.skills.reduce(function(a, s){ return a + s.level; }, 0);
      head(c, 'Status', 'Total level ' + fmt(total));
      var chat = el('div','chat');
      chat.appendChild(line('clamp clamp2', [['Goal: ', 'who'], [d.goal, 'said']]));
      c.appendChild(chat);
      var hp = css(el('div'), 'display:flex;align-items:center;gap:10px;padding:0 4px');
      hp.appendChild(badge('Hitpoints', 24));
      hp.appendChild(bar(d.hp / d.maxHp * 100, '#00b400', 'hp'));
      hp.appendChild(css(el('span','',d.hp + ' / ' + d.maxHp), 'color:' + (d.hp * 4 <= d.maxHp ? '#ff3a2a' : '#ffff00') + ';min-width:58px;text-align:right'));
      c.appendChild(hp);
      var cols = el('div','cols');
      var ps = well('Skills');
      var g = el('div','sk');
      d.skills.forEach(function(s){
        var t = el('div','skt');
        t.appendChild(badge(s.name, 22));
        t.appendChild(el('span','nm',s.name));
        t.appendChild(el('span','lv',s.level));
        g.appendChild(t);
      });
      ps.appendChild(g); cols.appendChild(ps);
      var items = d.items || [];
      var pi = css(well('Inventory', items.length + ' / 28'), 'flex:none');
      pi.appendChild(slots(items, icons, 4, 28)).classList.add('tight');
      cols.appendChild(pi);
      c.appendChild(cols);
    }
  };

  var LINE = ['#ffff00','#00ff00','#ff981f','#5fb0ff'];
  R.xp_chart = function(c, d){
    head(c, 'XP per hour', d.title);
    function color(s, i){ return LINE[i % LINE.length]; }
    var leg = el('div','legend');
    d.series.forEach(function(s, i){
      var sum = s.values.reduce(function(a, v){ return a + v; }, 0);
      var x = el('span');
      var dot = el('span','dot'); dot.style.background = color(s, i);
      x.appendChild(dot); x.appendChild(document.createTextNode(s.name + DOT + fmt(sum)));
      leg.appendChild(x);
    });
    c.appendChild(leg);
    var box = well();
    var W = 554, H = 210, L = 46, Rp = 12, T = 12, B = 20, n = d.labels.length;
    var top = 1;
    d.series.forEach(function(s){ s.values.forEach(function(v){ if (v > top) top = v; }); });
    // A round top for the axis: 1, 2, 2.5 or 5 times a power of 10.
    var mag = Math.pow(10, Math.floor(Math.log10(top)));
    var max = [1, 2, 2.5, 5, 10].map(function(f){ return f * mag; }).filter(function(v){ return v >= top; })[0];
    var svg = svgEl('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H });
    function X(i){ return L + (W - L - Rp) * i / (n - 1); }
    function Y(v){ return T + (H - B - T) * (1 - v / max); }
    [0, 0.25, 0.5, 0.75, 1].forEach(function(f){
      var y = Y(max * f);
      svg.appendChild(svgEl('line', { x1: L, x2: W - Rp, y1: y, y2: y, stroke: f === 0 ? '#6e6352' : '#3e3529' }));
      if (f === 0 || f === 0.5 || f === 1) { var t = svgEl('text', { x: L - 8, y: y + 4, 'text-anchor': 'end' }); t.textContent = fmt(Math.round(max * f)); svg.appendChild(t); }
    });
    d.labels.forEach(function(l, i){
      var last = i === n - 1;
      if (i % 3 !== 0 && !last) return;
      if (!last && n - 1 - i < 2) return;
      var t = svgEl('text', { x: X(i), y: H - 4, 'text-anchor': last ? 'end' : (i === 0 ? 'start' : 'middle') }); t.textContent = l; svg.appendChild(t);
    });
    for (var k = d.series.length - 1; k >= 0; k--) {
      var pts = d.series[k].values.map(function(v, i){ return X(i).toFixed(1) + ',' + Y(v).toFixed(1); }).join(' ');
      svg.appendChild(svgEl('polyline', { points: pts, fill: 'none', stroke: '#000', 'stroke-width': k === 0 ? 5 : 4, 'stroke-linejoin': 'miter' }));
      svg.appendChild(svgEl('polyline', { points: pts, fill: 'none', stroke: color(d.series[k], k), 'stroke-width': k === 0 ? 2.5 : 2, 'stroke-linejoin': 'miter' }));
    }
    box.appendChild(svg);
    c.appendChild(box);
  };

  // Cuts one icon per skill out of the sprite sheets (data: URLs) and makes magenta transparent.
  // Returns the number of icons. Runs once, when the card tab opens.
  window.loadSkillIcons = function(sheets, cells, size, cols){
    var cache = {};
    function load(src){
      if (!cache[src]) cache[src] = new Promise(function(res){ var i = new Image(); i.onload = function(){ res(i); }; i.onerror = function(){ res(null); }; i.src = src; });
      return cache[src];
    }
    return Promise.all(Object.keys(cells).map(function(name){
      var c = cells[name];
      var src = sheets[c.sheet];
      if (typeof src !== 'string' || src.indexOf('data:image/png;base64,') !== 0) return null;
      return load(src).then(function(im){
        if (!im) return;
        var cv = document.createElement('canvas'); cv.width = size; cv.height = size;
        var g = cv.getContext('2d');
        g.drawImage(im, (c.index % cols) * size, Math.floor(c.index / cols) * size, size, size, 0, 0, size, size);
        var px = g.getImageData(0, 0, size, size), d = px.data, seen = 0;
        for (var k = 0; k < d.length; k += 4) {
          if (d[k] === 255 && d[k + 1] === 0 && d[k + 2] === 255) d[k + 3] = 0;
          else if (d[k + 3]) seen++;
        }
        if (!seen) return;
        g.putImageData(px, 0, 0);
        SKILL_IMG[name] = cv.toDataURL('image/png');
      });
    })).then(function(){ return Object.keys(SKILL_IMG).length; });
  };

  // Draws the card and returns the height of its content in CSS pixels.
  // frame: a PNG data: URL of the game view, for the receipt card. Other cards ignore it.
  window.renderCard = function(kind, data, icons, frame){
    var draw = R[kind];
    if (!draw) throw new Error('unknown card kind');
    var root = document.getElementById('root');
    root.replaceChildren();
    var card = el('div','card ' + kind);
    root.appendChild(card);
    var view = typeof frame === 'string' && frame.indexOf('data:image/png;base64,') === 0 ? frame : null;
    draw(card, data, icons || {}, view);
    var imgs = Array.prototype.slice.call(card.querySelectorAll('img'));
    return Promise.all(imgs.map(function(i){ return i.decode().catch(function(){}); })).then(function(){
      return Math.ceil(card.getBoundingClientRect().height);
    });
  };
})();
`;

// The CSP blocks every load except inline style, inline script and data: images.
export const CARD_PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>${CSS}</style></head><body><div id="root" style="width:100vw"></div>
<script>${CARD_PAGE_SCRIPT}</script></body></html>`;

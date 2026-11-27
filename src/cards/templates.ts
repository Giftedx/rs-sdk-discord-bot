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
  level_up: { width: 600, height: 280 },
  death: { width: 600, height: 400 },
  instruction_receipt: { width: 600, height: 620 },
  daily_recap: { width: 600, height: 560 },
  status: { width: 780, height: 600 },
  xp_chart: { width: 600, height: 400 },
};

/** The smallest height of a card picture. */
export const CARD_MIN_HEIGHT = 120;

export const CARD_DEVICE_SCALE = 2;

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


// The font is a system font: Inter (package fonts-inter) when installed, else Liberation Sans.
// The page loads no font file.
const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#101217;color:#ecebe7;font:15px/1.4 Inter,"Liberation Sans",Arial,system-ui,sans-serif;font-feature-settings:"tnum" 1;overflow:hidden;-webkit-font-smoothing:antialiased}
.card{--accent:#e0b24f;position:relative;width:100%;padding:22px 28px 24px;display:flex;flex-direction:column;gap:14px;overflow:hidden;
background:radial-gradient(90% 70% at 0% 0%,color-mix(in srgb,var(--accent) 20%,transparent),transparent 65%),radial-gradient(60% 50% at 100% 100%,color-mix(in srgb,var(--accent) 8%,transparent),transparent 70%),#101217}
.card::before{content:"";position:absolute;left:0;right:0;top:0;height:4px;background:linear-gradient(90deg,var(--accent),transparent)}
.card.level_up{--accent:#e0b24f}.card.death{--accent:#d8524a}.card.instruction_receipt{--accent:#4f9ee0}.card.daily_recap{--accent:#5cbf75}.card.status{--accent:#9b7be0}.card.xp_chart{--accent:#e08a4f}
.head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:26px}
.kicker{display:flex;align-items:center;gap:8px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:800}
.kicker svg{width:16px;height:16px}
.title{font-size:27px;font-weight:800;line-height:1.15;letter-spacing:-.01em;color:#fff;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:anywhere}
.title.one{-webkit-line-clamp:1}
.sub{display:flex;align-items:center;gap:6px;color:#a3a29c;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sub svg{width:15px;height:15px;flex:none}
.text{font-size:14.5px;color:#d0cec8;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;overflow-wrap:anywhere;white-space:pre-wrap}
.clamp2{-webkit-line-clamp:2}.clamp4{-webkit-line-clamp:4}
.quote{font-size:19px;font-weight:700;color:#fff;line-height:1.3}
.big{font-size:62px;font-weight:900;line-height:.9;color:var(--accent);text-shadow:0 0 28px color-mix(in srgb,var(--accent) 45%,transparent)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);font-size:13px;color:#d8d6d0;white-space:nowrap}
.chip.accent{background:color-mix(in srgb,var(--accent) 20%,transparent);border-color:color-mix(in srgb,var(--accent) 45%,transparent);color:#fff;font-weight:700}
.panel{background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:9px}
.label{display:flex;justify-content:space-between;gap:8px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#8d8c86;font-weight:800}
.label .v{color:#d8d6d0;letter-spacing:.04em}
.bar{position:relative;flex:1;height:12px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden}
.bar.thin{height:7px}
.panel>.bar{flex:none}
.bar>div{height:100%;border-radius:999px;background:linear-gradient(90deg,color-mix(in srgb,var(--fill,var(--accent)) 65%,#000),var(--fill,var(--accent)));box-shadow:0 0 12px color-mix(in srgb,var(--fill,var(--accent)) 55%,transparent)}
.stats{display:grid;gap:8px}
.stat{display:flex;flex-direction:column;gap:3px;padding:10px 13px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);min-width:0}
.stat .v{font-size:22px;font-weight:800;color:#fff;white-space:nowrap}
.stat .l{font-size:12.5px;color:#8d8c86;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.badge{flex:none;display:inline-flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--sk) 22%,#15171d);border:1px solid color-mix(in srgb,var(--sk) 50%,transparent);color:var(--sk);box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
.badge img{width:80%;height:80%;object-fit:contain;image-rendering:pixelated;filter:drop-shadow(1px 1px 0 rgba(0,0,0,.7))}
.badge .ini{font-weight:800;color:var(--sk);line-height:1}
svg.i{fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.items{display:grid;gap:4px;justify-content:start}
.slot{position:relative;width:46px;height:38px;border-radius:7px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.07);display:flex;align-items:center;justify-content:center}
.tight .slot{height:33px}
.slot.empty{background:rgba(255,255,255,.018);border-color:rgba(255,255,255,.04)}
.slot img{max-width:36px;max-height:30px;image-rendering:pixelated;margin-top:4px;filter:drop-shadow(1px 1px 0 rgba(0,0,0,.65))}
.slot .c{position:absolute;left:3px;top:0;font-size:10.5px;font-weight:800;color:#ffe55c;text-shadow:1px 1px 0 #000}
.slot .c.k{color:#fff}.slot .c.m{color:#52e07e}
.slot .nm{font-size:8.5px;line-height:1.05;text-align:center;padding:0 2px;color:#b9b7b0;overflow-wrap:anywhere;max-height:34px;overflow:hidden}
.rows{display:flex;flex-direction:column;gap:7px}
.r{display:flex;align-items:center;gap:8px;font-size:13.5px;min-width:0;height:22px}
.r .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#e2e0da}
.r .ch{color:#a3a29c;white-space:nowrap}
.r .d{text-align:right;font-weight:800;white-space:nowrap}
.r img{width:22px;height:20px;object-fit:contain;image-rendering:pixelated;flex:none}
.r .ph{width:22px;height:20px;border-radius:5px;background:rgba(255,255,255,.06);flex:none}
.more{font-size:12px;color:#8d8c86}
.up{color:#5fd27f}.down{color:#ef6a5f}
.cols{display:flex;gap:12px;align-items:flex-start}.cols>.panel{flex:1;min-width:0}
.sk{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}
.skt{display:flex;align-items:center;gap:7px;height:30px;padding:0 8px 0 4px;border-radius:7px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.05);min-width:0}
.skt .nm{flex:1;min-width:0;font-size:12.5px;color:#c9c7c1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.skt .lv{font-size:13.5px;font-weight:800;color:#fff}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%}
svg text{fill:#8d8c86;font-size:10.5px;font-family:inherit}
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
  // Small interface glyphs for the card headings, on a 16 by 16 grid.
  var KICKERS = {
    level_up: 'M8 2l1.6 4.4L14 8l-4.4 1.6L8 14l-1.6-4.4L2 8l4.4-1.6z',
    death: 'M8 2a5 5 0 0 0-5 5c0 1.8.9 3 2 3.6V13h6v-2.4c1.1-.6 2-1.8 2-3.6a5 5 0 0 0-5-5zM6 7.5v.2M10 7.5v.2',
    instruction_receipt: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13zM5 8.2l2 2 4-4.2',
    daily_recap: 'M2.5 4h11v9.5h-11zM2.5 7h11M5.5 2.5v3M10.5 2.5v3',
    status: 'M1.5 8.5h3l2-4.5 3 9 2-4.5h3',
    xp_chart: 'M2 13.5h12M4 11V8M7 11V5M10 11V7M13 11V3.5'
  };
  var PIN = 'M8 14s4.5-4 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 10 8 14 8 14zM8 5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3z';
  var CLOCK = 'M8 2a6 6 0 1 0 0 12A6 6 0 1 0 8 2zM8 4.5V8l2.5 1.5';

  function icon(d){ var s = svgEl('svg', { viewBox: '0 0 16 16', 'class': 'i' }); s.appendChild(svgEl('path', { d: d })); return s; }
  function skillKey(name){ return String(name).toLowerCase().replace(/[^a-z]/g, ''); }
  function skillColor(name){ return SKILL_COLORS[skillKey(name)] || '#9aa0aa'; }
  function badge(name, size){
    var b = el('span','badge');
    b.style.setProperty('--sk', skillColor(name));
    b.style.width = size + 'px'; b.style.height = size + 'px'; b.style.borderRadius = Math.round(size * 0.28) + 'px';
    var src = SKILL_IMG[skillKey(name)];
    if (src) b.appendChild(img(src, name));
    else { var ini = el('span','ini',String(name).charAt(0).toUpperCase()); ini.style.fontSize = Math.round(size * 0.5) + 'px'; b.appendChild(ini); }
    return b;
  }
  function head(c, kind, label, right){
    var h = el('div','head');
    var k = el('div','kicker'); k.appendChild(icon(KICKERS[kind])); k.appendChild(el('span','',label));
    h.appendChild(k);
    if (right) h.appendChild(right);
    c.appendChild(h);
  }
  function chip(text, cls){ return el('span', 'chip' + (cls ? ' ' + cls : ''), text); }
  function sub(d, text){ var s = el('div','sub'); s.appendChild(icon(d)); s.appendChild(el('span','',text)); return s; }
  function stat(v, l){ var s = el('div','stat'); s.appendChild(el('div','v',v)); s.appendChild(el('div','l',l)); return s; }
  function stats(list, cols){ var g = el('div','stats'); g.style.gridTemplateColumns = 'repeat(' + cols + ',1fr)'; list.forEach(function(x){ g.appendChild(stat(x[0], x[1])); }); return g; }
  function bar(pct, fill, thin){
    var b = el('div', thin ? 'bar thin' : 'bar');
    var f = el('div'); f.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (fill) b.style.setProperty('--fill', fill);
    b.appendChild(f); return b;
  }
  function panel(label, value){
    var p = el('div','panel');
    var l = el('div','label'); l.appendChild(el('span','',label)); if (value !== undefined) l.appendChild(el('span','v',value));
    p.appendChild(l); return p;
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
    g.style.gridTemplateColumns = 'repeat(' + cols + ',46px)';
    list.forEach(function(it){ g.appendChild(slot(it, icons)); });
    for (var i = list.length; i < fill; i++) g.appendChild(el('div','slot empty'));
    return g;
  }
  function row(lead, name, change, delta, cls){
    var r = el('div','r');
    r.appendChild(lead);
    r.appendChild(el('span','nm',name));
    if (change) r.appendChild(el('span','ch',change));
    if (delta) r.appendChild(el('span','d ' + (cls || ''),delta));
    return r;
  }
  function more(box, n){ if (n > 0) box.appendChild(el('div','more','and ' + n + ' more')); }

  var R = {
    level_up: function(c, d){
      head(c, 'level_up', 'Level up', d.totalLevel ? chip('Total level ' + fmt(d.totalLevel)) : null);
      var top = css(el('div'), 'display:flex;align-items:center;gap:18px');
      top.appendChild(badge(d.skill, 68));
      var mid = css(el('div'), 'flex:1;min-width:0;display:flex;flex-direction:column;gap:8px');
      mid.appendChild(el('div','title one',d.skill));
      var ch = el('div','chips');
      if (d.from && d.from < d.level) ch.appendChild(chip('Level ' + d.from + ARROW + d.level, 'accent'));
      ch.appendChild(chip(fmt(d.xp) + ' XP'));
      mid.appendChild(ch);
      top.appendChild(mid);
      var big = css(el('div'), 'text-align:center');
      big.appendChild(el('div','big',d.level));
      big.appendChild(css(el('div','label'), 'justify-content:center;margin-top:6px')).textContent = 'Level';
      top.appendChild(big);
      c.appendChild(top);
      var p = el('div','panel');
      var l = el('div','label');
      if (d.progress) {
        l.appendChild(el('span','','Next: level ' + (d.level + 1)));
        l.appendChild(el('span','v',fmt(d.progress.toNext) + ' XP to go'));
        p.appendChild(l);
        p.appendChild(bar(Math.max(2, d.progress.pct), null, true));
      } else {
        l.appendChild(el('span','','Maximum level'));
        l.appendChild(el('span','v','99'));
        p.appendChild(l);
        p.appendChild(bar(100, null, true));
      }
      c.appendChild(p);
    },
    death: function(c, d, icons){
      head(c, 'death', 'Death', chip(d.time));
      c.appendChild(el('div','title', d.killer ? 'Probably killed by ' + d.killer : 'The account died'));
      c.appendChild(sub(PIN, d.place));
      var list = d.items || [];
      var p = panel('Items lost', list.length ? fmt(list.length) : 'none');
      if (list.length) p.appendChild(slots(list, icons, 10, 0));
      else p.appendChild(el('div','more','Nothing was lost.'));
      c.appendChild(p);
    },
    instruction_receipt: function(c, d, icons){
      head(c, 'instruction_receipt', 'Request done', null);
      c.appendChild(el('div','quote text clamp2',d.instruction));
      c.appendChild(el('div','text clamp4',d.summary));
      var cols = el('div','cols');
      var MAX = 6;
      if (d.skills && d.skills.length) {
        var xp = d.skills.reduce(function(a, x){ return a + x.xp; }, 0);
        var ps = panel('Skills', '+' + fmt(xp) + ' XP');
        var rs = el('div','rows');
        d.skills.slice(0, MAX).forEach(function(x){
          rs.appendChild(row(badge(x.name, 22), x.name, x.after > x.before ? x.before + ARROW + x.after : 'Lv ' + x.after, '+' + fmt(x.xp), 'up'));
        });
        more(rs, d.skills.length - MAX);
        ps.appendChild(rs); cols.appendChild(ps);
      }
      if (d.inventory && d.inventory.length) {
        var pi = panel('Items');
        var ri = el('div','rows');
        d.inventory.slice(0, MAX).forEach(function(x){
          var src = iconSrc(icons, x.id);
          var n = x.after - x.before;
          ri.appendChild(row(src ? img(src, x.name) : el('span','ph'), x.name, fmt(x.before) + ARROW + fmt(x.after), signed(n), n > 0 ? 'up' : 'down'));
        });
        more(ri, d.inventory.length - MAX);
        pi.appendChild(ri); cols.appendChild(pi);
      }
      if (cols.childNodes.length) c.appendChild(cols);
      var list = [];
      if (d.durationMs !== undefined) { var m = Math.round(d.durationMs / 60000); list.push([m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : Math.max(1, m) + ' min', 'Took']); }
      list.push([fmt(d.turns), 'AI turns']);
      list.push(['$' + Number(d.costUsd).toFixed(2), 'Cost']);
      c.appendChild(stats(list, list.length));
    },
    daily_recap: function(c, d){
      var when = new Date(d.date + 'T00:00:00Z');
      var nice = isNaN(when.getTime()) ? d.date : when.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
      head(c, 'daily_recap', 'Daily recap', chip('UTC day'));
      c.appendChild(el('div','title one',nice));
      c.appendChild(stats(d.counts.map(function(x){ return [fmt(x.value), x.label]; }), Math.min(4, Math.max(1, d.counts.length))));
      if (d.xp && d.xp.length) {
        var list = d.xp.slice().sort(function(a, b){ return b.xp - a.xp; });
        var total = list.reduce(function(a, x){ return a + x.xp; }, 0);
        var top = list[0].xp || 1;
        var p = panel('XP gained', '+' + fmt(total));
        var rs = el('div','rows');
        var MAX = 6;
        list.slice(0, MAX).forEach(function(x){
          var r = el('div','r');
          r.appendChild(badge(x.skill, 22));
          r.appendChild(css(el('span','nm',x.skill), 'flex:none;width:110px'));
          r.appendChild(bar(Math.max(2, x.xp / top * 100), skillColor(x.skill), true));
          r.appendChild(css(el('span','d','+' + fmt(x.xp)), 'min-width:72px'));
          rs.appendChild(r);
        });
        more(rs, list.length - MAX);
        p.appendChild(rs); c.appendChild(p);
      }
    },
    status: function(c, d, icons){
      var total = d.skills.reduce(function(a, s){ return a + s.level; }, 0);
      head(c, 'status', 'Status', chip('Total level ' + fmt(total)));
      c.appendChild(el('div','quote text clamp2',d.goal));
      var hp = css(el('div'), 'display:flex;align-items:center;gap:10px');
      hp.appendChild(badge('Hitpoints', 26));
      var low = d.hp * 4 <= d.maxHp;
      hp.appendChild(bar(d.hp / d.maxHp * 100, low ? '#e8564f' : '#4fc46a'));
      hp.appendChild(css(el('span','',d.hp + ' / ' + d.maxHp), 'font-weight:800;min-width:58px;text-align:right'));
      c.appendChild(hp);
      var cols = el('div','cols');
      var ps = panel('Skills');
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
      var pi = css(panel('Inventory', items.length + ' / 28'), 'flex:none');
      pi.appendChild(slots(items, icons, 4, 28)).classList.add('tight');
      cols.appendChild(pi);
      c.appendChild(cols);
    }
  };

  var LINE = ['#f2f1ec','#4f9ee0','#f2a13a','#5cbf75'];
  R.xp_chart = function(c, d){
    head(c, 'xp_chart', 'XP per hour', chip(d.title));
    function color(s, i){ return LINE[i % LINE.length]; }
    var leg = el('div','chips');
    d.series.forEach(function(s, i){
      var sum = s.values.reduce(function(a, v){ return a + v; }, 0);
      var x = chip('');
      var dot = el('span','dot'); dot.style.background = color(s, i);
      x.appendChild(dot); x.appendChild(document.createTextNode(s.name + DOT + fmt(sum)));
      leg.appendChild(x);
    });
    c.appendChild(leg);
    var W = 544, H = 210, L = 46, Rp = 16, T = 18, B = 22, n = d.labels.length;
    var top = 1;
    d.series.forEach(function(s){ s.values.forEach(function(v){ if (v > top) top = v; }); });
    // A round top for the axis: 1, 2, 2.5 or 5 times a power of 10.
    var mag = Math.pow(10, Math.floor(Math.log10(top)));
    var max = [1, 2, 2.5, 5, 10].map(function(f){ return f * mag; }).filter(function(v){ return v >= top; })[0];
    var svg = svgEl('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H });
    var defs = svgEl('defs', {});
    var grad = svgEl('linearGradient', { id: 'area', x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': LINE[0], 'stop-opacity': 0.22 }));
    grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': LINE[0], 'stop-opacity': 0 }));
    defs.appendChild(grad); svg.appendChild(defs);
    function X(i){ return L + (W - L - Rp) * i / (n - 1); }
    function Y(v){ return T + (H - B - T) * (1 - v / max); }
    [0, 0.25, 0.5, 0.75, 1].forEach(function(f){
      var y = Y(max * f);
      svg.appendChild(svgEl('line', { x1: L, x2: W - Rp, y1: y, y2: y, stroke: f === 0 ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.06)' }));
      if (f === 0 || f === 0.5 || f === 1) { var t = svgEl('text', { x: L - 8, y: y + 3.5, 'text-anchor': 'end' }); t.textContent = fmt(Math.round(max * f)); svg.appendChild(t); }
    });
    d.labels.forEach(function(l, i){
      var last = i === n - 1;
      if (i % 3 !== 0 && !last) return;
      if (!last && n - 1 - i < 2) return;
      var t = svgEl('text', { x: X(i), y: H - 5, 'text-anchor': last ? 'end' : (i === 0 ? 'start' : 'middle') }); t.textContent = l; svg.appendChild(t);
    });
    var first = d.series[0].values;
    var area = 'M' + X(0) + ',' + Y(0) + first.map(function(v, i){ return 'L' + X(i).toFixed(1) + ',' + Y(v).toFixed(1); }).join('') + 'L' + X(n - 1) + ',' + Y(0) + 'Z';
    svg.appendChild(svgEl('path', { d: area, fill: 'url(#area)' }));
    for (var k = d.series.length - 1; k >= 0; k--) {
      var pts = d.series[k].values.map(function(v, i){ return X(i).toFixed(1) + ',' + Y(v).toFixed(1); }).join(' ');
      svg.appendChild(svgEl('polyline', { points: pts, fill: 'none', stroke: color(d.series[k], k), 'stroke-width': k === 0 ? 2.5 : 1.8, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }
    var lv = first[n - 1];
    svg.appendChild(svgEl('circle', { cx: X(n - 1), cy: Y(lv), r: 4, fill: '#101217', stroke: LINE[0], 'stroke-width': 2 }));
    c.appendChild(svg);
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
  window.renderCard = function(kind, data, icons){
    var draw = R[kind];
    if (!draw) throw new Error('unknown card kind');
    var root = document.getElementById('root');
    root.replaceChildren();
    var card = el('div','card ' + kind);
    root.appendChild(card);
    draw(card, data, icons || {});
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

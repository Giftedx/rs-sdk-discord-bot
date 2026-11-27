// Templates for drawn cards. The card tab loads CARD_PAGE_HTML once and calls
// window.renderCard(kind, data, icons) for each card. The page script builds the DOM with
// createElement and textContent only, because item names and player names are untrusted.

export type CardKind = 'level_up' | 'death' | 'instruction_receipt' | 'daily_recap' | 'status';

export const CARD_KINDS: readonly CardKind[] = ['level_up', 'death', 'instruction_receipt', 'daily_recap', 'status'];

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

export interface CardDataMap {
  level_up: LevelUpCard;
  death: DeathCard;
  instruction_receipt: InstructionReceiptCard;
  daily_recap: DailyRecapCard;
  status: StatusCard;
}

export const CARD_SIZES: Readonly<Record<CardKind, { width: number; height: number }>> = {
  level_up: { width: 600, height: 200 },
  death: { width: 600, height: 260 },
  instruction_receipt: { width: 600, height: 420 },
  daily_recap: { width: 600, height: 360 },
  status: { width: 600, height: 400 },
};

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
  deathItems: 8,
  statusItems: 28,
  skills: 24,
  counts: 8,
  receiptRows: 12,
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
      const inv = rows(o, 'inventory', LIMITS.receiptRows, w, (k, kw) => ({
        name: str(k, 'name', LIMITS.name, kw), before: num(k, 'before', kw, 0, 2_147_483_647), after: num(k, 'after', kw, 0, 2_147_483_647),
      }));
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
  if (kind !== 'death' && kind !== 'status') return [];
  const list = (data as DeathCard | StatusCard).items ?? [];
  return [...new Set(list.flatMap(i => (i.id === undefined ? [] : [i.id])))];
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#14161a;color:#e8e6e1;font:15px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow:hidden}
.card{position:relative;width:100%;height:100%;padding:20px 24px;display:flex;flex-direction:column;gap:10px;border-left:8px solid var(--accent,#c8a24a)}
.card.level_up{--accent:#c8a24a}.card.death{--accent:#b23a3a}.card.instruction_receipt{--accent:#4a8fc8}.card.daily_recap{--accent:#5aa86a}.card.status{--accent:#8a6ac8}
.kicker{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);font-weight:700}
.title{font-size:26px;font-weight:700;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sub{color:#a9a69f;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.text{font-size:15px;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;overflow-wrap:anywhere;white-space:pre-wrap}
.clamp2{-webkit-line-clamp:2}.clamp5{-webkit-line-clamp:5}
.big{font-size:64px;font-weight:800;line-height:1;color:var(--accent);font-variant-numeric:tabular-nums}
.row{display:flex;gap:24px;align-items:flex-end}
.stat{display:flex;flex-direction:column}.stat .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}.stat .l{font-size:12px;color:#a9a69f;text-transform:uppercase;letter-spacing:.08em}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px 16px}
.bar{height:18px;background:#2a2d33;border-radius:4px;overflow:hidden}.bar>div{height:100%;background:#3fae56}.bar>div.low{background:#c8453a}
table{border-collapse:collapse;width:100%;font-size:12.5px;font-variant-numeric:tabular-nums}
td{padding:1px 6px 1px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:90px}td.n{text-align:right;color:#e8e6e1}td.k{color:#a9a69f}
.items{display:flex;flex-wrap:wrap;gap:4px}
.item{position:relative;width:40px;height:36px;background:#22252b;border-radius:4px;display:flex;align-items:center;justify-content:center}
.item img{max-width:36px;max-height:32px;image-rendering:pixelated}
.item .c{position:absolute;left:2px;top:0;font-size:10px;color:#ffeb6b;text-shadow:1px 1px 0 #000}
.item .nm{font-size:8px;line-height:1;text-align:center;overflow:hidden;max-height:32px;color:#a9a69f;overflow-wrap:anywhere}
.cols{display:flex;gap:20px;min-height:0;flex:1}.cols>div{min-width:0}
`;

// Plain JavaScript that runs in the card page. It must never parse a string as HTML.
export const CARD_PAGE_SCRIPT = `
(function(){
  function el(tag, cls, text){
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = String(text);
    return e;
  }
  function fmt(n){ return Number(n).toLocaleString('en-US'); }
  function stat(v, l){ var s = el('div','stat'); s.appendChild(el('div','v',v)); s.appendChild(el('div','l',l)); return s; }
  function itemsRow(list, icons){
    var box = el('div','items');
    (list || []).forEach(function(it){
      var cell = el('div','item');
      cell.title = it.name;
      var src = it.id === undefined ? undefined : icons[String(it.id)];
      if (typeof src === 'string' && src.indexOf('data:image/png;base64,') === 0) {
        var img = document.createElement('img');
        img.alt = it.name;
        img.src = src;
        cell.appendChild(img);
      } else {
        cell.appendChild(el('div','nm',it.name));
      }
      if (it.count > 1) cell.appendChild(el('div','c', it.count >= 100000 ? Math.floor(it.count/1000) + 'K' : it.count));
      box.appendChild(cell);
    });
    return box;
  }
  var R = {
    level_up: function(c, d){
      c.appendChild(el('div','kicker','Level up'));
      var row = el('div','row');
      row.appendChild(el('div','big',d.level));
      var col = el('div');
      col.appendChild(el('div','title',d.skill));
      col.appendChild(el('div','sub',(d.from ? d.from + ' -> ' + d.level + '   ' : '') + fmt(d.xp) + ' xp' + (d.totalLevel ? '   total level ' + d.totalLevel : '')));
      row.appendChild(col);
      c.appendChild(row);
      if (d.progress) {
        var bar = el('div','bar'); var fill = el('div'); fill.style.width = d.progress.pct + '%'; bar.appendChild(fill); c.appendChild(bar);
        c.appendChild(el('div','sub',fmt(d.progress.toNext) + ' xp to ' + (d.level + 1)));
      }
    },
    death: function(c, d, icons){
      c.appendChild(el('div','kicker','Death'));
      c.appendChild(el('div','title',d.place));
      c.appendChild(el('div','sub',d.time));
      if (d.killer) c.appendChild(el('div','sub','Probably killed by ' + d.killer + ' (a guess)'));
      if (d.items && d.items.length) { c.appendChild(el('div','sub','Items')); c.appendChild(itemsRow(d.items, icons)); }
    },
    instruction_receipt: function(c, d){
      c.appendChild(el('div','kicker','Instruction done'));
      c.appendChild(el('div','text clamp2',d.instruction)).style.fontWeight = '700';
      c.appendChild(el('div','text clamp5',d.summary));
      var cols = el('div','cols');
      function table(head, list, cells){
        var box = el('div'); box.style.flex = '1';
        box.appendChild(el('div','sub',head));
        var t = el('table'); var tb = el('tbody'); t.appendChild(tb);
        list.forEach(function(x){ var tr = el('tr'); cells(x).forEach(function(v, i){ tr.appendChild(el('td', i ? 'n' : 'k', v)); }); tb.appendChild(tr); });
        box.appendChild(t); cols.appendChild(box);
      }
      if (d.skills && d.skills.length) table('Skills', d.skills, function(x){ return [x.name, x.before, '-> ' + x.after, '+' + fmt(x.xp)]; });
      if (d.inventory && d.inventory.length) table('Inventory', d.inventory, function(x){ return [x.name, fmt(x.before), '-> ' + fmt(x.after)]; });
      if (cols.childNodes.length) c.appendChild(cols);
      var row = el('div','row');
      row.style.marginTop = 'auto';
      if (d.durationMs !== undefined) { var m = Math.round(d.durationMs / 60000); row.appendChild(stat(m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm','took')); }
      row.appendChild(stat(fmt(d.turns),'turns'));
      row.appendChild(stat('$' + Number(d.costUsd).toFixed(2),'cost'));
      c.appendChild(row);
    },
    daily_recap: function(c, d){
      c.appendChild(el('div','kicker','Daily recap'));
      c.appendChild(el('div','title',d.date));
      var g = el('div','grid');
      d.counts.forEach(function(x){ g.appendChild(stat(fmt(x.value), x.label)); });
      c.appendChild(g);
      if (d.xp && d.xp.length) {
        c.appendChild(el('div','sub','XP gained'));
        var t = el('table'); var tb = el('tbody'); t.appendChild(tb);
        for (var i = 0; i < d.xp.length; i += 3) {
          var tr = el('tr');
          for (var j = i; j < i + 3; j++) { var x = d.xp[j]; tr.appendChild(el('td','k', x ? x.skill : '')); tr.appendChild(el('td','n', x ? '+' + fmt(x.xp) : '')); }
          tb.appendChild(tr);
        }
        c.appendChild(t);
      }
    },
    status: function(c, d, icons){
      c.appendChild(el('div','kicker','Status'));
      c.appendChild(el('div','text clamp2',d.goal)).style.fontWeight = '700';
      var hp = el('div','row'); hp.style.alignItems = 'center';
      hp.appendChild(el('div','sub','HP ' + d.hp + ' / ' + d.maxHp));
      var bar = el('div','bar'); bar.style.flex = '1';
      var fill = el('div', d.hp * 4 <= d.maxHp ? 'low' : '');
      fill.style.width = Math.max(0, Math.min(100, d.hp / d.maxHp * 100)) + '%';
      bar.appendChild(fill); hp.appendChild(bar); c.appendChild(hp);
      var cols = el('div','cols');
      var t = el('table'); var tb = el('tbody'); t.appendChild(tb);
      for (var i = 0; i < d.skills.length; i += 3) {
        var tr = el('tr');
        for (var j = i; j < i + 3; j++) {
          var s = d.skills[j];
          tr.appendChild(el('td','k', s ? s.name : ''));
          tr.appendChild(el('td','n', s ? s.level : ''));
        }
        tb.appendChild(tr);
      }
      var left = el('div'); left.style.flex = '1'; left.appendChild(t); cols.appendChild(left);
      if (d.items && d.items.length) {
        var right = el('div'); right.style.width = '216px'; right.appendChild(itemsRow(d.items, icons)); cols.appendChild(right);
      }
      c.appendChild(cols);
    }
  };
  window.renderCard = function(kind, data, icons){
    var draw = R[kind];
    if (!draw) throw new Error('unknown card kind');
    var root = document.getElementById('root');
    root.replaceChildren();
    var card = el('div','card ' + kind);
    root.appendChild(card);
    draw(card, data, icons || {});
    var imgs = Array.prototype.slice.call(card.querySelectorAll('img'));
    return Promise.all(imgs.map(function(i){ return i.decode().catch(function(){}); })).then(function(){ return true; });
  };
})();
`;

// The CSP blocks every load except inline style, inline script and data: images.
export const CARD_PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>${CSS}</style></head><body><div id="root" style="width:100vw;height:100vh"></div>
<script>${CARD_PAGE_SCRIPT}</script></body></html>`;

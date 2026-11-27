// Cards that answer a question about the account: what it wears and carries, its skills, and the
// last bank and exchange that the bot saw. Plain functions from the game state to card data.
import type { BankCard, CardItem, EquipmentCard, EquipSlot, GeCard, GeOffer, InventoryCard, NearbyCard, PrayerCard, ShopCard, ShopItemCard, SkillsCard, TradeCard } from '../cards/templates';
import { PRAYER_LEVELS, PRAYER_NAMES } from '../../vendor/rs-sdk/sdk/types';

export type InfoKind = 'equipment' | 'inventory' | 'bank' | 'skills' | 'ge' | 'shop' | 'prayer' | 'nearby' | 'trade';

// The words that ask for each card. The first match wins, so the narrow kinds come first.
const PICK: [InfoKind, RegExp][] = [
  ['ge', /\b(ge|grand exchange|exchange|offers?)\b/i],
  ['trade', /\b(trade|trading|traded)\b/i],
  ['shop', /\b(shop|shops|store|shopkeeper|stock)\b/i],
  ['bank', /\bbank(ed)?\b/i],
  ['equipment', /\b(wear|wearing|worn|equip|equipped|equipment|gear|armou?r|weapons?|wield|wielding|outfit)\b/i],
  ['inventory', /\b(inventory|invent|inv|backpack|bag|carry|carrying|holding)\b/i],
  ['prayer', /\b(pray|praying|prayers?)\b/i],
  ['nearby', /\b(nearby|around (you|here|us)|near (you|us|here)|close by|next to you|npcs?|monsters?|players?|on the ground)\b/i],
  ['skills', /\b(skills?|stats|levels?|xp|experience)\b/i],
];

/** The card that a question asks for, or null. */
export function pickInfoCard(question: string): InfoKind | null {
  for (const [kind, re] of PICK) if (re.test(question)) return kind;
  return null;
}

/** The parts of the game state that the cards read. */
export interface InfoState {
  player: { combatLevel: number } | null;
  skills: { name: string; level: number; baseLevel: number }[];
  inventory: { slot: number; id: number; name: string; count: number }[];
  equipment: { slot: number; id: number; name: string; count: number }[];
  bank?: { isOpen: boolean; items: { id: number; name: string; count: number }[] };
  ge?: { isOpen: boolean; offers: { item: number; name: string; side: 'buy' | 'sell'; quantity: number; price: number; filled: number; state: 'open' | 'completed' | 'cancelled' }[] } | null;
  combatStyle?: { currentStyle: number; known: boolean; styles: { index: number; name: string; type: string }[] };
  shop?: { isOpen: boolean; title: string; shopItems: { id: number; name: string; count: number; buyPrice: number }[] };
  prayers?: { activePrayers: boolean[]; prayerPoints: number; prayerLevel: number };
  nearbyNpcs?: { name: string; combatLevel: number; distance: number; healthPercent: number | null }[];
  nearbyPlayers?: { name: string; combatLevel: number; distance: number }[];
  groundItems?: { id: number; name: string; count: number; distance: number }[];
  trade?: { isOpen: boolean; screen: 'offer' | 'confirm' | null; partner: string | null; myOffer: { id: number; name: string; count: number }[]; theirOffer: { id: number; name: string; count: number }[]; myAccepted: boolean; partnerAccepted: boolean };
}

// The wear position numbers of the game (ObjType.getWearPosId) and the slot that each fills.
const WEAR_POS: Record<number, EquipSlot> = { 0: 'head', 1: 'cape', 2: 'neck', 3: 'weapon', 4: 'body', 5: 'shield', 7: 'legs', 9: 'hands', 10: 'feet', 12: 'ring', 13: 'ammo' };

const item = (it: { id: number; name: string; count: number }): CardItem => ({ id: it.id, name: it.name, count: Math.max(1, it.count) });

export function equipmentData(s: InfoState): EquipmentCard {
  const worn: EquipmentCard['worn'] = [];
  const used = new Set<EquipSlot>();
  for (const it of s.equipment) {
    const slot = WEAR_POS[it.slot];
    if (!slot || used.has(slot) || !it.name) continue;
    used.add(slot);
    worn.push({ slot, ...item(it) });
  }
  const out: EquipmentCard = { worn };
  if (s.player && s.player.combatLevel >= 3) out.combatLevel = s.player.combatLevel;
  const cs = s.combatStyle;
  const style = cs?.known ? cs.styles.find(x => x.index === cs.currentStyle) : undefined;
  if (style) out.style = `${style.type} (${style.name})`;
  return out;
}

export function inventoryData(s: InfoState): InventoryCard {
  const seen = new Set<number>();
  const items: InventoryCard['items'] = [];
  for (const it of s.inventory) {
    if (it.slot < 0 || it.slot > 27 || seen.has(it.slot) || !it.name) continue;
    seen.add(it.slot);
    items.push({ slot: it.slot, ...item(it) });
  }
  return { items };
}

export function skillsData(s: InfoState): SkillsCard {
  const out: SkillsCard = { skills: s.skills.slice(0, 24).map(k => ({ name: k.name, level: Math.max(0, k.level), base: Math.max(1, k.baseLevel) })) };
  if (s.player && s.player.combatLevel >= 3) out.combatLevel = s.player.combatLevel;
  return out;
}

/** What the bot keeps of an open bank. */
export interface BankSeen { items: CardItem[] }
/** What the bot keeps of an open exchange. */
export interface GeSeen { offers: GeOffer[] }

export function bankSeen(s: InfoState): BankSeen | null {
  if (!s.bank?.isOpen) return null;
  return { items: s.bank.items.filter(it => it.name && it.count > 0).map(item) };
}

export function geSeen(s: InfoState): GeSeen | null {
  if (!s.ge?.isOpen) return null;
  return {
    offers: s.ge.offers.slice(0, 8).map(o => ({
      id: o.item, name: o.name, side: o.side, quantity: Math.max(1, o.quantity), price: Math.max(0, o.price),
      filled: Math.min(Math.max(0, o.filled), Math.max(1, o.quantity)), state: o.state,
    })),
  };
}

/** A time span in words, for example "5 minutes ago". */
export function ago(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  return `${d} days ago`;
}

export const BANK_CARD_ITEMS = 80;

export function bankData(seen: BankSeen, ageMs: number): BankCard {
  return { seen: ago(ageMs), items: seen.items.slice(0, BANK_CARD_ITEMS), total: seen.items.length };
}

export function geData(seen: GeSeen, ageMs: number): GeCard {
  return { seen: ago(ageMs), offers: seen.offers };
}

/** One line of facts for the answer prompt. */
export function bankText(seen: BankSeen, ageMs: number): string {
  const list = seen.items.slice(0, 200).map(it => `${it.name} x${it.count.toLocaleString('en-US')}`).join(', ');
  return `Bank, seen ${ago(ageMs)} (${seen.items.length} different items): ${list || 'empty'}.`;
}

export function geText(seen: GeSeen, ageMs: number): string {
  const list = seen.offers.map(o => `${o.side} ${o.quantity} ${o.name} at ${o.price} gp, ${o.filled} filled, ${o.state}`).join('; ');
  return `Grand Exchange offers, seen ${ago(ageMs)}: ${list || 'none'}.`;
}

/** What the bot keeps of an open shop. */
export interface ShopSeen { title: string; items: ShopItemCard[] }
/** What the bot keeps of an open trade. */
export interface TradeSeen { partner: string; screen: 'offer' | 'confirm'; mine: CardItem[]; theirs: CardItem[]; myAccepted: boolean; theirAccepted: boolean }

export const SHOP_CARD_ITEMS = 40;

export function shopSeen(s: InfoState): ShopSeen | null {
  if (!s.shop?.isOpen) return null;
  return {
    title: s.shop.title || 'Shop',
    items: s.shop.shopItems.filter(it => it.name).slice(0, SHOP_CARD_ITEMS).map(it => ({ id: it.id, name: it.name, count: Math.max(0, it.count), price: Math.max(0, it.buyPrice) })),
  };
}

export function tradeSeen(s: InfoState): TradeSeen | null {
  const t = s.trade;
  if (!t?.isOpen || !t.partner) return null;
  return {
    partner: t.partner, screen: t.screen === 'confirm' ? 'confirm' : 'offer',
    mine: t.myOffer.filter(it => it.name).slice(0, 28).map(item), theirs: t.theirOffer.filter(it => it.name).slice(0, 28).map(item),
    myAccepted: t.myAccepted, theirAccepted: t.partnerAccepted,
  };
}

export function shopData(seen: ShopSeen, ageMs: number): ShopCard {
  return { title: seen.title, seen: ago(ageMs), items: seen.items };
}

export function tradeData(seen: TradeSeen, ageMs: number): TradeCard {
  return { ...seen, seen: ago(ageMs) };
}

// "thick_skin" becomes "Thick Skin"; the short words stay small.
const prayerTitle = (key: string) => key.split('_').map((w, i) => (i > 0 && (w === 'of' || w === 'from') ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');

export function prayerData(s: InfoState): PrayerCard | null {
  const p = s.prayers;
  if (!p) return null;
  const level = Math.max(1, p.prayerLevel);
  return {
    points: Math.min(Math.max(0, p.prayerPoints), 255), level,
    prayers: PRAYER_NAMES.map((key, i) => ({ name: prayerTitle(key), level: PRAYER_LEVELS[i] ?? 1, active: p.activePrayers[i] === true })),
  };
}

const NEARBY = 8;
const nearest = <T extends { distance: number }>(list: T[] | undefined) => [...(list ?? [])].sort((a, b) => a.distance - b.distance).slice(0, NEARBY);
const tiles = (d: number) => Math.min(200, Math.max(0, Math.round(d)));

export function nearbyData(s: InfoState): NearbyCard {
  return {
    npcs: nearest(s.nearbyNpcs).filter(n => n.name).map(n => ({
      name: n.name, level: Math.max(0, n.combatLevel), distance: tiles(n.distance),
      ...(n.healthPercent === null || n.healthPercent === undefined ? {} : { hpPct: Math.min(100, Math.max(0, Math.round(n.healthPercent))) }),
    })),
    players: nearest(s.nearbyPlayers).filter(p => p.name).map(p => ({ name: p.name, level: Math.max(0, p.combatLevel), distance: tiles(p.distance) })),
    items: nearest(s.groundItems).filter(it => it.name).map(it => ({ ...item(it), distance: tiles(it.distance) })),
  };
}

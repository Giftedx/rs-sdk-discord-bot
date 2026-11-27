// Events come from a comparison of two state snapshots. The text of each event comes from a template, not from the AI.
import type { BotWorldState } from '../../vendor/rs-sdk/sdk/types';

export interface CompactState {
  hp: number;
  maxHp: number;
  x: number;
  z: number;
  plane: number;
  skills: Record<string, { level: number; xp: number }>;
  inventory: Record<string, number>;
  inCombat: boolean;
  /** Worn items by name. Absent in old snapshots. An item gain counts inventory and equipment together. */
  equipment?: Record<string, number>;
  /** The client's death signal (PlayerState.lastDeathTick). Absent on old clients. */
  deathTick?: number | null;
}

export type GameEvent =
  | { kind: 'level_up'; skill: string; from: number; level: number }
  | { kind: 'total_level'; total: number }
  // lost and killer are filled by the caller: the inventory before minus after, and the NPC that fought the player last.
  | { kind: 'death'; lost?: { name: string; count: number }[]; killer?: string }
  | { kind: 'item_gain'; items: { name: string; count: number }[] }
  | { kind: 'instruction_done'; instruction: string; outcome: string };

export const TOTAL_LEVEL_STEP = 25;
// A respawn moves the player far. A walk between two snapshots does not.
export const DEATH_JUMP_TILES = 30;

// The 2004 game has two unused skill slots, "Stat18" and "Stat19" (server engine/data/symbols/stat.sym).
// The game state lists them, but they are not skills: no card or total counts them.
export const isRealSkill = (name: string): boolean => !/^stat\d+$/i.test(name.trim());

export function compactState(s: BotWorldState): CompactState | null {
  if (!s.inGame || !s.player) return null;
  const skills: CompactState['skills'] = {};
  // baseLevel is the real level; level can be boosted or drained.
  for (const k of s.skills) if (isRealSkill(k.name)) skills[k.name] = { level: k.baseLevel, xp: k.experience };
  const inventory: Record<string, number> = {};
  for (const it of s.inventory) inventory[it.name] = (inventory[it.name] ?? 0) + it.count;
  const equipment: Record<string, number> = {};
  for (const it of s.equipment ?? []) equipment[it.name] = (equipment[it.name] ?? 0) + it.count;
  const p = s.player;
  const out: CompactState = { hp: p.hp, maxHp: p.maxHp, x: p.worldX, z: p.worldZ, plane: p.level, skills, inventory, inCombat: p.combat.inCombat, equipment };
  if (p.lastDeathTick !== undefined) out.deathTick = p.lastDeathTick;
  return out;
}

export function totalLevel(s: CompactState): number {
  let t = 0;
  for (const k of Object.values(s.skills)) t += k.level;
  return t;
}

// instruction_done is not made here; the caller makes it when an instruction ends.
export function diffStates(prev: CompactState | null, next: CompactState | null): GameEvent[] {
  if (!prev || !next) return [];
  const out: GameEvent[] = [];

  for (const [name, k] of Object.entries(next.skills)) {
    const before = prev.skills[name];
    if (before && k.level > before.level) out.push({ kind: 'level_up', skill: name, from: before.level, level: k.level });
  }
  // A missing skill list in either snapshot gives a false total, so check that both have skills.
  if (Object.keys(prev.skills).length > 0 && Object.keys(next.skills).length > 0) {
    const a = totalLevel(prev);
    const b = totalLevel(next);
    if (Math.floor(b / TOTAL_LEVEL_STEP) > Math.floor(a / TOTAL_LEVEL_STEP)) {
      out.push({ kind: 'total_level', total: Math.floor(b / TOTAL_LEVEL_STEP) * TOTAL_LEVEL_STEP });
    }
  }

  // The client's own signal when both snapshots have it: lastDeathTick changes on each death.
  // It also sees a death between two snapshots. Without it, the HP and position heuristic.
  if (prev.deathTick !== undefined && next.deathTick !== undefined) {
    if (next.deathTick !== null && next.deathTick !== prev.deathTick) out.push({ kind: 'death' });
  } else {
  const jump = Math.max(Math.abs(next.x - prev.x), Math.abs(next.z - prev.z)) >= DEATH_JUMP_TILES || next.plane !== prev.plane;
  const diedNow = next.hp === 0 && prev.hp > 0;
  // prev.hp === 0 means the death was already reported on the snapshot before.
  const respawned = prev.hp > 0 && prev.hp < prev.maxHp && next.hp === next.maxHp && next.maxHp > 0 && jump;
  if (diedNow || respawned) out.push({ kind: 'death' });
  }

  // An item that moves between the inventory and the equipment is no gain.
  // Only when both snapshots have the equipment: else each worn item looks new.
  const eq = prev.equipment !== undefined && next.equipment !== undefined;
  const before = held(prev, eq);
  const items: { name: string; count: number }[] = [];
  for (const [name, n] of Object.entries(held(next, eq))) {
    const gain = n - (before[name] ?? 0);
    if (gain >= 1) items.push({ name, count: gain });
  }
  if (items.length > 0) out.push({ kind: 'item_gain', items: items.sort((a, b) => a.name.localeCompare(b.name)) });
  return out;
}

/** The inventory and the equipment together, by name. */
function held(s: CompactState, withEquipment: boolean): Record<string, number> {
  const out = { ...s.inventory };
  if (withEquipment) for (const [name, n] of Object.entries(s.equipment ?? {})) out[name] = (out[name] ?? 0) + n;
  return out;
}

export function eventText(e: GameEvent): string {
  switch (e.kind) {
    case 'level_up':
      return `${e.skill} level ${e.level} (was ${e.from}).`;
    case 'total_level':
      return `Total level ${e.total}.`;
    case 'death': {
      const lost = e.lost && e.lost.length > 0 ? ` Lost: ${itemList(e.lost)}.` : '';
      // The killer is a guess from the game state, and the text says so.
      const killer = e.killer ? ` Probably killed by ${e.killer}.` : '';
      return `The account died.${killer}${lost}`;
    }
    case 'item_gain':
      return `Got ${itemList(e.items)}.`;
    case 'instruction_done':
      return `Instruction ended (${e.outcome}): ${e.instruction}`;
  }
}

function itemList(items: { name: string; count: number }[]): string {
  return items.map((i) => `${i.count} x ${i.name}`).join(', ');
}

/** The items in `before` and not in `after`, by name. For the death post. */
export function lostItems(before: Record<string, number>, after: Record<string, number>): { name: string; count: number }[] {
  const out: { name: string; count: number }[] = [];
  for (const [name, n] of Object.entries(before)) {
    const loss = n - (after[name] ?? 0);
    if (loss >= 1) out.push({ name, count: loss });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The name of the NPC that hit the player last, or the NPC the player fought, from one state.
 * It is a guess: the NPC can be out of the nearby list, and another NPC can have the same name.
 */
export function guessKiller(s: BotWorldState): string | undefined {
  const npcName = (index: number) => (s.nearbyNpcs ?? []).find((n) => n.index === index)?.name;
  const hits = (s.combatEvents ?? []).filter((e) => e.type === 'damage_taken' && e.sourceType === 'npc').sort((a, b) => b.tick - a.tick);
  for (const h of hits) {
    const name = npcName(h.sourceIndex);
    if (name) return name;
  }
  const c = s.player?.combat;
  return c && c.targetType === 'npc' && c.targetIndex >= 0 ? npcName(c.targetIndex) : undefined;
}

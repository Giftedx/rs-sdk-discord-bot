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
}

export type GameEvent =
  | { kind: 'level_up'; skill: string; from: number; level: number }
  | { kind: 'total_level'; total: number }
  | { kind: 'death' }
  | { kind: 'item_gain'; items: { name: string; count: number }[] }
  | { kind: 'instruction_done'; instruction: string; outcome: string };

export const TOTAL_LEVEL_STEP = 25;
// A respawn moves the player far. A walk between two snapshots does not.
export const DEATH_JUMP_TILES = 30;

export function compactState(s: BotWorldState): CompactState | null {
  if (!s.inGame || !s.player) return null;
  const skills: CompactState['skills'] = {};
  // baseLevel is the real level; level can be boosted or drained.
  for (const k of s.skills) skills[k.name] = { level: k.baseLevel, xp: k.experience };
  const inventory: Record<string, number> = {};
  for (const it of s.inventory) inventory[it.name] = (inventory[it.name] ?? 0) + it.count;
  const p = s.player;
  return { hp: p.hp, maxHp: p.maxHp, x: p.worldX, z: p.worldZ, plane: p.level, skills, inventory, inCombat: p.combat.inCombat };
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

  const jump = Math.max(Math.abs(next.x - prev.x), Math.abs(next.z - prev.z)) >= DEATH_JUMP_TILES || next.plane !== prev.plane;
  const diedNow = next.hp === 0 && prev.hp > 0;
  // prev.hp === 0 means the death was already reported on the snapshot before.
  const respawned = prev.hp > 0 && prev.hp < prev.maxHp && next.hp === next.maxHp && next.maxHp > 0 && jump;
  if (diedNow || respawned) out.push({ kind: 'death' });

  const items: { name: string; count: number }[] = [];
  for (const [name, n] of Object.entries(next.inventory)) {
    const gain = n - (prev.inventory[name] ?? 0);
    if (gain >= 1) items.push({ name, count: gain });
  }
  if (items.length > 0) out.push({ kind: 'item_gain', items: items.sort((a, b) => a.name.localeCompare(b.name)) });
  return out;
}

export function eventText(e: GameEvent): string {
  switch (e.kind) {
    case 'level_up':
      return `${e.skill} level ${e.level} (was ${e.from}).`;
    case 'total_level':
      return `Total level ${e.total}.`;
    case 'death':
      return 'The account died.';
    case 'item_gain':
      return `Got ${e.items.map((i) => `${i.count} x ${i.name}`).join(', ')}.`;
    case 'instruction_done':
      return `Instruction ended (${e.outcome}): ${e.instruction}`;
  }
}

// The skill icons of the game client: the sprite sheets staticons and staticons2 of the rs-sdk
// content, read at run time from the vendor submodule. This repository holds no copy of them.
// Each sheet has cells of 25 x 25 pixels, 6 to a row; magenta (#ff00ff) is transparent.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPng } from './icons';

export const SKILL_SPRITE_DIR = join(import.meta.dir, '../../vendor/rs-sdk/server/content/sprites');
export const SKILL_CELL = 25;
export const SKILL_SHEET_COLUMNS = 6;

/** The cell of each skill, from the stats tab of the client (stats.if). */
export const SKILL_CELLS: Readonly<Record<string, { sheet: 'staticons' | 'staticons2'; index: number }>> = {
  attack: { sheet: 'staticons', index: 0 },
  strength: { sheet: 'staticons', index: 1 },
  defence: { sheet: 'staticons', index: 2 },
  ranged: { sheet: 'staticons', index: 3 },
  prayer: { sheet: 'staticons', index: 4 },
  magic: { sheet: 'staticons', index: 5 },
  hitpoints: { sheet: 'staticons', index: 6 },
  agility: { sheet: 'staticons', index: 7 },
  herblore: { sheet: 'staticons', index: 8 },
  thieving: { sheet: 'staticons', index: 9 },
  crafting: { sheet: 'staticons', index: 10 },
  fletching: { sheet: 'staticons', index: 11 },
  mining: { sheet: 'staticons', index: 12 },
  smithing: { sheet: 'staticons', index: 13 },
  fishing: { sheet: 'staticons', index: 14 },
  cooking: { sheet: 'staticons', index: 15 },
  firemaking: { sheet: 'staticons', index: 16 },
  woodcutting: { sheet: 'staticons', index: 17 },
  runecraft: { sheet: 'staticons2', index: 0 },
};

export interface SkillSheets {
  staticons?: string;
  staticons2?: string;
}

/** The two sheets as data: URLs. A sheet that is missing or is not a PNG is left out. */
export function loadSkillSheets(dir = SKILL_SPRITE_DIR, read: (path: string) => Uint8Array = p => readFileSync(p)): SkillSheets {
  const out: SkillSheets = {};
  for (const name of ['staticons', 'staticons2'] as const) {
    try {
      const bytes = read(join(dir, `${name}.png`));
      if (isPng(bytes) && bytes.length <= 256 * 1024) out[name] = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
    } catch {
      // No sheet: the cards show the first letter of the skill.
    }
  }
  return out;
}

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadSkillSheets, SKILL_CELLS, SKILL_SPRITE_DIR } from './skill-icons';

describe('skill icons', () => {
  test('every skill of the stats tab has its own cell', () => {
    expect(Object.keys(SKILL_CELLS)).toHaveLength(19);
    const cells = Object.values(SKILL_CELLS).map(c => `${c.sheet}:${c.index}`);
    expect(new Set(cells).size).toBe(cells.length);
  });

  test('reads both sheets of the vendor submodule as PNG data URLs', () => {
    if (!existsSync(join(SKILL_SPRITE_DIR, 'staticons.png'))) return;
    const s = loadSkillSheets();
    expect(s.staticons).toStartWith('data:image/png;base64,');
    expect(s.staticons2).toStartWith('data:image/png;base64,');
  });

  test('leaves out a missing sheet and a file that is not a PNG', () => {
    const s = loadSkillSheets('/nowhere', p => {
      if (p.includes('staticons2')) throw new Error('ENOENT');
      return new TextEncoder().encode('<svg/>');
    });
    expect(s).toEqual({});
  });
});

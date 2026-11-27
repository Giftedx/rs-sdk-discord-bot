import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStore } from '../agent/store';
import { parseSeed, readSeeds, seedStore } from './seed';

const SEED_DIR = resolve(import.meta.dir, '..', '..', 'seed');

describe('seed scripts', () => {
  test('parseSeed splits the description line from the body', () => {
    expect(parseSeed('a', '// Do a thing\nreturn 1;\n')).toEqual({ name: 'a', description: 'Do a thing', body: 'return 1;\n' });
    expect(() => parseSeed('b', 'return 1;')).toThrow();
  });

  test('seedStore adds missing scripts and keeps existing ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-'));
    const seeds = join(dir, 'seed');
    mkdirSync(seeds);
    writeFileSync(join(seeds, 'one.ts'), '// First\nreturn 1;\n');
    writeFileSync(join(seeds, 'two.ts'), '// Second\nreturn 2;\n');
    writeFileSync(join(seeds, 'Bad Name.ts'), '// skipped\n');
    const store = createStore(join(dir, 'data'));
    store.saveScript('two', 'Mine', 'return 22;\n');
    expect(seedStore(store, seeds)).toEqual(['one']);
    expect(store.readScript('one')).toBe('// First\nreturn 1;\n');
    expect(store.readScript('two')).toBe('// Mine\nreturn 22;\n');
    expect(seedStore(store, seeds)).toEqual([]);
    expect(seedStore(store, join(dir, 'missing'))).toEqual([]);
  });

  test('every shipped seed has a description, a loop, a limit, and parses as an async function body', () => {
    const seeds = readSeeds(SEED_DIR);
    expect(seeds.length).toBeGreaterThanOrEqual(5);
    expect(seeds.length).toBeLessThanOrEqual(8);
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    for (const s of seeds) {
      expect(s.description.length).toBeGreaterThan(10);
      expect(s.body).toMatch(/\b(for|while)\s*\(/);
      expect(s.body).toMatch(/const MAX_MS = /);
      expect(s.body).toMatch(/\breturn\b/);
      expect(() => transpiler.transformSync(`export async function job(bot: any, sdk: any, protections: any) {\n${s.body}\n}`)).not.toThrow();
    }
  });
});

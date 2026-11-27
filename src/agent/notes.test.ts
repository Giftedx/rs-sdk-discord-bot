import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledgePack, createStore, createWikiIndex, DEFAULT_PERSONALITY, MAX_DIARY_LINES, searchKnowledge, StoreError } from './store';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe('personality and diary', () => {
  test('writes the default personality only when the file is missing', () => {
    const dir = tmp('pers-');
    expect(createStore(dir).readPersonality()).toBe(DEFAULT_PERSONALITY.trim());
    writeFileSync(join(dir, 'personality.md'), 'A grumpy dwarf.');
    expect(createStore(dir).readPersonality()).toBe('A grumpy dwarf.');
    expect(readFileSync(join(dir, 'personality.md'), 'utf8')).toBe('A grumpy dwarf.');
  });

  test('a diary line is dated, one line, capped, and the file keeps the last 200 lines', () => {
    let t = Date.parse('2026-11-27T09:05:00Z');
    const s = createStore(tmp('diary-'), () => new Date(t));
    expect(s.appendDiary('Chopped\nlogs   near the bank')).toBe('2026-11-27 09:05 Chopped logs near the bank');
    expect(() => s.appendDiary('  \n ')).toThrow(StoreError);
    expect(s.appendDiary('x'.repeat(500)).length).toBe(17 + 300);
    for (let i = 0; i < 250; i++) { t += 60_000; s.appendDiary(`entry ${i}`); }
    const tail = s.diaryTail(MAX_DIARY_LINES + 50);
    expect(tail.length).toBe(MAX_DIARY_LINES);
    expect(tail.at(-1)).toEndWith('entry 249');
    expect(s.diaryTail(10).length).toBe(10);
    expect(s.diaryTail(0)).toEqual([]);
  });

  test('notes_search finds notes and diary lines with their file and line', () => {
    const s = createStore(tmp('ns-'), () => new Date('2026-11-27T10:00:00Z'));
    expect(s.searchNotes('fish')).toBe('No match.');
    s.writeNotes('# Places\nbank is east of the castle\nfishing spot at Draynor');
    s.appendDiary('Caught shrimp at Draynor');
    const out = s.searchNotes('draynor fishing');
    expect(out.split('\n')[0]).toBe('[notes.md:3] fishing spot at Draynor');
    expect(out).toContain('[diary.md:1] 2026-11-27 10:00 Caught shrimp at Draynor');
    expect(s.searchNotes('?')).toBe('Give some search words.');
  });
});

describe('wiki knowledge', () => {
  function fixture() {
    const root = tmp('wiki-');
    const base = join(root, 'vendor', 'rs-sdk');
    for (const d of ['wiki/items', 'wiki/shops', 'learnings']) mkdirSync(join(base, d), { recursive: true });
    writeFileSync(join(base, 'wiki/items/bronze-axe.md'), '# Bronze axe\n- Sold by: Bob\'s Brilliant Axes for 16 gp');
    writeFileSync(join(base, 'wiki/items/bronze-pickaxe.md'), '# Bronze pickaxe');
    writeFileSync(join(base, 'wiki/shops/bobs-brilliant-axes.md'), '# Bob\'s Brilliant Axes');
    writeFileSync(join(base, 'learnings/woodcutting.md'), '# Woodcutting\nuse an axe on a tree');
    return root;
  }

  test('a pack searches the wiki and the learnings, and shows the source path', () => {
    const pack = createKnowledgePack(fixture());
    expect(pack.wiki.size).toBe(3);
    const out = searchKnowledge(pack, 'who sells a bronze axe');
    expect(out.startsWith('[wiki/items/bronze-axe.md]\n# Bronze axe')).toBe(true);
    expect(out).toContain('[learnings/woodcutting.md]');
    expect(searchKnowledge(pack, 'zzz')).toBe('No match.');
  });

  test('the index reads only the pages that it returns', () => {
    const reads: string[] = [];
    const pages = Array.from({ length: 3000 }, (_, i) => ({ source: `wiki/items/thing-${i}.md`, file: `/w/thing-${i}.md` }));
    pages.push({ source: 'wiki/npcs/chicken.md', file: '/w/chicken.md' });
    const idx = createWikiIndex(pages, f => { reads.push(f); return `page ${f}`; });
    const t0 = performance.now();
    const hits = idx.search('where are chickens');
    const ms = performance.now() - t0;
    expect(hits.map(h => h.source)).toEqual(['wiki/npcs/chicken.md']);
    expect(reads).toEqual(['/w/chicken.md']);
    expect(idx.search('thing', 3).length).toBe(3);
    expect(reads.length).toBe(4);
    expect(ms).toBeLessThan(50);
  });

  const root = join(import.meta.dir, '..', '..');
  test.skipIf(!existsSync(join(root, 'vendor', 'rs-sdk', 'wiki', 'items')))('the real wiki: indexed, and a query is under 50 ms', () => {
    const pack = createKnowledgePack(root);
    expect(pack.wiki.size).toBeGreaterThan(2000);
    const t0 = performance.now();
    const out = searchKnowledge(pack, 'bronze axe');
    const ms = performance.now() - t0;
    expect(out).toContain('[wiki/items/bronze-axe.md]');
    expect(out.length).toBeLessThan(5 * 1_600);
    expect(ms).toBeLessThan(50);
  });
});

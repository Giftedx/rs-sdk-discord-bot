import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, loadKnowledge, searchKnowledge, StoreError } from './store';
import { costUsd, createSpendTracker } from './spend';
import { redactNames, sanitizeForDiscord } from '../shared/sanitize';

describe('store', () => {
  test('a good run marks a script known good; a failure, a new save or a delete clears it', () => {
    let t = Date.UTC(2026, 0, 2, 3, 4);
    const s = createStore(mkdtempSync(join(tmpdir(), 'store-')), () => new Date(t));
    s.saveScript('fish', 'Fish', 'return 1;');
    expect(s.listScripts()).toEqual([{ name: 'fish', description: 'Fish' }]);
    s.markScriptRun('fish', true);
    expect(s.listScripts()).toEqual([{ name: 'fish', description: 'Fish', knownGoodAt: t }]);
    s.markScriptRun('fish', false);
    expect(s.listScripts()[0]!.knownGoodAt).toBeUndefined();
    s.markScriptRun('fish', true);
    s.saveScript('fish', 'Fish', 'return 2;');
    expect(s.listScripts()[0]!.knownGoodAt).toBeUndefined();
    s.markScriptRun('fish', true);
    s.deleteScript('fish');
    s.saveScript('fish', 'Fish', 'return 3;');
    expect(s.listScripts()[0]!.knownGoodAt).toBeUndefined();
    // No script: no mark file.
    s.markScriptRun('nope', true);
    expect(s.listScripts().map(x => x.name)).toEqual(['fish']);
  });

  test('saves, lists, reads and deletes a script', () => {
    const s = createStore(mkdtempSync(join(tmpdir(), 'store-')));
    s.saveScript('chop-trees', 'Chop trees\nnear Lumbridge', 'await bot.chopTree();');
    expect(s.listScripts()).toEqual([{ name: 'chop-trees', description: 'Chop trees near Lumbridge' }]);
    expect(s.readScript('chop-trees')).toContain('await bot.chopTree();');
    s.deleteScript('chop-trees');
    expect(s.listScripts()).toEqual([]);
  });

  test('refuses a name with a path in it', () => {
    const s = createStore(mkdtempSync(join(tmpdir(), 'store-')));
    expect(() => s.saveScript('../x', '', '')).toThrow(StoreError);
  });

  test('notes', () => {
    const s = createStore(mkdtempSync(join(tmpdir(), 'store-')));
    expect(s.readNotes()).toBe('');
    s.writeNotes('bank is east');
    expect(s.readNotes()).toBe('bank is east');
  });

  test('knowledge search finds the best section', () => {
    const dir = mkdtempSync(join(tmpdir(), 'know-'));
    const f = join(dir, 'fishing.md');
    writeFileSync(f, '# Fishing\nshrimp at draynor\n## Cooking\nrange in lumbridge\n');
    const chunks = loadKnowledge([f]);
    expect(chunks.length).toBe(2);
    expect(searchKnowledge(chunks, 'shrimp')).toContain('draynor');
    expect(searchKnowledge(chunks, 'zzz')).toBe('No match.');
  });
});

describe('spend', () => {
  test('cost and cap', () => {
    expect(costUsd('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(4);
    const file = join(mkdtempSync(join(tmpdir(), 'spend-')), 'spend.json');
    const t = createSpendTracker(file, 1, () => new Date('2026-11-27T00:00:00Z'));
    t.add('claude-opus-5-5', { input_tokens: 0, output_tokens: 60_000 });
    expect(t.overCap()).toBe(true);
    const next = createSpendTracker(file, 1, () => new Date('2026-12-01T00:00:00Z'));
    expect(next.spentUsd()).toBe(0);
  });
});

describe('sanitizeForDiscord', () => {
  test('removes secrets and mentions and caps the length', () => {
    const out = sanitizeForDiscord('hi @everyone <@123> tok-secret', ['tok-secret']);
    expect(out).not.toContain('@everyone');
    expect(out).not.toContain('<@123>');
    expect(out).toContain('<secret>');
    expect(sanitizeForDiscord('x'.repeat(5000), []).length).toBeLessThanOrEqual(2000);
  });
});

describe('redactNames', () => {
  test('replaces the account name in any letter case, as a whole word', () => {
    expect(redactNames('my character Hero42 is near HERO42.', ['hero42'], 'X')).toBe('my character X is near X.');
    expect(redactNames('hero423 stays', ['hero42'], 'X')).toBe('hero423 stays');
    expect(redactNames('ab', ['ab'], 'X')).toBe('ab');
  });
});

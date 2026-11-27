// Seed scripts: saved scripts that ship with the bot (seed/*.ts, store format: the first line
// is "// description", the rest is the body of an async function with bot and sdk).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SCRIPT_NAME } from '../agent/store';

export interface SeedStore {
  listScripts(): { name: string }[];
  saveScript(name: string, description: string, body: string): void;
}

export interface SeedScript { name: string; description: string; body: string; }

export function parseSeed(name: string, text: string): SeedScript {
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  if (!first.startsWith('//')) throw new Error(`seed ${name}: the first line must be "// description"`);
  return { name, description: first.slice(2).trim(), body: nl < 0 ? '' : text.slice(nl + 1) };
}

export function readSeeds(seedDir: string): SeedScript[] {
  if (!existsSync(seedDir)) return [];
  return readdirSync(seedDir).filter(f => f.endsWith('.ts')).sort()
    .map(f => basename(f, '.ts'))
    .filter(name => SCRIPT_NAME.test(name))
    .map(name => parseSeed(name, readFileSync(join(seedDir, `${name}.ts`), 'utf8').replace(/\r\n/g, '\n')));
}

// Copies each seed script into the store when the store has no script of that name.
// Returns the names it added. A script that the AI or the owner changed stays as it is.
export function seedStore(store: SeedStore, seedDir: string): string[] {
  const have = new Set(store.listScripts().map(s => s.name));
  const added: string[] = [];
  for (const seed of readSeeds(seedDir)) {
    if (have.has(seed.name)) continue;
    store.saveScript(seed.name, seed.description, seed.body);
    added.push(seed.name);
  }
  return added;
}

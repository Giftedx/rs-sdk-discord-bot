// Seed scripts: saved scripts that ship with the bot (seed/*.ts, store format: the first line
// is "// description", the rest is the body of an async function with bot and sdk).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// The hashes of the seed versions that seedStore wrote, by name. With them, a later version of a
// seed replaces the stored script only while the AI or the owner did not change it.
export interface SeedRecord {
  get(name: string): string | undefined;
  set(name: string, hash: string): void;
}

const hashOf = (text: string) => new Bun.CryptoHasher('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

// Copies each seed script into the store when the store has no script of that name, and, with a
// record, updates a stored seed that nobody changed. Returns the names it added or updated.
export function seedStore(store: SeedStore & { readScript?(name: string): string }, seedDir: string, record?: SeedRecord): string[] {
  const have = new Set(store.listScripts().map(s => s.name));
  const changed: string[] = [];
  const write = (seed: SeedScript) => {
    store.saveScript(seed.name, seed.description, seed.body);
    if (record && store.readScript) record.set(seed.name, hashOf(store.readScript(seed.name)));
    changed.push(seed.name);
  };
  for (const seed of readSeeds(seedDir)) {
    if (!have.has(seed.name)) { write(seed); continue; }
    if (!record || !store.readScript) continue;
    const stored = hashOf(store.readScript(seed.name));
    const last = record.get(seed.name);
    if (last === undefined || last !== stored) continue;   // unknown or changed by someone: keep it
    const next = `// ${seed.description}\n${seed.body}`;
    if (hashOf(next) !== stored) write(seed);
  }
  return changed;
}

// A SeedRecord in one JSON file.
export function fileSeedRecord(path: string): SeedRecord {
  let data: Record<string, string> = {};
  try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first run */ }
  return {
    get: name => data[name],
    set(name, hash) { data[name] = hash; writeFileSync(path, JSON.stringify(data, null, 1)); },
  };
}

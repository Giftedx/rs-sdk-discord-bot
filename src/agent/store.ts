// Files that the AI keeps between restarts: saved scripts and one notes file.
// Read-only knowledge: the rs-sdk learnings and the SDK API reference.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const SCRIPT_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const MAX_SCRIPT_CHARS = 40_000;
export const MAX_NOTES_CHARS = 20_000;

export class StoreError extends Error {}

export function createStore(dataDir: string) {
  const scriptsDir = join(dataDir, 'scripts');
  const notesFile = join(dataDir, 'notes.md');
  mkdirSync(scriptsDir, { recursive: true });

  const scriptPath = (name: string) => {
    if (!SCRIPT_NAME.test(name)) throw new StoreError('script name must match ^[a-z0-9][a-z0-9_-]{0,39}$');
    return join(scriptsDir, `${name}.ts`);
  };

  return {
    listScripts(): { name: string; description: string }[] {
      return readdirSync(scriptsDir).filter(f => f.endsWith('.ts')).sort().map(f => {
        const text = readFileSync(join(scriptsDir, f), 'utf8');
        const first = text.split('\n', 1)[0] ?? '';
        return { name: basename(f, '.ts'), description: first.startsWith('//') ? first.slice(2).trim() : '' };
      });
    },
    readScript(name: string): string {
      const p = scriptPath(name);
      if (!existsSync(p)) throw new StoreError(`no script named ${name}`);
      return readFileSync(p, 'utf8');
    },
    saveScript(name: string, description: string, body: string): void {
      if (body.length > MAX_SCRIPT_CHARS) throw new StoreError(`script is longer than ${MAX_SCRIPT_CHARS} characters`);
      const line = description.replace(/[\r\n]+/g, ' ').slice(0, 200);
      writeFileSync(scriptPath(name), `// ${line}\n${body}`);
    },
    deleteScript(name: string): void {
      rmSync(scriptPath(name), { force: true });
    },
    readNotes(): string {
      return existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : '';
    },
    writeNotes(text: string): void {
      if (text.length > MAX_NOTES_CHARS) throw new StoreError(`notes are longer than ${MAX_NOTES_CHARS} characters`);
      writeFileSync(notesFile, text);
    },
  };
}

export type Store = ReturnType<typeof createStore>;

export interface KnowledgeChunk { source: string; text: string; }

// Splits each Markdown file at its headings.
export function loadKnowledge(files: string[]): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const source = basename(file);
    let current: string[] = [];
    const flush = () => { const t = current.join('\n').trim(); if (t) chunks.push({ source, text: t }); current = []; };
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (/^#{1,3} /.test(line)) flush();
      current.push(line);
    }
    flush();
  }
  return chunks;
}

export function knowledgeFiles(rootDir: string): string[] {
  const learnings = join(rootDir, 'vendor', 'rs-sdk', 'learnings');
  const files = existsSync(learnings) ? readdirSync(learnings).filter(f => f.endsWith('.md')).map(f => join(learnings, f)) : [];
  return files.sort();
}

export function searchKnowledge(chunks: KnowledgeChunk[], query: string, limit = 5, maxChars = 1_500): string {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1);
  if (terms.length === 0) return 'Give some search words.';
  const scored = chunks
    .map(c => {
      const lower = c.text.toLowerCase();
      let score = 0;
      for (const t of terms) { let i = lower.indexOf(t); while (i !== -1) { score++; i = lower.indexOf(t, i + t.length); } }
      return { c, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (scored.length === 0) return 'No match.';
  return scored.map(s => `[${s.c.source}]\n${s.c.text.slice(0, maxChars)}`).join('\n\n---\n\n');
}

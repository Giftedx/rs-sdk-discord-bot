// Files that the AI keeps between restarts: saved scripts, notes, the diary and the
// personality. Read-only knowledge: the rs-sdk learnings, the rs-sdk wiki and the SDK API
// reference.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

export const SCRIPT_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const MAX_SCRIPT_CHARS = 40_000;
export const MAX_NOTES_CHARS = 20_000;
export const MAX_DIARY_LINE = 300;
export const MAX_DIARY_LINES = 200;

/** The default text of personality.md. The store writes it only when the file is missing. */
export const DEFAULT_PERSONALITY = `# Personality

You are a cheerful, curious adventurer who lives in this world. You speak in short, plain sentences.
You are proud of small wins, honest about failures, and careful with the account: safety first, then progress.
You talk about the game as your own life ("I chopped some logs"), but you never pretend that you are a person.
`;

export class StoreError extends Error {}

const pad = (n: number) => String(n).padStart(2, '0');
/** The UTC stamp of a diary line: YYYY-MM-DD HH:MM. */
export const diaryStamp = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

const readText = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');

export function createStore(dataDir: string, now: () => Date = () => new Date()) {
  const scriptsDir = join(dataDir, 'scripts');
  const notesFile = join(dataDir, 'notes.md');
  const diaryFile = join(dataDir, 'diary.md');
  const personalityFile = join(dataDir, 'personality.md');
  mkdirSync(scriptsDir, { recursive: true });
  if (!existsSync(personalityFile)) writeFileSync(personalityFile, DEFAULT_PERSONALITY);

  const scriptPath = (name: string) => {
    if (!SCRIPT_NAME.test(name)) throw new StoreError('script name must match ^[a-z0-9][a-z0-9_-]{0,39}$');
    return join(scriptsDir, `${name}.ts`);
  };
  const diaryLines = () => readText(diaryFile).split('\n').filter(l => l.trim());

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
      return readText(notesFile);
    },
    writeNotes(text: string): void {
      if (text.length > MAX_NOTES_CHARS) throw new StoreError(`notes are longer than ${MAX_NOTES_CHARS} characters`);
      writeFileSync(notesFile, text);
    },
    /** personality.md. The AI has no tool that writes it. */
    readPersonality(): string {
      return readText(personalityFile).trim();
    },
    /** Adds one dated line. Keeps the last MAX_DIARY_LINES lines. Returns the line. */
    appendDiary(text: string): string {
      const body = text.replace(/\s+/g, ' ').trim().slice(0, MAX_DIARY_LINE);
      if (!body) throw new StoreError('the diary entry is empty');
      const line = `${diaryStamp(now())} ${body}`;
      const lines = [...diaryLines(), line].slice(-MAX_DIARY_LINES);
      writeFileSync(diaryFile, lines.join('\n') + '\n');
      return line;
    },
    diaryTail(n = 10): string[] {
      return n > 0 ? diaryLines().slice(-n) : [];
    },
    /** Plain-text search over notes.md and diary.md. Each hit shows file:line. */
    searchNotes(query: string, limit = 10): string {
      const terms = queryTerms(query);
      if (terms.length === 0) return 'Give some search words.';
      const hits: { at: string; line: string; score: number; order: number }[] = [];
      let order = 0;
      for (const [name, text] of [['notes.md', readText(notesFile)], ['diary.md', readText(diaryFile)]] as const) {
        text.split('\n').forEach((line, i) => {
          const lower = line.toLowerCase();
          const score = terms.filter(t => lower.includes(t)).length;
          if (score > 0) hits.push({ at: `${name}:${i + 1}`, line: line.trim().slice(0, 300), score, order: order++ });
        });
      }
      if (hits.length === 0) return 'No match.';
      // Most terms first; among equals, the newest line (later in the file) first.
      return hits.sort((a, b) => b.score - a.score || b.order - a.order).slice(0, limit)
        .map(h => `[${h.at}] ${h.line}`).join('\n');
    },
  };
}

export type Store = ReturnType<typeof createStore>;

export interface KnowledgeChunk { source: string; text: string; }

const toPosix = (p: string) => p.replace(/\\/g, '/');

// Splits each Markdown file at its headings. With `base`, the source is the path relative to it.
export function loadKnowledge(files: string[], base?: string): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const source = base ? toPosix(relative(base, file)) : basename(file);
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

const STOP_WORDS = new Set(['the', 'and', 'for', 'how', 'who', 'what', 'where', 'which', 'can', 'get', 'buy', 'sell', 'sells', 'find', 'with', 'from', 'are', 'any', 'does', 'near', 'best', 'its', 'you', 'there']);
// A plural "s" is cut so that "axes" finds "axe".
const stem = (t: string) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);
// Lower case words without stop words. When only stop words remain, all words stay.
function queryTerms(query: string): string[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1);
  const kept = words.filter(t => !STOP_WORDS.has(t));
  return [...new Set(kept.length ? kept : words)];
}

/** One wiki page in the compact index: the path and the words of its file name. */
interface WikiEntry { source: string; file: string; words: string[]; }

/**
 * A compact index of the wiki: only paths and file-name words stay in memory. A search reads
 * only the pages that it returns. The file names are the page titles (items, npcs, shops,
 * quests, skills), and an item page lists the shops that sell it and the NPCs that drop it.
 */
export function createWikiIndex(pages: { source: string; file: string }[], read: (file: string) => string = f => readFileSync(f, 'utf8')) {
  const entries: WikiEntry[] = pages.map(p => ({
    ...p,
    words: basename(p.file, '.md').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem),
  }));
  return {
    size: entries.length,
    /** The best pages for the query, most specific first. */
    search(query: string, limit = 3): KnowledgeChunk[] {
      const terms = queryTerms(query).map(stem);
      if (terms.length === 0) return [];
      const scored: { e: WikiEntry; score: number }[] = [];
      for (const e of entries) {
        let hit = 0;
        for (const w of e.words) if (terms.includes(w)) hit++;
        if (hit === 0) continue;
        // All words of the title are in the query: an exact page, such as "bronze axe".
        const exact = hit === e.words.length ? 15 : 0;
        scored.push({ e, score: hit * 10 + exact - e.words.length });
      }
      scored.sort((a, b) => b.score - a.score || a.e.source.localeCompare(b.e.source));
      const out: KnowledgeChunk[] = [];
      for (const { e } of scored.slice(0, limit)) {
        try { out.push({ source: e.source, text: read(e.file) }); } catch { /* the page was removed */ }
      }
      return out;
    },
  };
}

export type WikiIndex = ReturnType<typeof createWikiIndex>;

/** The knowledge pack: the learnings as chunks, and the wiki as a compact index. */
export interface KnowledgePack { learnings: KnowledgeChunk[]; wiki: WikiIndex; }

function walkMd(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkMd(p, out);
    else if (ent.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** Loads the learnings and indexes every Markdown page under vendor/rs-sdk/wiki. */
export function createKnowledgePack(rootDir: string): KnowledgePack {
  const base = join(rootDir, 'vendor', 'rs-sdk');
  const pages = walkMd(join(base, 'wiki')).sort().map(file => ({ source: toPosix(relative(base, file)), file }));
  return { learnings: loadKnowledge(knowledgeFiles(rootDir), base), wiki: createWikiIndex(pages) };
}

const isPack = (k: KnowledgeChunk[] | KnowledgePack): k is KnowledgePack => !Array.isArray(k);

/** Searches the learnings and, for a pack, the wiki. Each result starts with its source path. */
export function searchKnowledge(knowledge: KnowledgeChunk[] | KnowledgePack, query: string, limit = 5, maxChars = 1_500): string {
  const terms = queryTerms(query);
  if (terms.length === 0) return 'Give some search words.';
  const chunks = isPack(knowledge) ? knowledge.learnings : knowledge;
  const wiki = isPack(knowledge) ? knowledge.wiki.search(query, Math.min(3, limit)) : [];
  const scored = chunks
    .map(c => {
      const lower = c.text.toLowerCase();
      let score = 0;
      for (const t of terms) { let i = lower.indexOf(t); while (i !== -1) { score++; i = lower.indexOf(t, i + t.length); } }
      return { c, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(limit - wiki.length, 2));
  const results = [...wiki, ...scored.map(s => s.c)];
  if (results.length === 0) return 'No match.';
  return results.map(r => `[${r.source}]\n${r.text.slice(0, maxChars)}`).join('\n\n---\n\n');
}

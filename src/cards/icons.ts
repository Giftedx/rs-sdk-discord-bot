// Item icons come at run time from the sprite route of the rs-sdk engine web server
// (GET /sprite/item/{id}.png, the same origin that serves the webclient). They stay in memory
// only: the repo holds no game art.

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface IconCacheOptions {
  // Origin of the game host, for example "http://localhost:8888". Without it, cards have no icons.
  iconHost?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  // A failed id is not asked for again until this time passes.
  retryAfterMs?: number;
  now?: () => number;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(b: Uint8Array): boolean {
  return b.length > PNG_MAGIC.length && PNG_MAGIC.every((v, i) => b[i] === v);
}

export function iconOrigin(iconHost: string): string {
  const u = new URL(iconHost);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`icon host must be http or https: ${u.protocol}`);
  return u.origin;
}

export function itemIconUrl(origin: string, id: number): string {
  if (!Number.isInteger(id) || id < 0 || id > 999_999) throw new Error(`bad item id: ${id}`);
  return `${origin}/sprite/item/${id}.png`;
}

export class IconCache {
  private readonly origin: string | null;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly retryAfterMs: number;
  private readonly now: () => number;
  private readonly hits = new Map<number, string>();
  private readonly failedAt = new Map<number, number>();
  private readonly inflight = new Map<number, Promise<string | null>>();

  constructor(opts: IconCacheOptions = {}) {
    this.origin = opts.iconHost ? iconOrigin(opts.iconHost) : null;
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 3_000;
    this.maxEntries = opts.maxEntries ?? 512;
    this.maxBytes = opts.maxBytes ?? 64 * 1024;
    this.retryAfterMs = opts.retryAfterMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.hits.size;
  }

  // A data: URL of the PNG, or null when there is no icon host or the fetch failed.
  async get(id: number): Promise<string | null> {
    if (!this.origin) return null;
    const hit = this.hits.get(id);
    if (hit !== undefined) {
      // Refresh the order of the Map, so the oldest entry is the least recently used.
      this.hits.delete(id);
      this.hits.set(id, hit);
      return hit;
    }
    const failed = this.failedAt.get(id);
    if (failed !== undefined && this.now() - failed < this.retryAfterMs) return null;
    let p = this.inflight.get(id);
    if (!p) {
      p = this.load(id).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return p;
  }

  async getMany(ids: readonly number[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    await Promise.all(ids.map(async id => {
      const v = await this.get(id);
      if (v) out[String(id)] = v;
    }));
    return out;
  }

  private async load(id: number): Promise<string | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(itemIconUrl(this.origin!, id), { signal: ctrl.signal });
      if (!res.ok) return this.fail(id);
      const type = res.headers.get('content-type') ?? '';
      if (!type.startsWith('image/png')) return this.fail(id);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > this.maxBytes || !isPng(bytes)) return this.fail(id);
      const url = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
      this.failedAt.delete(id);
      this.hits.set(id, url);
      while (this.hits.size > this.maxEntries) this.hits.delete(this.hits.keys().next().value!);
      return url;
    } catch {
      return this.fail(id);
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(id: number): null {
    this.failedAt.set(id, this.now());
    return null;
  }
}

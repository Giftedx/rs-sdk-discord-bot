import { describe, expect, test } from 'bun:test';
import { type FetchLike, IconCache, iconOrigin, isPng, itemIconUrl } from './icons';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function fakeFetch(handler: (url: string) => { ok?: boolean; type?: string; body?: Uint8Array } | Error) {
  const calls: string[] = [];
  const fn: FetchLike = async url => {
    calls.push(url);
    const r = handler(url);
    if (r instanceof Error) throw r;
    const body = r.body ?? PNG;
    return {
      ok: r.ok ?? true,
      headers: { get: (n: string) => (n === 'content-type' ? (r.type ?? 'image/png') : null) },
      arrayBuffer: async () => body.slice().buffer,
    };
  };
  return { fn, calls };
}

describe('icon helpers', () => {
  test('builds the sprite URL and checks the origin', () => {
    expect(itemIconUrl(iconOrigin('http://localhost:8888/bot?x=1'), 995)).toBe('http://localhost:8888/sprite/item/995.png');
    expect(() => iconOrigin('file:///etc/passwd')).toThrow(/http/);
    expect(() => itemIconUrl('http://h', -1)).toThrow(/bad item id/);
    expect(() => itemIconUrl('http://h', 1.5)).toThrow(/bad item id/);
  });

  test('isPng checks the magic bytes', () => {
    expect(isPng(PNG)).toBe(true);
    expect(isPng(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('IconCache', () => {
  test('returns null without an icon host and makes no fetch', async () => {
    const f = fakeFetch(() => ({}));
    const c = new IconCache({ fetch: f.fn });
    expect(await c.get(1)).toBeNull();
    expect(f.calls).toEqual([]);
  });

  test('fetches once, then serves from memory', async () => {
    const f = fakeFetch(() => ({}));
    const c = new IconCache({ iconHost: 'http://game:8888', fetch: f.fn });
    const [a, b] = await Promise.all([c.get(995), c.get(995)]);
    expect(a).toStartWith('data:image/png;base64,');
    expect(b).toBe(a);
    expect(await c.get(995)).toBe(a);
    expect(f.calls).toEqual(['http://game:8888/sprite/item/995.png']);
  });

  test('rejects a non-PNG body, a wrong type, a large body and a failed response', async () => {
    const big = new Uint8Array(70_000);
    big.set(PNG);
    const f = fakeFetch(url => {
      if (url.includes('/1.png')) return { body: new Uint8Array([60, 104]) };
      if (url.includes('/2.png')) return { type: 'text/html' };
      if (url.includes('/3.png')) return { body: big };
      if (url.includes('/4.png')) return { ok: false };
      return new Error('network down');
    });
    const c = new IconCache({ iconHost: 'http://game:8888', fetch: f.fn });
    for (const id of [1, 2, 3, 4, 5]) expect(await c.get(id)).toBeNull();
    expect(c.size).toBe(0);
  });

  test('waits before it asks for a failed id again', async () => {
    let now = 0;
    let fail = true;
    const f = fakeFetch(() => (fail ? new Error('down') : {}));
    const c = new IconCache({ iconHost: 'http://game:8888', fetch: f.fn, retryAfterMs: 1000, now: () => now });
    expect(await c.get(7)).toBeNull();
    fail = false;
    expect(await c.get(7)).toBeNull();
    expect(f.calls.length).toBe(1);
    now = 1000;
    expect(await c.get(7)).not.toBeNull();
    expect(f.calls.length).toBe(2);
  });

  test('drops the least recently used entry above the limit', async () => {
    const f = fakeFetch(() => ({}));
    const c = new IconCache({ iconHost: 'http://game:8888', fetch: f.fn, maxEntries: 2 });
    await c.get(1);
    await c.get(2);
    await c.get(1);
    await c.get(3);
    expect(c.size).toBe(2);
    await c.get(1);
    expect(f.calls.length).toBe(3);
    await c.get(2);
    expect(f.calls.length).toBe(4);
  });

  test('getMany leaves out the ids without an icon', async () => {
    const f = fakeFetch(url => (url.includes('/2.png') ? { ok: false } : {}));
    const c = new IconCache({ iconHost: 'http://game:8888', fetch: f.fn });
    expect(Object.keys(await c.getMany([1, 2, 3])).sort()).toEqual(['1', '3']);
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'puppeteer';
import { SAMPLE_CARDS } from '../cards/samples';
import { CARD_DEVICE_SCALE, CARD_KINDS, CARD_MIN_HEIGHT, CARD_SIZES, CardDataError, cardIconIds, validateCardData } from '../cards/templates';
import { allowCardRequest, cardHeight, type CardTab, openCardTab } from './card-tab';
import { launchBrowser } from './game-tab';

const T = 60_000;

describe('allowCardRequest', () => {
  test('allows only about:blank and data: URLs', () => {
    expect(allowCardRequest('about:blank')).toBe(true);
    expect(allowCardRequest('data:image/png;base64,AAAA')).toBe(true);
    expect(allowCardRequest('http://localhost:8888/sprite/item/1.png')).toBe(false);
    expect(allowCardRequest('https://example.com/font.woff2')).toBe(false);
    expect(allowCardRequest('file:///etc/passwd')).toBe(false);
  });
});

// The same switch as src/gamelink/game-tab.test.ts: RS_SKIP_BROWSER_TESTS=1 skips the tests
// that launch Chromium.
const SKIP_BROWSER = process.env.RS_SKIP_BROWSER_TESTS === '1';
const browserTest = SKIP_BROWSER ? test.skip : test;
// CARD_PNG_DIR, when set, receives one PNG per card for a look by eye.
const PNG_DIR = process.env.CARD_PNG_DIR;
// CARD_ICON_HOST, when set, takes icons from a real game host instead of the test server.
const LIVE_ICON_HOST = process.env.CARD_ICON_HOST;

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let tab: CardTab | undefined;
const seen: string[] = [];

function pngSize(b: Uint8Array): { width: number; height: number } {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

beforeAll(async () => {
  if (SKIP_BROWSER) return;
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(path);
      if (/^\/sprite\/item\/\d+\.png$/.test(path)) return new Response(ONE_PIXEL_PNG, { headers: { 'content-type': 'image/png' } });
      return new Response('no', { status: 404 });
    },
  });
  browser = await launchBrowser();
  tab = await openCardTab(browser, { iconHost: LIVE_ICON_HOST ?? `http://127.0.0.1:${server.port}` });
}, T);

afterAll(async () => {
  await tab?.close();
  await browser?.close();
  await server?.stop(true);
}, T);

describe('card tab', () => {
  browserTest('draws each card at its width and at most its largest height', async () => {
    if (PNG_DIR) mkdirSync(PNG_DIR, { recursive: true });
    for (const kind of CARD_KINDS) {
      const png = await tab!.draw(kind, SAMPLE_CARDS[kind] as never);
      expect(png[0]).toBe(0x89);
      const { width, height } = CARD_SIZES[kind];
      const size = pngSize(png);
      expect(size.width).toBe(width * CARD_DEVICE_SCALE);
      expect(size.height).toBeGreaterThanOrEqual(CARD_MIN_HEIGHT * CARD_DEVICE_SCALE);
      expect(size.height).toBeLessThanOrEqual(height * CARD_DEVICE_SCALE);
      if (PNG_DIR) writeFileSync(join(PNG_DIR, `${kind}.png`), png);
    }
    if (!LIVE_ICON_HOST) {
      const want = new Set(CARD_KINDS.flatMap(k => cardIconIds(k, validateCardData(k, SAMPLE_CARDS[k]))));
      expect(seen.filter(p => p.startsWith('/sprite/item/')).sort()).toEqual([...want].map(id => `/sprite/item/${id}.png`).sort());
    }
  }, T);

  browserTest('the receipt card shows the game view at its own size', async () => {
    // CARD_FRAME, when set, is a real game frame for the PNG in CARD_PNG_DIR. Any PNG fills the view.
    const frame = new Uint8Array(process.env.CARD_FRAME ? readFileSync(process.env.CARD_FRAME) : ONE_PIXEL_PNG);
    const without = pngSize(await tab!.draw('instruction_receipt', SAMPLE_CARDS.instruction_receipt));
    const png = await tab!.draw('instruction_receipt', SAMPLE_CARDS.instruction_receipt, frame);
    const size = pngSize(png);
    // The view is 334 CSS pixels high, plus its frame.
    expect(size.height - without.height).toBeGreaterThanOrEqual(340 * CARD_DEVICE_SCALE);
    expect(size.height).toBeLessThanOrEqual(CARD_SIZES.instruction_receipt.height * CARD_DEVICE_SCALE);
    // Other cards ignore a frame.
    const level = await tab!.draw('level_up', SAMPLE_CARDS.level_up, frame);
    expect(pngSize(level)).toEqual(pngSize(await tab!.draw('level_up', SAMPLE_CARDS.level_up)));
    if (PNG_DIR) writeFileSync(join(PNG_DIR, 'instruction_receipt-frame.png'), png);
  }, T);

  browserTest('draws markup in names as text and loads nothing it names', async () => {
    const before = seen.length;
    const evil = `<img src="http://127.0.0.1:${server!.port}/evil" onerror="fetch('/evil2')">`;
    const png = await tab!.draw('death', { place: evil, time: evil, items: [{ id: 42, name: evil, count: 3 }] });
    expect(png.length).toBeGreaterThan(100);
    expect(seen.slice(before).filter(p => p.includes('evil'))).toEqual([]);
    if (PNG_DIR) writeFileSync(join(PNG_DIR, 'death-markup.png'), png);
  }, T);

  browserTest('the card page cannot reach the network', async () => {
    const page = (await browser!.pages()).find(p => p.url() === 'about:blank' && p.viewport()?.deviceScaleFactor === CARD_DEVICE_SCALE)!;
    expect(page).toBeDefined();
    const before = seen.length;
    const r = await page.evaluate(async (u: string) => {
      try {
        await fetch(u);
        return 'reached';
      } catch {
        return 'blocked';
      }
    }, `http://127.0.0.1:${server!.port}/leak`);
    expect(r).toBe('blocked');
    expect(seen.slice(before)).toEqual([]);
  }, T);

  browserTest('rejects bad data before it draws', async () => {
    await expect(tab!.draw('level_up', { skill: 'A', level: 0, xp: 1 })).rejects.toThrow(CardDataError);
    await expect(tab!.draw('nope' as never, {} as never)).rejects.toThrow(/unknown card kind/);
    // The tab still draws after a rejected card.
    expect((await tab!.draw('level_up', SAMPLE_CARDS.level_up)).length).toBeGreaterThan(100);
  }, T);
});

describe('cardHeight', () => {
  test('keeps the content height between the minimum and the largest height', () => {
    expect(cardHeight(250.2, 400)).toBe(251);
    expect(cardHeight(10, 400)).toBe(CARD_MIN_HEIGHT);
    expect(cardHeight(900, 400)).toBe(400);
    expect(cardHeight('x', 400)).toBe(400);
    expect(cardHeight(Number.NaN, 400)).toBe(400);
  });
});

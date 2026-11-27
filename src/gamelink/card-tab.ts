import type { Browser, HTTPRequest, Page } from 'puppeteer';
import { IconCache, type IconCacheOptions } from '../cards/icons';
import { loadSkillSheets, SKILL_CELL, SKILL_CELLS, SKILL_SHEET_COLUMNS, type SkillSheets } from '../cards/skill-icons';
import {
  CARD_DEVICE_SCALE,
  CARD_MIN_HEIGHT,
  CARD_PAGE_HTML,
  CARD_SIZES,
  type CardDataMap,
  type CardKind,
  cardIconIds,
  isCardKind,
  CardDataError,
  validateCardData,
} from '../cards/templates';

export interface CardTabOptions extends IconCacheOptions {
  drawTimeoutMs?: number;
  /** The skill icon sheets. Default: read from the vendor submodule. */
  skillSheets?: SkillSheets;
}

export interface CardTab {
  draw<K extends CardKind>(kind: K, data: CardDataMap[K]): Promise<Uint8Array>;
  close(): Promise<void>;
}

// The card page loads nothing from the network. Icons reach it as data: URLs from the
// IconCache in this process, so every request that is not about: or data: is aborted.
export function allowCardRequest(url: string): boolean {
  return url.startsWith('data:') || url === 'about:blank';
}

/** The picture height for a content height from the page: a whole number from CARD_MIN_HEIGHT to max. */
export function cardHeight(content: unknown, max: number): number {
  const h = typeof content === 'number' && Number.isFinite(content) ? Math.ceil(content) : max;
  return Math.max(CARD_MIN_HEIGHT, Math.min(max, h));
}

export async function openCardTab(browser: Browser, opts: CardTabOptions = {}): Promise<CardTab> {
  const icons = new IconCache(opts);
  const drawTimeoutMs = opts.drawTimeoutMs ?? 10_000;
  const page: Page = await browser.newPage();
  let closed = false;
  try {
    await page.setJavaScriptEnabled(true);
    await page.setRequestInterception(true);
    page.on('request', (req: HTTPRequest) => {
      if (req.isInterceptResolutionHandled()) return;
      if (allowCardRequest(req.url())) void req.continue();
      else void req.abort('blockedbyclient');
    });
    await page.goto('about:blank');
    await page.setContent(CARD_PAGE_HTML, { waitUntil: 'load' });
    const ready = await page.evaluate(() => typeof (window as unknown as { renderCard?: unknown }).renderCard === 'function');
    if (!ready) throw new Error('card page script did not load');
    const sheets = opts.skillSheets ?? loadSkillSheets();
    await page.evaluate(
      (s, c, z, k) => (window as unknown as { loadSkillIcons(s: unknown, c: unknown, z: number, k: number): Promise<number> }).loadSkillIcons(s, c, z, k),
      sheets as Record<string, string>, SKILL_CELLS as unknown as Record<string, unknown>, SKILL_CELL, SKILL_SHEET_COLUMNS,
    );
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }

  // One page draws one card at a time.
  let chain: Promise<unknown> = Promise.resolve();

  async function drawNow(kind: CardKind, raw: unknown): Promise<Uint8Array> {
    if (closed) throw new Error('card tab is closed');
    if (!isCardKind(kind)) throw new CardDataError(`unknown card kind: ${String(kind)}`);
    const data = validateCardData(kind, raw);
    const iconMap = await icons.getMany(cardIconIds(kind, data));
    const { width, height: maxHeight } = CARD_SIZES[kind];
    await page.setViewport({ width, height: maxHeight, deviceScaleFactor: CARD_DEVICE_SCALE });
    const content = await page.evaluate(
      (k, d, i) => (window as unknown as { renderCard(k: string, d: unknown, i: unknown): Promise<number> }).renderCard(k, d, i),
      kind,
      data as unknown as Record<string, unknown>,
      iconMap,
    );
    // The picture is as high as the card content, between the minimum and the largest height.
    const height = cardHeight(content, maxHeight);
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height }, omitBackground: false });
    return new Uint8Array(png);
  }

  function withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`card draw timed out after ${drawTimeoutMs} ms`)), drawTimeoutMs);
    });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
  }

  return {
    draw(kind, data) {
      // The next draw waits for this one to end on the page, even after its timeout.
      const run = chain.then(() => drawNow(kind, data));
      chain = run.catch(() => {});
      return withTimeout(run);
    },
    async close() {
      if (closed) return;
      closed = true;
      await page.close().catch(() => {});
    },
  };
}

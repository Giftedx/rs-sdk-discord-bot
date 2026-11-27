import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'puppeteer';
import {
  CHROMIUM_ARGS,
  RigCheckError,
  TabNotReadyError,
  browserLaunchEnv,
  buildBotUrl,
  launchBrowser,
  openGameTab,
  type GameTab,
} from './game-tab';

const FIXTURE = new URL('../testing/fixture-bot-page.html', import.meta.url);
const T = 30_000;
const PASSWORD = 'sEcr3t-pw-9f2a';

let server: ReturnType<typeof Bun.serve>;
let base: string;
let browser: Browser;
const seen: string[] = [];
const tabs: GameTab[] = [];
const pages: Page[] = [];

function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => undefined, e => e);
}

function pngSize(b: Uint8Array): [number, number] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return [v.getUint32(16), v.getUint32(20)];
}

async function tab(path = '/bot'): Promise<GameTab> {
  const t = await openGameTab({
    browser,
    botPageUrl: `${base}${path}`,
    account: 'abc123',
    password: PASSWORD,
    fps: 15,
  });
  tabs.push(t);
  return t;
}

// The tab is the only open page whose URL carries the bot parameter.
async function gamePage(): Promise<Page> {
  return (await browser.pages()).find(p => p.url().includes('bot=abc123'))!;
}

// RS_SKIP_BROWSER_TESTS=1 skips the tests that launch Chromium. Job `check` of the CI workflow
// sets it: GitHub's Ubuntu runners restrict unprivileged user namespaces, so Chromium cannot
// start its sandbox there, and this project never uses --no-sandbox. Job `browser-tests` turns
// that restriction of the runner off and runs these tests. docs/development.md has the detail.
const SKIP_BROWSER = process.env.RS_SKIP_BROWSER_TESTS === '1';
const browserTest = SKIP_BROWSER ? test.skip : test;

beforeAll(async () => {
  if (SKIP_BROWSER) {
    console.warn('RS_SKIP_BROWSER_TESTS=1: the tests that launch Chromium are skipped.');
    return;
  }
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push(`${req.method} ${url.pathname}`);
      // /bad and /nocanvas redirect to the fixture with its flag in the query.
      if (url.pathname === '/bad' || url.pathname === '/nocanvas') {
        const flag = url.pathname.slice(1);
        return Response.redirect(`${base}/bot?${flag === 'bad' ? 'bad' : 'nocanvas'}=1&${url.searchParams}`, 302);
      }
      if (url.pathname === '/bot') {
        return new Response(Bun.file(FIXTURE), { headers: { 'content-type': 'text/html' } });
      }
      return new Response('ok');
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  browser = await launchBrowser();
}, T);

afterEach(async () => {
  for (const t of tabs.splice(0)) await t.close().catch(() => {});
  for (const p of pages.splice(0)) await p.close().catch(() => {});
}, T);

afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
}, T);

describe('game tab', () => {
  test('CHROMIUM_ARGS has no flag that disables the sandbox', () => {
    expect(CHROMIUM_ARGS.some(a => a.includes('no-sandbox') || a.includes('disable-setuid-sandbox'))).toBe(false);
  });

  test('browserLaunchEnv keeps the environment, removes the password, and turns the session bus off', () => {
    const base = { HOME: '/home/u', PATH: '/bin', XDG_RUNTIME_DIR: '/run/user/1', TMPDIR: '/tmp', RS_PASSWORD: PASSWORD, UNSET: undefined };
    const env = browserLaunchEnv(base);
    expect(env).toEqual({
      HOME: '/home/u', PATH: '/bin', XDG_RUNTIME_DIR: '/run/user/1', TMPDIR: '/tmp',
      NO_AT_BRIDGE: '1', DBUS_SESSION_BUS_ADDRESS: 'disabled:',
    });
    expect(Object.values(env)).not.toContain(PASSWORD);
    expect(base.RS_PASSWORD).toBe(PASSWORD);
  });

  test('buildBotUrl encodes values and adds fps and minimal', () => {
    expect(buildBotUrl('https://h/bot', 'abc123', 'p&w', 15)).toBe('https://h/bot?bot=abc123&password=p%26w&fps=15&minimal');
  });

  browserTest('selfCheck passes on a 765x503 canvas', async () => {
    const t = await tab();
    await t.selfCheck();
  }, T);

  browserTest('selfCheck rejects with RigCheckError on an 800x600 canvas', async () => {
    const t = await tab('/bad');
    expect(await rejection(t.selfCheck())).toBeInstanceOf(RigCheckError);
  }, T);

  browserTest("frame('full') returns a 765x503 PNG", async () => {
    const t = await tab();
    expect(pngSize(await t.frame('full'))).toEqual([765, 503]);
  }, T);

  browserTest("frame('view') returns a 1024x668 PNG that is all red", async () => {
    const t = await tab();
    const png = await t.frame('view');
    expect(pngSize(png)).toEqual([1024, 668]);
    const page = await browser.newPage();
    pages.push(page);
    const b64 = Buffer.from(png).toString('base64');
    const ok = await page.evaluate(async (data: string) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      for (const [x, y] of [[0, 0], [1023, 0], [0, 667], [1023, 667], [512, 334], [100, 200], [900, 600]]) {
        const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
        if (r !== 255 || g !== 0 || b !== 0) return false;
      }
      return true;
    }, b64);
    expect(ok).toBe(true);
  }, T);

  browserTest('frame does not change the game canvas', async () => {
    const t = await tab();
    await t.frame('view');
    const px = await (await gamePage()).evaluate(() => {
      const c = document.getElementById('canvas') as HTMLCanvasElement;
      return Array.from(c.getContext('2d')!.getImageData(0, 0, 1, 1).data);
    });
    expect(px).toEqual([0, 0, 0, 255]);
  }, T);

  browserTest('frame rejects with TabNotReadyError when the page has no canvas', async () => {
    const t = await tab('/nocanvas');
    const start = Date.now();
    expect(await rejection(t.frame('full'))).toBeInstanceOf(TabNotReadyError);
    expect(Date.now() - start).toBeLessThan(6000);
  }, T);

  browserTest('inGame needs gameClient.ingame and a loaded map (sceneState 2)', async () => {
    const t = await tab();
    expect(await t.inGame()).toBe(true);
    const found = await gamePage();
    await found.evaluate(() => { (window as any).gameClient.sceneState = 1; });
    expect(await t.inGame()).toBe(false);
    await found.evaluate(() => { delete (window as any).gameClient.sceneState; });
    expect(await t.inGame()).toBe(false);
    await found.evaluate(() => { (window as any).gameClient.sceneState = 2; (window as any).gameClient.ingame = false; });
    expect(await t.inGame()).toBe(false);
    await found.evaluate(() => { delete (window as any).gameClient; });
    expect(await t.inGame()).toBe(false);
  }, T);

  browserTest('loginMessage joins loginMes1 and loginMes2; null without a client', async () => {
    const t = await tab();
    expect(await t.loginMessage()).toBe('Enter your username & password.');
    const found = await gamePage();
    await found.evaluate(() => { const gc = (window as any).gameClient; gc.loginMes1 = 'Invalid username or password.'; gc.loginMes2 = 7; });
    expect(await t.loginMessage()).toBe('Invalid username or password.');
    await found.evaluate(() => { delete (window as any).gameClient; });
    expect(await t.loginMessage()).toBeNull();
  }, T);

  browserTest('deferLogin opens the tab without the login URL; reload logs in', async () => {
    const t = await openGameTab({ browser, botPageUrl: `${base}/bot`, account: 'abc124', password: PASSWORD, fps: 15, deferLogin: true });
    tabs.push(t);
    expect((await browser.pages()).some(p => p.url().includes('bot=abc124'))).toBe(false);
    await t.reload();
    expect((await browser.pages()).some(p => p.url().includes('bot=abc124'))).toBe(true);
  }, T);

  browserTest('keepAlive raises gameClient.idleTimer', async () => {
    const t = await tab();
    await t.keepAlive();
    const found = await gamePage();
    const v = await found.evaluate(() => (window as any).gameClient.idleTimer as number);
    expect(v).toBeGreaterThan(0);
  }, T);

  browserTest('a POST to /api/screenshot is blocked', async () => {
    await tab();
    const found = await gamePage();
    const before = seen.filter(s => s === 'POST /api/screenshot').length;
    const outcome = await found.evaluate(async () => {
      try {
        await fetch('/api/screenshot', { method: 'POST', body: 'x' });
        return 'sent';
      } catch {
        return 'blocked';
      }
    });
    expect(outcome).toBe('blocked');
    expect(seen.filter(s => s === 'POST /api/screenshot').length).toBe(before);
  }, T);

  browserTest('frame during a reload resolves with a PNG or rejects with TabNotReadyError', async () => {
    const t = await tab();
    const start = Date.now();
    const reloading = t.reload();
    const outcome: unknown = await t.frame('full').then(png => ({ png }), (e: unknown) => e);
    await reloading;
    expect(Date.now() - start).toBeLessThan(6000);
    if (outcome instanceof Error) {
      expect(outcome).toBeInstanceOf(TabNotReadyError);
    } else {
      expect(pngSize((outcome as { png: Uint8Array }).png)).toEqual([765, 503]);
    }
  }, T);

  describe('navigation failure', () => {
    const SECRET = 'p&w sekret';
    const closedPort = async () => {
      const s = Bun.serve({ port: 0, fetch: () => new Response('x') });
      const port = s.port as number;
      await s.stop(true);
      return port;
    };
    const open = async (port: number) =>
      openGameTab({ browser, botPageUrl: `http://127.0.0.1:${port}/bot`, account: 'abc123', password: SECRET, fps: 15 });
    const leaks = (err: unknown) => {
      const e = err as Error & { cause?: unknown };
      const text = [String(err), e.message, e.stack ?? '', e.cause ? JSON.stringify(e.cause) : ''].join(' ');
      return text.includes(SECRET) || text.includes(encodeURIComponent(SECRET));
    };

    browserTest('openGameTab rejects without the password in the error and leaks no page', async () => {
      const port = await closedPort();
      const before = (await browser.pages()).length;
      const err = await rejection(open(port));
      expect(err).toBeInstanceOf(TabNotReadyError);
      expect(leaks(err)).toBe(false);
      expect((await browser.pages()).length).toBe(before);
    }, T);

    browserTest('reload rejects without the password in the error', async () => {
      const own = Bun.serve({
        port: 0,
        fetch: () => new Response(Bun.file(FIXTURE), { headers: { 'content-type': 'text/html' } }),
      });
      const t = await open(own.port as number);
      tabs.push(t);
      await own.stop(true);
      const err = await rejection(t.reload());
      expect(err).toBeInstanceOf(TabNotReadyError);
      expect(leaks(err)).toBe(false);
    }, T);
  });

  browserTest('the password is not in the browser process arguments', () => {
    expect(browser.process()!.spawnargs.join(' ')).not.toContain(PASSWORD);
  });
});

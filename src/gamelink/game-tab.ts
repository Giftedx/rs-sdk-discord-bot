import { existsSync } from 'node:fs';
import puppeteer, { type Browser, type LaunchOptions, type Page } from 'puppeteer';
import { parseChromePath } from '../shared/config';

export const CHROMIUM_ARGS: readonly string[] = [
  '--mute-audio',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-component-update',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  // No crash dumps: a dump of the renderer can hold the password of the login page.
  '--disable-crash-reporter',
  '--disable-breakpad',
];

export type FrameMode = 'view' | 'full';

export class TabNotReadyError extends Error {}
export class RigCheckError extends Error {}

export interface GameTabOptions {
  browser: Browser;
  botPageUrl: string;
  account: string;
  password: string;
  fps: number;
}

export interface GameTab {
  selfCheck(): Promise<void>;
  inGame(): Promise<boolean>;
  frame(mode: FrameMode): Promise<Uint8Array>;
  keepAlive(): Promise<void>;
  reload(): Promise<void>;
  // Clicks the logout button of the client until the page is out of the game. True when it left.
  logout(deadlineMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

// The logout button of the client. The click sets logoutTimer first: 250 is the value that the
// client itself sets before its idle logout.
const LOGOUT_COMPONENT = 2458;
const LOGOUT_TIMER = 250;

const CANVAS_WIDTH = 765;
const CANVAS_HEIGHT = 503;
const CANVAS_WAIT_MS = 4_500;

// Environment variables that hold secrets. The allow list below never passes them.
export const SECRET_ENV_NAMES: readonly string[] = ['RS_PASSWORD', 'DISCORD_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

// The only variables of the current environment that the browser gets.
export const BROWSER_ENV_ALLOW: readonly string[] = [
  'PATH', 'HOME', 'TMPDIR', 'TZ', 'LANG', 'LANGUAGE',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'FONTCONFIG_PATH',
];

function allowedEnvName(name: string): boolean {
  if (SECRET_ENV_NAMES.includes(name)) return false;
  return BROWSER_ENV_ALLOW.includes(name) || name.startsWith('LC_');
}

// The browser environment: an allow list of the current environment, and the
// accessibility bridge and the D-Bus session bus off. Without the last two, Chromium
// makes the user's systemd start dbus-daemon and at-spi-bus-launcher, which
// stay after the browser stops.
export function browserLaunchEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && allowedEnvName(k)) env[k] = v;
  }
  env.NO_AT_BRIDGE = '1';
  env.DBUS_SESSION_BUS_ADDRESS = 'disabled:';
  return env;
}

export class ChromePathError extends Error {}

export interface BrowserLaunchOpts {
  userDataDir?: string;
  // The Chrome binary. When absent, RS_CHROME_PATH gives it; when both are absent, puppeteer picks its default.
  executablePath?: string;
}

export interface BrowserLaunchDeps {
  env: Record<string, string | undefined>;
  fileExists: (path: string) => boolean;
}

// The puppeteer launch options. A Chrome path that is set but has no file is an error:
// on the server, a fallback to the default copy would start a Chrome that the AppArmor profile does not cover.
export function browserLaunchOptions(
  opts: BrowserLaunchOpts = {},
  deps: BrowserLaunchDeps = { env: process.env, fileExists: existsSync },
): LaunchOptions {
  let executablePath: string | null;
  try {
    executablePath = parseChromePath(opts.executablePath ?? deps.env.RS_CHROME_PATH);
  } catch (err) {
    throw new ChromePathError(err instanceof Error ? err.message : String(err));
  }
  if (executablePath !== null && !deps.fileExists(executablePath)) {
    throw new ChromePathError(`The Chrome binary ${executablePath} (RS_CHROME_PATH) does not exist.`);
  }
  return {
    headless: true,
    // DevTools over a pipe, not a loopback port: code of a job cannot connect to the browser.
    pipe: true,
    args: [...CHROMIUM_ARGS],
    env: browserLaunchEnv(deps.env),
    ...(opts.userDataDir ? { userDataDir: opts.userDataDir } : {}),
    ...(executablePath !== null ? { executablePath } : {}),
  };
}

export function launchBrowser(opts: BrowserLaunchOpts = {}): Promise<Browser> {
  return puppeteer.launch(browserLaunchOptions(opts));
}

export function buildBotUrl(botPageUrl: string, account: string, password: string, fps: number): string {
  const e = encodeURIComponent;
  return `${botPageUrl}?bot=${e(account)}&password=${e(password)}&fps=${e(String(fps))}&minimal`;
}

function isScreenshotPost(method: string, url: string): boolean {
  if (method !== 'POST') return false;
  try {
    return new URL(url).pathname === '/api/screenshot';
  } catch {
    return false;
  }
}

const FRAME_DEADLINE_MS = 5_000;

// The navigation URL holds the password. Build the error text from the page
// URL without query and the Chromium error code only, and attach no cause.
async function gotoRedacted(page: Page, botPageUrl: string, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    const code = /net::ERR_[A-Z_]+/.exec(err instanceof Error ? err.message : '')?.[0] ?? 'navigation error';
    throw new TabNotReadyError(`navigation to ${botPageUrl} failed: ${code}`);
  }
}

export async function openGameTab(opts: GameTabOptions): Promise<GameTab> {
  const page: Page = await opts.browser.newPage();
  const url = buildBotUrl(opts.botPageUrl, opts.account, opts.password, opts.fps);
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (req.isInterceptResolutionHandled()) return;
      if (isScreenshotPost(req.method(), req.url())) {
        void req.abort('blockedbyclient').catch(() => {});
      } else {
        void req.continue().catch(() => {});
      }
    });
    await page.goto('about:blank');
    await gotoRedacted(page, opts.botPageUrl, url);
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }

  async function waitForCanvas(): Promise<void> {
    try {
      await page.waitForSelector('#canvas', { timeout: CANVAS_WAIT_MS });
    } catch {
      throw new TabNotReadyError('The page has no canvas with the ID "canvas".');
    }
  }

  return {
    async selfCheck() {
      const size = await page.evaluate(() => {
        const c = document.getElementById('canvas');
        return c instanceof HTMLCanvasElement ? { w: c.width, h: c.height } : null;
      });
      if (!size || size.w !== CANVAS_WIDTH || size.h !== CANVAS_HEIGHT) {
        throw new RigCheckError(
          `The canvas must be #canvas at ${CANVAS_WIDTH}x${CANVAS_HEIGHT}. Found: ${size ? `${size.w}x${size.h}` : 'none'}.`,
        );
      }
    },

    async inGame() {
      return page.evaluate(() => {
        const gc = (window as unknown as { gameClient?: { ingame?: unknown } }).gameClient;
        return gc?.ingame === true;
      });
    },

    async frame(mode) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new TabNotReadyError('The frame did not finish in time.')),
          FRAME_DEADLINE_MS,
        );
      });
      const work = capture(mode);
      work.catch(() => {});
      try {
        return await Promise.race([work, deadline]);
      } finally {
        clearTimeout(timer);
      }
    },

    // Resets the idle timer of the client, so that a waiting account stays logged in.
    // Use it on a game server that you run, or with the agreement of the person who runs it.
    async keepAlive() {
      await page.evaluate(() => {
        const gc = (window as unknown as { gameClient?: { idleTimer?: unknown } }).gameClient;
        if (gc && typeof gc.idleTimer === 'number') gc.idleTimer = performance.now();
      });
    },

    async reload() {
      await gotoRedacted(page, opts.botPageUrl, url);
    },

    async logout(deadlineMs = 15_000) {
      const click = () => page.evaluate((timer: number, component: number) => {
        const gc = (window as unknown as { gameClient?: { logoutTimer?: unknown; clickComponent?: unknown } }).gameClient;
        if (!gc || typeof gc.clickComponent !== 'function') return false;
        gc.logoutTimer = timer;
        (gc.clickComponent as (id: number) => unknown).call(gc, component);
        return true;
      }, LOGOUT_TIMER, LOGOUT_COMPONENT).catch(() => false);
      const inGame = () => page.evaluate(() =>
        (window as unknown as { gameClient?: { ingame?: unknown } }).gameClient?.ingame === true).catch(() => false);
      const start = Date.now();
      let lastClick = 0;
      while (Date.now() - start < deadlineMs) {
        if (!(await inGame())) return true;
        if (Date.now() - lastClick >= 2_500) { await click(); lastClick = Date.now(); }
        await new Promise(r => setTimeout(r, 250));
      }
      return !(await inGame());
    },

    async close() {
      if (!page.isClosed()) await page.close();
    },
  };

  async function capture(mode: FrameMode): Promise<Uint8Array> {
    await waitForCanvas();
    let dataUrl: string;
    try {
      dataUrl = await page.evaluate((m: FrameMode) => {
        const src = document.getElementById('canvas') as HTMLCanvasElement;
        const out = document.createElement('canvas');
        const ctx = out.getContext('2d')!;
        if (m === 'view') {
          out.width = 1024;
          out.height = 668;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(src, 4, 4, 512, 334, 0, 0, 1024, 668);
        } else {
          out.width = src.width;
          out.height = src.height;
          ctx.drawImage(src, 0, 0);
        }
        return out.toDataURL('image/png');
      }, mode);
    } catch {
      throw new TabNotReadyError('The page changed or closed while the frame was read.');
    }
    return new Uint8Array(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  }
}

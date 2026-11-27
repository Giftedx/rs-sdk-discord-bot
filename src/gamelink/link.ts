// The interface between the bot and the game parts of one guild: game tab, supervisor, proxy,
// frame store and card tab. Two implementations: openLocalGameLink runs the parts in this process;
// connectGameLink (client.ts) talks to the gamelink process over its Unix socket (service.ts).
// The bot (src/bot/guild.ts, src/bot/main.ts) uses only this interface.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CardDataMap, CardKind } from '../cards/templates';
import type { Config } from '../shared/config';
import { launchBrowserWithProfile, sweepStaleProfiles, type ProfiledBrowser } from './browser-profile';
import { openCardTab, type CardTab } from './card-tab';
import { createFrameStore, type StoredFrame } from './frame-store';
import { openGameTab, type GameTab } from './game-tab';
import { createActionPolicy } from './policy';
import { startProxy, type ProxyHandle, type ProxyStatus } from './proxy';
import { createSupervisor, type Supervisor, type TabStatus } from './supervisor';

export interface GuildLink {
  readonly name: string;
  readonly account: string;
  // The loopback port of the proxy, and the token that the box sends to it. Not the game password.
  readonly proxyPort: number;
  readonly bootToken: string;
  tabStatus(): TabStatus;
  proxyStatus(): ProxyStatus;
  // The newest state from the state tap and the time it came, or null.
  state(): { state: unknown; at: number } | null;
  latestFrame(): StoredFrame | null;
  // The newest stored frame if it is fresh, else a new capture while the tab is in the game.
  frame(): Promise<Uint8Array | null>;
  framesActive(): boolean;
  startFrames(): void;
  stopFrames(): void;
  setJobActive(active: boolean): Promise<void>;
  // Null when there is no card tab.
  drawCard<K extends CardKind>(kind: K, data: CardDataMap[K]): Promise<Uint8Array | null>;
  logout(): Promise<boolean>;
  // In-process: log out and stop the parts. Socket client: stop polling; gamelink keeps the session.
  close(): Promise<void>;
}

export interface GameLink {
  readonly guilds: ReadonlyMap<string, GuildLink>;
  close(): Promise<void>;
}

export const FRAME_FRESH_MS = 15_000;
export const TOKEN_MIN_CHARS = 32;

// The token file holds one line. Error messages never contain the token.
export function readTokenFile(path: string, read: (p: string) => string = p => readFileSync(p, 'utf8')): string {
  let text: string;
  try {
    text = read(path);
  } catch {
    throw new Error('GAMELINK_TOKEN_FILE cannot be read');
  }
  const token = text.trim();
  if (token.length < TOKEN_MIN_CHARS || /\s/.test(token)) throw new Error(`GAMELINK_TOKEN_FILE must hold one token of at least ${TOKEN_MIN_CHARS} characters`);
  return token;
}

export interface LocalGuildSpec {
  name: string;
  game: Config;
}

export interface LocalLinkOptions {
  guilds: LocalGuildSpec[];
  idleGuard: boolean;
  cards: boolean;
  log(line: string): void;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Launches one browser for all guilds, with its profile on tmpfs, and starts the parts of each guild.
export async function openLocalGameLink(opts: LocalLinkOptions): Promise<GameLink> {
  const swept = sweepStaleProfiles();
  if (swept > 0) opts.log(`removed ${swept} browser profile(s) left by an earlier run`);
  const first = opts.guilds[0]!.game;
  const pb: ProfiledBrowser = await launchBrowserWithProfile(first.chromePath ? { executablePath: first.chromePath } : {});
  opts.log(pb.profile.onTmpfs ? 'browser profile on tmpfs' : 'WARNING: /dev/shm is missing; the browser profile is on disk');
  let cards: CardTab | null = null;
  const guilds = new Map<string, GuildLink>();
  const closeAll = async () => {
    await Promise.all([...guilds.values()].map(g => g.close().catch(err => opts.log(`[${g.name}] stop failed: ${errText(err)}`))));
    await cards?.close().catch(() => {});
    await pb.close().catch(() => {});
  };
  try {
    if (opts.cards) {
      cards = await openCardTab(pb.browser, { iconHost: new URL(first.botPageUrl).origin })
        .catch(err => { opts.log(`card tab not open, posts go without cards: ${errText(err)}`); return null; });
    }
    for (const g of opts.guilds) {
      const log = (line: string) => opts.log(`[${g.name}] ${line}`);
      log(`game server ${g.game.serverHost}, proxy port ${g.game.proxyPort}`);
      guilds.set(g.name, await startLocalGuild(pb, cards, g, opts.idleGuard, log));
    }
  } catch (err) {
    await closeAll();
    throw err;
  }
  let closed = false;
  return {
    guilds,
    async close() {
      if (closed) return;
      closed = true;
      await closeAll();
    },
  };
}

async function startLocalGuild(pb: ProfiledBrowser, cards: CardTab | null, g: LocalGuildSpec, idleGuard: boolean, log: (line: string) => void): Promise<GuildLink> {
  const bootToken = randomBytes(24).toString('base64url');
  let tab: GameTab | null = null;
  let sup: Supervisor | null = null;
  let proxy: ProxyHandle | null = null;
  let lastState: unknown = null;
  let lastStateAt = 0;

  const stopParts = async () => {
    sup?.stop();
    if (tab) {
      const out = await tab.logout().catch(() => false);
      log(out ? 'logged out of the game' : 'logout did not finish');
    }
    await proxy?.stop().catch(() => {});
    await tab?.close().catch(() => {});
  };

  try {
    tab = await openGameTab({ browser: pb.browser, botPageUrl: g.game.botPageUrl, account: g.game.account.name, password: g.game.account.password, fps: g.game.fps });
    sup = createSupervisor({ tab, idleGuard, log });
    sup.start();
    proxy = await startProxy({
      upstreamUrl: g.game.gatewayUrl,
      account: g.game.account.name,
      password: g.game.account.password,
      bootToken,
      listenPort: g.game.proxyPort,
      policy: createActionPolicy(),
      onState: (state, at) => { lastState = state; lastStateAt = at; },
      log,
    });
  } catch (err) {
    await stopParts();
    throw err;
  }
  const gameTab = tab;
  const supervisor = sup;
  const prx = proxy;
  const frames = createFrameStore({ source: gameTab, log });
  let closed = false;

  return {
    name: g.name,
    account: g.game.account.name,
    proxyPort: prx.port,
    bootToken,
    tabStatus: () => supervisor.status(),
    proxyStatus: () => prx.status(),
    state: () => (lastState === null ? null : { state: lastState, at: lastStateAt }),
    latestFrame: () => frames.latest(),
    async frame() {
      const f = frames.latest();
      if (f && Date.now() - f.at < FRAME_FRESH_MS) return f.png;
      if (supervisor.status() !== 'in_game') return f?.png ?? null;
      return gameTab.frame('view').catch(() => f?.png ?? null);
    },
    framesActive: () => frames.active,
    startFrames: () => frames.start(),
    stopFrames: () => frames.stop(),
    async setJobActive(active) { prx.setJobActive(active); },
    async drawCard(kind, data) {
      if (!cards) return null;
      return cards.draw(kind, data);
    },
    async logout() {
      supervisor.stop();
      return gameTab.logout().catch(() => false);
    },
    async close() {
      if (closed) return;
      closed = true;
      frames.stop();
      await stopParts();
    },
  };
}

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
import { createFrameStore, type FrameStore, type StoredFrame } from './frame-store';
import { openGameTab, type GameTab } from './game-tab';
import { createActionPolicy } from './policy';
import { startProxy, type ProxyHandle, type ProxyStatus } from './proxy';
import { reloginDelayMs } from './relogin';
import { createSupervisor, nextFirstLoginAt, type Supervisor, type TabStatus } from './supervisor';

export interface GuildLink {
  readonly name: string;
  readonly account: string;
  // The loopback port of the proxy, and the token that the box sends to it. Not the game password.
  readonly proxyPort: number;
  readonly bootToken: string;
  tabStatus(): TabStatus;
  // The last login message of the client while out of the game (why a login failed), or null.
  tabReason(): string | null;
  proxyStatus(): ProxyStatus;
  // The newest state from the state tap and the time it came, or null.
  state(): { state: unknown; at: number } | null;
  latestFrame(): StoredFrame | null;
  // The newest stored frame if it is fresh, else a new capture while the tab is in the game.
  frame(): Promise<Uint8Array | null>;
  // A PNG of the game view around the player, at 2x with sharp pixels; null out of the game.
  portrait(): Promise<Uint8Array | null>;
  framesActive(): boolean;
  startFrames(): void;
  stopFrames(): void;
  setJobActive(active: boolean): Promise<void>;
  // Actions sent to the game whose result has not come yet.
  actionsInFlight(): number;
  // True when no action is in flight within timeoutMs (capped at 30 s). For the end of a job.
  waitIdle(timeoutMs: number): Promise<boolean>;
  // Null when there is no card tab.
  // withFrame: the receipt card shows the game view, from frame().
  drawCard<K extends CardKind>(kind: K, data: CardDataMap[K], opts?: { withFrame?: boolean }): Promise<Uint8Array | null>;
  logout(): Promise<boolean>;
  // In-process: log out and stop the parts. Socket client: stop polling; gamelink keeps the session.
  close(): Promise<void>;
}

export interface GameLink {
  readonly guilds: ReadonlyMap<string, GuildLink>;
  close(): Promise<void>;
}

// The in-process link adds the operator actions of gamelink/main.ts (signals, not Discord).
export interface LocalGuildLink extends GuildLink {
  // Logs the tab out, then a new supervisor logs it in after reloginDelayMs (SIGHUP).
  relog(): Promise<boolean>;
  // Drops the gateway socket of the proxy and connects again (SIGUSR1).
  reconnectProxy(): void;
}

export interface LocalGameLink extends GameLink {
  readonly guilds: ReadonlyMap<string, LocalGuildLink>;
}

/** SIGHUP: every tab logs out and logs in again. One failing guild does not stop the others. */
export async function relogAll(link: LocalGameLink, log: (line: string) => void): Promise<void> {
  await Promise.all([...link.guilds.values()].map(async g => {
    const out = await g.relog().catch(err => { log(`[${g.name}] relog failed: ${errText(err)}`); return false; });
    log(`[${g.name}] ${out ? 'logged out; the login follows' : 'logout did not finish; the login follows'}`);
  }));
}

/** SIGUSR1: every proxy drops its gateway socket and connects again. */
export function reconnectAll(link: LocalGameLink, log: (line: string) => void): void {
  for (const g of link.guilds.values()) {
    try { g.reconnectProxy(); } catch (err) { log(`[${g.name}] proxy reconnect failed: ${errText(err)}`); }
  }
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
  // The wait before the first login of each tab. Default reloginDelayMs: 20 to 30 s.
  startDelay?: () => number;
  // Called when the browser stops by itself (a crash, an OOM kill). Every tab is then dead, so
  // the caller exits and systemd starts a new browser.
  onBrowserGone?: () => void;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Launches one browser for all guilds, with its profile on tmpfs, and starts the parts of each guild.
export async function openLocalGameLink(opts: LocalLinkOptions): Promise<LocalGameLink> {
  const swept = sweepStaleProfiles();
  if (swept > 0) opts.log(`removed ${swept} browser profile(s) left by an earlier run`);
  const first = opts.guilds[0]!.game;
  const pb: ProfiledBrowser = await launchBrowserWithProfile(first.chromePath ? { executablePath: first.chromePath } : {});
  opts.log(pb.profile.onTmpfs ? 'browser profile on tmpfs' : 'WARNING: /dev/shm is missing; the browser profile is on disk');
  pb.onGone(() => { opts.log('the browser stopped by itself'); opts.onBrowserGone?.(); });
  let cards: CardTab | null = null;
  const guilds = new Map<string, LocalGuildLink>();
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
    const startDelay = opts.startDelay ?? (() => reloginDelayMs());
    let prevLoginAt: number | null = null;
    for (const g of opts.guilds) {
      const log = (line: string) => opts.log(`[${g.name}] ${line}`);
      const loginAt: number = nextFirstLoginAt(prevLoginAt, Date.now(), startDelay());
      prevLoginAt = loginAt;
      log(`game server ${g.game.serverHost}, proxy port ${g.game.proxyPort}, first login in ${Math.round((loginAt - Date.now()) / 1000)} s`);
      guilds.set(g.name, await startLocalGuild(pb, cards, g, opts.idleGuard, loginAt, log));
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

async function startLocalGuild(pb: ProfiledBrowser, cards: CardTab | null, g: LocalGuildSpec, idleGuard: boolean, firstLoginAt: number, log: (line: string) => void): Promise<LocalGuildLink> {
  const bootToken = randomBytes(24).toString('base64url');
  let tab: GameTab | null = null;
  let sup: Supervisor | null = null;
  let proxy: ProxyHandle | null = null;
  let lastState: unknown = null;
  let lastStateAt = 0;
  let frames: FrameStore | null = null;
  let newSupervisor: ((startDelayMs: number) => Supervisor) | null = null;

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
    tab = await openGameTab({ browser: pb.browser, botPageUrl: g.game.botPageUrl, account: g.game.account.name, password: g.game.account.password, fps: g.game.fps, deferLogin: true });
    // The source checks that the tab is still in the game after each capture.
    frames = createFrameStore({ source: tab, log });
    const store = frames;
    const t = tab;
    newSupervisor = (startDelayMs: number) => createSupervisor({
      tab: t, idleGuard, log, startDelayMs,
      // The rig check runs once, after the first login; a failure turns frames off for this tab.
      onInGame: () => { void store.checkRig(); },
    });
    sup = newSupervisor(Math.max(0, firstLoginAt - Date.now()));
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
  let supervisor = sup;
  const makeSupervisor = newSupervisor!;
  const prx = proxy;
  const store = frames!;
  let closed = false;

  async function frame(): Promise<Uint8Array | null> {
    const f = store.latest();
    if (f && Date.now() - f.at < FRAME_FRESH_MS) return f.png;
    if (supervisor.status() !== 'in_game' || store.disabled) return f?.png ?? null;
    return gameTab.frame('view').catch(() => f?.png ?? null);
  }

  return {
    name: g.name,
    account: g.game.account.name,
    proxyPort: prx.port,
    bootToken,
    tabStatus: () => supervisor.status(),
    tabReason: () => supervisor.reason(),
    proxyStatus: () => prx.status(),
    state: () => (lastState === null ? null : { state: lastState, at: lastStateAt }),
    latestFrame: () => store.latest(),
    frame,
    async portrait() {
      if (supervisor.status() !== 'in_game') return null;
      return gameTab.frame('portrait').catch(() => null);
    },
    framesActive: () => store.active,
    startFrames: () => store.start(),
    stopFrames: () => store.stop(),
    async setJobActive(active) { prx.setJobActive(active); },
    actionsInFlight: () => prx.actionsInFlight(),
    waitIdle: timeoutMs => prx.waitIdle(timeoutMs),
    async drawCard(kind, data, opts) {
      if (!cards) return null;
      const view = opts?.withFrame ? await frame().catch(() => null) : null;
      return cards.draw(kind, data, view);
    },
    async logout() {
      supervisor.stop();
      return gameTab.logout().catch(() => false);
    },
    async relog() {
      if (closed) return false;
      supervisor.stop();
      const out = await gameTab.logout().catch(() => false);
      if (closed) return out;
      // A new supervisor also clears a refused login; its first login waits reloginDelayMs.
      supervisor = makeSupervisor(reloginDelayMs());
      sup = supervisor;
      supervisor.start();
      return out;
    },
    reconnectProxy: () => prx.reconnect(),
    async close() {
      if (closed) return;
      closed = true;
      store.stop();
      await stopParts();
    },
  };
}

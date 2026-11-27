// The bot side of the gamelink socket (service.ts). It implements GuildLink, so guild.ts does not
// know which side runs the game parts. Status and state are polled and kept in a cache, so the
// sync getters of GuildLink answer at once.
import type { CardDataMap, CardKind } from '../cards/templates';
import type { StoredFrame } from './frame-store';
import type { GameLink, GuildLink } from './link';
import { WAIT_IDLE_CAP_MS, type ProxyStatus } from './proxy';
import type { StatusBody } from './service';
import type { TabStatus } from './supervisor';

export interface ClientOptions {
  socketPath: string;
  token: string;
  // The guild names and the account that the bot expects for each.
  guilds: { name: string; account: string }[];
  pollMs?: number;            // default 2000
  // After this long with no answer, the link reports the tab as out of the game.
  staleMs?: number;           // default 10_000
  requestTimeoutMs?: number;  // default 15_000
  log?: (line: string) => void;
}

export class GameLinkError extends Error {}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function requester(opts: ClientOptions) {
  const timeoutMs = opts.requestTimeoutMs ?? 15_000;
  return async (method: 'GET' | 'POST', path: string, body?: unknown, timeoutOverrideMs?: number): Promise<Response> => {
    const res = await fetch(`http://gamelink${path}`, {
      method,
      unix: opts.socketPath,
      headers: { authorization: `Bearer ${opts.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutOverrideMs ?? timeoutMs),
    } as RequestInit);
    if (res.status === 401) throw new GameLinkError('gamelink refused the token');
    if (res.status >= 400) {
      const text = await res.text().catch(() => '');
      throw new GameLinkError(`gamelink ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return res;
  };
}

const bytesOf = async (res: Response): Promise<Uint8Array | null> => (res.status === 204 ? null : new Uint8Array(await res.arrayBuffer()));

async function connectGuild(opts: ClientOptions, name: string, account: string): Promise<GuildLink> {
  const req = requester(opts);
  const log = (line: string) => opts.log?.(`[${name}] ${line}`);
  const base = `/guilds/${name}`;
  const pollMs = opts.pollMs ?? 2_000;
  const staleMs = opts.staleMs ?? 10_000;

  const first = await (await req('GET', `${base}/status`)).json() as StatusBody;
  if (first.account !== account) throw new GameLinkError(`gamelink serves another account for guild ${name}`);
  // A bot that crashed during a job left the flag on in gamelink. No job runs at connect.
  await req('POST', `${base}/job`, { active: false });
  let status = first;
  let statusAt = Date.now();
  let state: { state: unknown; at: number } | null = null;
  let stored: StoredFrame | null = null;
  let framesWanted = first.framesActive;
  let failing = false;
  let closed = false;

  async function poll(): Promise<void> {
    try {
      status = await (await req('GET', `${base}/status`)).json() as StatusBody;
      statusAt = Date.now();
      const s = await (await req('GET', `${base}/state`)).json() as { state: unknown; ageMs: number | null };
      state = s.state === null || s.ageMs === null ? null : { state: s.state, at: Date.now() - s.ageMs };
      if (status.frameAt !== null && status.frameAt !== stored?.at) {
        const png = await bytesOf(await req('GET', `${base}/frame?stored=1`));
        stored = png ? { at: status.frameAt, png } : null;
      }
      if (failing) log('gamelink answers again');
      failing = false;
    } catch (err) {
      if (!failing) log(`gamelink poll failed: ${errText(err)}`);
      failing = true;
    }
  }
  await poll();
  let busy = false;
  const timer = setInterval(() => {
    if (busy || closed) return;
    busy = true;
    void poll().finally(() => { busy = false; });
  }, pollMs);

  const stale = () => Date.now() - statusAt > staleMs;
  const post = (path: string, body?: unknown) => req('POST', `${base}/${path}`, body ?? {});

  return {
    name,
    account,
    // From the newest status: a restart of gamelink makes a new boot token.
    get proxyPort() { return status.proxyPort; },
    get bootToken() { return status.bootToken; },
    tabStatus: (): TabStatus => (stale() ? 'out_of_game' : status.tab),
    tabReason: () => (stale() ? 'gamelink does not answer' : status.tabReason ?? null),
    // From the cache: a stale status counts as idle, since no answer of gamelink can come.
    actionsInFlight: () => (stale() ? 0 : status.actionsInFlight ?? 0),
    async waitIdle(timeoutMs) {
      const ms = Math.min(Math.max(0, timeoutMs), WAIT_IDLE_CAP_MS);
      try {
        const r = await (await req('POST', `${base}/idle`, { timeoutMs: ms }, ms + 5_000)).json() as { idle?: unknown };
        return r.idle === true;
      } catch (err) {
        log(`idle wait failed: ${errText(err)}`);
        return false;
      }
    },
    proxyStatus: (): ProxyStatus => (stale() ? { connected: false, lastError: 'gamelink does not answer', reconnects: status.proxy.reconnects } : status.proxy),
    state: () => state,
    latestFrame: () => stored,
    async frame() {
      try {
        return await bytesOf(await req('GET', `${base}/frame`));
      } catch (err) {
        log(`frame failed: ${errText(err)}`);
        return stored?.png ?? null;
      }
    },
    framesActive: () => framesWanted,
    startFrames() {
      framesWanted = true;
      void post('frames/start').catch(err => log(`frames start failed: ${errText(err)}`));
    },
    stopFrames() {
      framesWanted = false;
      void post('frames/stop').catch(err => log(`frames stop failed: ${errText(err)}`));
    },
    // The job flag must turn off after a job. Try three times, 1 s apart; then the error goes to
    // the caller.
    async setJobActive(active) {
      let last: unknown;
      for (let i = 0; i < (active ? 1 : 3); i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 1_000));
        try {
          await post('job', { active });
          return;
        } catch (err) {
          last = err;
        }
      }
      throw last;
    },
    async drawCard<K extends CardKind>(kind: K, data: CardDataMap[K]) {
      return bytesOf(await post('card', { kind, data }));
    },
    async logout() {
      const r = await (await post('logout')).json() as { ok?: unknown };
      return r.ok === true;
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await post('job', { active: false }).catch(() => {});
      await post('frames/stop').catch(() => {});
    },
  };
}

export async function connectGameLink(opts: ClientOptions): Promise<GameLink> {
  const guilds = new Map<string, GuildLink>();
  try {
    for (const g of opts.guilds) guilds.set(g.name, await connectGuild(opts, g.name, g.account));
  } catch (err) {
    await Promise.all([...guilds.values()].map(g => g.close()));
    throw err;
  }
  return {
    guilds,
    async close() {
      await Promise.all([...guilds.values()].map(g => g.close()));
    },
  };
}

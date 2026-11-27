// The local interface of the gamelink process: HTTP and JSON on a Unix socket (docs/design.md 5.2).
// Every request must carry `authorization: Bearer <token>`. The token comes from a file that only
// the gamelink user and the bot user can read. Routes, per guild name:
//   GET  /guilds/:name/status         tab, tab reason, proxy, in game, frames, actions in flight, proxy port, boot token
//   GET  /guilds/:name/state          newest raw state and its age in ms
//   GET  /guilds/:name/frame          PNG: newest fresh frame or a new capture (?stored=1: stored only)
//   GET  /guilds/:name/portrait       PNG: the game view around the player at 2x; 204 out of the game
//   POST /guilds/:name/frames/start   POST /guilds/:name/frames/stop
//   POST /guilds/:name/job            {"active": boolean}: the job flag of the proxy
//   POST /guilds/:name/card           {"kind", "data"}: PNG of a drawn card
//   POST /guilds/:name/idle           {"timeoutMs": number}: {"idle": boolean} when no action is in flight (max 30 s)
//   POST /guilds/:name/logout
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CardDataError, isCardKind, type CardDataMap, type CardKind } from '../cards/templates';
import type { GameLink, GuildLink } from './link';
import { WAIT_IDLE_CAP_MS } from './proxy';

export interface ServiceOptions {
  link: GameLink;
  socketPath: string;
  token: string;
  log?: (line: string) => void;
  // Default 0o660: the owner and the shared group.
  socketMode?: number;
}

export interface ServiceHandle {
  stop(): Promise<void>;
}

export interface StatusBody {
  account: string;
  proxyPort: number;
  bootToken: string;
  tab: ReturnType<GuildLink['tabStatus']>;
  tabReason: string | null;
  actionsInFlight: number;
  proxy: ReturnType<GuildLink['proxyStatus']>;
  inGame: boolean;
  framesActive: boolean;
  frameAt: number | null;
}

const MAX_BODY_BYTES = 1024 * 1024;

export class LockError extends Error {}

export interface LockDeps {
  pid: number;
  // True when a process with this pid runs.
  alive(pid: number): boolean;
  // Creates the file only when it does not exist; throws an error with code EEXIST otherwise.
  create(path: string, text: string): void;
  read(path: string): string;
  remove(path: string): void;
}

const defaultLockDeps = (): LockDeps => ({
  pid: process.pid,
  alive(pid) {
    try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
  },
  create: (path, text) => writeFileSync(path, text, { flag: 'wx', mode: 0o600 }),
  read: path => readFileSync(path, 'utf8'),
  remove: path => rmSync(path, { force: true }),
});

/** The lock file of gamelink, beside its socket. */
export const lockPathFor = (socketPath: string) => join(dirname(socketPath), 'gamelink.lock');

/** Takes the lock file, so that a second gamelink refuses to start. A lock whose pid does not run
 *  is stale and is taken over. Returns the release function. */
export function acquireLock(path: string, deps: LockDeps = defaultLockDeps()): () => void {
  for (let i = 0; i < 2; i++) {
    try {
      deps.create(path, `${deps.pid}\n`);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { if (deps.read(path).trim() === String(deps.pid)) deps.remove(path); } catch { /* already gone */ }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let text = '';
    try { text = deps.read(path).trim(); } catch { /* removed meanwhile */ }
    const pid = /^\d+$/.test(text) ? Number(text) : NaN;
    if (Number.isInteger(pid) && pid > 0 && pid !== deps.pid && deps.alive(pid)) {
      throw new LockError(`another gamelink runs (pid ${pid}, lock ${path})`);
    }
    deps.remove(path);
  }
  throw new LockError(`the lock ${path} cannot be taken`);
}
const digest = (s: string) => createHash('sha256').update(s).digest();

export function checkAuth(header: string | null, tokenDigest: Buffer): boolean {
  if (!header || !header.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(header.slice(7)), tokenDigest);
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const png = (bytes: Uint8Array) => new Response(bytes as unknown as BodyInit, { headers: { 'content-type': 'image/png' } });
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function statusBody(g: GuildLink): StatusBody {
  const tab = g.tabStatus();
  return {
    account: g.account,
    proxyPort: g.proxyPort,
    bootToken: g.bootToken,
    tab,
    tabReason: g.tabReason(),
    actionsInFlight: g.actionsInFlight(),
    proxy: g.proxyStatus(),
    inGame: tab === 'in_game',
    framesActive: g.framesActive(),
    frameAt: g.latestFrame()?.at ?? null,
  };
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

async function route(link: GameLink, req: Request, log: (line: string) => void): Promise<Response> {
  const url = new URL(req.url);
  const m = /^\/guilds\/([a-z0-9_-]{1,32})\/([a-z/]+)$/.exec(url.pathname);
  if (!m) return json({ error: 'not found' }, 404);
  const g = link.guilds.get(m[1]!);
  if (!g) return json({ error: 'unknown guild' }, 404);
  const what = `${req.method} ${m[2]}`;
  switch (what) {
    case 'GET status':
      return json(statusBody(g));
    case 'GET state': {
      const s = g.state();
      return json(s ? { state: s.state, ageMs: Math.max(0, Date.now() - s.at) } : { state: null, ageMs: null });
    }
    case 'GET frame': {
      const bytes = url.searchParams.get('stored') === '1' ? g.latestFrame()?.png ?? null : await g.frame();
      return bytes ? png(bytes) : new Response(null, { status: 204 });
    }
    case 'GET portrait': {
      const bytes = await g.portrait();
      return bytes ? png(bytes) : new Response(null, { status: 204 });
    }
    case 'POST frames/start':
      g.startFrames();
      return json({ ok: true });
    case 'POST frames/stop':
      g.stopFrames();
      return json({ ok: true });
    case 'POST job': {
      const body = await readJson(req) as { active?: unknown } | undefined;
      if (typeof body?.active !== 'boolean') return json({ error: 'active must be a boolean' }, 400);
      await g.setJobActive(body.active);
      return json({ ok: true });
    }
    case 'POST card': {
      const body = await readJson(req) as { kind?: unknown; data?: unknown } | undefined;
      if (!isCardKind(body?.kind)) return json({ error: 'unknown card kind' }, 400);
      try {
        const bytes = await g.drawCard(body.kind as CardKind, body.data as CardDataMap[CardKind]);
        return bytes ? png(bytes) : new Response(null, { status: 204 });
      } catch (err) {
        if (err instanceof CardDataError) return json({ error: err.message }, 400);
        log(`[${g.name}] card not drawn: ${errText(err)}`);
        return json({ error: 'card not drawn' }, 500);
      }
    }
    case 'POST idle': {
      const body = await readJson(req) as { timeoutMs?: unknown } | undefined;
      const ms = body?.timeoutMs;
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return json({ error: 'timeoutMs must be a number of 0 or more' }, 400);
      return json({ idle: await g.waitIdle(Math.min(ms, WAIT_IDLE_CAP_MS)) });
    }
    case 'POST logout':
      return json({ ok: await g.logout() });
    default:
      return json({ error: 'not found' }, 404);
  }
}

export function serveGameLink(opts: ServiceOptions): ServiceHandle {
  const log = opts.log ?? (() => {});
  const tokenDigest = digest(opts.token);
  // A socket file left by an earlier run blocks the listen. Remove only a socket, never a file.
  if (existsSync(opts.socketPath) && lstatSync(opts.socketPath).isSocket()) rmSync(opts.socketPath);
  const server = Bun.serve({
    unix: opts.socketPath,
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(req) {
      if (!checkAuth(req.headers.get('authorization'), tokenDigest)) return json({ error: 'unauthorized' }, 401);
      try {
        return await route(opts.link, req, log);
      } catch (err) {
        log(`request failed: ${errText(err)}`);
        return json({ error: 'internal error' }, 500);
      }
    },
  });
  try {
    chmodSync(opts.socketPath, opts.socketMode ?? 0o660);
  } catch (err) {
    // Windows has no Unix modes on a socket file. On Linux a failed chmod is fatal.
    if (process.platform !== 'win32') {
      void server.stop(true);
      throw err;
    }
  }
  return {
    async stop() {
      await server.stop(true);
      rmSync(opts.socketPath, { force: true });
    },
  };
}

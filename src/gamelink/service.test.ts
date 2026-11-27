import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBotConfig, loadGameConfig } from '../bot/config';
import { CARD_FRAME_MAX_BYTES, CardDataError } from '../cards/templates';
import { connectGameLink } from './client';
import { readTokenFile, reconnectAll, relogAll, type GameLink, type GuildLink, type LocalGameLink, type LocalGuildLink } from './link';
import { LockError, SERVICE_IDLE_TIMEOUT_S, acquireLock, lockPathFor, serveGameLink, type LockDeps, type ServiceHandle } from './service';

const TOKEN = 'a'.repeat(40);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PORTRAIT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]);

function fakeGuild() {
  const calls: string[] = [];
  let framesOn = false;
  const g: GuildLink = {
    name: 'main', account: 'abc', proxyPort: 7790, bootToken: 'boot-token-xyz',
    tabStatus: () => 'in_game',
    tabReason: () => 'Connecting to server...',
    actionsInFlight: () => 2,
    waitIdle: async ms => { calls.push(`idle:${ms}`); return ms > 0; },
    proxyStatus: () => ({ connected: true, lastError: null, reconnects: 0, gateway: 'direct' }),
    state: () => ({ state: { player: { hp: 7 } }, at: Date.now() - 1_000 }),
    latestFrame: () => ({ at: 1234, png: PNG }),
    frame: async () => PNG,
    portrait: async () => { calls.push('portrait'); return PORTRAIT; },
    framesActive: () => framesOn,
    startFrames: () => { framesOn = true; calls.push('frames:start'); },
    stopFrames: () => { framesOn = false; calls.push('frames:stop'); },
    setJobActive: async a => { calls.push(`job:${a}`); },
    drawCard: async (kind, _data, frame) => {
      if ((kind as string) === 'status') throw new CardDataError('bad data');
      calls.push(frame ? `card:${kind}:frame:${frame.length}` : `card:${kind}`);
      return PNG;
    },
    logout: async () => { calls.push('logout'); return true; },
    close: async () => {},
  };
  return { g, calls };
}

describe('gamelink socket: long requests', () => {
  // Bun's default idleTimeout (10 s) cut a GET whose answer took more than about 12 s (Bun 1.3.14).
  // The service sets idleTimeout to SERVICE_IDLE_TIMEOUT_S, so a slow frame capture, card or idle
  // wait gets its answer.
  test('a handler that takes 14 s is not cut', async () => {
    expect(SERVICE_IDLE_TIMEOUT_S).toBeGreaterThanOrEqual(60);
    expect(SERVICE_IDLE_TIMEOUT_S).toBeLessThanOrEqual(255);
    const dir = mkdtempSync(join(tmpdir(), 'gamelink-slow-'));
    const sock = join(dir, 'gl.sock');
    const { g } = fakeGuild();
    const slow: GuildLink = { ...g, frame: async () => { await new Promise(r => setTimeout(r, 14_000)); return PNG; } };
    const service = serveGameLink({ link: { guilds: new Map([['main', slow]]), close: async () => {} }, socketPath: sock, token: TOKEN });
    try {
      const res = await fetch('http://gamelink/guilds/main/frame', { unix: sock, headers: { authorization: `Bearer ${TOKEN}` } } as RequestInit);
      expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...PNG]);
    } finally {
      await service.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('gamelink socket', () => {
  let dir: string;
  let sock: string;
  let service: ServiceHandle;
  const { g, calls } = fakeGuild();
  const link: GameLink = { guilds: new Map([['main', g]]), close: async () => {} };
  let client: GameLink;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gamelink-'));
    sock = join(dir, 'gl.sock');
    service = serveGameLink({ link, socketPath: sock, token: TOKEN });
    client = await connectGameLink({ socketPath: sock, token: TOKEN, guilds: [{ name: 'main', account: 'abc' }], pollMs: 50 });
  });
  afterAll(async () => {
    await client?.close();
    await service?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test('socket file has mode 660 on Unix', () => {
    if (process.platform === 'win32') return;
    expect(statSync(sock).mode & 0o777).toBe(0o660);
  });

  test('client round trip: status, state, frames, job flag, card, logout', async () => {
    const c = client.guilds.get('main')!;
    expect(c.proxyPort).toBe(7790);
    expect(c.bootToken).toBe('boot-token-xyz');
    expect(c.tabStatus()).toBe('in_game');
    expect(c.proxyStatus().connected).toBe(true);
    const s = c.state();
    expect((s!.state as { player: { hp: number } }).player.hp).toBe(7);
    expect(Date.now() - s!.at).toBeGreaterThanOrEqual(900);
    expect(c.latestFrame()?.at).toBe(1234);
    expect([...c.latestFrame()!.png]).toEqual([...PNG]);
    expect([...(await c.frame())!]).toEqual([...PNG]);
    await c.setJobActive(true);
    await c.setJobActive(false);
    expect([...(await c.drawCard('death', {} as never))!]).toEqual([...PNG]);
    await expect(c.drawCard('status', {} as never)).rejects.toThrow(/HTTP 400/);
    expect(await c.logout()).toBe(true);
    c.startFrames();
    await Bun.sleep(100);
    expect(c.framesActive()).toBe(true);
    // The first job:false is the reset at connect: a crashed bot may have left the flag on.
    expect(calls).toEqual(['job:false', 'job:true', 'job:false', 'card:death', 'logout', 'frames:start']);
  });

  test('a card takes a PNG frame; anything else is refused before the draw', async () => {
    const c = client.guilds.get('main')!;
    const before = calls.length;
    const frame = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    expect([...(await c.drawCard('instruction_receipt', {} as never, frame))!]).toEqual([...PNG]);
    await expect(c.drawCard('instruction_receipt', {} as never, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toThrow(/HTTP 400/);
    await expect(c.drawCard('instruction_receipt', {} as never, new Uint8Array(CARD_FRAME_MAX_BYTES + 1).fill(0x89))).rejects.toThrow(/HTTP 400/);
    expect(calls.slice(before)).toEqual(['card:instruction_receipt:frame:10']);
  });

  test('status carries the tab reason and the actions in flight; waitIdle goes over the socket, capped at 30 s', async () => {
    const c = client.guilds.get('main')!;
    expect(c.tabReason()).toBe('Connecting to server...');
    expect(c.actionsInFlight()).toBe(2);
    const before = calls.length;
    expect(await c.waitIdle(5_000)).toBe(true);
    expect(await c.waitIdle(0)).toBe(false);
    expect(await c.waitIdle(90_000)).toBe(true);
    expect(calls.slice(before)).toEqual(['idle:5000', 'idle:0', 'idle:30000']);
    const bad = await fetch('http://gamelink/guilds/main/idle', { unix: sock, method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{"timeoutMs":"x"}' } as RequestInit);
    expect(bad.status).toBe(400);
  });

  test('portrait goes over the socket; the status carries the gateway route', async () => {
    const c = client.guilds.get('main')!;
    expect([...(await c.portrait())!]).toEqual([...PORTRAIT]);
    expect(calls).toContain('portrait');
    expect(c.proxyStatus().gateway).toBe('direct');
  });

  const raw = (path: string, auth?: string) =>
    fetch(`http://gamelink${path}`, { unix: sock, method: 'POST', headers: auth ? { authorization: auth } : {}, body: '{"active":true}' } as RequestInit);

  test('refuses a request without a token or with a wrong token', async () => {
    const before = calls.length;
    expect((await raw('/guilds/main/job')).status).toBe(401);
    expect((await raw('/guilds/main/job', `Bearer ${'b'.repeat(40)}`)).status).toBe(401);
    expect((await raw('/guilds/main/job', `Bearer ${TOKEN}x`)).status).toBe(401);
    expect((await raw('/guilds/main/job', TOKEN)).status).toBe(401);
    expect(calls.length).toBe(before);
    expect((await raw('/guilds/other/job', `Bearer ${TOKEN}`)).status).toBe(404);
  });

  test('the client refuses a wrong token and a wrong account', async () => {
    await expect(connectGameLink({ socketPath: sock, token: 'c'.repeat(40), guilds: [{ name: 'main', account: 'abc' }] })).rejects.toThrow(/refused the token/);
    await expect(connectGameLink({ socketPath: sock, token: TOKEN, guilds: [{ name: 'main', account: 'other' }] })).rejects.toThrow(/another account/);
  });

  test('framesActive follows the polled status, so frames that gamelink lost (a restart) show as off', async () => {
    const c = client.guilds.get('main')!;
    c.startFrames();
    expect(c.framesActive()).toBe(true);
    await new Promise(r => setTimeout(r, 300));
    expect(c.framesActive()).toBe(true);
    // Gamelink restarted: its frames are off, and the bot did not stop them.
    g.stopFrames();
    await new Promise(r => setTimeout(r, 300));
    expect(c.framesActive()).toBe(false);
  });
});

describe('split-mode configuration', () => {
  const game = { RS_ACCOUNT: 'abc', RS_PASSWORD: 'pw', RS_SERVER_HOST: 'game.example.org' };

  test('loadGameConfig needs no Discord token and no API key', () => {
    const c = loadGameConfig({ ...game, GAMELINK_TOKEN_FILE: '/etc/gl/token' }, '/r');
    expect(c.guilds).toHaveLength(1);
    expect(c.guilds[0]!.name).toBe('main');
    expect(c.guilds[0]!.game.account.password).toBe('pw');
    expect(c.socketPath).toBe('/run/rs-gamelink/gamelink.sock');
    expect(() => loadGameConfig(game, '/r')).toThrow(/GAMELINK_TOKEN_FILE/);
    expect(() => loadGameConfig({ ...game, RS_PASSWORD: '', GAMELINK_TOKEN_FILE: '/t' }, '/r')).toThrow(/RS_PASSWORD/);
  });

  test('the bot in split mode needs no game password and keeps none', () => {
    const bot = { RS_ACCOUNT: 'abc', RS_SERVER_HOST: 'game.example.org', DISCORD_TOKEN: 'tok', DISCORD_CHANNEL_ID: '123456789012345678', BOX_USER: 'rsbox', DISCORD_ALLOW_EVERYONE: '1' };
    expect(() => loadBotConfig(bot, '/r')).toThrow(/RS_PASSWORD/);
    const split = { ...bot, GAMELINK_SOCKET: '/run/rs-gamelink/gamelink.sock', GAMELINK_TOKEN_FILE: '/t' };
    expect(loadBotConfig(split, '/r').gamelink).toEqual({ socketPath: '/run/rs-gamelink/gamelink.sock', tokenFile: '/t' });
    expect(loadBotConfig({ ...split, RS_PASSWORD: 'pw' }, '/r').game.account.password).toBe('');
    expect(() => loadBotConfig({ ...bot, GAMELINK_SOCKET: '/s' }, '/r')).toThrow(/GAMELINK_TOKEN_FILE/);
    expect(loadBotConfig({ ...bot, RS_PASSWORD: 'pw' }, '/r').gamelink).toBeNull();
  });

  test('readTokenFile refuses a short token and never shows it', () => {
    expect(readTokenFile('/t', () => `${TOKEN}\n`)).toBe(TOKEN);
    expect(() => readTokenFile('/t', () => 'short')).toThrow(/at least 32/);
    expect(() => readTokenFile('/t', () => { throw new Error('ENOENT'); })).toThrow(/cannot be read/);
  });
});

function fakeLockFs(pid: number, running: number[]) {
  const files = new Map<string, string>();
  const deps: LockDeps = {
    pid,
    alive: p => running.includes(p),
    create(path, text) {
      if (files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      files.set(path, text);
    },
    read(path) {
      const t = files.get(path);
      if (t === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return t;
    },
    remove: path => { files.delete(path); },
  };
  return { files, deps };
}

describe('gamelink lock file', () => {
  const path = lockPathFor(join('run', 'gamelink', 'gl.sock'));

  test('sits beside the socket', () => {
    expect(path).toBe(join('run', 'gamelink', 'gamelink.lock'));
  });

  test('a second gamelink refuses to start while the first runs; release frees the lock', () => {
    const fs = fakeLockFs(100, [100, 200]);
    const release = acquireLock(path, fs.deps);
    expect(fs.files.get(path)).toBe('100\n');
    expect(() => acquireLock(path, { ...fs.deps, pid: 200 })).toThrow(LockError);
    release();
    expect(fs.files.has(path)).toBe(false);
    acquireLock(path, { ...fs.deps, pid: 200 });
    expect(fs.files.get(path)).toBe('200\n');
  });

  test('takes over a stale lock whose pid does not run, or that holds no pid', () => {
    const fs = fakeLockFs(300, [300]);
    fs.files.set(path, '100\n');
    acquireLock(path, fs.deps);
    expect(fs.files.get(path)).toBe('300\n');
    fs.files.set(path, 'garbage');
    acquireLock(path, fs.deps);
    expect(fs.files.get(path)).toBe('300\n');
  });

  test('release does not remove a lock that another process took over', () => {
    const fs = fakeLockFs(100, [100]);
    const release = acquireLock(path, fs.deps);
    fs.files.set(path, '999\n');
    release();
    expect(fs.files.get(path)).toBe('999\n');
  });

  test('works on a real directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gamelink-lock-'));
    try {
      const p = lockPathFor(join(dir, 'gl.sock'));
      const release = acquireLock(p);
      expect(() => acquireLock(p, { pid: process.pid + 1, alive: () => true, create: (f, t) => writeFileSync(f, t, { flag: 'wx' }), read: f => readFileSync(f, 'utf8'), remove: f => rmSync(f, { force: true }) })).toThrow(LockError);
      release();
      expect(existsSync(p)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('operator signals', () => {
  function fakeLocal(names: string[], failing: string | null) {
    const calls: string[] = [];
    const guilds = new Map<string, LocalGuildLink>();
    for (const name of names) {
      const { g } = fakeGuild();
      guilds.set(name, {
        ...g, name,
        relog: async () => { calls.push(`relog:${name}`); if (name === failing) throw new Error('page closed'); return true; },
        reconnectProxy: () => { calls.push(`reconnect:${name}`); if (name === failing) throw new Error('stopped'); },
      });
    }
    const link: LocalGameLink = { guilds, close: async () => {} };
    return { link, calls };
  }

  test('relogAll relogs every guild; one failure does not stop the others', async () => {
    const { link, calls } = fakeLocal(['a', 'b'], 'a');
    const lines: string[] = [];
    await relogAll(link, l => lines.push(l));
    expect(calls.sort()).toEqual(['relog:a', 'relog:b']);
    expect(lines).toContain('[a] relog failed: page closed');
    expect(lines).toContain('[b] logged out; the login follows');
  });

  test('reconnectAll reconnects every proxy; one failure does not stop the others', () => {
    const { link, calls } = fakeLocal(['a', 'b'], 'a');
    const lines: string[] = [];
    reconnectAll(link, l => lines.push(l));
    expect(calls).toEqual(['reconnect:a', 'reconnect:b']);
    expect(lines).toEqual(['[a] proxy reconnect failed: stopped']);
  });
});

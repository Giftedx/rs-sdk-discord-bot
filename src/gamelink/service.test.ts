import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBotConfig, loadGameConfig } from '../bot/config';
import { CardDataError } from '../cards/templates';
import { connectGameLink } from './client';
import { readTokenFile, type GameLink, type GuildLink } from './link';
import { serveGameLink, type ServiceHandle } from './service';

const TOKEN = 'a'.repeat(40);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function fakeGuild() {
  const calls: string[] = [];
  let framesOn = false;
  const g: GuildLink = {
    name: 'main', account: 'abc', proxyPort: 7790, bootToken: 'boot-token-xyz',
    tabStatus: () => 'in_game',
    tabReason: () => 'Connecting to server...',
    actionsInFlight: () => 2,
    waitIdle: async ms => { calls.push(`idle:${ms}`); return ms > 0; },
    proxyStatus: () => ({ connected: true, lastError: null, reconnects: 0 }),
    state: () => ({ state: { player: { hp: 7 } }, at: Date.now() - 1_000 }),
    latestFrame: () => ({ at: 1234, png: PNG }),
    frame: async () => PNG,
    framesActive: () => framesOn,
    startFrames: () => { framesOn = true; calls.push('frames:start'); },
    stopFrames: () => { framesOn = false; calls.push('frames:stop'); },
    setJobActive: async a => { calls.push(`job:${a}`); },
    drawCard: async kind => {
      if ((kind as string) === 'status') throw new CardDataError('bad data');
      calls.push(`card:${kind}`);
      return PNG;
    },
    logout: async () => { calls.push('logout'); return true; },
    close: async () => {},
  };
  return { g, calls };
}

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

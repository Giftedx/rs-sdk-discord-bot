import { describe, expect, test } from 'bun:test';
import { loadBotConfig } from './config';
import { createQueue } from './queue';

const base = {
  RS_ACCOUNT: 'abc', RS_PASSWORD: 'pw', RS_SERVER_HOST: 'game.example.org',
  DISCORD_TOKEN: 'tok', DISCORD_CHANNEL_ID: '123456789012345678', BOX_USER: 'rsbox',
  DISCORD_ALLOWED_ROLE_ID: '223456789012345678',
};

describe('loadBotConfig', () => {
  test('defaults', () => {
    const c = loadBotConfig(base, '/root');
    expect(c.model).toBe('claude-opus-5-5');
    expect(c.effort).toBe('medium');
    expect(c.idleGuard).toBe(true);
    expect(c.maxTurns).toBe(25);
  });
  test('the demo world needs RS_ALLOW_DEMO=1', () => {
    expect(() => loadBotConfig({ ...base, RS_SERVER_HOST: '' }, '/r')).toThrow(/RS_ALLOW_DEMO/);
    expect(loadBotConfig({ ...base, RS_SERVER_HOST: '', RS_ALLOW_DEMO: '1' }, '/r').game.serverHost).toBe('rs-sdk.maxbittker.com');
  });
  test('fails closed without a box user', () => {
    const { BOX_USER: _, ...noBox } = base;
    expect(() => loadBotConfig(noBox, '/r')).toThrow(/BOX_USER must be set/);
    expect(loadBotConfig({ ...noBox, BOT_ALLOW_UNSANDBOXED: '1' }, '/r').boxUser).toBeNull();
    expect(() => loadBotConfig({ ...base, BOX_USER: 'Bad User' }, '/r')).toThrow(/BOX_USER must be a Unix user name/);
  });
  test('needs a role or an explicit allow-everyone', () => {
    const { DISCORD_ALLOWED_ROLE_ID: _, ...noRole } = base;
    expect(() => loadBotConfig(noRole, '/r')).toThrow(/DISCORD_ALLOW_EVERYONE/);
    expect(loadBotConfig({ ...noRole, DISCORD_ALLOW_EVERYONE: '1' }, '/r').allowedRoleId).toBeNull();
  });
  test('refuses bad values and never prints them', () => {
    expect(() => loadBotConfig({ ...base, DISCORD_TOKEN: '' }, '/r')).toThrow(/DISCORD_TOKEN/);
    expect(() => loadBotConfig({ ...base, DISCORD_CHANNEL_ID: 'general' }, '/r')).toThrow(/DISCORD_CHANNEL_ID/);
    expect(() => loadBotConfig({ ...base, AI_EFFORT: 'huge' }, '/r')).toThrow(/AI_EFFORT/);
    expect(() => loadBotConfig({ ...base, AI_MAX_TURNS: '0' }, '/r')).toThrow(/AI_MAX_TURNS/);
  });
});

describe('queue', () => {
  test('one at a time, in order', () => {
    const q = createQueue({ max: 5, userCooldownMs: 0 });
    q.add('u1', 'a', 'first');
    q.add('u2', 'b', 'second');
    expect(q.next()?.text).toBe('first');
    expect(q.next()).toBeNull();
    q.done();
    expect(q.next()?.text).toBe('second');
  });
  test('limits', () => {
    let t = 0;
    const q = createQueue({ max: 1, userCooldownMs: 10_000, now: () => t });
    expect(q.add('u1', 'a', ' ')).toEqual({ ok: false, reason: 'empty' });
    expect(q.add('u1', 'a', 'x'.repeat(1001))).toEqual({ ok: false, reason: 'too_long' });
    expect(q.add('u1', 'a', 'go').ok).toBe(true);
    expect(q.add('u1', 'a', 'again')).toEqual({ ok: false, reason: 'cooldown' });
    expect(q.add('u2', 'b', 'go')).toEqual({ ok: false, reason: 'full' });
    t = 20_000;
    expect(q.clear()).toBe(1);
  });
});

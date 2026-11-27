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
    expect(c.model).toBe('claude-sonnet-5-5');
    expect(c.escalationModel).toBe('claude-opus-5-5');
    expect(c.smallModel).toBe('claude-haiku-5-5');
    expect(c.maxInstructionMs).toBe(120 * 60_000);
    expect(c.effort).toBe('medium');
    expect(c.idleGuard).toBe(true);
    expect(c.maxTurns).toBe(25);
  });
  test('job limit, notes review, gallery thread and silent posts', () => {
    const c = loadBotConfig(base, '/root');
    expect(c.maxJobMin).toBe(15);
    expect(c.notesReviewHourUtc).toBeNull();
    expect(c.galleryThreadName).toBe('gallery');
    expect(c.suppressNotifications).toBeUndefined();
    const d = loadBotConfig({ ...base, AI_MAX_JOB_MIN: '40', NOTES_REVIEW_HOUR_UTC: '0', DISCORD_GALLERY_THREAD: 'pics', DISCORD_SILENT: '1' }, '/r');
    expect([d.maxJobMin, d.notesReviewHourUtc, d.galleryThreadName, d.suppressNotifications]).toEqual([40, 0, 'pics', true]);
    expect(loadBotConfig({ ...base, DISCORD_SILENT: '0' }, '/r').suppressNotifications).toBe(false);
    expect(() => loadBotConfig({ ...base, AI_MAX_JOB_MIN: '61' }, '/r')).toThrow(/AI_MAX_JOB_MIN/);
    expect(() => loadBotConfig({ ...base, NOTES_REVIEW_HOUR_UTC: '24' }, '/r')).toThrow(/NOTES_REVIEW_HOUR_UTC/);
    expect(() => loadBotConfig({ ...base, DISCORD_SILENT: 'yes' }, '/r')).toThrow(/DISCORD_SILENT/);
    expect(() => loadBotConfig({ ...base, DISCORD_GALLERY_THREAD: 'adventure-log' }, '/r')).toThrow(/must differ/);
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
  test('model settings and the instruction time limit', () => {
    const c = loadBotConfig({ ...base, AI_MODEL: 'claude-opus-5-5', ESCALATION_MODEL: 'none', AI_MAX_INSTRUCTION_MIN: '30' }, '/r');
    expect(c.model).toBe('claude-opus-5-5');
    expect(c.escalationModel).toBeNull();
    expect(c.maxInstructionMs).toBe(30 * 60_000);
    expect(() => loadBotConfig({ ...base, ESCALATION_MODEL: 'Bad Model' }, '/r')).toThrow(/ESCALATION_MODEL/);
    expect(() => loadBotConfig({ ...base, AI_MAX_INSTRUCTION_MIN: '0' }, '/r')).toThrow(/AI_MAX_INSTRUCTION_MIN/);
  });
  test('refuses bad values and never prints them', () => {
    expect(() => loadBotConfig({ ...base, DISCORD_TOKEN: '' }, '/r')).toThrow(/DISCORD_TOKEN/);
    expect(() => loadBotConfig({ ...base, DISCORD_CHANNEL_ID: 'general' }, '/r')).toThrow(/DISCORD_CHANNEL_ID/);
    expect(() => loadBotConfig({ ...base, AI_EFFORT: 'huge' }, '/r')).toThrow(/AI_EFFORT/);
    expect(() => loadBotConfig({ ...base, AI_MAX_TURNS: '0' }, '/r')).toThrow(/AI_MAX_TURNS/);
    expect(() => loadBotConfig({ ...base, SPEND_RESET_DAY: '29' }, '/r')).toThrow(/SPEND_RESET_DAY/);
    expect(() => loadBotConfig({ ...base, DISCORD_RECAP_HOUR_UTC: '24' }, '/r')).toThrow(/DISCORD_RECAP_HOUR_UTC/);
    expect(() => loadBotConfig({ ...base, ESCALATION_MODEL: 'Bad Model' }, '/r')).toThrow(/ESCALATION_MODEL/);
  });
  test('the single-guild form gives one guild in DATA_DIR', () => {
    const c = loadBotConfig({ ...base, DATA_DIR: '/d' }, '/r');
    expect(c.guilds).toHaveLength(1);
    expect(c.guilds[0]).toMatchObject({ name: 'main', channelId: base.DISCORD_CHANNEL_ID, dataDir: '/d', boxUser: 'rsbox' });
    expect(c.spendResetDay).toBe(1);
    expect(c.watchdogMs).toBe(300_000);
    expect(c.recapHourUtc).toBeUndefined();
    expect(c.postsPerHour).toBe(4);
    expect(c.jobLimits).toEqual({ memoryBytes: 1024 * 1_048_576, pids: 256, cpuPercent: 100 });
  });
});

describe('GUILDS_FILE', () => {
  const { RS_ACCOUNT: _a, RS_PASSWORD: _p, DISCORD_CHANNEL_ID: _c, DISCORD_ALLOWED_ROLE_ID: _r, ...common } = base;
  const entries = [
    { name: 'alpha', channelId: '323456789012345678', allowedRoleId: '423456789012345678', account: 'acca', passwordEnv: 'PW_ALPHA' },
    { name: 'beta', channelId: '523456789012345678', allowEveryone: true, account: 'accb', passwordEnv: 'PW_BETA', dataSubdir: 'b', boxUser: 'rsbox2' },
  ];
  const env = { ...common, GUILDS_FILE: 'guilds.json', PW_ALPHA: 'secretA', PW_BETA: 'secretB', DATA_DIR: '/d', PROXY_PORT: '7800' };
  const load = (list: unknown, e: Record<string, string | undefined> = env) => loadBotConfig(e, '/r', () => JSON.stringify(list));

  test('one guild per entry, with its own port, data dir, account and password', () => {
    const c = load(entries);
    expect(c.guilds.map(g => [g.name, g.game.proxyPort, g.game.account.name, g.game.account.password, g.boxUser, g.allowedRoleId]))
      .toEqual([['alpha', 7800, 'acca', 'secretA', 'rsbox', '423456789012345678'], ['beta', 7801, 'accb', 'secretB', 'rsbox2', null]]);
    expect(c.guilds[0]!.dataDir.replace(/\\/g, '/')).toMatch(/\/d\/alpha$/);
    expect(c.guilds[1]!.dataDir.replace(/\\/g, '/')).toMatch(/\/d\/b$/);
    expect(c.channelId).toBe('323456789012345678');
  });
  test('the password comes only from the named variable, and errors never print it', () => {
    const { PW_BETA: _, ...noPw } = env;
    let msg = '';
    try { load(entries, noPw); } catch (err) { msg = (err as Error).message; }
    expect(msg).toMatch(/entry 2: .*passwordEnv/);
    expect(msg).not.toContain('secretA');
    expect(() => load([{ ...entries[0], password: 'x', passwordEnv: 'bad name' }])).toThrow(/passwordEnv/);
  });
  test('refuses duplicates, bad entries and a missing file', () => {
    expect(() => load([entries[0], { ...entries[1], account: 'acca' }])).toThrow(/same account/);
    expect(() => load([entries[0], { ...entries[1], channelId: entries[0]!.channelId }])).toThrow(/same channelId/);
    expect(() => load([{ ...entries[0], allowedRoleId: undefined }])).toThrow(/allowEveryone/);
    expect(() => load([{ ...entries[0], name: 'Bad Name' }])).toThrow(/name must match/);
    expect(() => load([{ ...entries[0], dataSubdir: '../x' }])).toThrow(/dataSubdir/);
    expect(() => load([])).toThrow(/at least one/);
    expect(() => loadBotConfig(env, '/r', () => '{not json')).toThrow(/JSON list/);
    expect(() => loadBotConfig(env, '/r', () => { throw new Error('ENOENT'); })).toThrow(/cannot be read/);
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

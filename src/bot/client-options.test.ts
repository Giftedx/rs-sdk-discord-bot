import { describe, expect, test } from 'bun:test';
import { GatewayIntentBits, Partials } from 'discord.js';
import { IconCache } from '../cards/icons';
import { FakeTimers } from '../discord/fake-timers';
import { MainPosts, MAX_IN_MEMORY_EVENTS } from '../discord/posts';
import { DISCORD_CACHE_LIMITS, DISCORD_SWEEPERS, discordClientOptions } from './client-options';
import { createAdmission, createRateLimit } from './helpers';

describe('discordClientOptions', () => {
  test('enables bounded caches, sweepers, and expected intents/partials', () => {
    const withContent = discordClientOptions(true);
    expect(withContent.intents).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ]);
    expect(withContent.partials).toEqual([Partials.Message, Partials.Reaction, Partials.User]);
    expect(typeof withContent.makeCache).toBe('function');
    expect(withContent.sweepers).toBe(DISCORD_SWEEPERS);
    expect(DISCORD_CACHE_LIMITS.MessageManager).toBe(50);
    expect(DISCORD_CACHE_LIMITS.PresenceManager).toBe(0);
    expect(DISCORD_CACHE_LIMITS.ReactionUserManager).toBe(0);

    const withoutContent = discordClientOptions(false);
    expect(withoutContent.intents).not.toContain(GatewayIntentBits.MessageContent);
  });

  test('GuildMemberManager keepOverLimit retains only the bot member', () => {
    const keep = DISCORD_CACHE_LIMITS.GuildMemberManager.keepOverLimit;
    expect(keep({ id: 'bot-1', client: { user: { id: 'bot-1' } } })).toBe(true);
    expect(keep({ id: 'user-2', client: { user: { id: 'bot-1' } } })).toBe(false);
    expect(keep({ id: 'user-2', client: { user: null } })).toBe(false);
  });
});

describe('bounded caches in bot helpers, icons, and posts', () => {
  test('createAdmission prunes expired users and enforces maxTrackedUsers', () => {
    let t = 1_000;
    const admit = createAdmission({ max: 10, userCooldownMs: 1_000, now: () => t, maxTrackedUsers: 4 });
    for (let i = 0; i < 6; i++) {
      expect(admit(`u${i}`, 'hi', 0).ok).toBe(true);
    }
    // u0 and u1 were evicted by the cap, so u0 is admitted again immediately while u5 is on cooldown.
    expect(admit('u5', 'hi', 0)).toEqual({ ok: false, reason: 'cooldown' });
    expect(admit('u0', 'hi', 0).ok).toBe(true);
    t += 2_000;
    expect(admit('u5', 'hi', 0).ok).toBe(true);
  });

  test('createRateLimit evicts expired buckets and bounds tracked keys', () => {
    let t = 1_000;
    const allow = createRateLimit(1, 1_000, () => t, 3);
    expect(allow('k0')).toBe(true);
    expect(allow('k1')).toBe(true);
    expect(allow('k2')).toBe(true);
    expect(allow('k3')).toBe(true);
    // k0 was evicted when k3 entered; k3 is still rate-limited.
    expect(allow('k3')).toBe(false);
    expect(allow('k0')).toBe(true);
    t += 2_000;
    expect(allow('k3')).toBe(true);
  });

  test('IconCache bounds failedAt entries to maxEntries', async () => {
    let calls = 0;
    let t = 1_000;
    const cache = new IconCache({
      iconHost: 'http://localhost:8888',
      maxEntries: 3,
      retryAfterMs: 60_000,
      now: () => t,
      fetch: async () => {
        calls++;
        return { ok: false, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
      },
    });
    for (const id of [1, 2, 3, 4]) {
      expect(await cache.get(id)).toBeNull();
    }
    expect(calls).toBe(4);
    // id 4 is still cached as failed; id 1 was evicted when id 4 pushed size over 3.
    expect(await cache.get(4)).toBeNull();
    expect(calls).toBe(4);
    expect(await cache.get(1)).toBeNull();
    expect(calls).toBe(5);
  });

  test('MainPosts.record caps retained in-memory events at MAX_IN_MEMORY_EVENTS', () => {
    const timers = new FakeTimers(1_000_000);
    const posts = new MainPosts({
      channel: { send: async () => {} },
      secrets: [],
      timers,
      log: () => {},
    });
    for (let i = 0; i < MAX_IN_MEMORY_EVENTS + 50; i++) {
      posts.record({ kind: 'item_gain', items: [{ name: 'Logs', count: 1 }] });
    }
    expect(posts.recap().events).toBe(MAX_IN_MEMORY_EVENTS);
  });
});

import { describe, expect, test } from 'bun:test';
import { QueueVotes, isThumbsUp, moveUpOne, type ReactionInput } from './queue-votes';

describe('moveUpOne', () => {
  test('swaps with the one before; first or absent stays; input is not changed', () => {
    expect(moveUpOne([1, 2, 3], 3)).toEqual([1, 3, 2]);
    expect(moveUpOne([1, 2, 3], 1)).toEqual([1, 2, 3]);
    expect(moveUpOne([1, 2, 3], 9)).toEqual([1, 2, 3]);
    const src = [1, 2];
    moveUpOne(src, 2);
    expect(src).toEqual([1, 2]);
  });
});

describe('isThumbsUp', () => {
  test('with and without a skin tone', () => {
    expect(isThumbsUp('\u{1F44D}')).toBe(true);
    expect(isThumbsUp('\u{1F44D}\u{1F3FD}')).toBe(true);
    expect(isThumbsUp('\u{1F44E}')).toBe(false);
    expect(isThumbsUp('⏳')).toBe(false);
    expect(isThumbsUp(null)).toBe(false);
  });
});

function setup(allowed = new Set(['u1', 'u2'])) {
  let order = [10, 11, 12];
  const msgs: Record<string, number> = { m10: 10, m11: 11, m12: 12 };
  const v = new QueueVotes({
    requestFor: (m) => msgs[m] ?? null,
    mayTalk: async (u) => allowed.has(u),
    waitingOrder: () => order,
    setOrder: (ids) => {
      order = ids;
    },
    log: () => {},
  });
  return {
    v,
    order: () => order,
    drop: (id: number) => {
      order = order.filter((x) => x !== id);
    },
  };
}

const up = (messageId: string, userId: string, o: Partial<ReactionInput> = {}): ReactionInput => ({
  messageId,
  userId,
  userIsBot: false,
  emoji: '\u{1F44D}',
  ...o,
});

describe('QueueVotes', () => {
  test('each allowed member moves a request up one place, once per request', async () => {
    const s = setup();
    expect(await s.v.onReaction(up('m12', 'u1'))).toBe(true);
    expect(s.order()).toEqual([10, 12, 11]);
    expect(await s.v.onReaction(up('m12', 'u1'))).toBe(false);
    expect(s.order()).toEqual([10, 12, 11]);
    expect(await s.v.onReaction(up('m12', 'u2'))).toBe(true);
    expect(s.order()).toEqual([12, 10, 11]);
  });

  test('ignores bots, members who may not talk, other emoji and unknown messages', async () => {
    const s = setup();
    expect(await s.v.onReaction(up('m12', 'u1', { userIsBot: true }))).toBe(false);
    expect(await s.v.onReaction(up('m12', 'stranger'))).toBe(false);
    expect(await s.v.onReaction(up('m12', 'u1', { emoji: '❤' }))).toBe(false);
    expect(await s.v.onReaction(up('other', 'u1'))).toBe(false);
    expect(s.order()).toEqual([10, 11, 12]);
  });

  test('a request that is no longer waiting does not move', async () => {
    const s = setup();
    s.drop(12);
    expect(await s.v.onReaction(up('m12', 'u1'))).toBe(false);
    expect(s.order()).toEqual([10, 11]);
  });

  test('an error is logged, not thrown', async () => {
    const logs: string[] = [];
    const v = new QueueVotes({
      requestFor: () => {
        throw new Error('db closed');
      },
      mayTalk: () => true,
      waitingOrder: () => [],
      setOrder: () => {},
      log: (l) => logs.push(l),
    });
    expect(await v.onReaction(up('m', 'u'))).toBe(false);
    expect(logs[0]).toContain('db closed');
  });
});

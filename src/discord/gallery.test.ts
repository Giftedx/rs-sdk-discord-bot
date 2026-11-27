import { describe, expect, test } from 'bun:test';
import type { LogThread, LogThreadHost, ThreadSendOptions } from './adventure-log';
import { FakeTimers } from './fake-timers';
import { GALLERY_THREAD_NAME, Gallery, isGalleryEvent } from './gallery';

const PNG = new Uint8Array([1, 2, 3]);

class Host implements LogThreadHost {
  created: string[] = [];
  sent: { content: string; opts?: ThreadSendOptions }[] = [];
  fail = false;
  private thread: LogThread = {
    send: async (content, opts) => {
      if (this.fail) throw new Error('Missing Access');
      this.sent.push({ content, opts });
      return 'id';
    },
  };
  async findThread(name: string) {
    return this.created.includes(name) ? this.thread : null;
  }
  async createThread(name: string) {
    this.created.push(name);
    return this.thread;
  }
}

function setup(o: { frame?: Uint8Array | null; portrait?: Uint8Array; name?: string } = {}) {
  const host = new Host();
  const timers = new FakeTimers(0);
  const logs: string[] = [];
  const g = new Gallery({
    host,
    secrets: ['hunter22'],
    timers,
    log: (l) => logs.push(l),
    name: o.name,
    frame: async () => (o.frame === undefined ? PNG : o.frame),
    portrait: o.portrait === undefined ? undefined : async () => o.portrait!,
  });
  return { host, timers, logs, g };
}

const LV = { kind: 'level_up', skill: 'Mining', from: 9, level: 10 } as const;

describe('Gallery', () => {
  test('only level milestones and deaths', () => {
    expect(isGalleryEvent(LV)).toBe(true);
    expect(isGalleryEvent({ kind: 'death' })).toBe(true);
    expect(isGalleryEvent({ kind: 'level_up', skill: 'Mining', from: 10, level: 11 })).toBe(false);
    expect(isGalleryEvent({ kind: 'item_gain', items: [] })).toBe(false);
    expect(isGalleryEvent({ kind: 'instruction_done', instruction: 'x', outcome: 'done' })).toBe(false);
  });

  test('uses the milestone levels of its options, the same as the main posts', async () => {
    const host = new Host();
    const g = new Gallery({
      host, secrets: [], timers: new FakeTimers(0), log: () => {}, frame: async () => PNG, milestoneLevels: [20],
    });
    expect(await g.onEvent(LV)).toBe(false);
    expect(await g.onEvent({ kind: 'level_up', skill: 'Mining', from: 19, level: 20 })).toBe(true);
    expect(host.sent).toHaveLength(1);
  });

  test('posts the frame in the default thread, silent, in the first person', async () => {
    const { host, g } = setup();
    expect(await g.onEvent(LV)).toBe(true);
    expect(await g.onEvent({ kind: 'item_gain', items: [] })).toBe(false);
    expect(host.created).toEqual([GALLERY_THREAD_NAME]);
    expect(host.sent).toEqual([{ content: 'I reached Mining 10.', opts: { png: PNG, silent: true } }]);
  });

  test('a configured name; the portrait when there is no frame; nothing without either', async () => {
    const a = setup({ name: 'pics', frame: null, portrait: new Uint8Array([9]) });
    expect(await a.g.onEvent({ kind: 'death' })).toBe(true);
    expect(a.host.created).toEqual(['pics']);
    expect(a.host.sent[0]!.opts?.png).toEqual(new Uint8Array([9]));
    const b = setup({ frame: null });
    expect(await b.g.onEvent({ kind: 'death' })).toBe(false);
    expect(b.host.sent).toHaveLength(0);
  });

  test('at most 6 per hour', async () => {
    const { host, timers, logs, g } = setup();
    for (let i = 0; i < 8; i++) await g.onEvent({ kind: 'death' });
    expect(host.sent).toHaveLength(6);
    expect(logs.some((l) => l.includes('hourly cap'))).toBe(true);
    await timers.advance(3_600_001);
    expect(await g.onEvent({ kind: 'death' })).toBe(true);
  });

  test('a failed send logs and returns false', async () => {
    const { host, logs, g } = setup();
    host.fail = true;
    expect(await g.onEvent({ kind: 'death' })).toBe(false);
    expect(logs[0]).toContain('Missing Access');
  });
});

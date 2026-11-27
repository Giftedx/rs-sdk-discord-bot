import { describe, expect, test } from 'bun:test';
import { AdventureLog, LOG_THREAD_NAME, type LogThread, type LogThreadHost } from './adventure-log';
import { FakeTimers } from './fake-timers';

class FakeHost implements LogThreadHost {
  existing: string[] = [];
  created: string[] = [];
  messages: string[] = [];
  fail = false;
  private thread: LogThread = {
    send: async (c) => {
      if (this.fail) throw new Error('Missing Access');
      this.messages.push(c);
    },
  };
  async findThread(name: string) {
    return this.existing.includes(name) ? this.thread : null;
  }
  async createThread(name: string) {
    this.created.push(name);
    this.existing.push(name);
    return this.thread;
  }
}

function setup() {
  const host = new FakeHost();
  const timers = new FakeTimers();
  const logs: string[] = [];
  const log = new AdventureLog({ host, secrets: ['hunter22'], timers, log: (l) => logs.push(l) });
  return { host, timers, logs, log };
}

describe('AdventureLog', () => {
  test('creates the thread when it is missing and reuses one that exists', async () => {
    const a = setup();
    a.log.add('one');
    await a.timers.advance(0);
    expect(a.host.created).toEqual([LOG_THREAD_NAME]);
    const b = setup();
    b.host.existing = [LOG_THREAD_NAME];
    b.log.add('one');
    await b.timers.advance(0);
    expect(b.host.created).toEqual([]);
    expect(b.host.messages).toEqual(['one']);
  });

  test('at most one message per 10 s, holding all queued lines', async () => {
    const { host, timers, log } = setup();
    log.add('a');
    await timers.advance(0);
    log.add('b');
    log.add('c');
    await timers.advance(5_000);
    expect(host.messages).toEqual(['a']);
    await timers.advance(5_000);
    expect(host.messages).toEqual(['a', 'b\nc']);
  });

  test('lines are sanitized and newlines removed', async () => {
    const { host, timers, log } = setup();
    log.add('token hunter22\n@everyone look');
    await timers.advance(0);
    expect(host.messages[0]).not.toContain('hunter22');
    expect(host.messages[0]).not.toContain('\n');
    expect(host.messages[0]).not.toContain('@everyone');
  });

  test('a long queue is split across batches under the message limit', async () => {
    const { host, timers, log } = setup();
    for (let i = 0; i < 20; i++) log.add('x'.repeat(250));
    await timers.advance(0);
    expect(host.messages).toHaveLength(1);
    expect(host.messages[0]!.length).toBeLessThanOrEqual(2000);
    await timers.advance(20_000);
    expect(host.messages).toHaveLength(3);
    expect(log.queued).toBe(0);
  });

  test('a failed send keeps the lines, logs once and retries after the interval', async () => {
    const { host, timers, log, logs } = setup();
    host.fail = true;
    log.add('a');
    await timers.advance(30_000);
    expect(logs).toHaveLength(1);
    expect(log.queued).toBe(1);
    host.fail = false;
    await timers.advance(10_000);
    expect(host.messages).toEqual(['a']);
  });
});

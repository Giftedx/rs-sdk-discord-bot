import { describe, expect, test } from 'bun:test';
import { AdventureLog, LOG_THREAD_NAME, logLine, type LogThread, type LogThreadHost } from './adventure-log';
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

class EditHost implements LogThreadHost {
  messages: { id: string; content: string; silent?: boolean }[] = [];
  edits = 0;
  private thread: LogThread = {
    send: async (content, opts) => {
      const id = String(this.messages.length + 1);
      this.messages.push({ id, content, silent: opts?.silent });
      return id;
    },
    edit: async (id, content) => {
      this.edits++;
      this.messages.find((m) => m.id === id)!.content = content;
    },
  };
  async findThread() {
    return this.thread;
  }
  async createThread() {
    return this.thread;
  }
}

describe('AdventureLog append and silent', () => {
  function edit(o: { silent?: boolean } = {}) {
    const host = new EditHost();
    const timers = new FakeTimers();
    const log = new AdventureLog({ host, secrets: [], timers, log: () => {}, ...o });
    return { host, timers, log };
  }

  test('a batch within 2 minutes is appended to the last message by an edit', async () => {
    const { host, timers, log } = edit();
    log.add('a');
    await timers.advance(0);
    log.add('b');
    await timers.advance(10_000);
    expect(host.messages.map((m) => m.content)).toEqual(['a\nb']);
    expect(host.edits).toBe(1);
  });

  test('a new message after 2 minutes', async () => {
    const { host, timers, log } = edit();
    log.add('a');
    await timers.advance(0);
    await timers.advance(120_000);
    log.add('b');
    await timers.advance(10_000);
    expect(host.messages.map((m) => m.content)).toEqual(['a', 'b']);
  });

  test('a new message when the text does not fit in 1900 characters', async () => {
    const { host, timers, log } = edit();
    for (let i = 0; i < 6; i++) log.add('x'.repeat(299));
    await timers.advance(0);
    expect(host.messages[0]!.content.length).toBe(6 * 300 - 1);
    log.add('y'.repeat(200));
    await timers.advance(10_000);
    expect(host.messages).toHaveLength(2);
    expect(host.messages[1]!.content).toBe('y'.repeat(200));
    expect(host.messages.every((m) => m.content.length <= 1900)).toBe(true);
  });

  test('silent by default; silent false notifies', async () => {
    const a = edit();
    a.log.add('a');
    await a.timers.advance(0);
    expect(a.host.messages[0]!.silent).toBe(true);
    const b = edit({ silent: false });
    b.log.add('a');
    await b.timers.advance(0);
    expect(b.host.messages[0]!.silent).toBe(false);
  });
});

describe('logLine', () => {
  test('first person lines', () => {
    expect(logLine({ kind: 'level_up', skill: 'Woodcutting', from: 29, level: 30 })).toBe('I reached Woodcutting 30.');
    expect(logLine({ kind: 'total_level', total: 250 })).toBe('I reached total level 250.');
    expect(logLine({ kind: 'item_gain', items: [{ name: 'Logs', count: 3 }] })).toBe('I got 3 x Logs.');
    expect(logLine({ kind: 'death', killer: 'Goblin', lost: [{ name: 'Coins', count: 5 }] })).toBe('I died. Probably killed by Goblin (a guess). I lost 5 x Coins.');
    expect(logLine({ kind: 'death' })).toBe('I died.');
  });

  test('a finished request names the member', () => {
    const e = { kind: 'instruction_done', instruction: 'chop oaks', outcome: 'done' } as const;
    expect(logLine(e, 'Sam')).toBe('I finished a request for Sam (done): chop oaks');
    expect(logLine(e)).toBe('I finished a request (done): chop oaks');
    expect(logLine(e, `  ${'n'.repeat(60)}\n`)).toContain(`for ${'n'.repeat(40)} (done)`);
  });
});

describe('item gains', () => {
  test('collect for 60 s and go out as one line, most first', async () => {
    const { host, timers, log } = setup();
    log.addItems([{ name: 'Logs', count: 1 }]);
    log.addItems([{ name: 'Logs', count: 2 }, { name: 'Feather', count: 1 }]);
    await timers.advance(59_000);
    expect(host.messages).toEqual([]);
    await timers.advance(1_000);
    await timers.advance(0);
    expect(host.messages).toEqual(['I got 3 x Logs, 1 x Feather.']);
  });
  test('drain sends the waiting items at once (shutdown)', async () => {
    const { host, log } = setup();
    log.addItems([{ name: 'Bones', count: 4 }]);
    await log.drain();
    expect(host.messages).toEqual(['I got 4 x Bones.']);
  });
});

describe('item gains and batches', () => {
  test('a log batch does not cut the 60 s item window', async () => {
    const { host, timers, log } = setup();
    log.addItems([{ name: 'Logs', count: 1 }]);
    log.add('I reached Woodcutting 30.');
    await timers.advance(10_000);
    expect(host.messages).toEqual(['I reached Woodcutting 30.']);
    log.addItems([{ name: 'Logs', count: 2 }]);
    await timers.advance(50_000);
    await timers.advance(0);
    expect(host.messages.join('\n')).toContain('I got 3 x Logs.');
  });
  test('many items split into lines of at most 280 characters', async () => {
    const { host, log } = setup();
    log.addItems(Array.from({ length: 40 }, (_, i) => ({ name: `Item number ${i}`, count: i + 1 })));
    await log.drain();
    const lines = host.messages.join('\n').split('\n').filter(l => l.startsWith('I got'));
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(280);
    expect(lines.join(' ')).toContain('1 x Item number 0');
  });
});

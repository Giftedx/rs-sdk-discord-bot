// One thread that gets one line per event. Lines are batched: at most one message per batch interval.
// A batch is appended to the last message (an edit) while that message is young and the text fits.
import type { GameEvent } from '../events/diff';
import { DISCORD_MAX, sanitizeForDiscord } from '../shared/sanitize';
import { errText, type Handle, type Logger, type Timers } from './types';

export const LOG_THREAD_NAME = 'adventure-log';
export const LOG_BATCH_MS = 10_000;
export const LOG_MAX_QUEUE = 500;
export const LOG_APPEND_MS = 120_000;
export const LOG_APPEND_MAX = 1_900;
export const LOG_ITEM_WINDOW_MS = 60_000;
const ITEM_LINE_MAX = 280;
const LINE_MAX = 300;
const NAME_MAX = 40;

export interface ThreadSendOptions {
  /** A PNG to attach. */
  png?: Uint8Array;
  /** Sends with MessageFlags.SuppressNotifications. */
  silent?: boolean;
}

/** The adapter must send with allowedMentions { parse: [] }. */
export interface LogThread {
  /** Returns the message id. A thread without ids or edit gets a new message for each batch. */
  send(content: string, opts?: ThreadSendOptions): Promise<string | void>;
  edit?(id: string, content: string): Promise<void>;
}

export interface LogThreadHost {
  findThread(name: string): Promise<LogThread | null>;
  createThread(name: string): Promise<LogThread>;
}

export interface AdventureLogOptions {
  host: LogThreadHost;
  secrets: string[];
  timers: Timers;
  log: Logger;
  name?: string;
  batchMs?: number;
  maxQueue?: number;
  /** Default true: the log does not notify the members. */
  silent?: boolean;
  /** A batch is appended to the last message when it is younger than this. 0 turns the append off. */
  appendWithinMs?: number;
  // Item gains collect this long before they become one line. Default 60 s.
  itemWindowMs?: number;
}

function list(items: { name: string; count: number }[]): string {
  return items.map((i) => `${i.count} x ${i.name}`).join(', ');
}

/**
 * The adventure log line of an event, in the first person.
 * requester is the display name of the member whose request ended; it is cut to 40 characters.
 */
export function logLine(e: GameEvent, requester?: string): string {
  switch (e.kind) {
    case 'level_up':
      return `I reached ${e.skill} ${e.level}.`;
    case 'total_level':
      return `I reached total level ${e.total}.`;
    case 'death': {
      const killer = e.killer ? ` Probably killed by ${e.killer} (a guess).` : '';
      const lost = e.lost && e.lost.length > 0 ? ` I lost ${list(e.lost)}.` : '';
      return `I died.${killer}${lost}`;
    }
    case 'item_gain':
      return `I got ${list(e.items)}.`;
    case 'instruction_done': {
      const who = requester?.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
      return `I finished a request${who ? ` for ${who}` : ''} (${e.outcome}): ${e.instruction}`;
    }
  }
}

export class AdventureLog {
  private queue: string[] = [];
  private thread: LogThread | null = null;
  private timer: Handle | null = null;
  private lastSent = Number.NEGATIVE_INFINITY;
  private last: { id: string; content: string; at: number } | null = null;
  private dropped = 0;
  private sending = false;
  private warned = false;
  private readonly batchMs: number;
  private readonly maxQueue: number;
  private readonly appendMs: number;

  constructor(private readonly o: AdventureLogOptions) {
    this.batchMs = o.batchMs ?? LOG_BATCH_MS;
    this.maxQueue = o.maxQueue ?? LOG_MAX_QUEUE;
    this.appendMs = o.appendWithinMs ?? LOG_APPEND_MS;
  }

  get queued(): number {
    return this.queue.length;
  }

  // Item gains of a gather loop come one item at a time. They collect here for itemWindowMs
  // and go out as one line, such as "I got 14 x Logs, 3 x Feathers.".
  private items = new Map<string, number>();
  private itemTimer: Handle | null = null;

  addItems(items: { name: string; count: number }[]): void {
    for (const i of items) if (i.count > 0) this.items.set(i.name, (this.items.get(i.name) ?? 0) + i.count);
    if (this.items.size === 0 || this.itemTimer !== null) return;
    this.itemTimer = this.o.timers.setTimeout(() => { this.itemTimer = null; this.flushItems(); }, this.o.itemWindowMs ?? LOG_ITEM_WINDOW_MS);
  }

  private flushItems(): void {
    if (this.itemTimer !== null) { this.o.timers.clearTimeout(this.itemTimer); this.itemTimer = null; }
    if (this.items.size === 0) return;
    const parts = [...this.items].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${n} x ${name}`);
    this.items.clear();
    // One line holds at most ITEM_LINE_MAX characters; more items go to the next line.
    let line: string[] = [];
    for (const p of parts) {
      if (line.length > 0 && `I got ${[...line, p].join(', ')}.`.length > ITEM_LINE_MAX) {
        this.add(`I got ${line.join(', ')}.`);
        line = [];
      }
      line.push(p);
    }
    if (line.length > 0) this.add(`I got ${line.join(', ')}.`);
  }

  /** For shutdown: sends the waiting items and every queued line, and waits for a send that runs. */
  async drain(): Promise<void> {
    this.flushItems();
    for (let i = 0; i < 20 && (this.queue.length > 0 || this.sending); i++) {
      if (this.sending) await new Promise(r => setTimeout(r, 100));
      else await this.flush();
    }
  }

  add(line: string): void {
    const clean = sanitizeForDiscord(line.replace(/\s*\n\s*/g, ' '), this.o.secrets, LINE_MAX);
    this.queue.push(clean);
    if (this.queue.length > this.maxQueue) {
      this.dropped += this.queue.length - this.maxQueue;
      this.queue.splice(0, this.queue.length - this.maxQueue);
    }
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.itemTimer !== null) this.o.timers.clearTimeout(this.itemTimer);
    this.itemTimer = null;
    if (this.timer !== null) this.o.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private stopped = false;

  private schedule(): void {
    if (this.stopped || this.timer !== null || this.sending || this.queue.length === 0) return;
    const wait = Math.max(0, this.lastSent + this.batchMs - this.o.timers.now());
    this.timer = this.o.timers.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  /** Sends or appends one batch with as many queued lines as fit. Lines that do not fit wait for the next batch. */
  async flush(): Promise<void> {
    if (this.sending || this.queue.length === 0) return;
    this.sending = true;
    const now = this.o.timers.now();
    const head = this.dropped > 0 ? [`(${this.dropped} older lines were dropped)`] : [];
    const headSize = head.reduce((n, l) => n + l.length + 1, 0);
    const last = this.last;
    const append = last !== null && this.appendMs > 0 && now - last.at < this.appendMs
      && last.content.length + 1 + headSize + this.queue[0]!.length <= LOG_APPEND_MAX;
    const limit = append ? LOG_APPEND_MAX - last!.content.length - 1 : DISCORD_MAX;
    const batch: string[] = [];
    let size = headSize;
    while (this.queue.length > 0 && size + this.queue[0]!.length + (batch.length + head.length > 0 ? 1 : 0) <= limit) {
      const l = this.queue.shift()!;
      size += l.length + (batch.length + head.length > 0 ? 1 : 0);
      batch.push(l);
    }
    const text = [...head, ...batch].join('\n');
    try {
      this.thread ??= (await this.o.host.findThread(this.name)) ?? (await this.o.host.createThread(this.name));
      if (append && this.thread.edit) {
        const content = `${last!.content}\n${text}`;
        await this.thread.edit(last!.id, content);
        this.last = { id: last!.id, content, at: last!.at };
      } else {
        const id = await this.thread.send(text, { silent: this.o.silent ?? true });
        this.last = typeof id === 'string' && this.thread.edit ? { id, content: text, at: now } : null;
      }
      this.dropped = 0;
      this.warned = false;
    } catch (err) {
      this.queue.unshift(...batch);
      this.thread = null;
      this.last = null;
      if (!this.warned) this.o.log(`adventure log: send failed: ${errText(err)}`);
      this.warned = true;
    } finally {
      // A failed send also waits one interval, so a broken thread does not cause a fast retry loop.
      this.lastSent = this.o.timers.now();
      this.sending = false;
      this.schedule();
    }
  }

  private get name(): string {
    return this.o.name ?? LOG_THREAD_NAME;
  }
}

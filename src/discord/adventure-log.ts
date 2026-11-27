// One thread that gets one line per event. Lines are batched: at most one message per batch interval.
import { DISCORD_MAX, sanitizeForDiscord } from '../shared/sanitize';
import { errText, type Handle, type Logger, type Timers } from './types';

export const LOG_THREAD_NAME = 'adventure-log';
export const LOG_BATCH_MS = 10_000;
export const LOG_MAX_QUEUE = 500;
const LINE_MAX = 300;

/** The adapter must send with allowedMentions { parse: [] }. */
export interface LogThread {
  send(content: string): Promise<void>;
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
}

export class AdventureLog {
  private queue: string[] = [];
  private thread: LogThread | null = null;
  private timer: Handle | null = null;
  private lastSent = Number.NEGATIVE_INFINITY;
  private dropped = 0;
  private sending = false;
  private warned = false;
  private readonly batchMs: number;
  private readonly maxQueue: number;

  constructor(private readonly o: AdventureLogOptions) {
    this.batchMs = o.batchMs ?? LOG_BATCH_MS;
    this.maxQueue = o.maxQueue ?? LOG_MAX_QUEUE;
  }

  get queued(): number {
    return this.queue.length;
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
    if (this.timer !== null) this.o.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer !== null || this.sending || this.queue.length === 0) return;
    const wait = Math.max(0, this.lastSent + this.batchMs - this.o.timers.now());
    this.timer = this.o.timers.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  /** Sends one message with as many queued lines as fit. Lines that do not fit wait for the next batch. */
  async flush(): Promise<void> {
    if (this.sending || this.queue.length === 0) return;
    this.sending = true;
    const head = this.dropped > 0 ? [`(${this.dropped} older lines were dropped)`] : [];
    const batch: string[] = [];
    let size = head.reduce((n, l) => n + l.length + 1, 0);
    while (this.queue.length > 0 && size + this.queue[0]!.length + 1 <= DISCORD_MAX) {
      const l = this.queue.shift()!;
      batch.push(l);
      size += l.length + 1;
    }
    try {
      this.thread ??= (await this.o.host.findThread(this.name)) ?? (await this.o.host.createThread(this.name));
      await this.thread.send([...head, ...batch].join('\n'));
      this.dropped = 0;
      this.warned = false;
    } catch (err) {
      this.queue.unshift(...batch);
      this.thread = null;
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

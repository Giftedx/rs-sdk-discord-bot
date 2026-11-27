// Test helper: a manual clock. advance() runs due timers in time order.
import type { Handle, Timers } from './types';

interface Entry {
  id: number;
  at: number;
  fn: () => void;
  every?: number;
}

export class FakeTimers implements Timers {
  private t: number;
  private seq = 0;
  private entries = new Map<number, Entry>();

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): Handle {
    const id = ++this.seq;
    this.entries.set(id, { id, at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(h: Handle): void {
    this.entries.delete(h as number);
  }
  setInterval(fn: () => void, ms: number): Handle {
    const id = ++this.seq;
    this.entries.set(id, { id, at: this.t + ms, fn, every: ms });
    return id;
  }
  clearInterval(h: Handle): void {
    this.entries.delete(h as number);
  }
  pending(): number {
    return this.entries.size;
  }

  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      let next: Entry | undefined;
      for (const e of this.entries.values()) if (e.at <= end && (!next || e.at < next.at)) next = e;
      if (!next) break;
      this.t = next.at;
      if (next.every) next.at += next.every;
      else this.entries.delete(next.id);
      next.fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

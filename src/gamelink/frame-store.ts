import type { FrameMode } from './game-tab';

export interface FrameSource {
  frame(mode: FrameMode): Promise<Uint8Array>;
}

export interface StoredFrame {
  at: number;
  png: Uint8Array;
}

export interface FrameTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface FrameStoreOptions {
  source: FrameSource;
  intervalMs?: number; // default 5_000
  keep?: number;       // default 12
  now?: () => number;
  timers?: FrameTimers;
  log?: (line: string) => void;
}

export interface FrameStore {
  start(): void;
  stop(): void;
  readonly active: boolean;
  latest(): StoredFrame | null;
  // Oldest first.
  all(): StoredFrame[];
  // One capture. False when it was skipped (inactive, a capture runs) or it failed.
  tick(): Promise<boolean>;
}

const defaultTimers: FrameTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: h => clearInterval(h as ReturnType<typeof setInterval>),
};

export function createFrameStore(opts: FrameStoreOptions): FrameStore {
  const intervalMs = opts.intervalMs ?? 5_000;
  const keep = opts.keep ?? 12;
  const now = opts.now ?? Date.now;
  const timers = opts.timers ?? defaultTimers;
  const log = opts.log ?? (() => {});
  const frames: StoredFrame[] = [];
  let handle: unknown = null;
  let busy = false;
  // A capture that ends after stop() belongs to an old run and is not stored.
  let run = 0;

  async function tick(): Promise<boolean> {
    if (handle === null || busy) return false;
    busy = true;
    const myRun = run;
    try {
      const png = await opts.source.frame('view');
      if (myRun !== run || handle === null) return false;
      frames.push({ at: now(), png });
      if (frames.length > keep) frames.splice(0, frames.length - keep);
      return true;
    } catch (err) {
      log(`frame store: capture skipped: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (handle !== null) return;
      run++;
      handle = timers.setInterval(() => void tick(), intervalMs);
      void tick();
    },
    stop() {
      if (handle === null) return;
      timers.clearInterval(handle);
      handle = null;
      run++;
    },
    get active() {
      return handle !== null;
    },
    latest: () => frames.at(-1) ?? null,
    all: () => [...frames],
    tick,
  };
}

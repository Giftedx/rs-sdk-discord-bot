// Small interfaces that keep the Discord modules testable without Discord or real time.
export type Handle = unknown;

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): Handle;
  clearTimeout(h: Handle): void;
  setInterval(fn: () => void, ms: number): Handle;
  clearInterval(h: Handle): void;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export type Logger = (line: string) => void;

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

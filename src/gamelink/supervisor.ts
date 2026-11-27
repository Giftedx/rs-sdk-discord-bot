// Keeps one game tab in the game. Each check reads inGame(). If the tab is out of the game
// for longer than outGraceMs, the supervisor waits reloginDelayMs() (always more than 10 s)
// and reloads the page. With the idle guard on, it resets the idle timer of the client on
// each check, so that a waiting account is not logged out after 10 minutes.
import { reloginDelayMs } from './relogin';

export interface SupervisedTab {
  inGame(): Promise<boolean>;
  keepAlive(): Promise<void>;
  reload(): Promise<void>;
}

export interface SupervisorOptions {
  tab: SupervisedTab;
  idleGuard: boolean;
  checkMs?: number;            // default 5_000
  outGraceMs?: number;         // default 60_000: the time a login or a map load can take
  reloginDelay?: () => number; // default reloginDelayMs
  now?: () => number;
  log?: (line: string) => void;
}

export type TabStatus = 'starting' | 'in_game' | 'out_of_game' | 'reloading';

export interface Supervisor {
  status(): TabStatus;
  // One check. The timer calls it; tests call it directly.
  check(): Promise<void>;
  stop(): void;
  // Starts the timer.
  start(): void;
}

export function createSupervisor(opts: SupervisorOptions): Supervisor {
  const checkMs = opts.checkMs ?? 5_000;
  const outGraceMs = opts.outGraceMs ?? 60_000;
  const reloginDelay = opts.reloginDelay ?? (() => reloginDelayMs());
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});

  let status: TabStatus = 'starting';
  let outSince: number | null = null;
  let reloadAt: number | null = null;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function check(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      let inGame = false;
      try {
        inGame = await opts.tab.inGame();
      } catch {
        inGame = false;   // a page that is loading or closed counts as out of the game
      }
      const t = now();
      if (inGame) {
        if (status !== 'in_game') log('game tab is in the game');
        status = 'in_game';
        outSince = null;
        reloadAt = null;
        if (opts.idleGuard) await opts.tab.keepAlive().catch(() => {});
        return;
      }
      if (outSince === null) outSince = t;
      if (status === 'in_game') { status = 'out_of_game'; log('game tab left the game'); }
      if (t - outSince < outGraceMs) return;
      if (reloadAt === null) {
        const wait = reloginDelay();
        reloadAt = t + wait;
        status = 'out_of_game';
        log(`game tab out of the game for ${Math.round((t - outSince) / 1000)} s; reload in ${Math.round(wait / 1000)} s`);
        return;
      }
      if (t < reloadAt) return;
      status = 'reloading';
      log('reloading the game tab');
      try {
        await opts.tab.reload();
      } catch (err) {
        log(`reload failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Give the new page a full grace time before the next reload.
      outSince = now();
      reloadAt = null;
    } finally {
      busy = false;
    }
  }

  return {
    status: () => status,
    check,
    start() {
      if (timer) return;
      timer = setInterval(() => { void check(); }, checkMs);
      void check();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

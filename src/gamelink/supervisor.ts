// Keeps one game tab in the game. Each check reads inGame(). If the tab is out of the game
// for longer than outGraceMs, the supervisor waits reloginDelayMs() (always more than 10 s)
// times a back-off factor and reloads the page. After n failed reloads in a row the factor is
// min(2^(n-1), 16); it is 1 again when the tab is in the game. With startDelayMs set, the tab
// opened without a login, and the supervisor makes the first login after that delay.
// The login message of the client changes the plan: a refused login stops all retries
// (status login_refused); "RuneScape has been updated!" reloads the page at once, one time.
// With the idle guard on, it resets the idle timer of the client on each check, so that a
// waiting account is not logged out after 10 minutes.
import { reloginDelayMs } from './relogin';

export interface SupervisedTab {
  inGame(): Promise<boolean>;
  keepAlive(): Promise<void>;
  reload(): Promise<void>;
  // The login message of the client, or null.
  loginMessage?(): Promise<string | null>;
}

export interface SupervisorOptions {
  tab: SupervisedTab;
  idleGuard: boolean;
  checkMs?: number;            // default 5_000
  outGraceMs?: number;         // default 60_000: the time a login or a map load can take
  reloginDelay?: () => number; // default reloginDelayMs
  // Set when the tab opened without a login: the time from creation to the first login.
  startDelayMs?: number;
  // Called each time the tab comes into the game.
  onInGame?: () => void;
  now?: () => number;
  log?: (line: string) => void;
}

export type TabStatus = 'starting' | 'in_game' | 'out_of_game' | 'reloading' | 'login_refused';

export interface Supervisor {
  status(): TabStatus;
  // The last login message of the client while out of the game; null in the game.
  reason(): string | null;
  // One check. The timer calls it; tests call it directly.
  check(): Promise<void>;
  stop(): void;
  // Starts the timer.
  start(): void;
}

export const MAX_BACKOFF_FACTOR = 16;
export const FIRST_LOGIN_GAP_MS = 15_000;

export type LoginClass = 'refused' | 'updated' | 'other';

// The texts come from the login responses in the client (Client.ts, loginMes1 and loginMes2).
export function classifyLoginMessage(text: string | null): LoginClass | null {
  const t = (text ?? '').trim().toLowerCase();
  if (!t) return null;
  if (t.includes('invalid username or password') || t.includes('account has been disabled')) return 'refused';
  // Response 6. Not response 14 ("The server is being updated."): that one asks for a wait.
  if (t.includes('has been updated')) return 'updated';
  return 'other';
}

export function backoffFactor(failedReloads: number): number {
  return failedReloads <= 0 ? 1 : Math.min(2 ** (failedReloads - 1), MAX_BACKOFF_FACTOR);
}

// The time of the first login of the next tab: its own delay, and at least gapMs after the
// first login of the tab before it.
export function nextFirstLoginAt(prevAt: number | null, nowMs: number, delayMs: number, gapMs = FIRST_LOGIN_GAP_MS): number {
  const own = nowMs + delayMs;
  return prevAt === null ? own : Math.max(own, prevAt + gapMs);
}

export function createSupervisor(opts: SupervisorOptions): Supervisor {
  const checkMs = opts.checkMs ?? 5_000;
  const outGraceMs = opts.outGraceMs ?? 60_000;
  const reloginDelay = opts.reloginDelay ?? (() => reloginDelayMs());
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});

  let status: TabStatus = 'starting';
  let reason: string | null = null;
  let firstLoginAt: number | null = opts.startDelayMs === undefined ? null : now() + Math.max(0, opts.startDelayMs);
  let outSince: number | null = null;
  let reloadAt: number | null = null;
  let failedReloads = 0;
  let updateReloaded = false;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function reload(line: string): Promise<void> {
    status = 'reloading';
    log(line);
    try {
      await opts.tab.reload();
    } catch (err) {
      log(`reload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Give the new page a full grace time before the next reload.
    outSince = now();
    reloadAt = null;
  }

  async function readMessage(): Promise<string | null> {
    if (!opts.tab.loginMessage) return null;
    try {
      return await opts.tab.loginMessage();
    } catch {
      return null;
    }
  }

  async function check(): Promise<void> {
    if (busy || status === 'login_refused') return;
    busy = true;
    try {
      if (firstLoginAt !== null) {
        if (now() < firstLoginAt) return;
        firstLoginAt = null;
        await reload('first login of the game tab');
        return;
      }
      let inGame = false;
      try {
        inGame = await opts.tab.inGame();
      } catch {
        inGame = false;   // a page that is loading or closed counts as out of the game
      }
      const t = now();
      if (inGame) {
        if (status !== 'in_game') {
          log('game tab is in the game');
          try { opts.onInGame?.(); } catch { /* a failing hook must not stop the supervisor */ }
        }
        status = 'in_game';
        reason = null;
        outSince = null;
        reloadAt = null;
        failedReloads = 0;
        updateReloaded = false;
        if (opts.idleGuard) await opts.tab.keepAlive().catch(() => {});
        return;
      }
      if (outSince === null) outSince = t;
      if (status === 'in_game') { status = 'out_of_game'; log('game tab left the game'); }

      const message = await readMessage();
      const cls = classifyLoginMessage(message);
      if (cls !== null) reason = message!.trim().slice(0, 200);
      if (cls === 'refused') {
        status = 'login_refused';
        log(`the game refused the login (${reason}); no more retries until gamelink restarts`);
        return;
      }
      if (cls === 'updated' && !updateReloaded) {
        updateReloaded = true;
        failedReloads++;
        await reload('the game was updated; reloading the game tab now for the new client');
        return;
      }

      if (t - outSince < outGraceMs) return;
      if (reloadAt === null) {
        const wait = reloginDelay() * backoffFactor(failedReloads);
        reloadAt = t + wait;
        status = 'out_of_game';
        log(`game tab out of the game for ${Math.round((t - outSince) / 1000)} s; reload in ${Math.round(wait / 1000)} s`);
        return;
      }
      if (t < reloadAt) return;
      failedReloads++;
      await reload('reloading the game tab');
    } finally {
      busy = false;
    }
  }

  return {
    status: () => status,
    reason: () => reason,
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

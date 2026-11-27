// The wait before a new login after a game session ended. This project always waits more
// than 10 s, so that a new login does not follow the old session at once. The random part
// keeps several retries from falling on a fixed rhythm.
export const RELOGIN_BASE_MS = 20_000;
export const RELOGIN_JITTER_MS = 10_000;

export function reloginDelayMs(random: () => number = Math.random): number {
  const r = Math.min(Math.max(random(), 0), 1);
  return RELOGIN_BASE_MS + Math.floor(r * RELOGIN_JITTER_MS);
}

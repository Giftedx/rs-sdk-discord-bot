// Cleans text before it goes to Discord. Text from the AI, the box and the game is untrusted.
export const DISCORD_MAX = 2_000;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Secrets match in any letter case: the game shows the account name as "Name" or "NAME", and
// hiding a case variant of a password or token costs nothing.
export function sanitizeForDiscord(text: string, secrets: string[], max = DISCORD_MAX): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.replace(new RegExp(escapeRe(s), 'gi'), '<secret>');
  // Break mass mentions and user, role and channel mentions with a zero-width space.
  out = out.replace(/@(everyone|here)/gi, '@​$1');
  out = out.replace(/<(@[!&]?|#)(\d+)>/g, '<​$1$2>');
  if (out.length > max) out = `${out.slice(0, max - 15)}\n[... cut ...]`;
  return out;
}

// Replaces each name in any letter case, as a whole word. The game shows the account name with
// a capital letter, so a plain match would miss it.
export function redactNames(text: string, names: string[], replacement: string): string {
  let out = text;
  for (const n of names) {
    // Account names match ^[a-z0-9]{1,12}$ (src/shared/config.ts), so they need no escape.
    if (n.length < 3 || !/^[a-z0-9]+$/i.test(n)) continue;
    const re = new RegExp(`(?<![A-Za-z0-9_])${n}(?![A-Za-z0-9_])`, 'gi');
    out = out.replace(re, replacement);
  }
  return out;
}

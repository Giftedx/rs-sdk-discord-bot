// Cleans text before it goes to Discord. Text from the AI, the box and the game is untrusted.
export const DISCORD_MAX = 2_000;

export function sanitizeForDiscord(text: string, secrets: string[], max = DISCORD_MAX): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('<secret>');
  // Break mass mentions and user, role and channel mentions with a zero-width space.
  out = out.replace(/@(everyone|here)/gi, '@​$1');
  out = out.replace(/<(@[!&]?|#)(\d+)>/g, '<​$1$2>');
  if (out.length > max) out = `${out.slice(0, max - 15)}\n[... cut ...]`;
  return out;
}

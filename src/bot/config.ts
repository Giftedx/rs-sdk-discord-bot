// Settings of the Discord bot. Error messages name the variable only, never a value.
import { isAbsolute, resolve } from 'node:path';
import { ConfigError, loadConfig, type Config } from '../shared/config';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEMO_HOST = 'rs-sdk.maxbittker.com';

export interface BotConfig {
  game: Config;
  discordToken: string;
  channelId: string;
  allowedRoleId: string | null;
  model: string;
  effort: Effort;
  maxTurns: number;
  maxInstructionUsd: number;
  monthlyCapUsd: number;
  dataDir: string;
  idleGuard: boolean;
  queueMax: number;
  userCooldownMs: number;
  boxUser: string | null;
  boxBunPath: string;
}

const SNOWFLAKE = /^\d{17,20}$/;

function parseBoxUser(raw: string | undefined): string | null {
  if (!raw) return null;
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(raw)) throw new ConfigError('BOX_USER must be a Unix user name');
  return raw;
}

function num(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new ConfigError(`${name} must be a number from ${min} to ${max}`);
  return n;
}

export function loadBotConfig(env: Record<string, string | undefined>, rootDir: string): BotConfig {
  const game = loadConfig(env);
  if (game.serverHost === DEMO_HOST && env.RS_ALLOW_DEMO !== '1') {
    throw new ConfigError('RS_SERVER_HOST is the rs-sdk demo world. Read "Be a good guest on the demo world" in README.md, then set RS_ALLOW_DEMO=1.');
  }
  const discordToken = env.DISCORD_TOKEN ?? '';
  if (discordToken === '') throw new ConfigError('DISCORD_TOKEN must be set');
  const channelId = env.DISCORD_CHANNEL_ID ?? '';
  if (!SNOWFLAKE.test(channelId)) throw new ConfigError('DISCORD_CHANNEL_ID must be a Discord channel ID');
  const role = env.DISCORD_ALLOWED_ROLE_ID || null;
  if (role !== null && !SNOWFLAKE.test(role)) throw new ConfigError('DISCORD_ALLOWED_ROLE_ID must be a Discord role ID');
  if (role === null && env.DISCORD_ALLOW_EVERYONE !== '1') {
    throw new ConfigError('Set DISCORD_ALLOWED_ROLE_ID, or set DISCORD_ALLOW_EVERYONE=1 to let every member of the channel give instructions.');
  }
  const effort = (env.AI_EFFORT || 'medium') as Effort;
  if (!EFFORTS.includes(effort)) throw new ConfigError(`AI_EFFORT must be one of ${EFFORTS.join(', ')}`);
  const model = env.AI_MODEL || 'claude-opus-5-5';
  if (!/^[a-z0-9.-]+$/.test(model)) throw new ConfigError('AI_MODEL must be a model ID');
  const dataRaw = env.DATA_DIR || 'data';
  // Fail closed: without a box user, AI-written code can read the secrets of the bot.
  if (!env.BOX_USER && env.BOT_ALLOW_UNSANDBOXED !== '1') {
    throw new ConfigError('BOX_USER must be set (docs/running-the-bot.md, "The box user"). For local development only, set BOT_ALLOW_UNSANDBOXED=1.');
  }
  return {
    game,
    discordToken,
    channelId,
    allowedRoleId: role,
    model,
    effort,
    maxTurns: num(env, 'AI_MAX_TURNS', 25, 1, 200),
    maxInstructionUsd: num(env, 'AI_MAX_INSTRUCTION_USD', 2, 0.01, 100),
    monthlyCapUsd: num(env, 'AI_MONTHLY_CAP_USD', 30, 0, 10_000),
    dataDir: isAbsolute(dataRaw) ? dataRaw : resolve(rootDir, dataRaw),
    idleGuard: env.GAMELINK_IDLE_GUARD !== '0',
    queueMax: num(env, 'QUEUE_MAX', 5, 1, 50),
    userCooldownMs: num(env, 'USER_COOLDOWN_S', 30, 0, 3_600) * 1000,
    boxUser: parseBoxUser(env.BOX_USER),
    boxBunPath: env.BOX_BUN_PATH || '/usr/local/bin/bun',
  };
}

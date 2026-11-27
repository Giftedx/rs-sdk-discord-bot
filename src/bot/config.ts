// Settings of the Discord bot. Error messages name the variable only, never a value.
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { ConfigError, loadConfig, type Config } from '../shared/config';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEMO_HOST = 'rs-sdk.maxbittker.com';

// One Discord channel with its own game account, game tab, proxy and queue.
export interface GuildConfig {
  // Key in the database and in log lines. Not a secret.
  name: string;
  channelId: string;
  allowedRoleId: string | null;
  game: Config;
  dataDir: string;
  boxUser: string | null;
}

export interface JobLimitConfig {
  memoryBytes: number;
  pids: number;
  cpuPercent: number;
}

export interface BotConfig {
  // The game settings of the first guild. Kept for callers that serve one guild.
  game: Config;
  guilds: GuildConfig[];
  discordToken: string;
  channelId: string;
  allowedRoleId: string | null;
  model: string;
  escalationModel: string | null;
  effort: Effort;
  maxTurns: number;
  maxInstructionUsd: number;
  monthlyCapUsd: number;
  spendResetDay: number;
  watchdogMs: number;
  dataDir: string;
  idleGuard: boolean;
  queueMax: number;
  userCooldownMs: number;
  boxUser: string | null;
  boxBunPath: string;
  jobLimits: JobLimitConfig;
  postsPerHour: number;
  recapHourUtc: number | undefined;
  logThreadName: string;
  cards: boolean;
}

const SNOWFLAKE = /^\d{17,20}$/;
const GUILD_NAME = /^[a-z0-9_-]{1,32}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

function parseBoxUser(raw: string | undefined, name = 'BOX_USER'): string | null {
  if (!raw) return null;
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(raw)) throw new ConfigError(`${name} must be a Unix user name`);
  return raw;
}

function num(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new ConfigError(`${name} must be a number from ${min} to ${max}`);
  return n;
}

function int(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const n = num(env, name, fallback, min, max);
  if (!Number.isInteger(n)) throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

function access(prefix: string, role: string | null | undefined, everyone: boolean): string | null {
  const r = role || null;
  if (r !== null && !SNOWFLAKE.test(r)) throw new ConfigError(`${prefix} must be a Discord role ID`);
  if (r === null && !everyone) {
    throw new ConfigError(`Set ${prefix}, or allow every member of the channel to give instructions (DISCORD_ALLOW_EVERYONE=1, or "allowEveryone": true in GUILDS_FILE).`);
  }
  return r;
}

function checkDemo(game: Config, env: Record<string, string | undefined>): void {
  if (game.serverHost === DEMO_HOST && env.RS_ALLOW_DEMO !== '1') {
    throw new ConfigError('RS_SERVER_HOST is the rs-sdk demo world. Read "Be a good guest on the demo world" in README.md, then set RS_ALLOW_DEMO=1.');
  }
}

interface GuildEntry {
  name?: unknown; channelId?: unknown; allowedRoleId?: unknown; allowEveryone?: unknown;
  account?: unknown; passwordEnv?: unknown; dataSubdir?: unknown; boxUser?: unknown;
}

// GUILDS_FILE holds a JSON list of guild entries. Passwords are never in the file: each entry
// names the environment variable that holds its password.
export function parseGuildsFile(text: string, env: Record<string, string | undefined>, dataDir: string, defaultBoxUser: string | null): GuildConfig[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError('GUILDS_FILE must hold a JSON list');
  }
  if (!Array.isArray(raw) || raw.length === 0) throw new ConfigError('GUILDS_FILE must hold a list of at least one guild');
  if (raw.length > 20) throw new ConfigError('GUILDS_FILE can hold at most 20 guilds');
  const basePort = int(env, 'PROXY_PORT', 7790, 1, 65535 - raw.length);
  const seen = { name: new Set<string>(), channelId: new Set<string>(), account: new Set<string>(), dataSubdir: new Set<string>() };
  return raw.map((entry: unknown, i): GuildConfig => {
    const at = `GUILDS_FILE entry ${i + 1}`;
    if (typeof entry !== 'object' || entry === null) throw new ConfigError(`${at} must be an object`);
    const e = entry as GuildEntry;
    const name = typeof e.name === 'string' ? e.name : '';
    if (!GUILD_NAME.test(name)) throw new ConfigError(`${at}: name must match ${GUILD_NAME.source}`);
    const channelId = typeof e.channelId === 'string' ? e.channelId : '';
    if (!SNOWFLAKE.test(channelId)) throw new ConfigError(`${at}: channelId must be a Discord channel ID`);
    const role = access(`${at}: allowedRoleId`, typeof e.allowedRoleId === 'string' ? e.allowedRoleId : null, e.allowEveryone === true);
    const passwordEnv = typeof e.passwordEnv === 'string' ? e.passwordEnv : '';
    if (!ENV_NAME.test(passwordEnv)) throw new ConfigError(`${at}: passwordEnv must be the name of an environment variable`);
    const dataSubdir = typeof e.dataSubdir === 'string' ? e.dataSubdir : name;
    if (!GUILD_NAME.test(dataSubdir)) throw new ConfigError(`${at}: dataSubdir must match ${GUILD_NAME.source}`);
    if (e.boxUser !== undefined && typeof e.boxUser !== 'string') throw new ConfigError(`${at}: boxUser must be a string`);
    const boxUser = typeof e.boxUser === 'string' && e.boxUser !== '' ? parseBoxUser(e.boxUser, `${at}: boxUser`) : defaultBoxUser;
    let game: Config;
    try {
      game = loadConfig({
        ...env,
        RS_ACCOUNT: typeof e.account === 'string' ? e.account : '',
        RS_PASSWORD: env[passwordEnv] ?? '',
        PROXY_PORT: String(basePort + i),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConfigError(`${at}: ${msg.replace('RS_ACCOUNT', 'account').replace('RS_PASSWORD', `the variable named by passwordEnv`)}`);
    }
    checkDemo(game, env);
    const keys = { name, channelId, account: game.account.name, dataSubdir } as const;
    for (const k of Object.keys(keys) as (keyof typeof keys)[]) {
      if (seen[k].has(keys[k])) throw new ConfigError(`${at}: two guilds have the same ${k}`);
      seen[k].add(keys[k]);
    }
    return { name, channelId, allowedRoleId: role, game, dataDir: resolve(dataDir, dataSubdir), boxUser };
  });
}

export function loadBotConfig(
  env: Record<string, string | undefined>,
  rootDir: string,
  readFile: (path: string) => string = p => readFileSync(p, 'utf8'),
): BotConfig {
  const discordToken = env.DISCORD_TOKEN ?? '';
  if (discordToken === '') throw new ConfigError('DISCORD_TOKEN must be set');
  const effort = (env.AI_EFFORT || 'medium') as Effort;
  if (!EFFORTS.includes(effort)) throw new ConfigError(`AI_EFFORT must be one of ${EFFORTS.join(', ')}`);
  const model = env.AI_MODEL || 'claude-opus-5-5';
  if (!/^[a-z0-9.-]+$/.test(model)) throw new ConfigError('AI_MODEL must be a model ID');
  const escalationModel = env.ESCALATION_MODEL || null;
  if (escalationModel !== null && !/^[a-z0-9.-]+$/.test(escalationModel)) throw new ConfigError('ESCALATION_MODEL must be a model ID');
  const dataRaw = env.DATA_DIR || 'data';
  const dataDir = isAbsolute(dataRaw) ? dataRaw : resolve(rootDir, dataRaw);
  // Fail closed: without a box user, AI-written code can read the secrets of the bot.
  if (!env.BOX_USER && env.BOT_ALLOW_UNSANDBOXED !== '1') {
    throw new ConfigError('BOX_USER must be set (docs/running-the-bot.md, "The box user"). For local development only, set BOT_ALLOW_UNSANDBOXED=1.');
  }
  const boxUser = parseBoxUser(env.BOX_USER);

  let guilds: GuildConfig[];
  if (env.GUILDS_FILE) {
    const path = isAbsolute(env.GUILDS_FILE) ? env.GUILDS_FILE : resolve(rootDir, env.GUILDS_FILE);
    let text: string;
    try {
      text = readFile(path);
    } catch {
      throw new ConfigError('GUILDS_FILE cannot be read');
    }
    guilds = parseGuildsFile(text, env, dataDir, boxUser);
  } else {
    const game = loadConfig(env);
    checkDemo(game, env);
    const channelId = env.DISCORD_CHANNEL_ID ?? '';
    if (!SNOWFLAKE.test(channelId)) throw new ConfigError('DISCORD_CHANNEL_ID must be a Discord channel ID');
    const role = access('DISCORD_ALLOWED_ROLE_ID', env.DISCORD_ALLOWED_ROLE_ID, env.DISCORD_ALLOW_EVERYONE === '1');
    // The single-guild form keeps the data layout of earlier versions: DATA_DIR itself.
    guilds = [{ name: 'main', channelId, allowedRoleId: role, game, dataDir, boxUser }];
  }
  const first = guilds[0]!;
  const recapRaw = env.DISCORD_RECAP_HOUR_UTC;
  const logThreadName = env.DISCORD_LOG_THREAD || 'adventure-log';
  if (!/^[a-z0-9 _-]{1,64}$/i.test(logThreadName)) throw new ConfigError('DISCORD_LOG_THREAD must be 1 to 64 letters, digits, spaces, _ or -');

  return {
    game: first.game,
    guilds,
    discordToken,
    channelId: first.channelId,
    allowedRoleId: first.allowedRoleId,
    model,
    escalationModel,
    effort,
    maxTurns: num(env, 'AI_MAX_TURNS', 25, 1, 200),
    maxInstructionUsd: num(env, 'AI_MAX_INSTRUCTION_USD', 2, 0.01, 100),
    monthlyCapUsd: num(env, 'AI_MONTHLY_CAP_USD', 30, 0, 10_000),
    spendResetDay: int(env, 'SPEND_RESET_DAY', 1, 1, 28),
    watchdogMs: num(env, 'WATCHDOG_MINUTES', 5, 1, 120) * 60_000,
    dataDir,
    idleGuard: env.GAMELINK_IDLE_GUARD !== '0',
    queueMax: num(env, 'QUEUE_MAX', 5, 1, 50),
    userCooldownMs: num(env, 'USER_COOLDOWN_S', 30, 0, 3_600) * 1000,
    boxUser,
    boxBunPath: env.BOX_BUN_PATH || '/usr/local/bin/bun',
    jobLimits: {
      memoryBytes: int(env, 'JOB_MEMORY_MB', 1024, 64, 65_536) * 1024 * 1024,
      pids: int(env, 'JOB_PIDS', 256, 16, 32_768),
      cpuPercent: int(env, 'JOB_CPU_PERCENT', 100, 5, 6_400),
    },
    postsPerHour: int(env, 'DISCORD_POSTS_PER_HOUR', 4, 0, 60),
    recapHourUtc: recapRaw === undefined || recapRaw === '' ? undefined : int(env, 'DISCORD_RECAP_HOUR_UTC', 0, 0, 23),
    logThreadName,
    cards: env.DISCORD_CARDS !== '0',
  };
}

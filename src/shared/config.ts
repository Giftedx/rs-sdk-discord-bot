import { isAbsolute } from 'node:path';

export interface AccountConfig {
  name: string;
  password: string;
}

export interface Config {
  serverHost: string;
  gatewayUrl: string;
  botPageUrl: string;
  fps: number;
  proxyPort: number;
  account: AccountConfig;
  // The Chrome binary to launch, from RS_CHROME_PATH; null means the puppeteer default.
  chromePath: string | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_HOST = 'rs-sdk.maxbittker.com';
// The platform host name of the demo deployment. vendor/rs-sdk/fly.toml names it. The public
// name of the demo world is DEFAULT_HOST.
const REJECTED_HOSTS = new Set(['rs-sdk-demo.fly.dev']);
const ACCOUNT_PATTERN = /^[a-z0-9]{1,12}$/;
const FPS_MIN = 10;
const FPS_MAX = 50;
const PASSWORD_MAX = 20;
// The bootstrap makes 20 characters from A-Za-z0-9 (scripts/server-bootstrap.sh).
const PASSWORD_PATTERN = /^[A-Za-z0-9]{1,20}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

function parseUrl(name: string, raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be a URL`);
  }
}

// The gateway URL and the bot page URL get the game password. They must use wss:// and
// https:// on RS_SERVER_HOST. The one exception is the local stack: when both URLs point at
// localhost or 127.0.0.1, ws:// and http:// are allowed too.
export function checkGameUrls(serverHost: string, gatewayUrl: string, botPageUrl: string): void {
  const gw = parseUrl('RS_GATEWAY_URL', gatewayUrl);
  const page = parseUrl('RS_BOT_PAGE_URL', botPageUrl);
  if (LOCAL_HOSTS.has(gw.hostname) && LOCAL_HOSTS.has(page.hostname)) {
    if (gw.protocol !== 'ws:' && gw.protocol !== 'wss:') throw new ConfigError('RS_GATEWAY_URL must start with ws:// or wss://');
    if (page.protocol !== 'http:' && page.protocol !== 'https:') throw new ConfigError('RS_BOT_PAGE_URL must start with http:// or https://');
    return;
  }
  const host = serverHost.toLowerCase();
  if (gw.protocol !== 'wss:' || gw.hostname !== host) {
    throw new ConfigError('RS_GATEWAY_URL must start with wss:// and use the host of RS_SERVER_HOST');
  }
  if (page.protocol !== 'https:' || page.hostname !== host) {
    throw new ConfigError('RS_BOT_PAGE_URL must start with https:// and use the host of RS_SERVER_HOST');
  }
}

// RS_CHROME_PATH names the Chrome binary. On the server it is the root-owned copy that the
// AppArmor profile allows to create user namespaces. Unset or empty gives null.
export function parseChromePath(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  if (!isAbsolute(raw)) throw new ConfigError('RS_CHROME_PATH must be an absolute path');
  return raw;
}

function parseInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer`);
  return Number(raw);
}

// Error messages name the variable only. They never include a value,
// because RS_PASSWORD is a secret. With requirePassword false (the bot in split mode, where
// gamelink holds the password), an empty RS_PASSWORD gives an empty password.
export function loadConfig(env: Record<string, string | undefined>, opts: { requirePassword?: boolean } = {}): Config {
  const serverHost = env.RS_SERVER_HOST || DEFAULT_HOST;
  if (REJECTED_HOSTS.has(serverHost)) {
    throw new ConfigError('RS_SERVER_HOST names a retired host; use rs-sdk.maxbittker.com');
  }

  const fps = parseInteger('RS_FPS', env.RS_FPS, 15);
  if (fps < FPS_MIN || fps > FPS_MAX) {
    throw new ConfigError(`RS_FPS must be from ${FPS_MIN} to ${FPS_MAX}`);
  }

  const proxyPort = parseInteger('PROXY_PORT', env.PROXY_PORT, 7790);
  if (proxyPort < 1 || proxyPort > 65535) {
    throw new ConfigError('PROXY_PORT must be from 1 to 65535');
  }

  const name = env.RS_ACCOUNT ?? '';
  if (!ACCOUNT_PATTERN.test(name)) {
    throw new ConfigError('RS_ACCOUNT must match ^[a-z0-9]{1,12}$');
  }

  const password = env.RS_PASSWORD ?? '';
  if (password === '' && opts.requirePassword !== false) {
    throw new ConfigError('RS_PASSWORD must not be empty');
  }
  // The rs-sdk client and engine refuse a password longer than 20 characters
  // (webclient Client.login and engine World.ts: "Password must be 1-20 characters.").
  if (password.length > PASSWORD_MAX) {
    throw new ConfigError(`RS_PASSWORD must be at most ${PASSWORD_MAX} characters`);
  }
  if (password !== '' && !PASSWORD_PATTERN.test(password)) {
    throw new ConfigError('RS_PASSWORD must match ^[A-Za-z0-9]{1,20}$');
  }

  const gatewayUrl = env.RS_GATEWAY_URL || `wss://${serverHost}/gateway`;
  const botPageUrl = env.RS_BOT_PAGE_URL || `https://${serverHost}/bot`;
  checkGameUrls(serverHost, gatewayUrl, botPageUrl);

  return {
    serverHost,
    gatewayUrl,
    botPageUrl,
    fps,
    proxyPort,
    account: { name, password },
    chromePath: parseChromePath(env.RS_CHROME_PATH),
  };
}

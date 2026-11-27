// Security helpers of the scripts that run a game tab, the proxy and a box child.
// scripts/run-helpers.ts re-exports them.
import { randomBytes } from 'node:crypto';

// 24 random bytes give 32 base64url characters.
export function newBootToken(): string {
  return randomBytes(24).toString('base64url');
}

// A box child holds only the boot token, but remove both secrets in case an SDK version prints one.
// A password shorter than 4 characters (such as the local dummy "x") is not replaced:
// replacing it would change ordinary words in the output and hide the result.
const MIN_REDACTED_PASSWORD_LENGTH = 4;
export function makeRedact(bootToken: string, password: string): (text: string) => string {
  return text => {
    let result = text.split(bootToken).join('<boot token>');
    if (password.length >= MIN_REDACTED_PASSWORD_LENGTH) result = result.split(password).join('<game password>');
    return result;
  };
}

// The command line of a box child. Bun loads a .env file from the working directory into
// every process that it starts, a child with an explicit environment included. --no-env-file
// stops that, so a .env file in the repository root cannot add a variable to the child.
export function boxChildCommand(script: string): string[] {
  return [process.execPath, '--no-env-file', script];
}

// The explicit environment allow list of a box child. It holds the boot token, never the game password.
export function boxChildEnv(opts: { account: string; bootToken: string; proxyPort: number; password: string }): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    BOT_USERNAME: opts.account,
    PASSWORD: opts.bootToken,
    GATEWAY_URL: `ws://127.0.0.1:${opts.proxyPort}`,
    SHOW_CHAT: 'true',
    AUTO_LAUNCH_BROWSER: 'false',
    TELEMETRY: 'false',
  };
  if (Object.values(env).some(v => v === opts.password)) throw new Error('the game password is in the child environment');
  return env;
}

// Runs one job: a body of AI-written TypeScript with `bot` and `sdk` in scope. The runner
// wraps the body in the rs-sdk runScript(), writes it to the scratch directory, and runs it
// in a child Bun process. The child gets an explicit environment allow list with the boot
// token of the proxy, never the game password, the Discord token or the API key.
// The proxy accepts actions only while the job flag is on, and the runner turns it on only
// for the life of the child.
//
// With boxUser set (Linux), the child runs as that second Unix user through sudo, so it
// cannot read the secret files of the bot or the environment of the bot process. After each
// job the runner kills every process of the box user, so no code of a job stays behind.
// Without boxUser, the child runs as the same user as the bot: a known gap (docs/security.md).
import { chmodSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface JobProxy {
  port: number;
  setJobActive(active: boolean): void;
}

export interface JobRunnerOptions {
  rootDir: string;            // repository root; the child runs here
  scratchDir: string;         // job files go here; emptied at start
  account: string;
  bootToken: string;
  secrets: string[];          // values that must never be in the child environment or the output
  proxy: JobProxy;
  bunPath?: string;           // default process.execPath; with boxUser, default /usr/local/bin/bun
  boxUser?: string | null;    // run jobs as this Unix user through sudo
  sudoPath?: string;          // default /usr/bin/sudo
  pkillPath?: string;         // default /usr/bin/pkill
}

export const BOX_ENV_NAMES = ['BOT_USERNAME', 'PASSWORD', 'GATEWAY_URL', 'SHOW_CHAT', 'AUTO_LAUNCH_BROWSER', 'TELEMETRY', 'BUN_RUNTIME_TRANSPILER_CACHE_PATH'];

// The command of a job child. With a box user, sudo keeps only the listed variables.
export function jobCommand(opts: Pick<JobRunnerOptions, 'boxUser' | 'bunPath' | 'sudoPath'>, file: string): string[] {
  if (!opts.boxUser) return [opts.bunPath ?? process.execPath, '--no-env-file', file];
  return [opts.sudoPath ?? '/usr/bin/sudo', '-n', '-u', opts.boxUser, `--preserve-env=${BOX_ENV_NAMES.join(',')}`, '--',
    opts.bunPath ?? '/usr/local/bin/bun', '--no-env-file', file];
}

export function boxKillCommand(opts: Pick<JobRunnerOptions, 'boxUser' | 'sudoPath' | 'pkillPath'>): string[] | null {
  if (!opts.boxUser) return null;
  return [opts.sudoPath ?? '/usr/bin/sudo', '-n', '-u', opts.boxUser, '--', opts.pkillPath ?? '/usr/bin/pkill', '-KILL', '-u', opts.boxUser];
}

export interface JobResult {
  exitCode: number;
  output: string;             // the tail of stdout and stderr, redacted
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

export const MAX_JOB_MS = 15 * 60_000;
export const OUTPUT_TAIL_CHARS = 6_000;
const KILL_GRACE_MS = 3_000;

export function wrapJobCode(body: string, runnerPath: string, timeoutMs: number): string {
  const spec = JSON.stringify(runnerPath.replace(/\\/g, '/'));
  return [
    `import { runScript } from ${spec};`,
    `await runScript(async (ctx) => {`,
    `  const { bot, sdk } = ctx;`,
    body,
    `}, { timeout: ${Math.floor(timeoutMs)} });`,
    '',
  ].join('\n');
}

export function tail(text: string, max = OUTPUT_TAIL_CHARS): string {
  return text.length <= max ? text : `[... ${text.length - max} characters cut ...]\n${text.slice(-max)}`;
}

export function redactAll(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('<secret>');
  return out;
}

export function jobChildEnv(opts: { account: string; bootToken: string; proxyPort: number; secrets: string[] }): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? process.env.USERPROFILE ?? '',
    BOT_USERNAME: opts.account,
    PASSWORD: opts.bootToken,
    GATEWAY_URL: `ws://127.0.0.1:${opts.proxyPort}`,
    SHOW_CHAT: 'true',
    AUTO_LAUNCH_BROWSER: 'false',
    TELEMETRY: 'false',
  };
  if (process.platform === 'win32' && process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  for (const v of Object.values(env)) {
    if (opts.secrets.some(s => s.length > 0 && v === s)) throw new Error('a secret is in the job environment');
  }
  return env;
}

export function createJobRunner(opts: JobRunnerOptions) {
  const runnerPath = resolve(opts.rootDir, 'vendor', 'rs-sdk', 'sdk', 'runner.ts');
  let count = 0;
  let running = false;

  rmSync(opts.scratchDir, { recursive: true, force: true });
  mkdirSync(opts.scratchDir, { recursive: true });
  // The box user reads the job files; it cannot write them.
  if (opts.boxUser) chmodSync(opts.scratchDir, 0o755);

  const killBox = async () => {
    const cmd = boxKillCommand(opts);
    if (!cmd) return;
    const p = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { PATH: '/usr/bin:/bin' } });
    await p.exited;
  };

  return {
    isRunning: () => running,

    async run(body: string, timeoutMs: number, signal?: AbortSignal): Promise<JobResult> {
      if (running) throw new Error('a job is already running');
      running = true;
      const limit = Math.min(Math.max(timeoutMs, 1_000), MAX_JOB_MS);
      const file = join(opts.scratchDir, `job-${++count}.ts`);
      const started = Date.now();
      let timedOut = false;
      let aborted = false;
      try {
        writeFileSync(file, wrapJobCode(body, runnerPath, limit), { mode: 0o644 });
        if (opts.boxUser) chmodSync(file, 0o644);
        const env = jobChildEnv({ account: opts.account, bootToken: opts.bootToken, proxyPort: opts.proxy.port, secrets: opts.secrets });
        if (opts.boxUser) { env.PATH = '/usr/bin:/bin'; env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = '0'; }
        opts.proxy.setJobActive(true);
        const child = Bun.spawn(jobCommand(opts, file), {
          cwd: opts.rootDir, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        });
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const stopChild = () => {
          child.kill('SIGTERM');
          killTimer = setTimeout(() => { child.kill('SIGKILL'); void killBox(); }, KILL_GRACE_MS);
        };
        // runScript has its own timeout; this one is the backstop, with room to print the state.
        const deadline = setTimeout(() => { timedOut = true; stopChild(); }, limit + 15_000);
        const onAbort = () => { aborted = true; stopChild(); };
        if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
        const outText = new Response(child.stdout as ReadableStream).text();
        const errText = new Response(child.stderr as ReadableStream).text();
        await child.exited;
        clearTimeout(deadline);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
        // Kill what the job left behind, so that its pipes close and no code of it stays.
        await killBox();
        const pipeWait = new Promise<string>(r => setTimeout(() => r(''), 5_000));
        const [out, err] = await Promise.all([Promise.race([outText, pipeWait]), Promise.race([errText, pipeWait])]);
        const joined = err.trim() ? `${out}\n--- stderr ---\n${err}` : out;
        return {
          exitCode: child.exitCode ?? -1,
          output: tail(redactAll(joined, [...opts.secrets, opts.bootToken])),
          timedOut,
          aborted,
          durationMs: Date.now() - started,
        };
      } finally {
        opts.proxy.setJobActive(false);
        running = false;
        rmSync(file, { force: true });
      }
    },
  };
}

export type JobRunner = ReturnType<typeof createJobRunner>;

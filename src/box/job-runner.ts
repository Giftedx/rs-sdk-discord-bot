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
  // A promise when the proxy is in the gamelink process; the runner waits for it.
  setJobActive(active: boolean): void | Promise<void>;
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
  protections?: boolean;      // default true: run src/box/protections.ts inside each job
  onSpawn?(pid: number): void; // called right after the spawn, for example to move the child into a cgroup
  maxJobMs?: number;          // the longest job; default DEFAULT_MAX_JOB_MS, at most MAX_JOB_MS
}

export const BOX_ENV_NAMES = ['BOT_USERNAME', 'PASSWORD', 'GATEWAY_URL', 'SHOW_CHAT', 'AUTO_LAUNCH_BROWSER', 'TELEMETRY', 'BUN_RUNTIME_TRANSPILER_CACHE_PATH'];

// The command of a job child. With a box user, sudo keeps only the listed variables.
export function jobCommand(opts: Pick<JobRunnerOptions, 'boxUser' | 'bunPath' | 'sudoPath'>, file: string): string[] {
  if (!opts.boxUser) return [opts.bunPath ?? process.execPath, '--smol', '--no-env-file', file];
  return [opts.sudoPath ?? '/usr/bin/sudo', '-n', '-u', opts.boxUser, `--preserve-env=${BOX_ENV_NAMES.join(',')}`, '--',
    opts.bunPath ?? '/usr/local/bin/bun', '--smol', '--no-env-file', file];
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

/** The hard ceiling of one job (AI_MAX_JOB_MIN at most 60). */
export const MAX_JOB_MS = 60 * 60_000;
/** The default limit of one job when the options give none. */
export const DEFAULT_MAX_JOB_MS = 15 * 60_000;
/** The time limit of one job: timeoutMs, at least 1 s and at most maxJobMs (itself at most MAX_JOB_MS). */
export function jobLimitMs(timeoutMs: number, maxJobMs = DEFAULT_MAX_JOB_MS): number {
  const cap = Math.min(Math.max(maxJobMs, 1_000), MAX_JOB_MS);
  return Math.min(Math.max(timeoutMs, 1_000), cap);
}
export const OUTPUT_TAIL_CHARS = 6_000;
const KILL_GRACE_MS = 3_000;
/** An abort with the reason 'shutdown' (the bot stops) kills the job after this short grace. */
export const SHUTDOWN_GRACE_MS = 500;

// With protectionsPath, the job imports startProtections() and runs it during the body.
// The body sees `protections` and can call protections.off().
export function wrapJobCode(body: string, runnerPath: string, timeoutMs: number, protectionsPath?: string): string {
  const spec = JSON.stringify(runnerPath.replace(/\\/g, '/'));
  if (!protectionsPath) {
    return [
      `import { runScript } from ${spec};`,
      `await runScript(async (ctx) => {`,
      `  const { bot, sdk } = ctx;`,
      body,
      `}, { timeout: ${Math.floor(timeoutMs)} });`,
      '',
    ].join('\n');
  }
  const prot = JSON.stringify(protectionsPath.replace(/\\/g, '/'));
  return [
    `import { runScript } from ${spec};`,
    `import { startProtections } from ${prot};`,
    `await runScript(async (ctx) => {`,
    `  const { bot, sdk } = ctx;`,
    `  const protections = startProtections(bot, sdk);`,
    `  try {`,
    body,
    `  } finally { protections.stop(); }`,
    `}, { timeout: ${Math.floor(timeoutMs)} });`,
    '',
  ].join('\n');
}

// `alreadyCut` counts characters that readTail dropped before this text.
export function tail(text: string, max = OUTPUT_TAIL_CHARS, alreadyCut = 0): string {
  const cut = Math.max(0, text.length - max) + alreadyCut;
  return cut === 0 ? text : `[... ${cut} characters cut ...]\n${text.slice(-max)}`;
}

/**
 * Reads a stream and keeps only its last `keep` characters, so that a job that prints without
 * end cannot fill the memory of the bot. `dropped` counts the characters it did not keep. The
 * window must be much larger than OUTPUT_TAIL_CHARS: a secret cut at the start of the window
 * is then outside the final tail, and redactAll still sees every whole secret in the tail.
 */
export async function readTail(stream: ReadableStream<Uint8Array>, keep = 64_000): Promise<{ text: string; dropped: number }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let dropped = 0;
  for (;;) {
    const { done, value } = await reader.read();
    text += decoder.decode(value, { stream: !done });
    if (text.length > keep * 2 || (done && text.length > keep)) {
      dropped += text.length - keep;
      text = text.slice(-keep);
    }
    if (done) return { text, dropped };
  }
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
  const protectionsPath = opts.protections === false ? undefined : resolve(opts.rootDir, 'src', 'box', 'protections.ts');
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
      const limit = jobLimitMs(timeoutMs, opts.maxJobMs);
      const file = join(opts.scratchDir, `job-${++count}.ts`);
      const started = Date.now();
      let timedOut = false;
      let aborted = false;
      try {
        writeFileSync(file, wrapJobCode(body, runnerPath, limit, protectionsPath), { mode: 0o644 });
        if (opts.boxUser) chmodSync(file, 0o644);
        const env = jobChildEnv({ account: opts.account, bootToken: opts.bootToken, proxyPort: opts.proxy.port, secrets: opts.secrets });
        if (opts.boxUser) { env.PATH = '/usr/bin:/bin'; env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = '0'; }
        await opts.proxy.setJobActive(true);
        const child = Bun.spawn(jobCommand(opts, file), {
          cwd: opts.rootDir, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        });
        try { opts.onSpawn?.(child.pid); } catch { /* a failed move only loses the limits */ }
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const stopChild = (graceMs = KILL_GRACE_MS) => {
          child.kill('SIGTERM');
          clearTimeout(killTimer);
          // A rejection in a timer is unhandled, and main.ts stops the bot on one.
          killTimer = setTimeout(() => { child.kill('SIGKILL'); killBox().catch(() => { /* the await after child.exited tries again */ }); }, graceMs);
        };
        // runScript has its own timeout; this one is the backstop, with room to print the state.
        const deadline = setTimeout(() => { timedOut = true; stopChild(); }, limit + 15_000);
        const onAbort = () => { aborted = true; stopChild(signal?.reason === 'shutdown' ? SHUTDOWN_GRACE_MS : KILL_GRACE_MS); };
        if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
        const outText = readTail(child.stdout as ReadableStream<Uint8Array>);
        const errText = readTail(child.stderr as ReadableStream<Uint8Array>);
        await child.exited;
        clearTimeout(deadline);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
        // Kill what the job left behind, so that its pipes close and no code of it stays.
        await killBox();
        let pipeTimer: ReturnType<typeof setTimeout> | undefined;
        const pipeWait = new Promise<{ text: string; dropped: number }>(r => { pipeTimer = setTimeout(() => r({ text: '', dropped: 0 }), 5_000); });
        const [out, err] = await Promise.all([Promise.race([outText, pipeWait]), Promise.race([errText, pipeWait])]);
        clearTimeout(pipeTimer);
        const joined = err.text.trim() ? `${out.text}\n--- stderr ---\n${err.text}` : out.text;
        return {
          exitCode: child.exitCode ?? -1,
          output: tail(redactAll(joined, [...opts.secrets, opts.bootToken]), OUTPUT_TAIL_CHARS, out.dropped + err.dropped),
          timedOut,
          aborted,
          durationMs: Date.now() - started,
        };
      } finally {
        await Promise.resolve()
          .then(() => opts.proxy.setJobActive(false))
          .catch(err => console.error(`job flag not turned off: ${err instanceof Error ? err.message : String(err)}`));
        running = false;
        rmSync(file, { force: true });
      }
    },
  };
}

export type JobRunner = ReturnType<typeof createJobRunner>;

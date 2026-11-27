// Checks the box user on a Linux machine, without a game connection.
// It runs jobs through the real job runner with BOX_USER, against a stand-in rs-sdk runner,
// and checks that a job cannot read the secret files or the environment of the bot, that
// it can read the code, and that no process of the box user stays after a job.
// Usage, as the bot user in the repository root:
//   BOX_USER=rsbox bun scripts/box-check.ts
// stdout gets one JSON line. Exit code 0 when every check passed.
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createJobRunner } from '../src/box/job-runner';
import { ROOT } from './run-helpers';

const boxUser = process.env.BOX_USER;
if (process.platform !== 'linux' || !boxUser) {
  console.error('usage (Linux): BOX_USER=<user> bun scripts/box-check.ts');
  process.exit(2);
}

// A stand-in repository root with a runner that only calls the job body.
const fakeRoot = join(ROOT, 'data', 'box-check');
rmSync(fakeRoot, { recursive: true, force: true });
mkdirSync(join(fakeRoot, 'vendor', 'rs-sdk', 'sdk'), { recursive: true });
for (const d of [fakeRoot, join(fakeRoot, 'vendor'), join(fakeRoot, 'vendor', 'rs-sdk'), join(fakeRoot, 'vendor', 'rs-sdk', 'sdk')]) chmodSync(d, 0o755);
writeFileSync(join(fakeRoot, 'vendor', 'rs-sdk', 'sdk', 'runner.ts'),
  'export async function runScript(fn: any) { const r = await fn({ bot: {}, sdk: {} }); console.log("RESULT " + JSON.stringify(r)); }\n', { mode: 0o644 });

const secretsDir = join(ROOT, 'secrets');
const secretFile = existsSync(join(secretsDir, 'account.env')) ? join(secretsDir, 'account.env') : null;
const flags: boolean[] = [];
const runner = createJobRunner({
  rootDir: fakeRoot, scratchDir: join(fakeRoot, 'jobs'), account: 'check', bootToken: 'box-check-token-0000',
  secrets: [], proxy: { port: 1, setJobActive: a => { flags.push(a); } }, boxUser,
  bunPath: process.env.BOX_BUN_PATH || '/usr/local/bin/bun',
});

const tryRead = (path: string) => `try { return 'READ ' + require('node:fs').readFileSync(${JSON.stringify(path)}, 'utf8').length; } catch (e) { return 'DENIED ' + e.code; }`;
const checks: Record<string, boolean> = {};
const outputs: Record<string, string> = {};

const who = await runner.run(`return require('node:os').userInfo().username + ' ' + process.env.PASSWORD + ' ' + (process.env.RS_PASSWORD ?? 'none');`, 30_000);
outputs.who = who.output.trim();
checks.runsAsBoxUser = who.output.includes(`RESULT "${boxUser} <secret> none"`) || who.output.includes(`RESULT "${boxUser} `);
checks.noGamePasswordInEnv = who.output.includes(' none"');

if (secretFile) {
  const s = await runner.run(tryRead(secretFile), 30_000);
  outputs.secretFile = s.output.trim();
  checks.cannotReadSecretFile = s.output.includes('DENIED');
}
const env = await runner.run(tryRead(`/proc/${process.pid}/environ`), 30_000);
outputs.botEnviron = env.output.trim();
checks.cannotReadBotEnviron = env.output.includes('DENIED');
const code = await runner.run(tryRead(join(ROOT, 'package.json')), 30_000);
outputs.code = code.output.trim();
checks.canReadCode = code.output.includes('READ ');

// A job that leaves a process behind. After the job, no process of the box user may stay.
await runner.run(`Bun.spawn(['sleep', '120'], { stdio: ['ignore', 'ignore', 'ignore'] }).unref(); return 'left a sleeper';`, 30_000);
const ps = Bun.spawnSync(['pgrep', '-u', boxUser]);
checks.noProcessAfterJob = ps.exitCode === 1;
outputs.pgrep = new TextDecoder().decode(ps.stdout).trim();
checks.flagOnlyDuringJobs = flags.length > 0 && flags.every((f, i) => f === (i % 2 === 0));

rmSync(fakeRoot, { recursive: true, force: true });
console.log(JSON.stringify({ checks, outputs }));
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);

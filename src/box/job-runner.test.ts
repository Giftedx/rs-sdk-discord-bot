import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boxKillCommand, createJobRunner, jobChildEnv, jobCommand, redactAll, tail, wrapJobCode } from './job-runner';

describe('job runner helpers', () => {
  test('wrapJobCode puts the body inside runScript with bot and sdk', () => {
    const src = wrapJobCode('await bot.chopTree();', 'C:\\x\\runner.ts', 60_000);
    expect(src).toContain('import { runScript } from "C:/x/runner.ts";');
    expect(src).toContain('const { bot, sdk } = ctx;');
    expect(src).toContain('await bot.chopTree();');
    expect(src).toContain('{ timeout: 60000 }');
    expect(src).not.toContain('startProtections');
  });

  test('wrapJobCode with a protections path starts and stops the protections around the body', () => {
    const src = wrapJobCode('return 1;', '/r/runner.ts', 1_000, 'C:\\r\\protections.ts');
    expect(src).toContain('import { startProtections } from "C:/r/protections.ts";');
    const start = src.indexOf('const protections = startProtections(bot, sdk);');
    expect(start).toBeGreaterThan(0);
    expect(src.indexOf('return 1;')).toBeGreaterThan(start);
    expect(src).toContain('finally { protections.stop(); }');
  });

  test('the job environment holds the boot token and no secret', () => {
    const env = jobChildEnv({ account: 'abc', bootToken: 'tok', proxyPort: 7790, secrets: ['gamepass123'] });
    expect(env.PASSWORD).toBe('tok');
    expect(env.GATEWAY_URL).toBe('ws://127.0.0.1:7790');
    expect(Object.keys(env)).not.toContain('DISCORD_TOKEN');
    expect(() => jobChildEnv({ account: 'abc', bootToken: 'same', proxyPort: 1, secrets: ['same'] })).toThrow();
  });

  test('jobCommand with a box user uses sudo and keeps the token out of argv', () => {
    expect(jobCommand({}, '/j.ts')).toEqual([process.execPath, '--no-env-file', '/j.ts']);
    const cmd = jobCommand({ boxUser: 'rsbox' }, '/j.ts');
    expect(cmd.slice(0, 4)).toEqual(['/usr/bin/sudo', '-n', '-u', 'rsbox']);
    expect(cmd[4]).toStartWith('--preserve-env=BOT_USERNAME,PASSWORD,GATEWAY_URL');
    expect(cmd.slice(-3)).toEqual(['/usr/local/bin/bun', '--no-env-file', '/j.ts']);
    expect(boxKillCommand({})).toBeNull();
    expect(boxKillCommand({ boxUser: 'rsbox' })).toEqual(['/usr/bin/sudo', '-n', '-u', 'rsbox', '--', '/usr/bin/pkill', '-KILL', '-u', 'rsbox']);
  });

  test('redactAll and tail', () => {
    expect(redactAll('a sekret b', ['sekret'])).toBe('a <secret> b');
    expect(tail('x'.repeat(10), 4)).toContain('6 characters cut');
  });
});

describe('job runner', () => {
  // A fake repository root whose vendor runner runs the body without a game connection.
  function fakeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'jobroot-'));
    mkdirSync(join(root, 'vendor', 'rs-sdk', 'sdk'), { recursive: true });
    writeFileSync(join(root, 'vendor', 'rs-sdk', 'sdk', 'runner.ts'),
      'export async function runScript(fn: any) { console.log("pw=" + process.env.PASSWORD); const r = await fn({ bot: {}, sdk: {} }); console.log("result=" + r); }\n');
    // The real protections file, so the test covers its import into a job.
    mkdirSync(join(root, 'src', 'box'), { recursive: true });
    copyFileSync(join(import.meta.dir, 'protections.ts'), join(root, 'src', 'box', 'protections.ts'));
    return root;
  }

  test('runs the body, turns the job flag on only during the job, and redacts the token', async () => {
    const root = fakeRoot();
    const flags: boolean[] = [];
    const runner = createJobRunner({
      rootDir: root, scratchDir: join(root, 'scratch'), account: 'abc', bootToken: 'boot-token-1234',
      secrets: ['gamepass123'], proxy: { port: 1, setJobActive: a => flags.push(a) },
    });
    const r = await runner.run('console.log("hello " + typeof bot);', 10_000);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('hello object');
    expect(r.output).toContain('pw=<secret>');
    expect(r.output).not.toContain('boot-token-1234');
    expect(flags).toEqual([true, false]);
    expect(runner.isRunning()).toBe(false);
  });

  test('the body can turn the protections off and its return value passes through', async () => {
    const root = fakeRoot();
    const runner = createJobRunner({
      rootDir: root, scratchDir: join(root, 'scratch'), account: 'abc', bootToken: 'boot-token-1234',
      secrets: [], proxy: { port: 1, setJobActive: () => {} },
    });
    const r = await runner.run('protections.off(); return JSON.stringify(protections.status());', 10_000);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('result={"enabled":false,"eats":0,"flees":0}');
  });

  test('abort stops the job', async () => {
    const root = fakeRoot();
    const runner = createJobRunner({
      rootDir: root, scratchDir: join(root, 'scratch'), account: 'abc', bootToken: 'boot-token-1234',
      secrets: [], proxy: { port: 1, setJobActive: () => {} },
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await runner.run('await new Promise(r => setTimeout(r, 30_000));', 60_000, ac.signal);
    expect(r.aborted).toBe(true);
    expect(r.durationMs).toBeLessThan(10_000);
  });
});

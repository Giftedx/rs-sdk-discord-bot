import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'puppeteer';
import { createProfileDir, launchBrowserWithProfile } from './browser-profile';
import type { BrowserLaunchOpts } from './game-tab';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prof-test-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('uses the shm root when it exists; dispose removes the directory', () => {
  const p = createProfileDir({ shmRoot: dir, tmpRoot: join(dir, 'nope') });
  expect(p.onTmpfs).toBe(true);
  expect(p.path.startsWith(join(dir, 'rs-chrome-'))).toBe(true);
  writeFileSync(join(p.path, 'Cookies'), 'x');
  if (process.platform !== 'win32') expect(statSync(p.path).mode & 0o777).toBe(0o700);
  p.dispose();
  expect(existsSync(p.path)).toBe(false);
  p.dispose();
});

test('falls back to the temp root when there is no shm root', () => {
  const p = createProfileDir({ shmRoot: join(dir, 'no-shm'), tmpRoot: dir });
  expect(p.onTmpfs).toBe(false);
  expect(p.path.startsWith(join(dir, 'rs-chrome-'))).toBe(true);
  p.dispose();
});

test('two profiles are different directories', () => {
  const a = createProfileDir({ shmRoot: dir });
  const b = createProfileDir({ shmRoot: dir });
  expect(a.path).not.toBe(b.path);
  a.dispose();
  b.dispose();
});

test('launchBrowserWithProfile passes the profile and removes it on close', async () => {
  let seen: BrowserLaunchOpts | null = null;
  let closed = false;
  const fake = { close: async () => { closed = true; } } as unknown as Browser;
  const pb = await launchBrowserWithProfile({ executablePath: '/x' }, { shmRoot: dir, launch: async o => { seen = o; return fake; } });
  expect(seen!).toEqual({ executablePath: '/x', userDataDir: pb.profile.path });
  expect(existsSync(pb.profile.path)).toBe(true);
  await pb.close();
  expect(closed).toBe(true);
  expect(existsSync(pb.profile.path)).toBe(false);
});

test('a failed launch removes the profile', async () => {
  let path = '';
  const launch = async (o: BrowserLaunchOpts): Promise<Browser> => { path = o.userDataDir!; throw new Error('no chrome'); };
  await expect(launchBrowserWithProfile({}, { shmRoot: dir, launch })).rejects.toThrow('no chrome');
  expect(path).not.toBe('');
  expect(existsSync(path)).toBe(false);
});

import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'puppeteer';
import { launchBrowser, type BrowserLaunchOpts } from './game-tab';

// Removes the rs-chrome-* profiles that an earlier run of this user left after a crash or a
// SIGKILL. Call it at start, before the first launch. Returns the number removed.
export function sweepStaleProfiles(roots: string[] = ['/dev/shm', tmpdir()], uid: number | null = process.getuid?.() ?? null): number {
  let removed = 0;
  for (const root of roots) {
    let names: string[];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('rs-chrome-')) continue;
      const path = join(root, name);
      try {
        const st = statSync(path);
        if (!st.isDirectory() || (uid !== null && st.uid !== uid)) continue;
        rmSync(path, { recursive: true, force: true });
        removed++;
      } catch { /* gone or not ours */ }
    }
  }
  return removed;
}

export interface ProfileDir {
  readonly path: string;
  // True when the directory is on /dev/shm (tmpfs): cookies and cache never touch a disk.
  readonly onTmpfs: boolean;
  dispose(): void;
}

export interface ProfileDirDeps {
  shmRoot?: string;  // default /dev/shm
  tmpRoot?: string;  // default os.tmpdir()
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// A fresh Chromium profile directory, mode 700. Each launch gets its own, so no state of an old
// session (cookies, local storage) carries over.
export function createProfileDir(deps: ProfileDirDeps = {}): ProfileDir {
  const shmRoot = deps.shmRoot ?? '/dev/shm';
  const tmpRoot = deps.tmpRoot ?? tmpdir();
  let path: string | null = null;
  let onTmpfs = false;
  if (isDir(shmRoot)) {
    try {
      path = mkdtempSync(join(shmRoot, 'rs-chrome-'));
      onTmpfs = true;
    } catch {
      path = null;
    }
  }
  if (path === null) path = mkdtempSync(join(tmpRoot, 'rs-chrome-'));
  chmodSync(path, 0o700);
  const dir = path;
  let disposed = false;
  return {
    path: dir,
    onTmpfs,
    dispose() {
      if (disposed) return;
      disposed = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface ProfiledBrowser {
  browser: Browser;
  profile: ProfileDir;
  // Closes the browser, then removes its profile.
  close(): Promise<void>;
}

export async function launchBrowserWithProfile(
  opts: Omit<BrowserLaunchOpts, 'userDataDir'> = {},
  deps: ProfileDirDeps & { launch?: (o: BrowserLaunchOpts) => Promise<Browser> } = {},
): Promise<ProfiledBrowser> {
  const profile = createProfileDir(deps);
  let browser: Browser;
  try {
    browser = await (deps.launch ?? launchBrowser)({ ...opts, userDataDir: profile.path });
  } catch (err) {
    profile.dispose();
    throw err;
  }
  return {
    browser,
    profile,
    async close() {
      try {
        await browser.close();
      } finally {
        profile.dispose();
      }
    },
  };
}

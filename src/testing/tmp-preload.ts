// Test preload (bunfig.toml): each test run gets its own temporary directory, and the run
// removes it at the end. Tests make many temporary directories with os.tmpdir(); without this
// they stay in /tmp after every run.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runDir = mkdtempSync(join(tmpdir(), 'rs-bot-tests-'));
process.env.TMPDIR = runDir;
process.env.TMP = runDir;
process.env.TEMP = runDir;
process.on('exit', () => {
  try { rmSync(runDir, { recursive: true, force: true }); } catch { /* a file can still be open on Windows */ }
});

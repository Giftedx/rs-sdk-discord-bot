// Linux /proc readers for the RAM and CPU of a process tree.
// The parsers are pure. processTree, sampleTree and readMeminfoKb read /proc and work on Linux only.
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';

export interface Sample {
  pssMb: number;                // sum of Pss at the end of the window
  cpuPercentOfOneCore: number;  // 100 = one core busy for the whole window
  processes: number;            // processes in the tree at the end of the window (the Pss count)
  cpuProcesses: number;         // processes present at both ends of the window (the CPU count)
  processesAtStart: number;
  pssUnreadable: number;        // end processes without a readable smaps_rollup (ended or no access)
  windowMs: number;             // measured length of the window
}

export function parsePssKb(smapsRollup: string): number {
  const m = /^Pss:\s+(\d+)\s+kB/m.exec(smapsRollup);
  if (!m) throw new Error('smaps_rollup has no Pss line');
  return Number(m[1]);
}

// Fields after the last ')' start at field 3 (state). utime and stime are fields 14 and 15.
function statFields(stat: string): string[] {
  const close = stat.lastIndexOf(')');
  if (close < 0) throw new Error('stat has no process name');
  return stat.slice(close + 1).trim().split(/\s+/);
}

export function parseCpuTicks(stat: string): number {
  const f = statFields(stat);
  const utime = Number(f[14 - 3]);
  const stime = Number(f[15 - 3]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) throw new Error('stat has no utime or stime');
  return utime + stime;
}

// Field 22 (starttime) tells a reused PID from the process that had it before.
function parseStartTime(stat: string): number {
  return Number(statFields(stat)[22 - 3]);
}

export function parseChildPids(childrenFile: string): number[] {
  return childrenFile.split(/\s+/).filter(s => s !== '').map(Number);
}

export function parseMeminfoKb(meminfo: string, key: string): number {
  const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(meminfo);
  if (!m) throw new Error(`meminfo has no ${key} line`);
  return Number(m[1]);
}

const readProcFile = (p: string): string => {
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
};

function listProcTasks(pid: number): number[] {
  try { return readdirSync(`/proc/${pid}/task`).map(Number); } catch { return []; }
}

// The kernel lists a child in the children file of the thread that forked it,
// so the walk reads the file of every thread. With an injected reader and no
// task lister, each process has one thread with its own PID.
export function processTree(
  rootPid: number,
  readFile: (p: string) => string = readProcFile,
  listTasks: (pid: number) => number[] = readFile === readProcFile ? listProcTasks : pid => [pid],
): number[] {
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const tid of listTasks(pid)) {
      for (const child of parseChildPids(readFile(`/proc/${pid}/task/${tid}/children`))) {
        if (!seen.has(child)) { seen.add(child); queue.push(child); }
      }
    }
  }
  return [...seen];
}

function requireLinux(what: string): void {
  if (process.platform !== 'linux') throw new Error(`${what} reads /proc and works on Linux only (this is ${process.platform})`);
}

let cachedClockTicks: number | null = null;
export function clockTicksPerSecond(): number {
  if (cachedClockTicks !== null) return cachedClockTicks;
  let ticks = 100;
  try {
    const r = Bun.spawnSync(['getconf', 'CLK_TCK']);
    const n = Number(r.stdout.toString().trim());
    if (r.exitCode === 0 && Number.isInteger(n) && n > 0) ticks = n;
  } catch { /* keep the Linux default */ }
  cachedClockTicks = ticks;
  return ticks;
}

interface CpuReading { ticks: number; start: number; }

function readCpu(pids: number[]): Map<number, CpuReading> {
  const out = new Map<number, CpuReading>();
  for (const pid of pids) {
    const stat = readProcFile(`/proc/${pid}/stat`);
    if (stat === '') continue;  // the process ended
    out.set(pid, { ticks: parseCpuTicks(stat), start: parseStartTime(stat) });
  }
  return out;
}

function trees(rootPids: number[]): number[] {
  return [...new Set(rootPids.flatMap(pid => processTree(pid)))];
}

export interface ProcInfo { pid: number; argv0: string; startTicks: number; }

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);

// Chromium starts chrome_crashpad_handler with a double fork, so it leaves the
// browser tree. A companion runs a program from the browser's directory, is not
// in the tree, and started no earlier than the browser and at most maxGapTicks later.
export function findCompanions(browser: ProcInfo, all: ProcInfo[], tree: ReadonlySet<number>, maxGapTicks: number): number[] {
  const dir = dirOf(browser.argv0);
  return all
    .filter(p => !tree.has(p.pid) && dir !== '' && dirOf(p.argv0) === dir
      && p.startTicks >= browser.startTicks && p.startTicks - browser.startTicks <= maxGapTicks)
    .map(p => p.pid);
}

// argv0 is the executable path from /proc/<pid>/exe. Chromium rewrites its
// cmdline as one string with spaces, so the cmdline is not usable for this.
export function readProcInfo(pid: number): ProcInfo | null {
  const stat = readProcFile(`/proc/${pid}/stat`);
  if (stat === '') return null;
  let argv0 = '';
  try { argv0 = readlinkSync(`/proc/${pid}/exe`); } catch { /* another user's process, or it ended */ }
  return { pid, argv0, startTicks: parseStartTime(stat) };
}

// The companions of a running browser process, found from all processes in /proc.
export function browserCompanions(browserPid: number, maxGapMs = 5_000): number[] {
  requireLinux('browserCompanions');
  const browser = readProcInfo(browserPid);
  if (!browser) return [];
  const all = readdirSync('/proc').filter(d => /^\d+$/.test(d)).map(Number)
    .map(readProcInfo).filter((p): p is ProcInfo => p !== null);
  return findCompanions(browser, all, new Set(processTree(browserPid)), Math.round(maxGapMs / 1000 * clockTicksPerSecond()));
}

// Pss now, over the trees of the given roots.
export function readTreesPss(rootPids: number[]): { pssMb: number; processes: number } {
  requireLinux('readTreesPss');
  let kb = 0;
  let processes = 0;
  for (const pid of trees(rootPids)) {
    const text = readProcFile(`/proc/${pid}/smaps_rollup`);
    if (text === '') continue;
    kb += parsePssKb(text);
    processes++;
  }
  return { pssMb: kb / 1024, processes };
}

export function sampleTree(rootPid: number, windowMs: number): Promise<Sample> {
  return sampleTrees([rootPid], windowMs);
}

// One sample over the union of the trees of the given roots.
export async function sampleTrees(rootPids: number[], windowMs: number): Promise<Sample> {
  requireLinux('sampleTree');
  const hz = clockTicksPerSecond();
  const before = readCpu(trees(rootPids));
  const t0 = performance.now();
  await new Promise(r => setTimeout(r, windowMs));
  const endPids = trees(rootPids);
  const after = readCpu(endPids);
  const elapsedMs = performance.now() - t0;

  let deltaTicks = 0;
  let cpuProcesses = 0;
  for (const [pid, b] of before) {
    const a = after.get(pid);
    if (!a || a.start !== b.start) continue;  // ended, or the PID was reused: counts as zero
    deltaTicks += a.ticks - b.ticks;
    cpuProcesses++;
  }

  let pssKb = 0;
  let processes = 0;
  let pssUnreadable = 0;
  for (const pid of endPids) {
    const text = readProcFile(`/proc/${pid}/smaps_rollup`);
    if (text === '') { pssUnreadable++; continue; }
    pssKb += parsePssKb(text);
    processes++;
  }

  return {
    pssMb: pssKb / 1024,
    cpuPercentOfOneCore: (deltaTicks / hz) / (elapsedMs / 1000) * 100,
    processes,
    cpuProcesses,
    processesAtStart: before.size,
    pssUnreadable,
    windowMs: Math.round(elapsedMs),
  };
}

export function readMeminfoKb(): { memTotalKb: number; memAvailableKb: number } {
  requireLinux('readMeminfoKb');
  const text = readFileSync('/proc/meminfo', 'utf8');
  return { memTotalKb: parseMeminfoKb(text, 'MemTotal'), memAvailableKb: parseMeminfoKb(text, 'MemAvailable') };
}

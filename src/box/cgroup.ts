import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Job limits through cgroup v2 delegation. The systemd unit of the bot has Delegate=yes, so the
// bot owns the subtree of its own cgroup:
//
//   <own>/            subtree_control: +memory +pids (+cpu)
//   <own>/main/       the processes of the bot (cgroup v2 forbids processes in an inner node)
//   <own>/jobs/       the processes of all jobs, with memory.max, pids.max and cpu.max
//
// Every function returns { ok: false, reason } and does not throw when cgroup v2 or the
// delegation is not there (Windows, WSL, a unit without Delegate=yes).

export type Unavailable = { ok: false; reason: string };
export type CgroupResult<T = undefined> = ({ ok: true } & (T extends undefined ? {} : { value: T })) | Unavailable;

export interface CgroupOptions {
  root?: string;            // default /sys/fs/cgroup
  selfCgroupFile?: string;  // default /proc/self/cgroup
  kill?: (pid: number) => void; // fallback when cgroup.kill is missing (kernel < 5.14)
}

export interface JobLimits {
  memoryBytes?: number | 'max';
  pids?: number | 'max';
  // cpu.max: quotaUs of CPU time in each periodUs. 50_000 of 100_000 is half of one CPU.
  cpu?: { quotaUs: number | 'max'; periodUs: number };
}

export interface JobCgroup {
  readonly path: string;
  readonly controllers: readonly string[];
  setLimits(limits: JobLimits): CgroupResult;
  addProcess(pid: number): CgroupResult;
  pids(): number[];
  killAll(): CgroupResult;
}

const REQUIRED = ['memory', 'pids'];

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function no(reason: string): Unavailable {
  return { ok: false, reason };
}

function readPids(file: string): number[] {
  return readFileSync(file, 'utf8').split(/\s+/).filter(Boolean).map(Number).filter(n => Number.isInteger(n) && n > 0);
}

// The cgroup v2 path of this process, from the "0::<path>" line of /proc/self/cgroup.
export function detectOwnCgroup(opts: CgroupOptions = {}): CgroupResult<string> {
  const root = opts.root ?? '/sys/fs/cgroup';
  const selfFile = opts.selfCgroupFile ?? '/proc/self/cgroup';
  let text: string;
  try {
    text = readFileSync(selfFile, 'utf8');
  } catch {
    return no(`${selfFile} is missing: no cgroup support on this system.`);
  }
  const line = text.split('\n').find(l => l.startsWith('0::'));
  if (!line) return no('No cgroup v2 entry in /proc/self/cgroup (a cgroup v1 or hybrid system).');
  const rel = line.slice(3).trim();
  if (!rel.startsWith('/') || rel.split('/').includes('..')) return no(`An unexpected cgroup path: ${rel}`);
  // A process in the root cgroup has no delegated subtree.
  if (rel === '/') return no('The bot runs in the root cgroup: no delegated subtree.');
  // After prepareJobCgroup, the bot itself is in <own>/main.
  const own = rel.endsWith('/main') ? rel.slice(0, -'/main'.length) : rel;
  const path = join(root, own);
  if (!existsSync(join(path, 'cgroup.controllers'))) return no(`${path} is not a cgroup v2 directory.`);
  return { ok: true, value: path };
}

export function prepareJobCgroup(opts: CgroupOptions = {}): CgroupResult<JobCgroup> {
  const own = detectOwnCgroup(opts);
  if (!own.ok) return own;
  const base = own.value;
  let available: string[];
  try {
    available = readFileSync(join(base, 'cgroup.controllers'), 'utf8').split(/\s+/).filter(Boolean);
  } catch (err) {
    return no(`Cannot read the controllers of ${base}: ${message(err)}`);
  }
  const missing = REQUIRED.filter(c => !available.includes(c));
  if (missing.length > 0) return no(`The controllers ${missing.join(', ')} are not delegated to ${base} (Delegate=yes?).`);
  const wanted = [...REQUIRED, ...(available.includes('cpu') ? ['cpu'] : [])];

  const main = join(base, 'main');
  const jobs = join(base, 'jobs');
  try {
    mkdirSync(main, { recursive: true });
    // New processes can start while the old ones move, so repeat until the parent is empty.
    for (let i = 0; i < 5; i++) {
      const left = readPids(join(base, 'cgroup.procs'));
      if (left.length === 0) break;
      for (const pid of left) {
        try {
          writeFileSync(join(main, 'cgroup.procs'), String(pid));
        } catch (err) {
          // ESRCH: the process stopped between the read and the move.
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
        }
      }
    }
    const enabled = readFileSync(join(base, 'cgroup.subtree_control'), 'utf8').split(/\s+/).filter(Boolean);
    const toEnable = wanted.filter(c => !enabled.includes(c));
    if (toEnable.length > 0) writeFileSync(join(base, 'cgroup.subtree_control'), toEnable.map(c => `+${c}`).join(' '));
    mkdirSync(jobs, { recursive: true });
  } catch (err) {
    return no(`Cannot prepare the job cgroup under ${base}: ${message(err)}`);
  }
  return { ok: true, value: jobCgroupAt(jobs, wanted, opts.kill ?? (pid => process.kill(pid, 'SIGKILL'))) };
}

function jobCgroupAt(path: string, controllers: string[], kill: (pid: number) => void): JobCgroup {
  const write = (file: string, value: string): CgroupResult => {
    try {
      writeFileSync(join(path, file), value);
      return { ok: true };
    } catch (err) {
      return no(`Cannot write ${file} of ${path}: ${message(err)}`);
    }
  };
  const self: JobCgroup = {
    path,
    controllers,
    setLimits(limits) {
      if (limits.memoryBytes !== undefined) {
        const r = write('memory.max', String(limits.memoryBytes));
        if (!r.ok) return r;
        // Without this, a job past memory.max goes to swap instead of the OOM killer. The file is
        // there only when the kernel counts swap.
        if (existsSync(join(path, 'memory.swap.max'))) {
          const s = write('memory.swap.max', limits.memoryBytes === 'max' ? 'max' : '0');
          if (!s.ok) return s;
        }
      }
      if (limits.pids !== undefined) {
        const r = write('pids.max', String(limits.pids));
        if (!r.ok) return r;
      }
      if (limits.cpu !== undefined) {
        if (!controllers.includes('cpu')) return no('The cpu controller is not delegated: cpu.max is not set.');
        const r = write('cpu.max', `${limits.cpu.quotaUs} ${limits.cpu.periodUs}`);
        if (!r.ok) return r;
      }
      return { ok: true };
    },
    addProcess(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return no(`Not a process id: ${pid}`);
      return write('cgroup.procs', String(pid));
    },
    pids() {
      try {
        return readPids(join(path, 'cgroup.procs'));
      } catch {
        return [];
      }
    },
    killAll() {
      if (existsSync(join(path, 'cgroup.kill'))) return write('cgroup.kill', '1');
      for (const pid of self.pids()) {
        try {
          kill(pid);
        } catch {
          // The process stopped already.
        }
      }
      return { ok: true };
    },
  };
  return self;
}

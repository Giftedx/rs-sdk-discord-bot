import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectOwnCgroup, prepareJobCgroup } from './cgroup';

let dir: string;
let root: string;
let selfCgroupFile: string;
const UNIT = '/system.slice/rs-bot.service';

function fakeTree(controllers = 'cpuset cpu io memory pids', procs = '100\n101\n') {
  const own = join(root, UNIT);
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, 'cgroup.controllers'), controllers);
  writeFileSync(join(own, 'cgroup.subtree_control'), '');
  writeFileSync(join(own, 'cgroup.procs'), procs);
  writeFileSync(selfCgroupFile, `0::${UNIT}\n`);
  return own;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cg-test-'));
  root = join(dir, 'cgroup');
  selfCgroupFile = join(dir, 'self-cgroup');
  mkdirSync(root);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('no /proc/self/cgroup: unavailable', () => {
  expect(detectOwnCgroup({ root, selfCgroupFile: join(dir, 'missing') }).ok).toBe(false);
});

test('a cgroup v1 file: unavailable', () => {
  writeFileSync(selfCgroupFile, '12:memory:/user.slice\n');
  expect(detectOwnCgroup({ root, selfCgroupFile }).ok).toBe(false);
});

test('the root cgroup and a path with .. are unavailable', () => {
  writeFileSync(selfCgroupFile, '0::/\n');
  expect(detectOwnCgroup({ root, selfCgroupFile }).ok).toBe(false);
  writeFileSync(selfCgroupFile, '0::/a/../../etc\n');
  expect(detectOwnCgroup({ root, selfCgroupFile }).ok).toBe(false);
});

test('a path with no cgroup directory: unavailable', () => {
  writeFileSync(selfCgroupFile, `0::${UNIT}\n`);
  expect(detectOwnCgroup({ root, selfCgroupFile }).ok).toBe(false);
});

test('detects the own cgroup, also after the move into main', () => {
  const own = fakeTree();
  expect(detectOwnCgroup({ root, selfCgroupFile })).toEqual({ ok: true, value: own });
  writeFileSync(selfCgroupFile, `0::${UNIT}/main\n`);
  expect(detectOwnCgroup({ root, selfCgroupFile })).toEqual({ ok: true, value: own });
});

test('no memory or pids controller: unavailable with the reason', () => {
  fakeTree('cpu io');
  const r = prepareJobCgroup({ root, selfCgroupFile });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain('memory, pids');
});

test('prepare moves the bot into main, enables controllers and makes jobs', () => {
  const own = fakeTree();
  // The fake parent keeps its pids, so the loop repeats; the kernel empties it on each move.
  const r = prepareJobCgroup({ root, selfCgroupFile });
  if (!r.ok) throw new Error(r.reason);
  expect(r.value.path).toBe(join(own, 'jobs'));
  expect(r.value.controllers).toEqual(['memory', 'pids', 'cpu']);
  // The fake file keeps the last write only; the kernel takes one pid for each write.
  expect(readFileSync(join(own, 'main', 'cgroup.procs'), 'utf8')).toBe('101');
  expect(readFileSync(join(own, 'cgroup.subtree_control'), 'utf8')).toBe('+memory +pids +cpu');
});

test('controllers that are on already are not enabled again', () => {
  const own = fakeTree('memory pids cpu', '');
  writeFileSync(join(own, 'cgroup.subtree_control'), 'memory pids');
  const r = prepareJobCgroup({ root, selfCgroupFile });
  if (!r.ok) throw new Error(r.reason);
  expect(readFileSync(join(own, 'cgroup.subtree_control'), 'utf8')).toBe('+cpu');
});

test('no cpu controller: limits without cpu still work, cpu.max is refused', () => {
  const own = fakeTree('memory pids', '');
  const r = prepareJobCgroup({ root, selfCgroupFile });
  if (!r.ok) throw new Error(r.reason);
  expect(readFileSync(join(own, 'cgroup.subtree_control'), 'utf8')).toBe('+memory +pids');
  expect(r.value.setLimits({ memoryBytes: 1024, pids: 64 })).toEqual({ ok: true });
  expect(r.value.setLimits({ cpu: { quotaUs: 50_000, periodUs: 100_000 } }).ok).toBe(false);
});

test('setLimits, addProcess, pids', () => {
  fakeTree();
  const r = prepareJobCgroup({ root, selfCgroupFile });
  if (!r.ok) throw new Error(r.reason);
  const jobs = r.value;
  expect(jobs.setLimits({ memoryBytes: 512 * 1024 * 1024, pids: 128, cpu: { quotaUs: 50_000, periodUs: 100_000 } })).toEqual({ ok: true });
  expect(readFileSync(join(jobs.path, 'memory.max'), 'utf8')).toBe('536870912');
  expect(readFileSync(join(jobs.path, 'pids.max'), 'utf8')).toBe('128');
  expect(readFileSync(join(jobs.path, 'cpu.max'), 'utf8')).toBe('50000 100000');
  expect(jobs.setLimits({ memoryBytes: 'max' })).toEqual({ ok: true });
  expect(readFileSync(join(jobs.path, 'memory.max'), 'utf8')).toBe('max');
  expect(existsSync(join(jobs.path, 'memory.swap.max'))).toBe(false);
  writeFileSync(join(jobs.path, 'memory.swap.max'), 'max');
  expect(jobs.setLimits({ memoryBytes: 1024 })).toEqual({ ok: true });
  expect(readFileSync(join(jobs.path, 'memory.swap.max'), 'utf8')).toBe('0');
  expect(jobs.setLimits({ memoryBytes: 'max' })).toEqual({ ok: true });
  expect(readFileSync(join(jobs.path, 'memory.swap.max'), 'utf8')).toBe('max');
  expect(jobs.addProcess(4242)).toEqual({ ok: true });
  expect(jobs.pids()).toEqual([4242]);
  expect(jobs.addProcess(0).ok).toBe(false);
  expect(jobs.addProcess(1.5).ok).toBe(false);
});

test('killAll writes cgroup.kill when it exists', () => {
  fakeTree();
  const r = prepareJobCgroup({ root, selfCgroupFile, kill: () => { throw new Error('not used'); } });
  if (!r.ok) throw new Error(r.reason);
  writeFileSync(join(r.value.path, 'cgroup.kill'), '');
  expect(r.value.killAll()).toEqual({ ok: true });
  expect(readFileSync(join(r.value.path, 'cgroup.kill'), 'utf8')).toBe('1');
});

test('killAll without cgroup.kill signals each process', () => {
  fakeTree();
  const killed: number[] = [];
  const r = prepareJobCgroup({ root, selfCgroupFile, kill: pid => { killed.push(pid); if (pid === 8) throw new Error('ESRCH'); } });
  if (!r.ok) throw new Error(r.reason);
  writeFileSync(join(r.value.path, 'cgroup.procs'), '7\n8\n9\n');
  expect(r.value.killAll()).toEqual({ ok: true });
  expect(killed).toEqual([7, 8, 9]);
});

test('a write that fails is unavailable, not a throw', () => {
  fakeTree();
  const r = prepareJobCgroup({ root, selfCgroupFile });
  if (!r.ok) throw new Error(r.reason);
  mkdirSync(join(r.value.path, 'pids.max'));
  const w = r.value.setLimits({ pids: 10 });
  expect(w.ok).toBe(false);
  if (!w.ok) expect(w.reason).toContain('pids.max');
});

test('a subtree that cannot be written is unavailable', () => {
  const own = fakeTree();
  rmSync(join(own, 'cgroup.subtree_control'));
  mkdirSync(join(own, 'cgroup.subtree_control'));
  expect(prepareJobCgroup({ root, selfCgroupFile }).ok).toBe(false);
});

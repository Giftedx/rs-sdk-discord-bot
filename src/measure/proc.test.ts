import { expect, test } from 'bun:test';
import { findCompanions, parseChildPids, parseCpuTicks, parsePssKb, processTree } from './proc';

test('parsePssKb reads the Pss line', () => {
  expect(parsePssKb('Rss:  2000 kB\nPss:             1234 kB\nPss_Anon: 5 kB\n')).toBe(1234);
});
test('parseCpuTicks handles spaces and brackets in the name', () => {
  const stat = '123 (Web Content (x)) S 1 1 1 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 5 0 100 0 0';
  expect(parseCpuTicks(stat)).toBe(300);
});
test('parseChildPids reads a list and an empty file', () => {
  expect(parseChildPids('12 34 56 \n')).toEqual([12, 34, 56]);
  expect(parseChildPids('')).toEqual([]);
});
test('processTree walks children with an injected reader', () => {
  const files: Record<string, string> = {
    '/proc/1/task/1/children': '2 3', '/proc/2/task/2/children': '4',
    '/proc/3/task/3/children': '', '/proc/4/task/4/children': '',
  };
  expect(processTree(1, p => files[p] ?? '').sort()).toEqual([1, 2, 3, 4]);
});
// Chromium starts some helpers from a launcher thread: the kernel lists them
// in that thread's children file, not in the main thread's file.
test('processTree reads the children file of every thread', () => {
  const files: Record<string, string> = {
    '/proc/1/task/1/children': '2', '/proc/1/task/7/children': '3',
    '/proc/2/task/2/children': '', '/proc/3/task/3/children': '',
  };
  const tasks: Record<number, number[]> = { 1: [1, 7] };
  expect(processTree(1, p => files[p] ?? '', pid => tasks[pid] ?? [pid]).sort()).toEqual([1, 2, 3]);
});
test('findCompanions picks programs from the browser directory that started with it, outside the tree', () => {
  const dir = '/home/u/.cache/puppeteer/chrome/linux-1/chrome-linux64';
  const browser = { pid: 10, argv0: `${dir}/chrome`, startTicks: 1000 };
  const all = [
    browser,
    { pid: 11, argv0: `${dir}/chrome`, startTicks: 1001 },                    // in the tree
    { pid: 12, argv0: `${dir}/chrome_crashpad_handler`, startTicks: 1002 },   // companion
    { pid: 13, argv0: `${dir}/chrome_crashpad_handler`, startTicks: 1003 },   // companion
    { pid: 14, argv0: `${dir}/chrome_crashpad_handler`, startTicks: 999 },    // started before the browser
    { pid: 15, argv0: `${dir}/chrome_crashpad_handler`, startTicks: 2000 },   // started too late
    { pid: 16, argv0: '/usr/bin/dbus-daemon', startTicks: 1002 },              // other directory
  ];
  expect(findCompanions(browser, all, new Set([10, 11]), 500)).toEqual([12, 13]);
});

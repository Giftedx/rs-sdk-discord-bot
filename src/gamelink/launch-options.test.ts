import { expect, test } from 'bun:test';
import { browserLaunchOptions, ChromePathError, CHROMIUM_ARGS } from './game-tab';

const CHROME = '/opt/rs-chrome/148.0.7778.97/chrome-linux64/chrome';
const exists = (paths: string[]) => (p: string) => paths.includes(p);

test('no Chrome path: puppeteer picks its default', () => {
  const o = browserLaunchOptions({}, { env: { HOME: '/h' }, fileExists: exists([]) });
  expect(o.executablePath).toBeUndefined();
  expect(o.headless).toBe(true);
  expect(o.args).toEqual([...CHROMIUM_ARGS]);
  expect(o.env).toEqual({ HOME: '/h', NO_AT_BRIDGE: '1', DBUS_SESSION_BUS_ADDRESS: 'disabled:' });
});

test('RS_CHROME_PATH gives the executable path when the file exists', () => {
  const o = browserLaunchOptions({}, { env: { RS_CHROME_PATH: CHROME }, fileExists: exists([CHROME]) });
  expect(o.executablePath).toBe(CHROME);
});

test('an explicit executablePath wins over RS_CHROME_PATH', () => {
  const other = '/opt/rs-chrome/1/chrome-linux64/chrome';
  const o = browserLaunchOptions({ executablePath: other }, { env: { RS_CHROME_PATH: CHROME }, fileExists: exists([other]) });
  expect(o.executablePath).toBe(other);
});

test('a Chrome path with no file is an error, not a fallback', () => {
  expect(() => browserLaunchOptions({}, { env: { RS_CHROME_PATH: CHROME }, fileExists: exists([]) })).toThrow(ChromePathError);
  expect(() => browserLaunchOptions({ executablePath: CHROME }, { env: {}, fileExists: exists([]) })).toThrow(ChromePathError);
});

test('a relative Chrome path is an error', () => {
  expect(() => browserLaunchOptions({}, { env: { RS_CHROME_PATH: 'chrome' }, fileExists: () => true })).toThrow(ChromePathError);
});

test('the browser environment keeps no password', () => {
  const o = browserLaunchOptions({}, { env: { RS_PASSWORD: 'sekret1234', RS_CHROME_PATH: CHROME }, fileExists: exists([CHROME]) });
  expect(Object.values(o.env ?? {})).not.toContain('sekret1234');
});

test('userDataDir passes through', () => {
  expect(browserLaunchOptions({ userDataDir: '/tmp/u' }, { env: {}, fileExists: exists([]) }).userDataDir).toBe('/tmp/u');
});

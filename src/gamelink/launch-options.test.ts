import { expect, test } from 'bun:test';
import { browserLaunchEnv, browserLaunchOptions, ChromePathError, CHROMIUM_ARGS } from './game-tab';

const CHROME = '/opt/rs-chrome/148.0.7778.97/chrome-linux64/chrome';
const exists = (paths: string[]) => (p: string) => paths.includes(p);

test('no Chrome path: puppeteer picks its default', () => {
  const o = browserLaunchOptions({}, { env: { HOME: '/h' }, fileExists: exists([]), platform: 'linux' });
  expect(o.executablePath).toBeUndefined();
  expect(o.headless).toBe(true);
  expect(o.pipe).toBe(true);
  expect(o.args).toEqual([...CHROMIUM_ARGS]);
  expect(o.env).toEqual({ HOME: '/h', NO_AT_BRIDGE: '1', DBUS_SESSION_BUS_ADDRESS: 'disabled:' });
});

test('DevTools uses a pipe on Linux and a loopback port on Windows', () => {
  expect(browserLaunchOptions({}, { env: {}, fileExists: exists([]), platform: 'linux' }).pipe).toBe(true);
  expect(browserLaunchOptions({}, { env: {}, fileExists: exists([]), platform: 'win32' }).pipe).toBe(false);
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

test('the browser environment is an allow list', () => {
  const env = browserLaunchEnv({
    PATH: '/bin', HOME: '/h', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', XDG_RUNTIME_DIR: '/run/user/1',
    DISCORD_TOKEN: 'tok', ANTHROPIC_API_KEY: 'key', RS_ACCOUNT: 'acc', BOX_USER: 'box', SSH_AUTH_SOCK: '/s',
    NODE_OPTIONS: '--require x', LD_PRELOAD: '/x.so', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/b', UNSET: undefined,
  });
  expect(env).toEqual({
    PATH: '/bin', HOME: '/h', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', XDG_RUNTIME_DIR: '/run/user/1',
    NO_AT_BRIDGE: '1', DBUS_SESSION_BUS_ADDRESS: 'disabled:',
  });
});

test('the crash reporter is off', () => {
  expect(CHROMIUM_ARGS).toContain('--disable-crash-reporter');
  expect(CHROMIUM_ARGS).toContain('--disable-breakpad');
});

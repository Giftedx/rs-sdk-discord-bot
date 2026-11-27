import { expect, test } from 'bun:test';
import { loadConfig, ConfigError, parseChromePath } from './config';

const base = { RS_ACCOUNT: 'abc123', RS_PASSWORD: 'pw' };

test('defaults point at the demo world', () => {
  const c = loadConfig(base);
  expect(c.serverHost).toBe('rs-sdk.maxbittker.com');
  expect(c.gatewayUrl).toBe('wss://rs-sdk.maxbittker.com/gateway');
  expect(c.botPageUrl).toBe('https://rs-sdk.maxbittker.com/bot');
  expect(c.fps).toBe(15);
  expect(c.proxyPort).toBe(7790);
});
test('RS_CHROME_PATH is optional and must be absolute', () => {
  expect(loadConfig(base).chromePath).toBeNull();
  expect(loadConfig({ ...base, RS_CHROME_PATH: '' }).chromePath).toBeNull();
  expect(loadConfig({ ...base, RS_CHROME_PATH: '/opt/rs-chrome/1/chrome-linux64/chrome' }).chromePath)
    .toBe('/opt/rs-chrome/1/chrome-linux64/chrome');
  expect(() => loadConfig({ ...base, RS_CHROME_PATH: 'chrome-linux64/chrome' })).toThrow(ConfigError);
  expect(parseChromePath(undefined)).toBeNull();
});
test('accepts a password of 20 characters and rejects 21, without the value in the error', () => {
  expect(loadConfig({ ...base, RS_PASSWORD: 'a'.repeat(20) }).account.password).toBe('a'.repeat(20));
  let err: unknown;
  try { loadConfig({ ...base, RS_PASSWORD: 'Q'.repeat(21) }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ConfigError);
  expect(String(err)).not.toContain('QQQQ');
});
test('rejects the old host name', () => {
  expect(() => loadConfig({ ...base, RS_SERVER_HOST: 'rs-sdk-demo.fly.dev' })).toThrow(ConfigError);
});
test('rejects an account name that is not lower-case alphanumeric, 1 to 12', () => {
  for (const bad of ['', 'Abc', 'has space', 'thirteenchars', 'a-b'])
    expect(() => loadConfig({ ...base, RS_ACCOUNT: bad })).toThrow(ConfigError);
});
test('rejects fps below 10 and above 50', () => {
  expect(() => loadConfig({ ...base, RS_FPS: '9' })).toThrow(ConfigError);
  expect(() => loadConfig({ ...base, RS_FPS: '51' })).toThrow(ConfigError);
});
test('rejects an empty password and never puts it in the error text', () => {
  expect(() => loadConfig({ RS_ACCOUNT: 'abc123', RS_PASSWORD: '' })).toThrow(ConfigError);
  let err: unknown;
  try { loadConfig({ ...base, RS_PASSWORD: 'sekret', RS_FPS: '1' }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ConfigError);
  expect(String(err)).not.toContain('sekret');
});

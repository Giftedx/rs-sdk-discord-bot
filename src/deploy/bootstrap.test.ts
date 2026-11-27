// Checks that the values in scripts/server-bootstrap.sh agree with the repository.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PUPPETEER_REVISIONS } from 'puppeteer-core/internal/revisions.js';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const script = read('../../scripts/server-bootstrap.sh');

test('the AppArmor profile in the bootstrap is identical to deploy/apparmor/rsbot-chrome-for-testing', () => {
  const m = /cat <<'PROFILE'\n([\s\S]*?\n)PROFILE\n/.exec(script);
  expect(m).not.toBeNull();
  expect(m![1]).toBe(read('../../deploy/apparmor/rsbot-chrome-for-testing'));
});

test('CHROME_VERSION in the bootstrap is the Chrome of the pinned puppeteer', () => {
  const m = /^CHROME_VERSION=(\S+)$/m.exec(script);
  expect(m?.[1]).toBe(PUPPETEER_REVISIONS.chrome);
});

test('CHROME_ZIP_SHA256 is a SHA-256 value', () => {
  expect(script).toMatch(/^CHROME_ZIP_SHA256=[0-9a-f]{64}$/m);
});

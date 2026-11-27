import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createActionPolicy, ALLOWED_ACTION_TYPES, BLOCKED_ACTION_TYPES } from './policy';

const on = { jobActive: true, nowMs: 0 };

test('every action type of the pinned client is in exactly one list', () => {
  const src = readFileSync('vendor/rs-sdk/server/webclient/src/bot/ActionExecutor.ts', 'utf8');
  // Only the first `switch (action.type)` dispatches actions. A later switch only describes them.
  const marker = 'switch (action.type)';
  const start = src.indexOf(marker);
  const end = src.indexOf(marker, start + marker.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const types = [...src.slice(start, end).matchAll(/case '([A-Za-z]+)':/g)].map(m => m[1]);
  expect(types.length).toBeGreaterThan(30);
  for (const t of types)
    expect(ALLOWED_ACTION_TYPES.has(t) !== BLOCKED_ACTION_TYPES.has(t)).toBe(true);
  const all = new Set(types);
  for (const t of [...ALLOWED_ACTION_TYPES, ...BLOCKED_ACTION_TYPES]) expect(all.has(t)).toBe(true);
});
test('blocks direct player actions', () => {
  const p = createActionPolicy();
  expect(p.check({ type: 'interactPlayer' }, on)).toEqual({ allow: false, reason: 'blocked_type' });
  expect(p.check({ type: 'spellOnPlayer' }, on)).toEqual({ allow: false, reason: 'blocked_type' });
});
test('drops a type that is not in the allow list', () => {
  expect(createActionPolicy().check({ type: 'brandNewAction' }, on)).toEqual({ allow: false, reason: 'unknown_type' });
});
test('drops every action while no job runs', () => {
  expect(createActionPolicy().check({ type: 'walkTo' }, { jobActive: false, nowMs: 0 })).toEqual({ allow: false, reason: 'no_job' });
});
test('drops a say message that starts with ::', () => {
  expect(createActionPolicy().check({ type: 'say', message: '::give 995 1' }, on)).toEqual({ allow: false, reason: 'client_command' });
  expect(createActionPolicy().check({ type: 'say', message: '  ::x' }, on)).toEqual({ allow: false, reason: 'client_command' });
});
test('limits chat to 6 messages per minute across say and privateMessage', () => {
  const p = createActionPolicy();
  for (let i = 0; i < 6; i++) expect(p.check({ type: 'say', message: 'hi' }, { jobActive: true, nowMs: i * 1000 }).allow).toBe(true);
  expect(p.check({ type: 'privateMessage', message: 'hi' }, { jobActive: true, nowMs: 7000 })).toEqual({ allow: false, reason: 'chat_rate' });
  expect(p.check({ type: 'say', message: 'hi' }, { jobActive: true, nowMs: 61_000 }).allow).toBe(true);
});
test('drops a malformed action', () => {
  const p = createActionPolicy();
  for (const bad of [null, 'walkTo', 42, {}, { type: 7 }])
    expect(p.check(bad, on)).toEqual({ allow: false, reason: 'malformed' });
});
test('refuses a click on the logout button; other components pass', () => {
  const p = createActionPolicy();
  expect(p.check({ type: 'clickComponent', componentId: 2458 }, on)).toEqual({ allow: false, reason: 'logout_component' });
  expect(p.check({ type: 'clickComponentWithOption', componentId: '2458', optionIndex: 1 }, on)).toEqual({ allow: false, reason: 'logout_component' });
  expect(p.check({ type: 'clickComponent', componentId: 2459 }, on).allow).toBe(true);
});

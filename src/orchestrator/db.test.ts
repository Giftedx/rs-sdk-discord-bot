import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, SCHEMA_VERSION } from './db';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'orch-db-')), 'bot.sqlite');

describe('orchestrator db', () => {
  test('queue votes: a new order changes nextWaiting, and later rows stay after it', () => {
    const d = openDb(tmpFile());
    const a = d.enqueueInstruction('g1', 'alice', 'a');
    const b = d.enqueueInstruction('g1', 'bob', 'b');
    const c = d.enqueueInstruction('g1', 'cy', 'c');
    d.setMessageId(c, '111');
    expect(d.waitingByMessage('g1', '111')).toBe(c);
    expect(d.waitingByMessage('g2', '111')).toBeNull();
    d.setWaitingOrder('g1', [a, c, b]);
    expect(d.waitingOrder('g1')).toEqual([a, c, b]);
    const e = d.enqueueInstruction('g1', 'eve', 'e');
    expect(d.waitingOrder('g1')).toEqual([a, c, b, e]);
    expect(d.startInstruction(d.nextWaiting('g1')!.id)).toBe(true);
    expect(d.nextWaiting('g1')!.id).toBe(c);
    expect(d.listQueue('g1').map(r => r.id)).toEqual([a, c, b, e]);
    expect(d.waitingByMessage('g1', '111')).toBe(c);
    d.startInstruction(c);
    expect(d.waitingByMessage('g1', '111')).toBeNull();
    // An id that is not waiting leaves the order as it is.
    d.setWaitingOrder('g1', [e, a]);
    expect(d.waitingOrder('g1')).toEqual([b, e]);
    d.close();
  });

  test('lastWakeAt gives the newest instruction time of one wake kind and guild', () => {
    let t = 1_000;
    const d = openDb(tmpFile(), () => t);
    expect(d.lastWakeAt('g1', 'review')).toBeNull();
    d.enqueueInstruction('g1', 'review', 'tidy', 'review');
    t = 5_000;
    d.enqueueInstruction('g1', 'review', 'tidy', 'review');
    d.enqueueInstruction('g1', 'alice', 'chop', 'instruction');
    t = 9_000;
    d.enqueueInstruction('g2', 'review', 'tidy', 'review');
    expect(d.lastWakeAt('g1', 'review')).toBe(5_000);
    expect(d.lastWakeAt('g1', 'timer')).toBeNull();
    d.close();
  });

  test('keeps one seen value per guild and key, and replaces it', () => {
    const d = openDb(tmpFile());
    expect(d.getSeen('g1', 'bank')).toBeNull();
    d.setSeen('g1', 'bank', { items: [1] }, 100);
    d.setSeen('g1', 'bank', { items: [2] }, 200);
    d.setSeen('g2', 'bank', { items: [3] }, 300);
    expect(d.getSeen('g1', 'bank')).toEqual({ time: 200, value: { items: [2] } });
    expect(d.getSeen('g2', 'bank')?.value).toEqual({ items: [3] });
    expect(d.getSeen('g1', 'ge')).toBeNull();
    d.close();
  });

  test('migrates a new file to the current schema version, and opens it again', () => {
    const file = tmpFile();
    const a = openDb(file);
    expect(a.schemaVersion()).toBe(SCHEMA_VERSION);
    a.enqueueInstruction('g1', 'alice', 'chop trees');
    a.close();
    const b = openDb(file);
    expect(b.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(b.countWaiting('g1')).toBe(1);
    b.close();
  });

  test('refuses a file from a newer program', () => {
    const file = tmpFile();
    const raw = new Database(file, { create: true });
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => openDb(file)).toThrow(/newer/);
  });

  test('queue: waiting -> running -> done, per guild, in order', () => {
    let t = 1000;
    const db = openDb(':memory:', () => t);
    const a = db.enqueueInstruction('g1', 'alice', 'one');
    const b = db.enqueueInstruction('g1', 'bob', 'two');
    db.enqueueInstruction('g2', 'carol', 'other guild');
    expect(db.nextWaiting('g1')!.id).toBe(a);
    expect(db.startInstruction(a)).toBe(true);
    expect(db.startInstruction(a)).toBe(false);
    expect(db.runningInstruction('g1')!.text).toBe('one');
    expect(db.nextWaiting('g1')!.id).toBe(b);
    t = 2000;
    db.finishInstruction(a, 'done', 'Chopped.', 0.12);
    const row = db.getInstruction(a)!;
    expect(row).toMatchObject({ status: 'done', summary: 'Chopped.', usd: 0.12, startedAt: 1000, endedAt: 2000 });
    expect(db.listQueue('g1').map(r => r.id)).toEqual([b]);
    expect(db.cancelWaiting(b)).toBe(true);
    expect(db.getInstruction(b)!.status).toBe('stopped');
    expect(db.listQueue('g2').length).toBe(1);
  });

  test('recoverAfterRestart puts running rows back to waiting', () => {
    const db = openDb(':memory:');
    const a = db.enqueueInstruction('g1', 'alice', 'one');
    db.startInstruction(a);
    expect(db.recoverAfterRestart()).toBe(1);
    expect(db.getInstruction(a)).toMatchObject({ status: 'waiting', startedAt: null });
    expect(db.recoverAfterRestart()).toBe(0);
  });

  test('recoverAfterRestart stops a row that was running at 3 restarts', () => {
    const db = openDb(':memory:');
    const a = db.enqueueInstruction('g1', 'alice', 'one');
    for (let i = 0; i < 2; i++) {
      expect(db.startInstruction(a)).toBe(true);
      expect(db.recoverAfterRestart()).toBe(1);
      expect(db.getInstruction(a)!.status).toBe('waiting');
    }
    expect(db.startInstruction(a)).toBe(true);
    expect(db.recoverAfterRestart()).toBe(0);
    expect(db.getInstruction(a)).toMatchObject({ status: 'stopped' });
    expect(db.getInstruction(a)!.summary).toContain('restarted');
  });

  test('a clean stop requeues the row and does not count as a restart', () => {
    const db = openDb(':memory:');
    const a = db.enqueueInstruction('g1', 'alice', 'one');
    for (let i = 0; i < 5; i++) {
      expect(db.startInstruction(a)).toBe(true);
      expect(db.requeueAfterShutdown(a)).toBe(true);
      expect(db.recoverAfterRestart()).toBe(0);
      expect(db.getInstruction(a)!.status).toBe('waiting');
    }
    expect(db.requeueAfterShutdown(a)).toBe(false);
  });

  test('finishInstruction does not change a row that already ended', () => {
    const db = openDb(':memory:');
    const a = db.enqueueInstruction('g1', 'alice', 'one');
    db.startInstruction(a);
    db.finishInstruction(a, 'done', 'Chopped.', 0.1);
    db.finishInstruction(a, 'stopped', 'Error: x', 0);
    expect(db.getInstruction(a)).toMatchObject({ status: 'done', summary: 'Chopped.' });
  });

  test('spend sums by time range', () => {
    const db = openDb(':memory:');
    const row = { guild: 'g1', instructionId: null, model: 'm', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    db.recordSpend({ ...row, usd: 1, time: 100 });
    db.recordSpend({ ...row, usd: 2, time: 200 });
    db.recordSpend({ ...row, usd: 4, time: 300 });
    expect(db.spendBetween(100, 300)).toBe(3);
    expect(db.spendBetween(0, 1000)).toBe(7);
    expect(db.spendBetween(400, 500)).toBe(0);
  });

  test('events keep their data as JSON, newest first', () => {
    const db = openDb(':memory:');
    db.addEvent('g1', 'low_hp', 'HP low', { hp: 3 });
    db.addEvent(null, 'boot', 'Started');
    const ev = db.recentEvents(10);
    expect(ev.map(e => e.type)).toEqual(['boot', 'low_hp']);
    expect(ev[1]!.data).toEqual({ hp: 3 });
    expect(db.recentEvents(10, 'g1').length).toBe(1);
  });

  test('snapshots: latest and prune', () => {
    const db = openDb(':memory:');
    db.addSnapshot('g1', { hp: 10 }, 100);
    db.addSnapshot('g1', { hp: 7 }, 200);
    expect(db.latestSnapshot<{ hp: number }>('g1')).toEqual({ time: 200, state: { hp: 7 } });
    expect(db.pruneSnapshots(150)).toBe(1);
    expect(db.latestSnapshot()!.time).toBe(200);
  });

  test('timers: due, list, delete', () => {
    const db = openDb(':memory:', () => 0);
    const a = db.addTimer('g1', 500, 'later');
    const b = db.addTimer('g1', 100, 'sooner');
    db.addTimer('g2', 50, 'other');
    expect(db.dueTimers('g1', 99)).toEqual([]);
    expect(db.dueTimers('g1', 600).map(t => t.id)).toEqual([b, a]);
    expect(db.listTimers('g1').length).toBe(2);
    expect(db.deleteTimer(b)).toBe(true);
    expect(db.deleteTimer(b)).toBe(false);
    expect(db.dueTimers('g1', 600).map(t => t.note)).toEqual(['later']);
  });
});

describe('orchestrator db: since queries', () => {
  test('snapshotsSince (oldest first) and eventsSince (newest first) return the rows of one guild from a time', () => {
    let t = 1_000;
    const db = openDb(tmpFile(), () => t);
    db.addSnapshot('g1', { skills: { Attack: { level: 1, xp: 0 } } }, 500);
    db.addSnapshot('g1', { skills: { Attack: { level: 2, xp: 90 } } }, 1_500);
    db.addSnapshot('g1', { skills: { Attack: { level: 3, xp: 200 } } }, 2_500);
    db.addSnapshot('g2', { skills: {} }, 2_000);
    expect(db.snapshotsSince<{ skills: Record<string, { xp: number }> }>('g1', 1_000).map(s => [s.time, s.state.skills.Attack!.xp])).toEqual([[1_500, 90], [2_500, 200]]);
    db.addEvent('g1', 'death', 'old');
    t = 3_000;
    db.addEvent('g1', 'level_up', 'new', { kind: 'level_up', skill: 'Attack', from: 1, level: 2 });
    db.addEvent('g2', 'death', 'other guild');
    expect(db.eventsSince('g1', 2_000)).toEqual([{ time: 3_000, type: 'level_up', data: { kind: 'level_up', skill: 'Attack', from: 1, level: 2 } }]);
    expect(db.eventsSince('g1', 0).map(e => e.data)).toEqual([{ kind: 'level_up', skill: 'Attack', from: 1, level: 2 }, null]);
    db.close();
  });

  test('eventsSince puts item gains last, so a limit never drops a level-up or a death', () => {
    const db = openDb(':memory:', () => 1_000);
    db.addEvent('g1', 'level_up', 'a');
    for (let i = 0; i < 5; i++) db.addEvent('g1', 'item_gain', `item ${i}`);
    db.addEvent('g1', 'death', 'b');
    expect(db.eventsSince('g1', 0, 3).map(e => e.type)).toEqual(['death', 'level_up', 'item_gain']);
  });

  test('pruneEvents removes the events before a time', () => {
    let t = 100;
    const db = openDb(':memory:', () => t);
    db.addEvent('g1', 'item_gain', 'old');
    t = 200;
    db.addEvent('g1', 'death', 'new');
    expect(db.pruneEvents(150)).toBe(1);
    expect(db.recentEvents(10).map(e => e.text)).toEqual(['new']);
  });
});

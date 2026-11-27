import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, SCHEMA_VERSION } from './db';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'orch-db-')), 'bot.sqlite');

describe('orchestrator db', () => {
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

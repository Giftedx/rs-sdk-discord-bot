// The orchestrator database: one SQLite file with the instruction queue, the spend record,
// the events, the state snapshots and the timers that the AI sets.
import { Database } from 'bun:sqlite';

export type InstructionStatus = 'waiting' | 'running' | 'done' | 'stopped';

export interface InstructionRow {
  id: number;
  guild: string;
  user: string;
  text: string;
  wake: string;
  status: InstructionStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  summary: string | null;
  usd: number;
}

export interface SpendRow {
  guild: string | null;
  instructionId: number | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usd: number;
  time: number;
}

export interface EventRow {
  id: number;
  guild: string | null;
  type: string;
  text: string;
  data: unknown;
  time: number;
}

export interface TimerRow {
  id: number;
  guild: string;
  due: number;
  note: string;
  createdAt: number;
}

// Each entry moves the schema one version up. Never edit an entry that has shipped; add one.
const MIGRATIONS: string[] = [
  `CREATE TABLE instructions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild TEXT NOT NULL,
     user TEXT NOT NULL,
     text TEXT NOT NULL,
     wake TEXT NOT NULL DEFAULT 'instruction',
     status TEXT NOT NULL CHECK (status IN ('waiting','running','done','stopped')),
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     ended_at INTEGER,
     summary TEXT,
     usd REAL NOT NULL DEFAULT 0
   );
   CREATE INDEX instructions_queue ON instructions (guild, status, id);
   CREATE TABLE spend (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild TEXT,
     instruction_id INTEGER,
     model TEXT NOT NULL,
     input_tokens INTEGER NOT NULL,
     output_tokens INTEGER NOT NULL,
     cache_read_tokens INTEGER NOT NULL DEFAULT 0,
     cache_write_tokens INTEGER NOT NULL DEFAULT 0,
     usd REAL NOT NULL,
     time INTEGER NOT NULL
   );
   CREATE INDEX spend_time ON spend (time);
   CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild TEXT,
     type TEXT NOT NULL,
     text TEXT NOT NULL,
     data TEXT,
     time INTEGER NOT NULL
   );
   CREATE INDEX events_time ON events (time);
   CREATE TABLE snapshots (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild TEXT,
     time INTEGER NOT NULL,
     json TEXT NOT NULL
   );
   CREATE INDEX snapshots_time ON snapshots (time);
   CREATE TABLE timers (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild TEXT NOT NULL,
     due INTEGER NOT NULL,
     note TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX timers_due ON timers (due);`,
  // Queue votes: a waiting row runs in the order of COALESCE(rank, id). message_id is the Discord
  // message that asked for it, so a reaction on that message finds the row.
  `ALTER TABLE instructions ADD COLUMN rank INTEGER;
   ALTER TABLE instructions ADD COLUMN message_id TEXT;
   CREATE INDEX instructions_message ON instructions (message_id);`,
  // The last bank and exchange the bot saw. They are only in the state while their window is open.
  `CREATE TABLE seen (
     guild TEXT NOT NULL,
     key TEXT NOT NULL,
     time INTEGER NOT NULL,
     json TEXT NOT NULL,
     PRIMARY KEY (guild, key)
   );`,
  // How many times the bot restarted while the row was running. recoverAfterRestart() stops a row
  // at MAX_RESTARTS, so a request that crashes the bot does not run again and again.
  `ALTER TABLE instructions ADD COLUMN restarts INTEGER NOT NULL DEFAULT 0;`,
];

const MAX_RESTARTS = 3;

export const SCHEMA_VERSION = MIGRATIONS.length;

type Raw = Record<string, unknown>;

const toInstruction = (r: Raw): InstructionRow => ({
  id: r.id as number,
  guild: r.guild as string,
  user: r.user as string,
  text: r.text as string,
  wake: r.wake as string,
  status: r.status as InstructionStatus,
  createdAt: r.created_at as number,
  startedAt: (r.started_at as number | null) ?? null,
  endedAt: (r.ended_at as number | null) ?? null,
  summary: (r.summary as string | null) ?? null,
  usd: r.usd as number,
});

const parseJson = (s: unknown): unknown => {
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch { return null; }
};

export function openDb(path: string, now: () => number = Date.now) {
  const db = new Database(path, { create: true, strict: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);

  return {
    raw: db,
    schemaVersion(): number { return userVersion(db); },
    close(): void { db.close(); },

    // Queue.
    enqueueInstruction(guild: string, user: string, text: string, wake = 'instruction'): number {
      const r = db.query('INSERT INTO instructions (guild, user, text, wake, status, created_at) VALUES (?, ?, ?, ?, \'waiting\', ?) RETURNING id')
        .get(guild, user, text, wake, now()) as { id: number };
      return r.id;
    },
    getInstruction(id: number): InstructionRow | null {
      const r = db.query('SELECT * FROM instructions WHERE id = ?').get(id) as Raw | null;
      return r ? toInstruction(r) : null;
    },
    nextWaiting(guild: string): InstructionRow | null {
      const r = db.query('SELECT * FROM instructions WHERE guild = ? AND status = \'waiting\' ORDER BY COALESCE(rank, id), id LIMIT 1').get(guild) as Raw | null;
      return r ? toInstruction(r) : null;
    },
    runningInstruction(guild: string): InstructionRow | null {
      const r = db.query('SELECT * FROM instructions WHERE guild = ? AND status = \'running\' ORDER BY id LIMIT 1').get(guild) as Raw | null;
      return r ? toInstruction(r) : null;
    },
    listQueue(guild: string): InstructionRow[] {
      return (db.query('SELECT * FROM instructions WHERE guild = ? AND status IN (\'waiting\',\'running\') ORDER BY status = \'waiting\', COALESCE(rank, id), id').all(guild) as Raw[]).map(toInstruction);
    },
    /** Links a waiting row to the Discord message that asked for it. */
    setMessageId(id: number, messageId: string): void {
      db.query('UPDATE instructions SET message_id = ? WHERE id = ?').run(messageId, id);
    },
    /** The waiting row that this Discord message asked for, or null. */
    waitingByMessage(guild: string, messageId: string): number | null {
      const r = db.query('SELECT id FROM instructions WHERE guild = ? AND status = \'waiting\' AND message_id = ?').get(guild, messageId) as { id: number } | null;
      return r?.id ?? null;
    },
    /** The ids of the waiting rows, first to run first. */
    waitingOrder(guild: string): number[] {
      return (db.query('SELECT id FROM instructions WHERE guild = ? AND status = \'waiting\' ORDER BY COALESCE(rank, id), id').all(guild) as { id: number }[]).map(r => r.id);
    },
    /** Stores a new order of waiting rows. The rows share out the sort keys they hold, so rows queued later stay after them. */
    setWaitingOrder(guild: string, ids: number[]): void {
      db.transaction(() => {
        const keys = ids.map(id => db.query('SELECT COALESCE(rank, id) AS k FROM instructions WHERE id = ? AND guild = ? AND status = \'waiting\'').get(id, guild) as { k: number } | null);
        if (keys.some(k => k === null)) return;
        const sorted = keys.map(k => k!.k).sort((a, b) => a - b);
        ids.forEach((id, i) => db.query('UPDATE instructions SET rank = ? WHERE id = ?').run(sorted[i]!, id));
      })();
    },
    /** The created_at of the newest instruction of this wake kind, or null. For the daily review wake. */
    lastWakeAt(guild: string, wake: string): number | null {
      const r = db.query('SELECT MAX(created_at) AS t FROM instructions WHERE guild = ? AND wake = ?').get(guild, wake) as { t: number | null };
      return r.t ?? null;
    },
    countWaiting(guild: string): number {
      return (db.query('SELECT COUNT(*) AS n FROM instructions WHERE guild = ? AND status = \'waiting\'').get(guild) as { n: number }).n;
    },
    /** Returns false when the row is not waiting, so two callers cannot start one instruction. */
    startInstruction(id: number): boolean {
      return db.query('UPDATE instructions SET status = \'running\', started_at = ? WHERE id = ? AND status = \'waiting\'').run(now(), id).changes === 1;
    },
    finishInstruction(id: number, status: 'done' | 'stopped', summary: string, usd: number): void {
      // Only a running row: a row that already ended keeps its result.
      db.query('UPDATE instructions SET status = ?, ended_at = ?, summary = ?, usd = ? WHERE id = ? AND status = \'running\'').run(status, now(), summary, usd, id);
    },
    /** Stops one waiting instruction. Returns false when it is not waiting. */
    cancelWaiting(id: number): boolean {
      return db.query('UPDATE instructions SET status = \'stopped\', ended_at = ?, summary = \'Removed from the queue.\' WHERE id = ? AND status = \'waiting\'').run(now(), id).changes === 1;
    },
    /**
     * After a restart no instruction runs. Each running row goes back to waiting, and returns the
     * count of these. A row that was running at MAX_RESTARTS restarts is stopped.
     */
    recoverAfterRestart(): number {
      return db.transaction(() => {
        db.query('UPDATE instructions SET restarts = restarts + 1 WHERE status = \'running\'').run();
        db.query('UPDATE instructions SET status = \'stopped\', ended_at = ?, summary = ? WHERE status = \'running\' AND restarts >= ?')
          .run(now(), `Stopped: the bot restarted ${MAX_RESTARTS} times while this ran.`, MAX_RESTARTS);
        return db.query('UPDATE instructions SET status = \'waiting\', started_at = NULL WHERE status = \'running\'').run().changes;
      })();
    },

    // Spend.
    recordSpend(row: Omit<SpendRow, 'time'> & { time?: number }): void {
      db.query('INSERT INTO spend (guild, instruction_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd, time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(row.guild, row.instructionId, row.model, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens, row.usd, row.time ?? now());
    },
    /** Total USD of the rows with from <= time < to. */
    spendBetween(from: number, to: number): number {
      return (db.query('SELECT COALESCE(SUM(usd), 0) AS s FROM spend WHERE time >= ? AND time < ?').get(from, to) as { s: number }).s;
    },

    // Events.
    addEvent(guild: string | null, type: string, text: string, data?: unknown): number {
      const r = db.query('INSERT INTO events (guild, type, text, data, time) VALUES (?, ?, ?, ?, ?) RETURNING id')
        .get(guild, type, text, data === undefined ? null : JSON.stringify(data), now()) as { id: number };
      return r.id;
    },
    recentEvents(limit = 20, guild?: string): EventRow[] {
      const rows = (guild === undefined
        ? db.query('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)
        : db.query('SELECT * FROM events WHERE guild = ? ORDER BY id DESC LIMIT ?').all(guild, limit)) as Raw[];
      return rows.map(r => ({ id: r.id as number, guild: (r.guild as string | null) ?? null, type: r.type as string, text: r.text as string, data: parseJson(r.data), time: r.time as number }));
    },

    // The last thing of a kind that the bot saw, such as the bank. One row per guild and key.
    setSeen(guild: string, key: string, value: unknown, time = now()): void {
      db.query('INSERT INTO seen (guild, key, time, json) VALUES (?, ?, ?, ?) ON CONFLICT (guild, key) DO UPDATE SET time = excluded.time, json = excluded.json').run(guild, key, time, JSON.stringify(value));
    },
    getSeen<T = unknown>(guild: string, key: string): { time: number; value: T } | null {
      const r = db.query('SELECT time, json FROM seen WHERE guild = ? AND key = ?').get(guild, key) as Raw | null;
      return r ? { time: r.time as number, value: parseJson(r.json) as T } : null;
    },

    // Snapshots.
    addSnapshot(guild: string | null, state: unknown, time = now()): void {
      db.query('INSERT INTO snapshots (guild, time, json) VALUES (?, ?, ?)').run(guild, time, JSON.stringify(state));
    },
    latestSnapshot<T = unknown>(guild?: string | null): { time: number; state: T } | null {
      const r = (guild === undefined
        ? db.query('SELECT time, json FROM snapshots ORDER BY id DESC LIMIT 1').get()
        : db.query('SELECT time, json FROM snapshots WHERE guild IS ? ORDER BY id DESC LIMIT 1').get(guild)) as Raw | null;
      return r ? { time: r.time as number, state: parseJson(r.json) as T } : null;
    },
    // Oldest first. For the XP per hour of the status card and the XP of the daily recap.
    snapshotsSince<T = unknown>(guild: string | null, since: number, limit = 5_000): { time: number; state: T }[] {
      const rows = db.query('SELECT time, json FROM snapshots WHERE guild IS ? AND time >= ? ORDER BY time ASC, id ASC LIMIT ?').all(guild, since, limit) as Raw[];
      return rows.map(r => ({ time: r.time as number, state: parseJson(r.json) as T }));
    },
    // For the daily recap after a restart. Item gains are the most rows, so every other kind comes
    // first, each part newest first: a limit never drops a level-up or a death for an item gain.
    eventsSince(guild: string | null, since: number, limit = 10_000): { time: number; type: string; data: unknown }[] {
      const rows = db.query('SELECT time, type, data FROM events WHERE guild IS ? AND time >= ? ORDER BY type = \'item_gain\', id DESC LIMIT ?').all(guild, since, limit) as Raw[];
      return rows.map(r => ({ time: r.time as number, type: r.type as string, data: parseJson(r.data) }));
    },
    pruneSnapshots(before: number): number {
      return db.query('DELETE FROM snapshots WHERE time < ?').run(before).changes;
    },
    pruneEvents(before: number): number {
      return db.query('DELETE FROM events WHERE time < ?').run(before).changes;
    },

    // Timers.
    addTimer(guild: string, due: number, note: string): number {
      const r = db.query('INSERT INTO timers (guild, due, note, created_at) VALUES (?, ?, ?, ?) RETURNING id').get(guild, due, note, now()) as { id: number };
      return r.id;
    },
    dueTimers(guild: string, at = now()): TimerRow[] {
      return (db.query('SELECT * FROM timers WHERE guild = ? AND due <= ? ORDER BY due, id').all(guild, at) as Raw[])
        .map(r => ({ id: r.id as number, guild: r.guild as string, due: r.due as number, note: r.note as string, createdAt: r.created_at as number }));
    },
    listTimers(guild: string): TimerRow[] {
      return (db.query('SELECT * FROM timers WHERE guild = ? ORDER BY due, id').all(guild) as Raw[])
        .map(r => ({ id: r.id as number, guild: r.guild as string, due: r.due as number, note: r.note as string, createdAt: r.created_at as number }));
    },
    deleteTimer(id: number): boolean {
      return db.query('DELETE FROM timers WHERE id = ?').run(id).changes === 1;
    },
  };
}

export type OrchestratorDb = ReturnType<typeof openDb>;

function userVersion(db: Database): number {
  return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function migrate(db: Database): void {
  const from = userVersion(db);
  if (from > MIGRATIONS.length) throw new Error(`The database schema version ${from} is newer than this program (${MIGRATIONS.length}).`);
  for (let v = from; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

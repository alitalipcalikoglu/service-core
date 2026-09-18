// Real, separate OS process (spawned via `child_process.fork`, never `worker_threads` — the parent
// test uses this fixture specifically because it must be a genuinely independent process with its
// own SQLite connection, per this project's established distinction between real cross-process
// concurrency and pseudo-concurrency within one process). Opens `Database` against a shared DB
// path, synchronized to the parent's "go" signal via IPC so the race window is barrier-controlled,
// not left to OS scheduling luck. `migrations` is sent by the parent per test case (rather than
// imported from a fixed fixture module) so the same child binary covers every race scenario: the
// normal pending-migration race, a fresh/nonexistent-DB race, and a forward-version mismatch race
// between two differently-versioned "builds".
import { Database } from '../../src/db.js';

if (!process.send) throw new Error('migration-race-child.mjs must be run via child_process.fork (needs an IPC channel)');

process.send({ type: 'ready', pid: process.pid });

process.once('message', (/** @type {{ type: string, dbPath: string, migrations: string[] }} */ msg) => {
  if (msg.type !== 'go') return;
  class RaceDb extends Database {
    static MIGRATIONS = msg.migrations;
  }
  let result;
  try {
    const startedAt = process.hrtime.bigint();
    const db = new RaceDb(msg.dbPath);
    const finishedAt = process.hrtime.bigint();
    const schemaVersion = db.schemaVersion;
    const lastBackupPath = db.lastBackupPath;
    db.close();
    result = { type: 'result', ok: true, schemaVersion, lastBackupPath, startedAt: startedAt.toString(), finishedAt: finishedAt.toString() };
  } catch (err) {
    result = { type: 'result', ok: false, error: err instanceof Error ? err.message : String(err), code: /** @type {any} */ (err)?.code };
  }
  process.send(result, () => process.exit(0));
});

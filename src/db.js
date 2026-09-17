import { basename, dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ConfigError } from './config.js';

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL
  )
`;

/**
 * SQLite connection with schema migrations applied on open. Every service subclasses this with its
 * own `static MIGRATIONS` (an ordered array of SQL blocks, one per schema version) — nothing else
 * changes, so an existing service's schema and migration content move here unmodified:
 *
 * ```js
 * import { Database as CoreDatabase } from '@atc-web/service-core/db';
 * export class Database extends CoreDatabase {
 *   static MIGRATIONS = [`CREATE TABLE ...`];
 * }
 * ```
 *
 * `#migrate()` reads `MIGRATIONS` off the actual subclass (`this.constructor.MIGRATIONS`), so a
 * service that defines no migrations at all (there is none today, but the base class must not
 * assume one exists) simply gets an empty array via the default below. A fresh database (no prior
 * `user_version`) and an existing one being upgraded run through this exact same loop — there is no
 * separate "create" path.
 *
 * Migration tracking is deterministic and layered two ways: `PRAGMA user_version` is the fast-path
 * check (unchanged from before), and every applied migration also gets a row in `schema_migrations`
 * (`version INTEGER PRIMARY KEY`, so a second attempt to record the same version is a constraint
 * violation, not silent). Each migration runs in its own `BEGIN`/`COMMIT`; a failure rolls back that
 * one migration and throws, leaving `user_version` at the last successfully applied version — the
 * service then fails to start rather than run against a half-migrated schema. Before the first
 * pending migration on a database that already has data (`user_version > 0`), the file is snapshotted
 * with `VACUUM INTO` to `<path>.pre-v<current>-<timestamp>` (skipped for `:memory:` and for a brand
 * new database, since there is nothing to protect yet) — `VACUUM INTO` takes its own consistent read
 * snapshot, so it is safe under WAL with concurrent readers. If the database's `user_version` is
 * already ahead of what this build's `MIGRATIONS` supports, the constructor throws `ConfigError`
 * instead of touching anything — an old build must never run against a newer schema.
 *
 * This class does not cache prepared statements — every service already had its own idiom for that
 * (either a fixed set of named statements prepared once, or an ad hoc `Map` for dynamic SQL) and
 * none of them turned out to share the same shape closely enough to be worth a generic cache class
 * here. One gotcha worth keeping regardless of who does the caching: never reuse a cached statement
 * for `.iterate()` — `StatementSync#iterate()` keeps cursor state on the statement object itself, so
 * two concurrent `.iterate()` calls sharing one cached statement reset each other's cursor (the bug
 * Stage 0 fixed in audit's `EventStore.iterate()`). Prepare a fresh statement per `.iterate()` call.
 */
export class Database {
  /** @type {readonly string[]} */
  static MIGRATIONS = [];

  /**
   * @param {string} path File path, or ":memory:".
   * @param {{ backupDir?: string }} [opts] `backupDir` overrides where the pre-migration snapshot is
   *   written; defaults to the database file's own directory.
   */
  constructor(path, opts = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    /** @readonly */
    this.path = path;
    /** @readonly */
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA foreign_keys = ON');
    /** Path of the pre-migration snapshot taken during this open, if any. @type {string|null} */
    this.lastBackupPath = null;
    this.#migrate(opts.backupDir);
  }

  /** Current `PRAGMA user_version` — the applied schema version. */
  get schemaVersion() {
    return /** @type {{ user_version: number }} */ (this.raw.prepare('PRAGMA user_version').get()).user_version;
  }

  /** @param {string|undefined} backupDir */
  #migrate(backupDir) {
    /** @type {readonly string[]} */
    const migrations = /** @type {typeof Database} */ (this.constructor).MIGRATIONS;
    this.raw.exec(MIGRATIONS_TABLE);
    const current = this.schemaVersion;
    if (current > migrations.length) {
      throw new ConfigError(`database is newer than this build supports (schema v${current}, build supports up to v${migrations.length}); refusing to open ${this.path}`);
    }
    if (current === migrations.length) return;
    this.#backup(current, backupDir);
    for (let v = current; v < migrations.length; v++) {
      const startedAt = Date.now();
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(migrations[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        this.raw.prepare('INSERT INTO schema_migrations (version, name, applied_at, duration_ms) VALUES (?, ?, ?, ?)').run(v + 1, `v${v + 1}`, Date.now(), Date.now() - startedAt);
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    }
  }

  /**
   * Snapshot the file before the first pending migration touches it. No-op for `:memory:` or a
   * brand new database (`currentVersion === 0`): there is no existing data to protect.
   * @param {number} currentVersion
   * @param {string|undefined} backupDir
   */
  #backup(currentVersion, backupDir) {
    if (this.path === ':memory:' || currentVersion === 0) return;
    const dir = backupDir || dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${basename(this.path)}.pre-v${currentVersion}-${Date.now()}`);
    this.raw.prepare('VACUUM INTO ?').run(dest);
    this.lastBackupPath = dest;
  }

  /** @param {string} sql */
  prepare(sql) {
    return this.raw.prepare(sql);
  }

  /**
   * Run `fn` inside a write transaction; rolls back on throw.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  transaction(fn) {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  /** Cheap liveness probe; throws if the connection is unusable. */
  ping() {
    this.raw.prepare('SELECT 1').get();
  }

  /** Database file size in bytes. */
  sizeBytes() {
    const r = /** @type {{ bytes: number }} */ (this.raw.prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get());
    return Number(r.bytes);
  }

  close() {
    this.raw.close();
  }
}

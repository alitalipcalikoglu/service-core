import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
 * assume one exists) simply gets an empty array via the default below.
 */
export class Database {
  /** @type {readonly string[]} */
  static MIGRATIONS = [];

  /** @param {string} path File path, or ":memory:". */
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    /** @readonly */
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.#migrate();
  }

  #migrate() {
    /** @type {readonly string[]} */
    const migrations = /** @type {typeof Database} */ (this.constructor).MIGRATIONS;
    const { user_version: current } = /** @type {{ user_version: number }} */ (this.raw.prepare('PRAGMA user_version').get());
    for (let v = current; v < migrations.length; v++) {
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(migrations[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    }
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

/**
 * A `Map<sql, StatementSync>` cache for queries built from dynamic SQL text (e.g. an optional
 * `WHERE` clause assembled per call) — generalizes the ad hoc `#cached` idiom every store with
 * filtered search previously wrote by hand.
 *
 * **Never cache a statement used with `.iterate()`.** `StatementSync#iterate()` keeps state on the
 * prepared statement object itself; two concurrent `iterate()` calls sharing one cached statement
 * reset each other's cursor (this is the exact bug Stage 0 fixed in audit's `EventStore.iterate()`
 * — the fix was to stop going through the cache for that one call site). Prepare a fresh statement
 * for `.iterate()` every time; use this cache only for `.get()`/`.all()`/`.run()`.
 */
export class StatementCache {
  /** @param {{ prepare: (sql: string) => import('node:sqlite').StatementSync }} db */
  constructor(db) {
    this.db = db;
    /** @type {Map<string, import('node:sqlite').StatementSync>} */
    this.cache = new Map();
  }

  /** @param {string} sql */
  get(sql) {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  }
}

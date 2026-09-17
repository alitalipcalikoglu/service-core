import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError } from '../src/config.js';
import { Database } from '../src/db.js';

test('Database: subclass MIGRATIONS is applied, PRAGMAs set, transaction/ping/sizeBytes/close work', () => {
  class TestDb extends Database {
    static MIGRATIONS = ['CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)'];
  }
  const db = new TestDb(':memory:');
  db.ping();
  const get = (/** @type {string} */ sql) => /** @type {any} */ (db.prepare(sql).get());
  assert.equal(get('PRAGMA journal_mode').journal_mode, 'memory', 'in-memory db reports its own mode, but the pragma call itself must not throw');
  assert.equal(get('PRAGMA foreign_keys').foreign_keys, 1);

  db.transaction(() => {
    db.prepare('INSERT INTO t (id, v) VALUES (1, ?)').run('a');
  });
  assert.equal(get('SELECT v FROM t WHERE id = 1').v, 'a');

  assert.throws(() => db.transaction(() => {
    db.prepare('INSERT INTO t (id, v) VALUES (2, ?)').run('b');
    throw new Error('boom');
  }));
  assert.equal(get('SELECT COUNT(*) AS n FROM t').n, 1, 'the failed transaction rolled back');

  assert.equal(typeof db.sizeBytes(), 'number');
  assert.equal(db.schemaVersion, 1);
  db.close();
});

test('Database: a subclass with no MIGRATIONS override still opens (empty schema)', () => {
  class Empty extends Database {}
  const db = new Empty(':memory:');
  db.ping();
  assert.equal(db.schemaVersion, 0);
  db.close();
});

test('Database: a migration that throws rolls back and the error propagates (startup aborts)', () => {
  class Bad extends Database {
    static MIGRATIONS = ['NOT VALID SQL ;;;'];
  }
  assert.throws(() => new Bad(':memory:'));
});

test('Database: schema_migrations records every applied version, exactly once', () => {
  class Multi extends Database {
    static MIGRATIONS = [
      'CREATE TABLE t (id INTEGER PRIMARY KEY)',
      'ALTER TABLE t ADD COLUMN v TEXT',
    ];
  }
  const db = new Multi(':memory:');
  const rows = /** @type {any[]} */ (db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all());
  assert.deepEqual(rows.map((r) => [r.version, r.name]), [[1, 'v1'], [2, 'v2']]);
  db.close();
});

test('Database: fresh file and an upgraded existing file run through the same migration loop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-db-'));
  const path = join(dir, 'app.db');
  try {
    class V1 extends Database {
      static MIGRATIONS = ['CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)'];
    }
    const fresh = new V1(path);
    fresh.prepare('INSERT INTO t (id, v) VALUES (1, ?)').run('a');
    fresh.close();
    assert.equal(readdirSync(dir).filter((f) => f.includes('.pre-v')).length, 0, 'a brand new database is never snapshotted — nothing to protect');

    class V2 extends Database {
      static MIGRATIONS = ['CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)', 'ALTER TABLE t ADD COLUMN note TEXT'];
    }
    const upgraded = new V2(path);
    assert.equal(upgraded.schemaVersion, 2);
    assert.equal(/** @type {any} */ (upgraded.prepare('SELECT v FROM t WHERE id = 1').get()).v, 'a', 'existing row survives the upgrade');
    assert.ok(upgraded.lastBackupPath && existsSync(upgraded.lastBackupPath), 'an upgrade of existing data is snapshotted first');
    assert.match(upgraded.lastBackupPath ?? '', /app\.db\.pre-v1-\d+$/);

    const snapshot = new (class extends Database { static MIGRATIONS = V1.MIGRATIONS; })(/** @type {string} */ (upgraded.lastBackupPath));
    assert.equal(/** @type {any} */ (snapshot.prepare('SELECT v FROM t WHERE id = 1').get()).v, 'a', 'snapshot is a valid, independently-openable v1 database');
    snapshot.close();

    upgraded.close();

    const reopened = new V2(path);
    assert.equal(reopened.schemaVersion, 2, 'a database already at the latest version applies nothing on reopen');
    const rows = /** @type {any[]} */ (reopened.prepare('SELECT version FROM schema_migrations ORDER BY version').all());
    assert.deepEqual(rows.map((r) => r.version), [1, 2], 'v1 recorded on first open, v2 on upgrade — no duplicate row on reopen at the latest version');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Database: a migration that fails partway leaves the prior version intact and the pre-copy on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-db-fail-'));
  const path = join(dir, 'app.db');
  try {
    class V1 extends Database {
      static MIGRATIONS = ['CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)'];
    }
    new V1(path).close();

    class V2Bad extends Database {
      static MIGRATIONS = ['CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)', 'NOT VALID SQL ;;;'];
    }
    assert.throws(() => new V2Bad(path), (/** @type {any} */ err) => err instanceof Error);

    const recovered = new V1(path);
    assert.equal(recovered.schemaVersion, 1, 'the failed second migration never advanced user_version');
    assert.deepEqual(/** @type {any[]} */ (recovered.prepare('SELECT version FROM schema_migrations').all()).map((r) => r.version), [1]);
    recovered.close();
    assert.equal(readdirSync(dir).filter((f) => f.includes('.pre-v1-')).length, 1, 'the pre-migration snapshot from the failed attempt is still on disk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Database: refuses to open when the file is newer than this build supports', () => {
  class V2 extends Database {
    static MIGRATIONS = ['CREATE TABLE t (id INTEGER PRIMARY KEY)', 'ALTER TABLE t ADD COLUMN v TEXT'];
  }
  const dir = mkdtempSync(join(tmpdir(), 'core-db-newer-'));
  const path = join(dir, 'app.db');
  try {
    new V2(path).close();
    class V1Only extends Database {
      static MIGRATIONS = ['CREATE TABLE t (id INTEGER PRIMARY KEY)'];
    }
    assert.throws(() => new V1Only(path), ConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Database: backupDir option redirects the pre-migration snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-db-bkdir-'));
  const backupDir = mkdtempSync(join(tmpdir(), 'core-db-bkdir-dest-'));
  const path = join(dir, 'app.db');
  try {
    class V1 extends Database {
      static MIGRATIONS = ['CREATE TABLE t (id INTEGER PRIMARY KEY)'];
    }
    new V1(path).close();
    class V2 extends Database {
      static MIGRATIONS = ['CREATE TABLE t (id INTEGER PRIMARY KEY)', 'ALTER TABLE t ADD COLUMN v TEXT'];
    }
    const db = new V2(path, { backupDir });
    assert.ok(db.lastBackupPath?.startsWith(backupDir));
    assert.equal(readdirSync(dir).filter((f) => f.includes('.pre-v')).length, 0, 'nothing dropped next to the live db file');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  }
});

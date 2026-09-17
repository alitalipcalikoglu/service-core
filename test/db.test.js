import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Database, StatementCache } from '../src/db.js';

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
  db.close();
});

test('Database: a subclass with no MIGRATIONS override still opens (empty schema)', () => {
  class Empty extends Database {}
  const db = new Empty(':memory:');
  db.ping();
  db.close();
});

test('Database: a migration that throws rolls back and the error propagates (startup aborts)', () => {
  class Bad extends Database {
    static MIGRATIONS = ['NOT VALID SQL ;;;'];
  }
  assert.throws(() => new Bad(':memory:'));
});

test('StatementCache: same SQL text returns the same prepared statement, different text a different one', () => {
  class TestDb extends Database {
    static MIGRATIONS = ['CREATE TABLE t (id INTEGER)'];
  }
  const db = new TestDb(':memory:');
  const cache = new StatementCache(db);
  const a1 = cache.get('SELECT * FROM t WHERE id = 1');
  const a2 = cache.get('SELECT * FROM t WHERE id = 1');
  const b = cache.get('SELECT * FROM t WHERE id = 2');
  assert.equal(a1, a2, 'identical SQL text is cached');
  assert.notEqual(a1, b, 'different SQL text is a different statement');
  db.close();
});

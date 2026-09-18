/**
 * Shared migration definitions for the cross-process migration-race regression
 * (`../migration-race.test.js`). Deliberately non-idempotent in a way that is *silent*, not just
 * crash-prone: `v2`'s `UPDATE ... SET migrated_count = migrated_count + 1` succeeds every time it
 * runs, so a bug that lets two racing processes both apply it is only detectable by reading
 * `migrated_count` afterward (expected: exactly 1), not by either process crashing. This is the
 * "exactly once LOGICAL EFFECT" canary distinct from mere crash-avoidance.
 */
export const RACE_MIGRATIONS_V1 = [
  `CREATE TABLE meta (id INTEGER PRIMARY KEY, migrated_count INTEGER NOT NULL DEFAULT 0);
   INSERT INTO meta (id, migrated_count) VALUES (1, 0);
   CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);`,
];

export const RACE_MIGRATIONS_V2 = [
  ...RACE_MIGRATIONS_V1,
  `UPDATE meta SET migrated_count = migrated_count + 1 WHERE id = 1;`,
];

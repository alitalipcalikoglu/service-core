// Plain spawn-timing child (no IPC barrier) for scripts/migration-race-stress.mjs — mirrors the
// original audit reproduction exactly.
import { Database } from '../src/db.js';
import { RACE_MIGRATIONS_V2 } from '../test/fixtures/migration-race-schema.mjs';

class RaceDb extends Database {
  static MIGRATIONS = RACE_MIGRATIONS_V2;
}

const dbPath = process.argv[2];
try {
  new RaceDb(dbPath).close();
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

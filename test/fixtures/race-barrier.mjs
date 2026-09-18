import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./migration-race-child.mjs', import.meta.url));

/**
 * Forks one real OS process per entry in `migrationsPerChild`, each running
 * `migration-race-child.mjs` against the same `dbPath` (optionally each with its OWN `MIGRATIONS`
 * array, for a mixed-build/mixed-version race), and releases every one of them with a single
 * synchronous burst of IPC `go` messages only once EVERY child has signalled `ready` (i.e. is
 * blocked immediately before constructing its own `Database`). This is the barrier: it replaces
 * relying on `child_process.spawn`/`Promise.all` timing luck with an explicit rendezvous point, so
 * the race window opens deterministically on every run rather than "usually". Results are returned
 * in the same order as `migrationsPerChild`, not IPC arrival order.
 * @param {{ dbPath: string, migrationsPerChild: string[][] }} o
 * @returns {Promise<{ ok: boolean, schemaVersion?: number, lastBackupPath?: string|null, error?: string, code?: string, pid: number }[]>}
 */
export function raceOpenMixed({ dbPath, migrationsPerChild }) {
  return new Promise((resolve, reject) => {
    const children = migrationsPerChild.map(() => fork(CHILD, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
    const indexOf = new Map(children.map((c, i) => [c, i]));
    let readyCount = 0;
    /** @type {any[]} */
    const results = new Array(children.length).fill(undefined);
    const timer = setTimeout(() => { cleanup(); reject(new Error('raceOpenMixed: timed out waiting for children')); }, 20_000);
    const cleanup = () => { clearTimeout(timer); for (const c of children) if (!c.killed) c.kill(); };
    for (const child of children) {
      child.on('error', (err) => { cleanup(); reject(err); });
      child.on('message', (/** @type {any} */ msg) => {
        const i = /** @type {number} */ (indexOf.get(child));
        if (msg.type === 'ready') {
          readyCount++;
          if (readyCount === children.length) {
            // One synchronous burst: every child's `go` is sent in the same tick, so IPC delivery
            // latency (not this loop) is the only source of skew between when each child wakes up.
            for (let j = 0; j < children.length; j++) children[j].send({ type: 'go', dbPath, migrations: migrationsPerChild[j] });
          }
        } else if (msg.type === 'result') {
          results[i] = { ...msg, pid: child.pid };
          if (results.every(Boolean)) { cleanup(); resolve(results); }
        }
      });
    }
  });
}

/**
 * Convenience wrapper: `count` children, all racing with the SAME `migrations` array (the common
 * case — two builds of the same version racing a pending migration, or racing to create a fresh
 * database).
 * @param {{ dbPath: string, migrations: string[], count?: number }} o
 */
export function raceOpen({ dbPath, migrations, count = 2 }) {
  return raceOpenMixed({ dbPath, migrationsPerChild: Array.from({ length: count }, () => migrations) });
}

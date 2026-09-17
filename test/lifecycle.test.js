import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * `Lifecycle.install` calls `process.exit()` directly (matching every service's current
 * `application.js` exactly), so it cannot be exercised in-process without killing the test runner.
 * Each case spawns a tiny real child process, sends it a real signal, and asserts on its exit code
 * and stdout — the only way to observe this module's actual, documented behavior honestly.
 * @param {string} body Script body; `require`/`import` service-core via the relative path below.
 */
function run(body) {
  const src = fileURLToPath(new URL('../src/lifecycle.js', import.meta.url));
  // A self-sent signal is delivered asynchronously; with nothing else scheduled the bare script
  // would finish and the process would exit 0 *before* the handler ever runs. A short keep-alive
  // timer (well under any test's own forceExitMs) gives the event loop one more tick — this is a
  // test-harness artifact, not something a real service needs (its open server socket does this).
  const script = `import { Lifecycle } from '${src}';\nsetTimeout(() => {}, 2000);\n${body}`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.on('exit', (code) => resolve({ code, stdout }));
  });
}

const LOG = `const log = { info: (...a) => console.log(JSON.stringify(['info', a])), error: (...a) => console.log(JSON.stringify(['error', a])), fatal: (...a) => console.log(JSON.stringify(['fatal', a])) };`;

test('install: SIGTERM runs steps in order, then exits 0', async () => {
  const { code, stdout } = await run(`
    ${LOG}
    const order = [];
    Lifecycle.install({ forceExitMs: 5000, log, steps: [
      () => order.push('a'),
      async () => { await new Promise((r) => setTimeout(r, 10)); order.push('b'); },
      () => { order.push('c'); console.log(JSON.stringify(order)); },
    ] });
    process.kill(process.pid, 'SIGTERM');
  `);
  assert.equal(code, 0);
  assert.ok(stdout.includes('["a","b","c"]'), `steps ran in order: ${stdout}`);
  assert.ok(stdout.includes('"shutting down"'));
  assert.ok(stdout.includes('"shutdown complete"'));
});

test('install: a step that throws aborts remaining steps and exits 1', async () => {
  const { code, stdout } = await run(`
    ${LOG}
    Lifecycle.install({ forceExitMs: 5000, log, steps: [
      () => { throw new Error('boom'); },
      () => console.log('SHOULD_NOT_RUN'),
    ] });
    process.kill(process.pid, 'SIGTERM');
  `);
  assert.equal(code, 1);
  assert.ok(!stdout.includes('SHOULD_NOT_RUN'));
  assert.ok(stdout.includes('"shutdown failed"'));
});

test('install: a second signal while already shutting down is ignored (idempotent)', async () => {
  const { code, stdout } = await run(`
    ${LOG}
    let calls = 0;
    Lifecycle.install({ forceExitMs: 5000, log, steps: [
      async () => { calls++; await new Promise((r) => setTimeout(r, 200)); },
    ] });
    process.kill(process.pid, 'SIGTERM');
    process.kill(process.pid, 'SIGTERM');
  `);
  assert.equal(code, 0);
  assert.equal(stdout.split('"shutting down"').length - 1, 1, 'only the first SIGTERM logged "shutting down"');
});

test('install: a step that never resolves is force-exited after forceExitMs, exit code 1', async () => {
  const { code, stdout } = await run(`
    ${LOG}
    Lifecycle.install({ forceExitMs: 100, log, steps: [ () => new Promise(() => {}) ] });
    process.kill(process.pid, 'SIGTERM');
  `);
  assert.equal(code, 1);
  assert.ok(stdout.includes('"shutdown timed out, exiting"'));
});

test('install: unhandledRejection triggers the same shutdown sequence', async () => {
  const { code, stdout } = await run(`
    ${LOG}
    Lifecycle.install({ forceExitMs: 5000, log, steps: [ () => console.log('CLEANED_UP') ] });
    Promise.reject(new Error('async boom'));
  `);
  assert.equal(code, 0);
  assert.ok(stdout.includes('"unhandled rejection"'));
  assert.ok(stdout.includes('CLEANED_UP'));
});

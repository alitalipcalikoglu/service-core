import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * Contract test: every subpath a service will `import` must actually resolve and export the
 * classes/functions the modules described in IMPLEMENTATION_PLAN.md's Stage 2 table promise. A
 * package.json `exports` typo or a forgotten export would otherwise only surface as a runtime
 * error in the first *service* that adopts it.
 */
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package.json declares the exact subpaths named in the Stage 2 module table', () => {
  assert.deepEqual(Object.keys(pkg.exports).sort(), ['./audit', './auth', './config', './context', './db', './fastify', './http', './lifecycle'].sort());
});

test('every subpath resolves and exports its documented members', async () => {
  const config = await import('../src/config.js');
  assert.ok(config.EnvReader && config.ConfigError);
  assert.equal(typeof config.parseApiKeys, 'function');
  assert.equal(typeof config.parseAudit, 'function');
  assert.equal(typeof config.parseTarget, 'function');

  const db = await import('../src/db.js');
  assert.ok(db.Database && db.StatementCache);

  const audit = await import('../src/audit-client.js');
  assert.ok(audit.AuditClient && typeof audit.AuditClient.hook === 'function' && typeof audit.AuditClient.route === 'function');

  const auth = await import('../src/api-key-auth.js');
  assert.ok(auth.ApiKeyAuth && typeof auth.ApiKeyAuth.require === 'function' && typeof auth.ApiKeyAuth.assertScope === 'function');

  const context = await import('../src/trace-context.js');
  assert.ok(context.TraceContext && typeof context.TraceContext.forRequest === 'function');

  const http = await import('../src/http.js');
  assert.ok(http.HttpCaller && http.CallError && http.NetGuard && http.NetGuardError && http.Signer);

  const lifecycle = await import('../src/lifecycle.js');
  assert.ok(lifecycle.Lifecycle && typeof lifecycle.Lifecycle.install === 'function');

  const fastifyHelpers = await import('../src/fastify-helpers.js');
  assert.equal(typeof fastifyHelpers.jsonParser, 'function');
  assert.equal(typeof fastifyHelpers.createErrorHandler, 'function');
  assert.equal(typeof fastifyHelpers.registerProbes, 'function');
  assert.equal(typeof fastifyHelpers.metricsText, 'function');
});

test('each exports entry points at a file that exists', () => {
  for (const [subpath, rel] of Object.entries(pkg.exports)) {
    assert.doesNotThrow(() => readFileSync(new URL(`../${rel}`, import.meta.url)), `${subpath} -> ${rel} must exist`);
  }
});

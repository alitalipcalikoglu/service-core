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

test('package.json declares the exact subpaths this package actually has real adopters for', () => {
  // No "./context" here: TraceContext was moved from gateway into core during Stage 2 on the
  // assumption gateway (or some other service) would adopt it, but gateway was never in Stage 2's
  // adoption order and no service ended up needing it. Zero real consumers -> removed before
  // Stage 2 closed rather than shipped as a speculative, unused abstraction.
  assert.deepEqual(Object.keys(pkg.exports).sort(), ['./audit', './auth', './config', './db', './fastify', './http', './lifecycle', './log', './secrets'].sort());
});

test('every subpath resolves and exports its documented members', async () => {
  const config = await import('../src/config.js');
  assert.ok(config.EnvReader && config.ConfigError);
  assert.equal(typeof config.parseApiKeys, 'function');
  assert.equal(typeof config.parseAudit, 'function');
  assert.equal(typeof config.parseTarget, 'function');

  const db = await import('../src/db.js');
  assert.ok(db.Database);

  const audit = await import('../src/audit-client.js');
  assert.ok(audit.AuditClient && typeof audit.AuditClient.hook === 'function' && typeof audit.AuditClient.route === 'function');

  const auth = await import('../src/api-key-auth.js');
  assert.ok(auth.ApiKeyAuth && typeof auth.ApiKeyAuth.require === 'function' && typeof auth.ApiKeyAuth.assertScope === 'function');

  const http = await import('../src/http.js');
  assert.ok(http.HttpCaller && http.CallError && http.NetGuard && http.NetGuardError && http.Signer);

  const lifecycle = await import('../src/lifecycle.js');
  assert.ok(lifecycle.Lifecycle && typeof lifecycle.Lifecycle.install === 'function');

  const fastifyHelpers = await import('../src/fastify-helpers.js');
  assert.equal(typeof fastifyHelpers.jsonParser, 'function');
  assert.equal(typeof fastifyHelpers.createErrorHandler, 'function');
  assert.equal(typeof fastifyHelpers.registerProbes, 'function');
  assert.equal(typeof fastifyHelpers.metricsText, 'function');
  assert.equal(typeof fastifyHelpers.registerInfo, 'function');
  assert.equal(typeof fastifyHelpers.readServiceVersion, 'function');
  assert.equal(typeof fastifyHelpers.SERVICE_CORE_VERSION, 'string');

  const secrets = await import('../src/secret-box.js');
  assert.ok(secrets.SecretBox && typeof secrets.SecretBox.isSealed === 'function');

  const log = await import('../src/console-logger.js');
  assert.ok(log.ConsoleLogger);
});

test('each exports entry points at a file that exists', () => {
  for (const [subpath, rel] of Object.entries(pkg.exports)) {
    assert.doesNotThrow(() => readFileSync(new URL(`../${rel}`, import.meta.url)), `${subpath} -> ${rel} must exist`);
  }
});

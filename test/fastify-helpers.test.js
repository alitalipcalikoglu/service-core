import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { test } from 'node:test';
import { createErrorHandler, jsonParser, metricsText, readServiceVersion, registerInfo, registerOpenApi, registerProbes, SERVICE_CORE_VERSION } from '../src/fastify-helpers.js';

class DomainError extends Error {
  /** @param {string} code @param {number} statusCode @param {string} message @param {object} [details] */
  constructor(code, statusCode, message, details) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

test('jsonParser: empty body -> undefined, invalid JSON -> 400 INVALID_JSON, valid JSON parses', async () => {
  const app = Fastify({ logger: false });
  jsonParser(app);
  app.post('/x', async (request) => ({ got: request.body ?? null }));
  app.setErrorHandler((err, _req, reply) => reply.code(/** @type {any} */ (err).statusCode ?? 500).send({ code: /** @type {any} */ (err).code }));

  const empty = await app.inject({ method: 'POST', url: '/x', headers: { 'content-type': 'application/json' }, payload: '' });
  assert.deepEqual(empty.json(), { got: null });

  const bad = await app.inject({ method: 'POST', url: '/x', headers: { 'content-type': 'application/json' }, payload: '{not json' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, 'INVALID_JSON');

  const good = await app.inject({ method: 'POST', url: '/x', headers: { 'content-type': 'application/json' }, payload: '{"a":1}' });
  assert.deepEqual(good.json(), { got: { a: 1 } });
});

test('createErrorHandler: DomainError -> its own status/code/message/details; unknown 5xx -> generic INTERNAL_ERROR; validation errors -> VALIDATION_FAILED', async () => {
  const app = Fastify({ logger: false });
  app.setErrorHandler(createErrorHandler(DomainError));
  app.get('/domain', async () => { throw new DomainError('NOT_FOUND', 404, 'missing', { id: '1' }); });
  app.get('/boom', async () => { throw new Error('secret internal detail'); });
  app.post('/validated', { schema: { body: { type: 'object', required: ['x'], properties: { x: { type: 'string' } } } } }, async () => ({ ok: true }));

  const domain = await app.inject({ method: 'GET', url: '/domain' });
  assert.equal(domain.statusCode, 404);
  assert.deepEqual(domain.json(), { error: { code: 'NOT_FOUND', message: 'missing', details: { id: '1' } } });

  const boom = await app.inject({ method: 'GET', url: '/boom' });
  assert.equal(boom.statusCode, 500);
  assert.deepEqual(boom.json(), { error: { code: 'INTERNAL_ERROR', message: 'internal error' } }, 'internal error details never leak');

  const invalid = await app.inject({ method: 'POST', url: '/validated', payload: {} });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'VALIDATION_FAILED');
});

test('createErrorHandler: extra hook handles its own case first (media\'s 413, auth\'s retry-after, shortlink\'s QrTooLongError)', async () => {
  class QrTooLongError extends Error {}
  const app = Fastify({ logger: false });
  app.setErrorHandler(createErrorHandler(DomainError, {
    extra: (err, _request, reply) => {
      if (err instanceof QrTooLongError) { reply.code(400).send({ error: { code: 'QR_TOO_LONG', message: err.message } }); return true; }
      return false;
    },
  }));
  app.get('/qr', async () => { throw new QrTooLongError('too long'); });
  const res = await app.inject({ method: 'GET', url: '/qr' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'QR_TOO_LONG');
});

test('registerProbes: /health always ok; /ready 503 with error until the check passes, cached for cacheMs', async () => {
  let healthy = false;
  let calls = 0;
  const app = Fastify({ logger: false });
  registerProbes(app, () => { calls++; if (!healthy) throw new Error('db down'); }, { cacheMs: 50 });
  await app.ready();

  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.deepEqual(health.json(), { status: 'ok' });

  const notReady = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(notReady.statusCode, 503);
  assert.deepEqual(notReady.json(), { status: 'unavailable', error: 'db down' });

  healthy = true;
  const stillCached = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(stillCached.statusCode, 503, 'cached failure, checkReadiness not called again yet');
  assert.equal(calls, 1);

  await new Promise((r) => setTimeout(r, 60));
  const ok = await app.inject({ method: 'GET', url: '/ready' });
  assert.deepEqual(ok.json(), { status: 'ok' });
  assert.equal(calls, 2);
});

test('registerProbes: invalidate() forces the next /ready to re-check immediately (geo\'s post-reload behavior)', async () => {
  let healthy = true;
  let calls = 0;
  const app = Fastify({ logger: false });
  const { invalidate } = registerProbes(app, () => { calls++; if (!healthy) throw new Error('reload failed'); }, { cacheMs: 10_000 });
  await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(calls, 1);

  healthy = false;
  const stillCached = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(stillCached.statusCode, 200, 'far inside the 10s cache window, not re-checked yet');
  assert.equal(calls, 1);

  invalidate();
  const afterInvalidate = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(afterInvalidate.statusCode, 503, 'invalidate() bypassed the cache immediately');
  assert.equal(calls, 2);
});

test('registerProbes: extra() fields are merged into the healthy /ready body (scheduler/webhook-out\'s worker status)', async () => {
  const app = Fastify({ logger: false });
  let running = true;
  registerProbes(app, () => {}, { extra: () => ({ worker: running ? 'running' : 'stopped' }) });
  const ok = await app.inject({ method: 'GET', url: '/ready' });
  assert.deepEqual(ok.json(), { status: 'ok', worker: 'running' });
  running = false;
  const stopped = await app.inject({ method: 'GET', url: '/ready' });
  assert.deepEqual(stopped.json(), { status: 'ok', worker: 'stopped' });
});

test('registerProbes: checkReadiness may be async (notify\'s multi-channel verify)', async () => {
  const app = Fastify({ logger: false });
  registerProbes(app, async () => { await new Promise((r) => setTimeout(r, 5)); });
  const res = await app.inject({ method: 'GET', url: '/ready' });
  assert.deepEqual(res.json(), { status: 'ok' });
});

test('registerOpenApi: serves the exact configured bytes publicly as YAML', async () => {
  const app = Fastify();
  const specUrl = new URL('./fixtures/openapi.yaml', import.meta.url);
  registerOpenApi(app, specUrl);
  const response = await app.inject({ method: 'GET', url: '/openapi.yaml' });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /^text\/yaml; charset=utf-8/);
  assert.equal(response.rawPayload.compare(readFileSync(specUrl)), 0);
  await app.close();
});

test('metricsText: joins lines with a trailing newline', () => {
  assert.equal(metricsText(['a 1', 'b 2']), 'a 1\nb 2\n');
  assert.equal(metricsText([]), '\n');
});

test('SERVICE_CORE_VERSION: matches this package\'s own package.json (Stage 7)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(SERVICE_CORE_VERSION, pkg.version);
});

test('readServiceVersion: reads the caller\'s own package.json version, not a hand-maintained copy (Stage 7)', () => {
  assert.equal(readServiceVersion(import.meta.url), JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
});

test('registerInfo: returns the full contract, defaults apiVersion to v1 and schemaVersion/capabilities to the stateless-service shape (Stage 7)', async () => {
  const app = Fastify({ logger: false });
  registerInfo(app, { service: 'widgets', version: '2.3.1' });
  const res = await app.inject({ method: 'GET', url: '/v1/info' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { service: 'widgets', version: '2.3.1', apiVersion: 'v1', capabilities: [], schemaVersion: null, serviceCore: SERVICE_CORE_VERSION });
});

test('registerInfo: reports real capabilities and a stateful service\'s schemaVersion verbatim (Stage 7)', async () => {
  const app = Fastify({ logger: false });
  registerInfo(app, { service: 'notify', version: '1.0.0', capabilities: ['email', 'webhook'], schemaVersion: 3 });
  const res = await app.inject({ method: 'GET', url: '/v1/info' });
  assert.deepEqual(res.json(), { service: 'notify', version: '1.0.0', apiVersion: 'v1', capabilities: ['email', 'webhook'], schemaVersion: 3, serviceCore: SERVICE_CORE_VERSION });
});

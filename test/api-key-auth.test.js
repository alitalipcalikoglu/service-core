import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiKeyAuth } from '../src/api-key-auth.js';

class DomainError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** @returns {{ header: (k: string, v: string) => any, code: (c: number) => any, send: (b: unknown) => any, _r: { statusCode: number|undefined, headers: Record<string, string>, body: unknown } }} */
function fakeReply() {
  /** @type {{ statusCode: number|undefined, headers: Record<string, string>, body: unknown }} */
  const r = { statusCode: undefined, headers: {}, body: undefined };
  const reply = {
    header: (/** @type {string} */ k, /** @type {string} */ v) => { r.headers[k] = v; return reply; },
    code: (/** @type {number} */ c) => { r.statusCode = c; return reply; },
    send: (/** @type {unknown} */ b) => { r.body = b; return reply; },
    _r: r,
  };
  return reply;
}

test('identify: matches by secret regardless of position, never exits early (constant iteration)', () => {
  const keys = [{ id: 'a', secret: 's'.repeat(32) }, { id: 'b', secret: 't'.repeat(32) }, { id: 'c', secret: 'u'.repeat(32) }];
  const auth = new ApiKeyAuth(keys);
  assert.equal(auth.identify('t'.repeat(32))?.id, 'b');
  assert.equal(auth.identify('nope'), undefined);
});

test('hook: default decorate attaches request.apiKey (the 6/9-service shape); 401 body is the fixed shared envelope', async () => {
  const key = { id: 'svc', secret: 's'.repeat(32), role: 'readwrite' };
  const auth = new ApiKeyAuth([key]);
  const req = /** @type {any} */ ({ headers: { authorization: `Bearer ${key.secret}` } });
  const reply = fakeReply();
  await auth.hook(req, /** @type {any} */ (reply));
  assert.equal(req.apiKey, key);
  assert.equal(reply._r.statusCode, undefined, 'no error response on success');

  const bad = fakeReply();
  await auth.hook(/** @type {any} */ ({ headers: {} }), /** @type {any} */ (bad));
  assert.equal(bad._r.statusCode, 401);
  assert.deepEqual(bad._r.body, { error: { code: 'UNAUTHORIZED', message: 'missing or invalid API key' } });
  assert.equal(bad._r.headers['www-authenticate'], 'Bearer');
});

test('hook: custom decorate reproduces the split apiKeyId/apiKeyRole shape (audit/shortlink) and the id-only shape (media)', async () => {
  const key = { id: 'svc', secret: 's'.repeat(32), role: 'write' };
  const split = new ApiKeyAuth([key], { decorate: (/** @type {any} */ r, /** @type {any} */ k) => { r.apiKeyId = k.id; r.apiKeyRole = k.role; } });
  const req1 = /** @type {any} */ ({ headers: { authorization: `Bearer ${key.secret}` } });
  await split.hook(req1, /** @type {any} */ (fakeReply()));
  assert.deepEqual([req1.apiKeyId, req1.apiKeyRole], ['svc', 'write']);

  const idOnly = new ApiKeyAuth([{ id: 'svc', secret: key.secret }], { decorate: (/** @type {any} */ r, /** @type {any} */ k) => { r.apiKeyId = k.id; } });
  const req2 = /** @type {any} */ ({ headers: { authorization: `Bearer ${key.secret}` } });
  await idOnly.hook(req2, /** @type {any} */ (fakeReply()));
  assert.equal(req2.apiKeyId, 'svc');
  assert.equal(req2.apiKeyRole, undefined);
});

test('require: default grants (need or readwrite satisfies), matching every service but webhook-out', async () => {
  const makeError = (/** @type {string} */ need) => new DomainError('FORBIDDEN', `this API key has no ${need} access`);
  const guardWrite = ApiKeyAuth.require('write', { roleOf: (/** @type {any} */ r) => r.apiKey.role, makeError });
  await guardWrite(/** @type {any} */ ({ apiKey: { role: 'write' } }));
  await guardWrite(/** @type {any} */ ({ apiKey: { role: 'readwrite' } }));
  await assert.rejects(guardWrite(/** @type {any} */ ({ apiKey: { role: 'read' } })), DomainError);
});

test('require: webhook-out\'s grants lattice — write also satisfies publish', async () => {
  const GRANTS = { read: ['read', 'readwrite'], write: ['write', 'readwrite'], publish: ['publish', 'write', 'readwrite'] };
  const makeError = (/** @type {string} */ need) => new DomainError('FORBIDDEN', `this API key has no ${need} access`);
  const guardPublish = ApiKeyAuth.require('publish', { roleOf: (/** @type {any} */ r) => r.apiKey.role, makeError, grants: GRANTS });
  await guardPublish(/** @type {any} */ ({ apiKey: { role: 'publish' } }));
  await guardPublish(/** @type {any} */ ({ apiKey: { role: 'write' } }));
  await assert.rejects(guardPublish(/** @type {any} */ ({ apiKey: { role: 'read' } })), DomainError);
});

test('assertScope: null scopes means every scope allowed; a non-matching scope throws', () => {
  const makeError = (/** @type {string} */ name) => new DomainError('FORBIDDEN', `this API key has no access to policy "${name}"`);
  const key = (/** @type {string[]|null} */ scopes) => /** @type {any} */ ({ id: 'k', secret: 's'.repeat(32), scopes });
  assert.doesNotThrow(() => ApiKeyAuth.assertScope(key(null), 'anything', makeError));
  assert.doesNotThrow(() => ApiKeyAuth.assertScope(key(['a', 'b']), 'a', makeError));
  assert.throws(() => ApiKeyAuth.assertScope(key(['a']), 'b', makeError), DomainError);
});

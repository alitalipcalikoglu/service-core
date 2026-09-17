import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, EnvReader, parseApiKeys, parseAudit, parseTarget } from '../src/config.js';

test('EnvReader: optional/required/integer/boolean/list', () => {
  const r = new EnvReader({ A: '  x  ', N: '5', B1: 'true', B2: '0', L: 'a, b ,,c' });
  assert.equal(r.optional('A'), 'x');
  assert.equal(r.optional('MISSING'), '');
  assert.equal(r.required('A'), 'x');
  assert.throws(() => r.required('MISSING'), ConfigError);
  assert.equal(r.integer('N', 1), 5);
  assert.equal(r.integer('MISSING', 7), 7);
  assert.throws(() => r.integer('A', 1), ConfigError, 'non-numeric');
  assert.throws(() => new EnvReader({ N: '5' }).integer('N', 1, { max: 4 }), ConfigError, 'above max');
  assert.equal(r.boolean('B1', false), true);
  assert.equal(r.boolean('B2', true), false);
  assert.equal(r.boolean('MISSING', true), true);
  assert.throws(() => r.boolean('A', false), ConfigError, 'not true/false/1/0');
  assert.deepEqual(r.list('L'), ['a', 'b', 'c'], 'empty entries dropped');
  assert.deepEqual(r.list('MISSING'), []);
  assert.deepEqual(r.list('MISSING', 'x,y'), ['x', 'y'], 'explicit fallback (media\'s csv signature)');
});

test('parseApiKeys: roleless 2-part format (auth/media/notify today)', () => {
  const keys = parseApiKeys('svc:' + 's'.repeat(32), 'MEDIA_API_KEYS');
  assert.deepEqual(keys, [{ id: 'svc', secret: 's'.repeat(32), role: undefined, scopes: null }]);
  assert.throws(() => parseApiKeys('svc:' + 's'.repeat(32) + ':role', 'MEDIA_API_KEYS'), ConfigError, 'a 3rd part is rejected when roles is not given');
});

test('parseApiKeys: role[:scopes] format (ratelimit/geo/flags/search/scheduler/webhook-out/shortlink/audit)', () => {
  const roles = ['read', 'write', 'readwrite'];
  const [k1] = parseApiKeys('id1:' + 'a'.repeat(32), 'X_API_KEYS', { roles });
  assert.equal(k1.role, 'readwrite', 'role defaults to readwrite');
  assert.equal(k1.scopes, null);

  const [k2] = parseApiKeys('id2:' + 'b'.repeat(32) + ':read:foo+bar', 'X_API_KEYS', { roles, scopePattern: /^[a-z]+$/ });
  assert.equal(k2.role, 'read');
  assert.deepEqual(k2.scopes, ['foo', 'bar']);

  assert.throws(() => parseApiKeys('id:' + 'a'.repeat(32) + ':bogus', 'X_API_KEYS', { roles }), ConfigError, 'role not in roles list');
  assert.throws(() => parseApiKeys('id:' + 'a'.repeat(32) + ':read:BAD', 'X_API_KEYS', { roles, scopePattern: /^[a-z]+$/ }), ConfigError, 'scope fails pattern');
  assert.throws(() => parseApiKeys('id:' + 'a'.repeat(32) + ':read:BAD', 'RATELIMIT_API_KEYS', { roles, scopePattern: /^[a-z]+$/, scopeNoun: 'policy' }), (/** @type {any} */ e) => /invalid policy/.test(e.message), 'scopeNoun customizes the error wording per service (ratelimit says "policy", search says "index")');
  assert.throws(() => parseApiKeys('short:tooshort', 'X_API_KEYS', { roles }), ConfigError, 'secret under minSecretLength');
  assert.throws(() => parseApiKeys('', 'X_API_KEYS', { roles }), ConfigError, 'no keys at all');
  assert.throws(() => parseApiKeys(`a:${'x'.repeat(32)},a:${'y'.repeat(32)}`, 'X_API_KEYS', { roles }), ConfigError, 'duplicate id');
  assert.throws(() => parseApiKeys(`a:${'x'.repeat(32)},b:${'x'.repeat(32)}`, 'X_API_KEYS', { roles }), ConfigError, 'duplicate secret');
});

test('parseApiKeys: roles given, no scopePattern (geo/audit/scheduler/shortlink/webhook-out today) — role only, a 4th field is rejected', () => {
  const roles = ['read', 'write', 'readwrite'];
  const [k] = parseApiKeys('id:' + 'a'.repeat(32) + ':read', 'GEO_API_KEYS', { roles });
  assert.deepEqual(k, { id: 'id', secret: 'a'.repeat(32), role: 'read', scopes: null });
  assert.throws(() => parseApiKeys('id:' + 'a'.repeat(32) + ':read:extra', 'GEO_API_KEYS', { roles }), (/** @type {any} */ e) => /id:secret\[:role\]$/.test(e.message), 'no scope concept: message has no [:scopes] suffix, a 4th part is rejected outright');
});

test('parseApiKeys: extra roles/scope-less services (ratelimit\'s "check" role, webhook-out\'s "publish" role) are just data', () => {
  const [k] = parseApiKeys('id:' + 'a'.repeat(32) + ':check', 'RATELIMIT_API_KEYS', { roles: ['check', 'read', 'write', 'readwrite'] });
  assert.equal(k.role, 'check');
});

test('parseAudit: both-or-neither AUDIT_URL/AUDIT_API_KEY', () => {
  assert.equal(parseAudit(new EnvReader({})), null);
  assert.throws(() => parseAudit(new EnvReader({ AUDIT_URL: 'https://a.test' })), ConfigError, 'url without key');
  assert.throws(() => parseAudit(new EnvReader({ AUDIT_API_KEY: 'k'.repeat(32) })), ConfigError, 'key without url');
  assert.throws(() => parseAudit(new EnvReader({ AUDIT_URL: 'not-a-url', AUDIT_API_KEY: 'k'.repeat(32) })), ConfigError);
  assert.throws(() => parseAudit(new EnvReader({ AUDIT_URL: 'https://a.test', AUDIT_API_KEY: 'short' })), ConfigError);
  assert.deepEqual(parseAudit(new EnvReader({ AUDIT_URL: 'https://a.test///', AUDIT_API_KEY: 'k'.repeat(32) })), { url: 'https://a.test', apiKey: 'k'.repeat(32) }, 'trailing slashes stripped');
});

test('parseTarget: TARGET_ALLOW_HTTP/TARGET_ALLOW_PRIVATE/TARGET_ALLOWED_HOSTS', () => {
  assert.deepEqual(parseTarget(new EnvReader({})), { allowHttp: false, allowPrivate: false, allowedHosts: [] });
  assert.deepEqual(parseTarget(new EnvReader({ TARGET_ALLOW_HTTP: 'true', TARGET_ALLOW_PRIVATE: 'true', TARGET_ALLOWED_HOSTS: 'Internal.test' })), { allowHttp: true, allowPrivate: true, allowedHosts: ['internal.test'] }, 'hosts lower-cased');
  assert.throws(() => parseTarget(new EnvReader({ TARGET_ALLOW_PRIVATE: 'true' })), ConfigError, 'allowPrivate requires at least one allowed host');
});

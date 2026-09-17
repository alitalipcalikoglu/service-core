import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NetGuard, NetGuardError } from '../src/net-guard.js';

test('check: scheme, credentials, host allowlist — no network involved', () => {
  const guard = new NetGuard();
  assert.throws(() => guard.check('not a url'), NetGuardError);
  assert.throws(() => guard.check('http://example.test'), (/** @type {any} */ e) => e.code === 'SCHEME_NOT_ALLOWED', 'http rejected by default');
  assert.doesNotThrow(() => new NetGuard({ allowHttp: true }).check('http://example.test'));
  assert.throws(() => guard.check('https://user:pass@example.test'), (/** @type {any} */ e) => e.code === 'CREDENTIALS_IN_URL');

  const allowlisted = new NetGuard({ allowedHosts: ['example.test'] });
  assert.doesNotThrow(() => allowlisted.check('https://sub.example.test'), 'parent-domain match');
  assert.doesNotThrow(() => allowlisted.check('https://example.test'));
  assert.throws(() => allowlisted.check('https://evil.test'), (/** @type {any} */ e) => e.code === 'HOST_NOT_ALLOWED');
});

test('resolve: pins a public address; rejects private unless allowPrivate; DNS failure is retryable', async () => {
  const lookup = /** @type {any} */ (async (/** @type {string} */ host) => (host === 'public.test' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '10.0.0.5', family: 4 }]));
  const guard = new NetGuard({ lookup });
  const vetted = await guard.resolve('https://public.test/x');
  assert.equal(vetted.address, '93.184.216.34');
  assert.equal(vetted.family, 4);

  await assert.rejects(guard.resolve('https://private.test/'), (/** @type {any} */ e) => e.code === 'PRIVATE_ADDRESS');
  const allowPrivate = new NetGuard({ lookup, allowPrivate: true });
  assert.doesNotThrow(() => allowPrivate.resolve('https://private.test/'));

  const failing = new NetGuard({ lookup: /** @type {any} */ (async () => { throw new Error('nxdomain'); }) });
  await assert.rejects(failing.resolve('https://x.test/'), (/** @type {any} */ e) => e.code === 'DNS_FAILED' && e.retryable === true);
});

test('resolve: literal IP addresses skip DNS entirely', async () => {
  const guard = new NetGuard({ allowPrivate: true });
  const vetted = await guard.resolve('https://127.0.0.1:9999/');
  assert.equal(vetted.address, '127.0.0.1');
  assert.equal(vetted.family, 4);
});

test('isPublicAddress: RFC1918/loopback/link-local are private; a normal public v4 is not', () => {
  assert.equal(NetGuard.isPublicAddress('10.1.2.3'), false);
  assert.equal(NetGuard.isPublicAddress('192.168.1.1'), false);
  assert.equal(NetGuard.isPublicAddress('127.0.0.1'), false);
  assert.equal(NetGuard.isPublicAddress('169.254.1.1'), false);
  assert.equal(NetGuard.isPublicAddress('8.8.8.8'), true);
  assert.equal(NetGuard.isPublicAddress('::1'), false, 'IPv6 loopback');
  assert.equal(NetGuard.isPublicAddress('fc00::1'), false, 'unique local');
  assert.equal(NetGuard.isPublicAddress('2001:4860:4860::8888'), true, 'a real public v6 address');
});

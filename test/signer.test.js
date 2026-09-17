import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Signer } from '../src/signer.js';

test('sign/verify round-trip with a single secret matches scheduler\'s exact wire format', () => {
  const secret = 's'.repeat(32);
  const now = 1_700_000_000;
  const header = Signer.sign('body', now, [secret]);
  assert.equal(header, `t=${now},v1=${Signer.digest(secret, 'body', now).toString('hex')}`, 'one secret produces exactly one v1 tag, byte-identical to scheduler\'s single-secret format');
  assert.equal(Signer.verify([secret], 'body', header, { now: now * 1000 }), true);
  assert.equal(Signer.verify([secret], 'body', header, { now: (now + 1000) * 1000 }), false, 'outside tolerance');
  assert.equal(Signer.verify([secret], 'tampered', header, { now: now * 1000 }), false);
});

test('sign/verify with secret rotation (webhook-out): either the current or the previous secret verifies', () => {
  const current = 'c'.repeat(32);
  const previous = 'p'.repeat(32);
  const now = 1_700_000_000;
  const header = Signer.sign('body', now, [current, previous]);
  assert.equal(header.split(',').length, 3, 't= plus two v1= tags');
  assert.equal(Signer.verify([current], 'body', header, { now: now * 1000 }), true);
  assert.equal(Signer.verify([previous], 'body', header, { now: now * 1000 }), true);
  assert.equal(Signer.verify(['x'.repeat(32)], 'body', header, { now: now * 1000 }), false);
});

test('verify: malformed headers never throw, just fail', () => {
  const secret = 's'.repeat(32);
  assert.equal(Signer.verify([secret], 'body', ''), false);
  assert.equal(Signer.verify([secret], 'body', 'garbage'), false);
  assert.equal(Signer.verify([secret], 'body', 't=notanumber,v1=abc'), false);
});

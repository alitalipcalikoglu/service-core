import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { SecretBox } from '../src/secret-box.js';

test('SecretBox: seal/open round-trip, format, and independent random ivs', () => {
  const box = new SecretBox(randomBytes(32));
  const sealed1 = box.seal('super secret value');
  const sealed2 = box.seal('super secret value');
  assert.equal(box.open(sealed1), 'super secret value');
  assert.equal(box.open(sealed2), 'super secret value');
  assert.notEqual(sealed1, sealed2, 'a fresh random iv makes two seals of the same text differ');
  assert.match(sealed1, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('SecretBox: constructor rejects a key that is not exactly 32 bytes', () => {
  assert.throws(() => new SecretBox(randomBytes(31)), /32-byte/);
  assert.throws(() => new SecretBox(randomBytes(33)), /32-byte/);
});

test('SecretBox: open rejects a malformed or wrong-version sealed value', () => {
  const box = new SecretBox(randomBytes(32));
  assert.throws(() => box.open('not-sealed-at-all'), /unknown format/);
  assert.throws(() => box.open('v2.aa.bb.cc'), /unknown format/);
  assert.throws(() => box.open('v1.onlytwoparts'), /unknown format/);
});

test('SecretBox: open fails (auth tag) when sealed with a different key', () => {
  const sealed = new SecretBox(randomBytes(32)).seal('secret');
  assert.throws(() => new SecretBox(randomBytes(32)).open(sealed));
});

test('SecretBox: open fails when ciphertext or tag is tampered (authenticated encryption)', () => {
  const box = new SecretBox(randomBytes(32));
  const [v, iv, ct, tag] = box.seal('secret').split('.');
  const flipped = Buffer.from(ct, 'base64url'); flipped[0] ^= 0xff;
  assert.throws(() => box.open([v, iv, flipped.toString('base64url'), tag].join('.')));
});

test('SecretBox.isSealed: distinguishes the sealed format from legacy plaintext', () => {
  const box = new SecretBox(randomBytes(32));
  assert.equal(SecretBox.isSealed(box.seal('x')), true);
  assert.equal(SecretBox.isSealed('JBSWY3DPEHPK3PXP'), false, 'a plaintext base32 TOTP secret is not sealed');
  assert.equal(SecretBox.isSealed(''), false);
});

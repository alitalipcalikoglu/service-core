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

test('regression: a v1 ciphertext sealed before Stage 4.1 (frozen fixture, no keyId support) still opens byte-for-byte the same — webhook-out\'s existing sealed secrets must never break', () => {
  const key = Buffer.alloc(32, 7); // the exact key used to produce the frozen fixture below
  const box = new SecretBox(key); // no keyId — this is exactly how webhook-out constructs it
  const frozen = 'v1.AwMDAwMDAwMDAwMD.Q4zMeT9GcyQTODcpmTLSf4hfkorA.5wP7NLPXmgWtgE_K0gkJGw';
  assert.equal(box.open(frozen), 'frozen-fixture-secret');
});

test('SecretBox: unchanged default behavior when no keyId is given — seal() still produces plain v1, open() has no key to check', () => {
  const box = new SecretBox(randomBytes(32));
  assert.equal(box.keyId, null);
  const sealed = box.seal('x');
  assert.match(sealed, /^v1\./);
  assert.equal(box.open(sealed), 'x');
});

test('SecretBox v2 (keyed): seal() embeds the given keyId, open() accepts a matching-id value', () => {
  const key = randomBytes(32);
  const keyId = SecretBox.keyId(key);
  const box = new SecretBox(key, { keyId });
  const sealed = box.seal('secret');
  assert.match(sealed, /^v2\./);
  assert.equal(SecretBox.peekKeyId(sealed), keyId);
  assert.equal(box.open(sealed), 'secret');
  assert.equal(SecretBox.isSealed(sealed), true);
});

test('SecretBox v2: open() fail-closed refuses a value sealed under a different key id, before even attempting decryption', () => {
  const keyA = randomBytes(32);
  const keyB = randomBytes(32);
  const boxA = new SecretBox(keyA, { keyId: SecretBox.keyId(keyA) });
  const boxBWrongId = new SecretBox(keyB, { keyId: 'not-the-real-id' });
  const sealedByA = boxA.seal('secret');
  assert.throws(() => boxBWrongId.open(sealedByA), /this box is key "not-the-real-id"/);
});

test('SecretBox.keyId: deterministic, non-secret fingerprint — same key always yields the same id, different keys (almost certainly) differ', () => {
  const key = randomBytes(32);
  assert.equal(SecretBox.keyId(key), SecretBox.keyId(Buffer.from(key)));
  assert.notEqual(SecretBox.keyId(key), SecretBox.keyId(randomBytes(32)));
  assert.match(SecretBox.keyId(key), /^[0-9a-f]{16}$/);
});

test('SecretBox.peekKeyId: null for v1 and for anything not sealed at all', () => {
  const box = new SecretBox(randomBytes(32));
  assert.equal(SecretBox.peekKeyId(box.seal('x')), null, 'v1 has no embedded id');
  assert.equal(SecretBox.peekKeyId('not sealed'), null);
});

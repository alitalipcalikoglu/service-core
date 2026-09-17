import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM sealing of small secrets at rest (a webhook signing secret, a TOTP seed, …). A leaked
 * database file then reveals nothing without the key. Format: `v1.<iv>.<ciphertext>.<tag>`, each part
 * base64url — self-describing, so a sealed value is never mistaken for a legacy plaintext one and a
 * future format change can add a `v2.` variant without breaking `v1.` reads.
 */
export class SecretBox {
  static VERSION = 'v1';

  /** @param {Buffer} key 32 bytes. */
  constructor(key) {
    if (key.length !== 32) throw new Error('SecretBox needs a 32-byte key');
    this.#key = key;
  }

  /** @type {Buffer} */
  #key;

  /** @param {string} text */
  seal(text) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return [SecretBox.VERSION, iv.toString('base64url'), ct.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  }

  /** @param {string} sealed */
  open(sealed) {
    const [v, iv, ct, tag] = sealed.split('.');
    if (v !== SecretBox.VERSION || !iv || !ct || !tag) throw new Error('sealed secret has an unknown format');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }

  /**
   * True when `text` is already in this class's sealed format (any version), so callers can tell a
   * sealed value apart from legacy plaintext without trying to open it.
   * @param {string} text
   */
  static isSealed(text) {
    return /^v\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text);
  }
}

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA256 request/delivery signing. Header value is `t=<unix seconds>,v1=<hex>[,v1=<hex>]`
 * where `v1 = HMAC(secret, "<t>.<raw body>")` — one `v1` tag per secret in `secrets`, so a receiver
 * mid-rotation can verify against either the current or the previous secret. A single-secret caller
 * (`sign(body, ts, [secret])`) produces byte-identical output to a signer with no rotation concept
 * at all: this is webhook-out's design, generalized to also cover scheduler's single-secret case
 * without changing scheduler's wire format.
 *
 * The header *name* is deliberately not owned by this class — every service keeps its own constant
 * (`x-scheduler-signature`, `x-webhook-signature`, ...) and sets it itself; only the value format
 * and the constant-time verification are shared.
 */
export class Signer {
  /**
   * @param {string} body
   * @param {number} timestamp Unix seconds.
   * @param {string[]} secrets Current first, then the previous one while it is still valid.
   */
  static sign(body, timestamp, secrets) {
    return [`t=${timestamp}`, ...secrets.map((s) => `v1=${Signer.digest(s, body, timestamp).toString('hex')}`)].join(',');
  }

  /**
   * @param {string[]} secrets Any one of these validates the signature.
   * @param {string} body
   * @param {string} header
   * @param {{ toleranceSec?: number, now?: number }} [opts]
   */
  static verify(secrets, body, header, { toleranceSec = 300, now = Date.now() } = {}) {
    const parts = header.split(',');
    const t = Number(parts[0]?.startsWith('t=') ? parts[0].slice(2) : NaN);
    if (!Number.isInteger(t) || Math.abs(now / 1000 - t) > toleranceSec) return false;
    return parts.slice(1).some((p) => {
      if (!/^v1=[0-9a-f]{64}$/.test(p)) return false;
      const given = Buffer.from(p.slice(3), 'hex');
      return secrets.some((secret) => {
        const expected = Signer.digest(secret, body, t);
        return given.length === expected.length && timingSafeEqual(given, expected);
      });
    });
  }

  /** @param {string} secret @param {string} body @param {number} t */
  static digest(secret, body, t) {
    return createHmac('sha256', secret).update(`${t}.${body}`).digest();
  }
}

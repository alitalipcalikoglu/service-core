import http from 'node:http';
import https from 'node:https';

/** @typedef {import('./net-guard.js').VettedTarget} VettedTarget */

/**
 * Thrown by {@link HttpCaller.send}. Every current per-service `CallError` (scheduler, webhook-out)
 * has this exact shape; a service can keep re-exporting its own name for it if call sites already
 * `instanceof` against it, since the fields and semantics are unchanged.
 */
export class CallError extends Error {
  /**
   * @param {string} message
   * @param {{ httpStatus?: number|null, response?: string, retryable: boolean, code?: string }} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'CallError';
    this.httpStatus = info.httpStatus ?? null;
    this.response = info.response ?? '';
    this.retryable = info.retryable;
    this.code = info.code;
  }
}

/**
 * The low-level outbound transport shared by every service that calls a caller/operator-supplied
 * URL: pinned-address connection (the `target.address` a {@link module:./net-guard.js NetGuard}
 * already vetted — TLS SNI and the `Host` header still use the hostname), a timeout, and a bounded
 * response-body capture. This is deliberately *just* the transport: building the method, headers,
 * signature and body is service policy (scheduler signs one way with a bearer-token option,
 * webhook-out signs another way with multi-secret rotation, notify has its own inline variant) and
 * stays in each service's own thin caller class, which calls {@link HttpCaller.send} last.
 */
export class HttpCaller {
  static MAX_RESPONSE = 1024;

  /**
   * @param {import('./net-guard.js').VettedTarget} target Already vetted by `NetGuard.resolve()`.
   * @param {string} method
   * @param {Record<string, string>} headers
   * @param {string} body
   * @param {number} timeoutMs
   * @param {string} [label] Noun used in error messages ("target responded 500", "target timed
   *   out"). Default matches scheduler's wording; webhook-out passes `'receiver'` to keep its own.
   * @returns {Promise<{ httpStatus: number, response: string }>} 2xx outcome; rejects with
   *   {@link CallError} otherwise.
   */
  static send(target, method, headers, body, timeoutMs, label = 'target') {
    const client = target.url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = client.request(target.url, {
        method,
        headers,
        timeout: timeoutMs,
        lookup: (_host, opts, cb) => (opts.all
          ? cb(null, [{ address: target.address, family: target.family }])
          : cb(null, target.address, target.family)),
      }, (res) => {
        const status = res.statusCode ?? 0;
        /** @type {Buffer[]} */
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          if (size < HttpCaller.MAX_RESPONSE) { chunks.push(c); size += c.length; }
        });
        res.on('end', () => {
          const snippet = Buffer.concat(chunks).toString('utf8', 0, HttpCaller.MAX_RESPONSE).replace(/\s+/g, ' ').trim();
          if (status >= 200 && status < 300) return resolve({ httpStatus: status, response: snippet });
          reject(new CallError(`${label} responded ${status}${snippet ? `: ${snippet.slice(0, 200)}` : ''}`, { httpStatus: status, response: snippet, retryable: HttpCaller.isRetryableStatus(status) }));
        });
        res.on('error', (err) => reject(new CallError(`response error: ${err.message}`, { retryable: true })));
      });
      req.on('timeout', () => req.destroy(new CallError(`${label} timed out after ${timeoutMs}ms`, { retryable: true, code: 'TIMEOUT' })));
      req.on('error', (err) => reject(err instanceof CallError ? err : new CallError(`request error: ${err.message}`, { retryable: true, code: /** @type {{ code?: string }} */ (err).code })));
      req.end(body);
    });
  }

  /** Whether a failed call with this status may succeed later. @param {number} status */
  static isRetryableStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
}

export { NetGuard, NetGuardError } from './net-guard.js';
export { Signer } from './signer.js';

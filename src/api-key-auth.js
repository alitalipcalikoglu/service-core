import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * @typedef {{ id: string, secret: string, role?: string, scopes?: string[]|null }} ApiKey
 */

/**
 * Bearer API-key authentication. Every configured key is compared in constant time, without an
 * early exit on match, so timing does not reveal whether, or which, key matched — this property is
 * load-bearing and must survive every adoption unchanged.
 *
 * How a matched key is attached to `request`, and what `require()` throws on a role mismatch, both
 * vary per service today (object vs. split `apiKeyId`/`apiKeyRole` vs. `apiKeyId`-only; each
 * service's own domain error class) — both are constructor options precisely so an adoption can
 * reproduce its service's exact current behavior instead of being forced onto one shape.
 */
export class ApiKeyAuth {
  /**
   * @param {ApiKey[]} apiKeys
   * @param {object} [opts]
   * @param {(request: import('fastify').FastifyRequest, key: ApiKey) => void} [opts.decorate]
   *   Default: `request.apiKey = key` (the shape 6 of 9 current services use).
   * @param {() => Error} [opts.unauthorizedError] Not used for the 401 body (that is a fixed,
   *   already-identical-everywhere JSON envelope); reserved for a future divergent case.
   */
  constructor(apiKeys, { decorate = (request, key) => { /** @type {any} */ (request).apiKey = key; } } = {}) {
    this.apiKeys = apiKeys;
    this.decorate = decorate;
  }

  /**
   * Fastify `onRequest` hook. Arrow property so it can be passed directly to `addHook`.
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   */
  hook = async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const secret = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const key = secret ? this.identify(secret) : undefined;
    if (!key) {
      reply.header('www-authenticate', 'Bearer');
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'missing or invalid API key' } });
    }
    this.decorate(request, key);
  };

  /**
   * @param {string} secret Presented secret.
   * @returns {ApiKey|undefined} Matching key.
   */
  identify(secret) {
    /** @type {ApiKey|undefined} */
    let matched;
    for (const key of this.apiKeys) {
      if (ApiKeyAuth.#secretsEqual(secret, key.secret)) matched = key;
    }
    return matched;
  }

  /**
   * Route-level role guard. `grants` maps a required capability to the roles that satisfy it;
   * default is the simple rule every service but webhook-out uses (`need` itself, or `readwrite`).
   * webhook-out's lattice (`write` also satisfies `publish`) is reproduced by passing its own
   * `grants` table — it is service policy, not something core hardcodes.
   * @param {string} need
   * @param {object} opts
   * @param {(request: import('fastify').FastifyRequest) => string|undefined} opts.roleOf How to
   *   read the role back off the request (matches whatever `decorate` attached).
   * @param {(need: string) => Error} opts.makeError Thrown when the role does not satisfy `need`.
   * @param {Record<string, readonly string[]>} [opts.grants]
   */
  static require(need, { roleOf, makeError, grants }) {
    const satisfies = grants ? grants[need] : [need, 'readwrite'];
    /** @param {import('fastify').FastifyRequest} request */
    return async (request) => {
      const role = roleOf(request);
      if (!role || !satisfies.includes(role)) throw makeError(need);
    };
  }

  /**
   * Scope guard: a key scoped to some names (policies/indexes/environments/...) may not touch
   * others; `null` scopes means "every scope." Generalizes ratelimit's `assertPolicy`.
   * @param {ApiKey} key
   * @param {string} name
   * @param {(name: string) => Error} makeError
   */
  static assertScope(key, name, makeError) {
    if (key.scopes && !key.scopes.includes(name)) throw makeError(name);
  }

  /**
   * Constant-time comparison independent of input length.
   * @param {string} a
   * @param {string} b
   */
  static #secretsEqual(a, b) {
    return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
  }
}

/**
 * Pure Fastify helpers shared by every service that owns an HTTP API — no app factory here (each
 * service still builds its own `Fastify(...)` instance, since TLS options, body limits and the
 * request-id generator are per-service config, not infrastructure to centralize).
 */

/**
 * Tolerant `application/json` body parser: an empty body becomes `undefined` instead of a parse
 * error, anything else that fails to parse becomes a 400 `INVALID_JSON` instead of Fastify's
 * default `FST_ERR_CTP_INVALID_MEDIA_TYPE`-flavoured message. Not a fit for a service whose routes
 * need the raw body stream (gateway's proxy, an upload endpoint) — those keep their own parser.
 * @param {import('fastify').FastifyInstance} app
 */
export function jsonParser(app) {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    if (body === '') return done(null, undefined);
    try {
      done(null, JSON.parse(/** @type {string} */ (body)));
    } catch {
      done(Object.assign(new Error('body is not valid JSON'), { statusCode: 400, code: 'INVALID_JSON' }), undefined);
    }
  });
}

/**
 * Builds a Fastify `setErrorHandler` function. `DomainErrorClass` is the one `instanceof` check
 * every current handler has in common (`RateLimitError`, `LinkError`, `FlagError`, ...) — the
 * class itself stays in the service, only the dispatch shape is shared. `extra`, when given, runs
 * first and may return `true` to mean "handled, do not fall through" — this is how a service's own
 * additional branch (media's 413 on an oversized body, auth's `retry-after` header, shortlink's
 * `QrTooLongError`) survives adoption unchanged instead of being squeezed into core.
 * @param {new (...a: any[]) => { statusCode: number, code: string, message: string, details?: object }} DomainErrorClass
 * @param {{ extra?: (err: any, request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => boolean }} [opts]
 * @returns {import('fastify').FastifyInstance['errorHandler']}
 */
export function createErrorHandler(DomainErrorClass, { extra } = {}) {
  return (rawErr, request, reply) => {
    const err = /** @type {import('fastify').FastifyError & { validation?: { instancePath: string, message?: string, params: object }[] }} */ (rawErr);
    if (extra?.(err, request, reply)) return reply;
    if (err instanceof DomainErrorClass) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    if (err.validation) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_FAILED', message: err.message, details: err.validation.map((v) => ({ path: v.instancePath, message: v.message, params: v.params })) },
      });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(status).send({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
    }
    return reply.code(status).send({ error: { code: /** @type {any} */ (err).code ?? 'REQUEST_ERROR', message: err.message } });
  };
}

/**
 * Registers `GET /health` (always ok) and `GET /ready` (cached dependency check) exactly as every
 * service does today. `checkReadiness` may be sync or async (notify's checks its SMTP/webhook
 * channels too, not just the DB) and is only re-run after `cacheMs` since the last call.
 * @param {import('fastify').FastifyInstance} app
 * @param {() => (unknown|Promise<unknown>)} checkReadiness Only throwing means unhealthy; any
 *   return value (including `undefined`) means healthy — the return value itself is not inspected.
 * @param {{ cacheMs?: number }} [opts]
 */
export function registerProbes(app, checkReadiness, { cacheMs = 10_000 } = {}) {
  /** @type {{ at: number, ok: boolean, error: string }} */
  let readyCache = { at: 0, ok: false, error: '' };

  async function readiness() {
    const now = Date.now();
    if (now - readyCache.at > cacheMs) {
      try {
        await checkReadiness();
        readyCache = { at: now, ok: true, error: '' };
      } catch (err) {
        readyCache = { at: now, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    return readyCache;
  }

  app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok' }));
  app.get('/ready', { logLevel: 'warn' }, async (_request, reply) => {
    const ready = await readiness();
    if (!ready.ok) {
      app.log.warn({ error: ready.error }, 'readiness check failed');
      return reply.code(503).send({ status: 'unavailable', error: ready.error });
    }
    return { status: 'ok' };
  });
}

/**
 * Joins Prometheus text-format lines the way every `/metrics` route already does: one string per
 * metric/label combination, newline separated, with a trailing newline.
 * @param {string[]} lines
 */
export function metricsText(lines) {
  return `${lines.join('\n')}\n`;
}

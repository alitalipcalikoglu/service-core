import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { test } from 'node:test';
import { registerRequestContext, requestOptions } from '../src/fastify-helpers.js';
import { RequestContext } from '../src/request-context.js';
import { TraceContext } from '../src/trace-context.js';

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

/** Resolves every `arrive()` caller only once `n` of them have called it — forces genuine, controlled interleaving instead of relying on incidental async timing. @param {number} n */
function barrier(n) {
  let count = 0;
  /** @type {(value?: unknown) => void} */ let resolveAll = () => {};
  const ready = new Promise((r) => { resolveAll = r; });
  return async () => { count++; if (count === n) resolveAll(); await ready; };
}

test('RequestContext.run: two concurrent contexts never cross-contaminate across a real async boundary', async () => {
  const arrive = barrier(2);
  /** @param {string} id */
  async function simulate(id) {
    const ctx = new RequestContext({ requestId: `req-${id}`, trace: TraceContext.forRequest(undefined, false) });
    return RequestContext.run(ctx, async () => {
      const before = RequestContext.get();
      assert.equal(before?.requestId, `req-${id}`);
      await arrive(); // both A and B are suspended here at once, then resume — a real interleaving, not assumed ordering
      const after = RequestContext.get();
      assert.equal(after?.requestId, `req-${id}`, 'own requestId survived the boundary uncontaminated');
      assert.equal(after?.traceId, before?.traceId, 'own traceId survived the boundary uncontaminated');
      assert.equal(after?.spanId, before?.spanId, 'own spanId survived the boundary uncontaminated');
      return after;
    });
  }
  const [a, b] = await Promise.all([simulate('A'), simulate('B')]);
  assert.notEqual(a?.requestId, b?.requestId);
  assert.notEqual(a?.traceId, b?.traceId);
  assert.notEqual(a?.spanId, b?.spanId);
  assert.equal(RequestContext.get(), null, 'no context leaks outside both run() calls');
});

test('RequestContext.get() outside any run()/enterWith() is null — no global mutable fallback', () => {
  assert.equal(RequestContext.get(), null);
});

test('RequestContext#propagationHeaders: explicit, opt-in shape — same traceId, fresh child spanId, real requestId', () => {
  const trace = TraceContext.forRequest('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', true);
  const ctx = new RequestContext({ requestId: 'r-1', trace });
  const headers = ctx.propagationHeaders();
  assert.equal(headers['x-request-id'], 'r-1');
  const parsed = TraceContext.parse(headers.traceparent);
  assert.equal(parsed?.traceId, trace.traceId);
  assert.notEqual(parsed?.spanId, trace.spanId, 'a fresh child span is minted for the outbound call, never this hop\'s own span reused');
});

/** A real pino stream, capturing JSON log lines for inspection — not a fake logger shape. */
function captureLogger() {
  /** @type {any[]} */
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { lines.push(JSON.parse(chunk.toString())); cb(); },
  });
  return { lines, logger: { level: 'info', stream } };
}

test('registerRequestContext + requestOptions, wired into a real Fastify app: request-id compatibility, trusted/untrusted traceparent, log binding', async () => {
  const { lines, logger } = captureLogger();
  const app = Fastify({ ...requestOptions({ logLevel: 'info' }), logger });
  registerRequestContext(app, { trustProxy: true });
  app.get('/x', async (request) => {
    const ctx = RequestContext.get();
    request.log.info('handler reached');
    return { reqId: request.id, ctxRequestId: ctx?.requestId, traceId: ctx?.traceId, spanId: ctx?.spanId, parentSpanId: ctx?.parentSpanId };
  });

  // request-id compatibility: inbound header honoured verbatim, unchanged from before this existed.
  const withId = await app.inject({ method: 'GET', url: '/x', headers: { 'x-request-id': 'custom-caller-id' } });
  assert.equal(withId.json().reqId, 'custom-caller-id');
  assert.equal(withId.json().ctxRequestId, 'custom-caller-id', 'RequestContext sees the exact same request id Fastify resolved');

  // no inbound X-Request-Id: Fastify's own randomUUID() generator, unchanged.
  const noId = await app.inject({ method: 'GET', url: '/x' });
  assert.match(noId.json().reqId, /^[0-9a-f-]{36}$/);

  // trusted + valid traceparent: same traceId, fresh spanId, parentSpanId set to the caller's span.
  const inbound = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const trusted = await app.inject({ method: 'GET', url: '/x', headers: { traceparent: inbound } });
  assert.equal(trusted.json().traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.notEqual(trusted.json().spanId, '00f067aa0ba902b7');
  assert.match(trusted.json().spanId, HEX16);
  assert.equal(trusted.json().parentSpanId, '00f067aa0ba902b7');

  // malformed traceparent while trusted: fresh trace, request still succeeds (never 500s).
  const malformed = await app.inject({ method: 'GET', url: '/x', headers: { traceparent: 'not-a-traceparent' } });
  assert.equal(malformed.statusCode, 200);
  assert.match(malformed.json().traceId, HEX32);
  assert.equal(malformed.json().parentSpanId, null);

  // log binding: the captured structured log line carries traceId/spanId without the route handler doing anything special.
  const logged = lines.find((l) => l.msg === 'handler reached');
  assert.ok(logged, 'expected a captured log line');
  assert.match(logged.traceId, HEX32);
  assert.match(logged.spanId, HEX16);

  // Fastify's OWN built-in request logging — never an explicit request.log call anywhere — also
  // carries traceId/spanId, because registerRequestContext hooks logger *creation* itself
  // (setChildLoggerFactory), not a later request.log reassignment a hook can't retroactively
  // apply to lines Fastify already emitted through its own earlier-captured reference.
  const incoming = lines.find((l) => l.msg === 'incoming request' && l.reqId === 'custom-caller-id');
  assert.ok(incoming, `expected a built-in "incoming request" line. Lines: ${JSON.stringify(lines)}`);
  assert.match(incoming.traceId, HEX32);
  const completed = lines.find((l) => l.msg === 'request completed' && l.reqId === 'custom-caller-id');
  assert.ok(completed, 'expected a built-in "request completed" line');
  assert.equal(completed.traceId, incoming.traceId, 'same trace across both automatic log lines for the one request');
  assert.equal(completed.spanId, incoming.spanId);

  await app.close();
});

test('registerRequestContext: untrusted (trustProxy: false) never honours an inbound traceparent, even a well-formed one', async () => {
  const app = Fastify({ ...requestOptions(), logger: false });
  registerRequestContext(app, { trustProxy: false });
  app.get('/x', async () => {
    const ctx = RequestContext.get();
    return { traceId: ctx?.traceId, parentSpanId: ctx?.parentSpanId };
  });
  const inbound = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const res = await app.inject({ method: 'GET', url: '/x', headers: { traceparent: inbound } });
  assert.notEqual(res.json().traceId, '4bf92f3577b34da6a3ce929d0e0e4736', 'untrusted: inbound trace-id never adopted, regardless of validity');
  assert.equal(res.json().parentSpanId, null);
  await app.close();
});

test('requestOptions: extraRedact is additive to the universal req.headers.authorization redaction', () => {
  const opts = requestOptions({ extraRedact: ['req.headers["x-access-token"]'] });
  assert.deepEqual(/** @type {any} */ (opts.logger)?.redact, ['req.headers.authorization', 'req.headers["x-access-token"]']);
});

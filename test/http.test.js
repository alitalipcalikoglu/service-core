import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { CallError, HttpCaller } from '../src/http.js';

/** @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler */
async function withServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  return { port, close: () => new Promise((r) => server.close(() => r(undefined))) };
}

/** @param {number} port */
function target(port) {
  return { url: new URL(`http://127.0.0.1:${port}/`), address: '127.0.0.1', family: /** @type {4} */ (4) };
}

test('send: a 2xx response resolves with status and body snippet', async (t) => {
  const { port, close } = await withServer((req, res) => { res.writeHead(201, { 'content-type': 'text/plain' }); res.end('created'); });
  t.after(close);
  const out = await HttpCaller.send(target(port), 'POST', {}, 'hello', 2_000);
  assert.deepEqual(out, { httpStatus: 201, response: 'created' });
});

test('send: a non-2xx response rejects with CallError, retryable per isRetryableStatus', async (t) => {
  const { port, close } = await withServer((req, res) => { res.writeHead(500); res.end('boom'); });
  t.after(close);
  await assert.rejects(HttpCaller.send(target(port), 'GET', {}, '', 2_000), (/** @type {CallError} */ err) => {
    assert.equal(err.httpStatus, 500);
    assert.equal(err.retryable, true);
    assert.match(err.message, /^target responded 500/);
    return true;
  });
});

test('send: label parameter changes the error message noun (webhook-out\'s "receiver")', async (t) => {
  const { port, close } = await withServer((req, res) => { res.writeHead(503); res.end(); });
  t.after(close);
  await assert.rejects(HttpCaller.send(target(port), 'GET', {}, '', 2_000, 'receiver'), (/** @type {CallError} */ err) => {
    assert.match(err.message, /^receiver responded 503/);
    return true;
  });
});

test('send: a non-retryable 4xx is marked retryable: false', async (t) => {
  const { port, close } = await withServer((req, res) => { res.writeHead(400); res.end(); });
  t.after(close);
  await assert.rejects(HttpCaller.send(target(port), 'GET', {}, '', 2_000), (/** @type {CallError} */ err) => {
    assert.equal(err.retryable, false);
    return true;
  });
});

test('send: response body over MAX_RESPONSE is truncated, not buffered unbounded', async (t) => {
  const { port, close } = await withServer((req, res) => { res.writeHead(500); res.end('x'.repeat(5_000)); });
  t.after(close);
  await assert.rejects(HttpCaller.send(target(port), 'GET', {}, '', 2_000), (/** @type {CallError} */ err) => {
    assert.ok(err.response.length <= HttpCaller.MAX_RESPONSE);
    return true;
  });
});

test('send: connection refused rejects with a retryable CallError', async () => {
  await assert.rejects(HttpCaller.send(target(1), 'GET', {}, '', 1_000), CallError);
});

test('isRetryableStatus: 408/425/429/5xx retryable, other 4xx not', () => {
  assert.equal(HttpCaller.isRetryableStatus(408), true);
  assert.equal(HttpCaller.isRetryableStatus(429), true);
  assert.equal(HttpCaller.isRetryableStatus(500), true);
  assert.equal(HttpCaller.isRetryableStatus(404), false);
  assert.equal(HttpCaller.isRetryableStatus(401), false);
});

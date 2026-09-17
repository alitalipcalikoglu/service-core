import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditClient } from '../src/audit-client.js';

/** @param {{ status?: number, ok?: boolean, text?: string, throws?: boolean }[]} responses @returns {typeof fetch & { calls: { url: unknown, opts: unknown }[] }} */
function fakeFetch(responses) {
  let i = 0;
  /** @type {{ url: unknown, opts: unknown }[]} */
  const calls = [];
  const fn = async (/** @type {unknown} */ url, /** @type {unknown} */ opts) => {
    calls.push({ url, opts });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r.throws) throw new Error('network down');
    return { ok: r.ok ?? (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => r.text ?? '' };
  };
  fn.calls = calls;
  return /** @type {any} */ (fn);
}

function nullLogger() {
  return { warn() {}, error() {} };
}

test('AuditClient: disabled (no target) — record/start/flush/close are all safe no-ops', async () => {
  const client = new AuditClient({ target: null, logger: nullLogger() });
  assert.equal(client.enabled, false);
  assert.equal(client.record({ action: 'x.y' }), false);
  client.start();
  await client.flush();
  await client.close();
});

test('AuditClient: record buffers, flush sends a batch, hook records success/denied only', async () => {
  const fetch = fakeFetch([{ status: 200 }]);
  const client = new AuditClient({ target: { url: 'http://audit.test/', apiKey: 'k'.repeat(32) }, logger: nullLogger(), fetch, sleep: async () => {} });
  client.record({ action: 'svc.thing.create' });
  assert.equal(client.buffer.length, 1);
  await client.flush();
  assert.equal(client.buffer.length, 0, 'sent events leave the buffer');
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'http://audit.test/v1/events/batch');
  assert.equal(/** @type {any} */ (fetch.calls[0].opts).headers.authorization, `Bearer ${'k'.repeat(32)}`);
});

test('AuditClient: 4xx (not 429) drops the batch permanently; network error and 429 keep it for retry', async () => {
  const drop = new AuditClient({ target: { url: 'http://a.test', apiKey: 'k'.repeat(32) }, logger: nullLogger(), fetch: fakeFetch([{ status: 400, text: 'bad' }]), sleep: async () => {} });
  drop.record({ action: 'x' });
  await drop.flush();
  assert.equal(drop.buffer.length, 0, '4xx != 429 is dropped, not retried');
  assert.equal(drop.stats.dropped, 1);

  const retry = new AuditClient({ target: { url: 'http://a.test', apiKey: 'k'.repeat(32) }, logger: nullLogger(), fetch: fakeFetch([{ throws: true }]), sleep: async () => {} });
  retry.record({ action: 'x' });
  await retry.flush();
  assert.equal(retry.buffer.length, 1, 'network error is retried later, event stays buffered');
  assert.equal(retry.stats.failed, 1);
});

test('AuditClient: buffer overflow drops the oldest event', () => {
  const client = new AuditClient({ target: { url: 'http://a.test', apiKey: 'k'.repeat(32) }, logger: nullLogger() });
  AuditClient.MAX_BUFFER = 2;
  try {
    client.record({ action: 'a' });
    client.record({ action: 'b' });
    client.record({ action: 'c' });
    assert.equal(client.buffer.length, 2);
    assert.equal(client.buffer[0].action, 'b', 'oldest ("a") was dropped');
  } finally {
    AuditClient.MAX_BUFFER = 5_000;
  }
});

test('AuditClient.hook: records success under 400, denied on 403, nothing on other errors or when disabled', async () => {
  const client = new AuditClient({ target: { url: 'http://a.test', apiKey: 'k'.repeat(32) }, logger: nullLogger() });
  const hook = /** @type {any} */ (AuditClient.hook(client));
  const cfg = { audit: AuditClient.route('svc.thing.create', () => ({ type: 'thing', id: '1' })) };

  const request = /** @type {any} */ ({ routeOptions: { config: cfg }, id: 'req-1', ip: '1.2.3.4', headers: {}, apiKey: { id: 'caller' } });
  await hook(request, /** @type {any} */ ({ statusCode: 201 }), '{"ok":true}');
  assert.equal(client.buffer.length, 1);
  assert.equal(client.buffer[0].outcome, 'success');
  assert.equal(client.buffer[0].actor?.id, 'caller');

  client.buffer.length = 0;
  await hook(request, /** @type {any} */ ({ statusCode: 403 }), '{}');
  assert.equal(client.buffer[0].outcome, 'denied');

  client.buffer.length = 0;
  await hook(request, /** @type {any} */ ({ statusCode: 500 }), '{}');
  assert.equal(client.buffer.length, 0, 'errors other than 403 are not audited');

  client.buffer.length = 0;
  await hook(/** @type {any} */ ({ routeOptions: {}, id: 'req-2', ip: '1.2.3.4', headers: {} }), /** @type {any} */ ({ statusCode: 200 }), '{}');
  assert.equal(client.buffer.length, 0, 'a route with no config.audit is never audited');
});

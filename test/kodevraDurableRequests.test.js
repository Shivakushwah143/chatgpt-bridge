import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../src/server.js';
import { config } from '../src/config.js';
import { DurableRequestService } from '../src/kodevra/durableRequestService.js';

/**
 * A bridge whose turn settles only when the test says so. The point of the
 * durable protocol is that submit returns before the model does, so every test
 * needs to hold the turn open explicitly.
 */
class DeferredBridge {
  constructor() {
    this.turns = [];
    this.cancelled = [];
  }

  health() {
    return { ok: true, clients: [], activeClient: null, needsSelection: false, pendingRequests: this.turns.length };
  }

  isLocalRequest() {
    return true;
  }

  cancelRequest(requestId, reason) {
    this.cancelled.push({ requestId, reason });
    return { requestId, cancelled: true };
  }

  sendRequest(request, callbacks = {}) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.turns.push({ request, callbacks, resolve, reject, promise });
    return promise;
  }

  last() {
    return this.turns.at(-1);
  }
}

async function startFixture() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-kodevra-'));
  const bridge = new DeferredBridge();
  const durableRequests = new DurableRequestService({ bridge, dataDir: dataRoot, progressPersistMs: 0 });
  const app = createApp(bridge, null, null, null, null, null, { durableRequests });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (pathname, options = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${config.apiToken}`, ...(options.headers || {}) },
    });
    const type = response.headers.get('content-type') || '';
    const body = type.includes('application/json') ? await response.json() : await response.text();
    return { response, body };
  };
  return {
    dataRoot,
    bridge,
    durableRequests,
    request,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('submit returns a request id before the model answers', async () => {
  const fx = await startFixture();
  try {
    const startedAt = Date.now();
    const submitted = await fx.request('/kodevra/requests', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do the thing', idempotency_key: 'key-1', model: 'gpt-test', deadline_ms: 60_000 }),
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(submitted.response.status, 202);
    assert.equal(submitted.body.ok, true);
    assert.equal(submitted.body.protocol, 'kodevra-durable-v1');
    assert.match(submitted.body.request_id, /^[0-9a-f-]{36}$/);
    assert.equal(submitted.body.replayed, false);
    assert.ok(elapsed < 1_000, `submit must not wait for the turn (took ${elapsed}ms)`);
    assert.equal(fx.bridge.turns.length, 1);

    const pending = await fx.request(`/kodevra/requests/${submitted.body.request_id}`);
    assert.equal(pending.response.status, 200);
    assert.ok(['submitted', 'waiting_for_model'].includes(pending.body.status));
    assert.equal(pending.body.terminal, false);
    assert.equal(pending.body.response, null);

    fx.bridge.last().callbacks.onEvent?.({ type: 'prompt.delivered' });
    const delivered = await fx.request(`/kodevra/requests/${submitted.body.request_id}`);
    assert.equal(delivered.body.status, 'waiting_for_model');

    fx.bridge.last().resolve({ answer: '{"action":"finish","summary":"done"}', session: { id: 'conv_1' }, url: 'https://chatgpt.com/c/conv_1' });
    const completed = await fx.durableRequests.waitFor(submitted.body.request_id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.terminal, true);
    assert.equal(completed.response.answer, '{"action":"finish","summary":"done"}');
    assert.equal(completed.response.session.id, 'conv_1');

    const fetched = await fx.request(`/kodevra/requests/${submitted.body.request_id}`);
    assert.equal(fetched.body.status, 'completed');
    assert.equal(fetched.body.response.answer, '{"action":"finish","summary":"done"}');
  } finally {
    await fx.close();
  }
});

test('the same idempotency key never submits the prompt twice', async () => {
  const fx = await startFixture();
  try {
    const payload = { prompt: 'inspect the repo', idempotency_key: 'stable-key' };
    const first = await fx.request('/kodevra/requests', { method: 'POST', body: JSON.stringify(payload) });
    const second = await fx.request('/kodevra/requests', { method: 'POST', body: JSON.stringify(payload) });
    assert.equal(first.response.status, 202);
    assert.equal(second.response.status, 200);
    assert.equal(second.body.request_id, first.body.request_id);
    assert.equal(second.body.replayed, true);
    assert.equal(fx.bridge.turns.length, 1, 'a retry must reuse the existing turn');

    const conflict = await fx.request('/kodevra/requests', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'a different prompt', idempotency_key: 'stable-key' }),
    });
    assert.equal(conflict.response.status, 409);
    assert.match(conflict.body.detail, /already belongs to request/);
    assert.equal(fx.bridge.turns.length, 1, 'a conflicting key must not submit anything');
  } finally {
    await fx.close();
  }
});

test('a missing idempotency key is refused instead of guessed', async () => {
  const fx = await startFixture();
  try {
    const { response } = await fx.request('/kodevra/requests', { method: 'POST', body: JSON.stringify({ prompt: 'x' }) });
    assert.equal(response.status, 400);
    assert.equal(fx.bridge.turns.length, 0);
  } finally {
    await fx.close();
  }
});

test('a recovering browser keeps the request alive and completes it', async () => {
  const fx = await startFixture();
  try {
    const { body } = await fx.request('/kodevra/requests', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'wait for the tab', idempotency_key: 'recover-key' }),
    });
    const turn = fx.bridge.last();
    turn.callbacks.onStatus?.('resumed', { requestId: body.request_id });
    const recovering = await fx.request(`/kodevra/requests/${body.request_id}`);
    assert.equal(recovering.body.status, 'recovering');
    assert.equal(recovering.body.terminal, false);

    turn.callbacks.onProgressUpdate?.('ChatGPT is still generating', { phase: 'generating' });
    const generating = await fx.request(`/kodevra/requests/${body.request_id}`);
    assert.equal(generating.body.status, 'recovering');
    assert.equal(generating.body.terminal, false);

    turn.resolve({ answer: 'recovered answer' });
    const completed = await fx.durableRequests.waitFor(body.request_id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.response.answer, 'recovered answer');
  } finally {
    await fx.close();
  }
});

test('terminal failures are classified instead of collapsing into one code', async () => {
  const fx = await startFixture();
  try {
    const first = await fx.request('/kodevra/requests', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'plain failure', idempotency_key: 'fail-key' }),
    });
    const error = new Error('ChatGPT tab closed');
    error.code = 'CLIENT_DISCONNECTED';
    fx.bridge.last().reject(error);
    const failed = await fx.durableRequests.waitFor(first.body.request_id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.code, 'MODEL_REQUEST_FAILED');
    assert.equal(failed.error.bridgeCode, 'CLIENT_DISCONNECTED');
    assert.equal(failed.terminal, true);

    const second = await fx.request('/kodevra/requests', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'canonical failure', idempotency_key: 'recover-failed-key' }),
    });
    const canonical = new Error('active prompt belongs to another request');
    canonical.code = 'CANONICAL_REQUEST_CONFLICT';
    fx.bridge.last().reject(canonical);
    const unrecoverable = await fx.durableRequests.waitFor(second.body.request_id);
    assert.equal(unrecoverable.status, 'failed');
    assert.equal(unrecoverable.error.code, 'MODEL_RECOVERY_FAILED');
  } finally {
    await fx.close();
  }
});

test('a restarted bridge closes in-flight requests without resubmitting them', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-kodevra-restart-'));
  const storePath = path.join(dataRoot, 'kodevra-requests.json');
  await fs.writeFile(
    storePath,
    JSON.stringify({
      version: 1,
      requests: {
        'request-from-before': {
          requestId: 'request-from-before',
          idempotencyKey: 'old-key',
          promptHash: crypto.createHash('sha256').update('whatever').digest('hex'),
          status: 'waiting_for_model',
          phase: 'prompt_delivered',
          terminal: false,
          createdAt: Date.now() - 60_000,
          updatedAt: Date.now() - 30_000,
          lastProgressAt: Date.now() - 30_000,
        },
      },
    }),
  );
  const bridge = new DeferredBridge();
  const service = new DurableRequestService({ bridge, dataDir: dataRoot, progressPersistMs: 0 });
  const view = service.status('request-from-before');
  assert.equal(view.status, 'failed');
  assert.equal(view.error.code, 'BRIDGE_RESTART_UNRECOVERABLE');
  assert.equal(bridge.turns.length, 0, 'a stranded prompt must never be resubmitted');
  const replay = service.submit({ prompt: 'whatever', idempotency_key: 'old-key' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.record.status, 'failed');
  assert.equal(bridge.turns.length, 0);
});

test('cancel stops the turn and is terminal', async () => {
  const fx = await startFixture();
  try {
    const { body } = await fx.request('/kodevra/requests', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'cancel me', idempotency_key: 'cancel-key', deadline_ms: 60_000 }),
    });
    const cancelled = await fx.request(`/kodevra/requests/${body.request_id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' }),
    });
    assert.equal(cancelled.body.status, 'cancelled');
    assert.equal(cancelled.body.terminal, true);
    assert.equal(fx.bridge.cancelled.length, 1);
    assert.equal(fx.bridge.cancelled[0].requestId, body.request_id);
  } finally {
    await fx.close();
  }
});

test('the synchronous OpenAI-compatible API is unchanged', async () => {
  const fx = await startFixture();
  try {
    const pending = fx.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-test', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    });
    // The synchronous route still holds the HTTP request for the turn: it has
    // not answered yet, which is exactly the contract other consumers keep.
    await wait(50);
    assert.equal(fx.bridge.turns.length, 1);
    fx.bridge.last().resolve({ answer: 'legacy answer', session: { id: 'conv_legacy' } });
    const { response, body } = await pending;
    assert.equal(response.status, 200);
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.content, 'legacy answer');
  } finally {
    await fx.close();
  }
});

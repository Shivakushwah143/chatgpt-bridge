import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../src/server.js';
import { config } from '../src/config.js';
import { DurableRequestService } from '../src/kodevra/durableRequestService.js';
import { LiveResponseStream, createLiveResponseStream } from '../src/kodevra/liveResponseStream.js';
import { BridgeClientEventRouter } from '../src/bridge/coordinator/bridgeClientEventRouter.js';

class DeferredBridge {
  constructor() {
    this.turns = [];
  }

  health() {
    return { ok: true, clients: [], activeClient: null, needsSelection: false, pendingRequests: this.turns.length };
  }

  isLocalRequest() {
    return true;
  }

  cancelRequest() {
    return { cancelled: true };
  }

  sendRequest(request, callbacks = {}) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.turns.push({ request, callbacks, resolve, reject });
    return promise;
  }

  last() {
    return this.turns.at(-1);
  }
}

async function startFixture() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-live-'));
  const bridge = new DeferredBridge();
  const liveResponseStream = createLiveResponseStream();
  const durableRequests = new DurableRequestService({ bridge, dataDir: dataRoot, progressPersistMs: 0, liveStream: liveResponseStream });
  const app = createApp(bridge, null, null, null, null, null, { durableRequests, liveResponseStream });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (pathname, options = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${config.apiToken}`, ...(options.headers || {}) },
    });
    return { response, body: await response.json() };
  };
  return {
    bridge,
    liveResponseStream,
    durableRequests,
    request,
    baseUrl,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Read SSE frames until the predicate matches or the connection ends. */
async function readSseFrames(response, { until, timeoutMs = 2_000 } = {}) {
  const frames = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ value: undefined, done: false }), Math.max(0, deadline - Date.now()))),
      ]);
      if (done) break;
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          frames.push(JSON.parse(line.slice(5).trim()));
        }
        boundary = buffer.indexOf('\n\n');
      }
      if (until && until(frames)) break;
    }
  } finally {
    await reader.cancel?.().catch(() => {});
  }
  return frames;
}

test('live events carry ordered, per-request sequence numbers and resume after a cursor', () => {
  const stream = new LiveResponseStream();
  const first = stream.publish('req_1', { type: 'response.started', turnKey: 'turn-a' });
  const second = stream.publish('req_1', { type: 'response.delta', delta: '{"action":', answerLength: 10, turnKey: 'turn-a' });
  const third = stream.publish('req_1', { type: 'response.delta', delta: '"batch"}', answerLength: 18, turnKey: 'turn-a' });
  assert.deepEqual([first.seq, second.seq, third.seq], [1, 2, 3]);
  assert.equal(second.requestId, 'req_1');
  assert.equal(stream.publish('', { type: 'response.delta', delta: 'x' }), null);

  const replayed = [];
  const unsubscribe = stream.subscribe('req_1', (event) => replayed.push(event), { after: first.seq });
  assert.deepEqual(replayed.map((event) => event.seq), [2, 3]);
  unsubscribe();

  const live = [];
  const stop = stream.subscribe('req_1', (event) => live.push(event), { after: third.seq });
  stream.publish('req_1', { type: 'response.completed', answerLength: 18 });
  stop();
  assert.deepEqual(live.map((event) => event.type), ['response.completed']);
});

test('the live stream buffers a bounded tail instead of the whole response', () => {
  const stream = new LiveResponseStream();
  for (let index = 0; index < 300; index += 1) {
    stream.publish('req_buffer', { type: 'response.delta', delta: 'x'.repeat(1_000), answerLength: (index + 1) * 1_000 });
  }
  const stats = stream.stats('req_buffer');
  assert.ok(stats.buffered <= 64);
  assert.ok(stats.seq === 300);
});

test('extension delta messages reach the live sink without entering the request timeline', () => {
  const pending = new Map([['req_router', { requestId: 'req_router', clientId: 'client-1', callbacks: {}, events: [] }]]);
  const seen = [];
  const router = new BridgeClientEventRouter({
    pending,
    commands: new Map(),
    artifacts: new Map(),
    lifecycle: {},
    publishObservedTurn: () => {},
    registerObservedArtifacts: () => {},
    handleCommandResponse: () => {},
    liveDelta: (requestId, payload) => seen.push({ requestId, ...payload }),
  });

  router.handleClientMessage('client-1', { type: 'response.delta', requestId: 'req_router', seq: 1, delta: '{"action":', answerLength: 10, turnKey: 'turn-a' });
  router.handleClientMessage('client-1', { type: 'response.delta', requestId: 'req_router', seq: 2, delta: '', answerLength: 10, turnKey: 'turn-a' });
  router.handleClientMessage('client-2', { type: 'response.delta', requestId: 'req_router', seq: 3, delta: 'x', answerLength: 11, turnKey: 'turn-a' });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].requestId, 'req_router');
  assert.equal(seen[0].delta, '{"action":');
  assert.equal(seen[0].turnKey, 'turn-a');
  assert.equal(seen[0].seq, 1);
  assert.equal(pending.get('req_router').events.length, 0, 'display deltas are not request events');
});

test('durable deltas are forwarded in order and a gap only pauses the display', async () => {
  const fx = await startFixture();
  try {
    const submitted = await fx.request('/kodevra/requests', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'stream it', idempotency_key: 'live-key-1', deadline_ms: 60_000 }),
    });
    const requestId = submitted.body.request_id;
    const events = [];
    const unsubscribe = fx.liveResponseStream.subscribe(requestId, (event) => events.push(event));

    fx.bridge.last().callbacks.onEvent?.({ type: 'response.delta', turnKey: 'turn-a', seq: 1, delta: '{"action":', answerLength: 10 });
    fx.bridge.last().callbacks.onEvent?.({ type: 'response.delta', turnKey: 'turn-a', seq: 3, delta: '"batch"}', answerLength: 30 });
    // A skipped delta must not splice text into the middle of the answer.
    assert.deepEqual(events.map((event) => [event.type, event.delta]), [
      ['response.started', ''],
      ['response.delta', '{"action":'],
    ]);
    fx.bridge.last().callbacks.onEvent?.({ type: 'response.delta', turnKey: 'turn-a', seq: 2, delta: '"batch"}', answerLength: 18 });

    fx.bridge.last().callbacks.onEvent?.({ type: 'generation.reattach.started' });
    fx.bridge.last().resolve({ answer: '{"action":"batch"}', session: { id: 'conv_1' } });
    await fx.durableRequests.waitFor(requestId);
    unsubscribe();

    assert.deepEqual(events.map((event) => event.type), [
      'response.started',
      'response.delta',
      'response.delta',
      'response.recovering',
      'response.completed',
    ]);
    const deltas = events.filter((event) => event.type === 'response.delta').map((event) => event.delta);
    assert.deepEqual(deltas, ['{"action":', '"batch"}']);
    assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4, 5]);
  } finally {
    await fx.close();
  }
});

test('the SSE endpoint streams ordered frames and requires the bridge token', async () => {
  const fx = await startFixture();
  try {
    const submitted = await fx.request('/kodevra/requests', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'stream it', idempotency_key: 'live-key-2', deadline_ms: 60_000 }),
    });
    const requestId = submitted.body.request_id;

    const unauthorized = await fetch(`${fx.baseUrl}/kodevra/requests/${requestId}/events`);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${fx.baseUrl}/kodevra/requests/${requestId}/events?after=0`, {
      headers: { accept: 'text/event-stream', Authorization: `Bearer ${config.apiToken}` },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);

    fx.liveResponseStream.publish(requestId, { type: 'response.started', turnKey: 'turn-a' });
    fx.liveResponseStream.publish(requestId, { type: 'response.delta', delta: '{"action":', answerLength: 10, turnKey: 'turn-a' });
    const frames = await readSseFrames(response, {
      until: (all) => all.some((event) => event.type === 'response.delta'),
    });
    assert.deepEqual(frames.map((event) => event.type), ['response.started', 'response.delta']);
    assert.deepEqual(frames.map((event) => event.seq), [1, 2]);
    assert.equal(frames[1].delta, '{"action":');
  } finally {
    await fx.close();
  }
});

test('a client that drops the live stream does not affect the durable turn', async () => {
  const fx = await startFixture();
  try {
    const submitted = await fx.request('/kodevra/requests', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'stream it', idempotency_key: 'live-key-3', deadline_ms: 60_000 }),
    });
    const requestId = submitted.body.request_id;
    const response = await fetch(`${fx.baseUrl}/kodevra/requests/${requestId}/events`, {
      headers: { accept: 'text/event-stream', Authorization: `Bearer ${config.apiToken}` },
    });
    await response.body?.cancel?.();

    fx.bridge.last().callbacks.onEvent?.({ type: 'response.delta', turnKey: 'turn-a', seq: 1, delta: '{"action":', answerLength: 10 });
    fx.bridge.last().resolve({ answer: '{"action":"finish","summary":"done"}' });
    const completed = await fx.durableRequests.waitFor(requestId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.response.answer, '{"action":"finish","summary":"done"}');
    const fetched = await fx.request(`/kodevra/requests/${requestId}`);
    assert.equal(fetched.body.status, 'completed');
  } finally {
    await fx.close();
  }
});

test('streamed deltas are not written to the persisted request store', async () => {
  const fx = await startFixture();
  try {
    const submitted = await fx.request('/kodevra/requests', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'stream it', idempotency_key: 'live-key-4', deadline_ms: 60_000 }),
    });
    const requestId = submitted.body.request_id;
    fx.bridge.last().callbacks.onEvent?.({ type: 'response.delta', turnKey: 'turn-a', seq: 1, delta: '{"action":', answerLength: 10 });
    fx.bridge.last().resolve({ answer: '{"action":"finish","summary":"done"}' });
    await fx.durableRequests.waitFor(requestId);
    const persisted = await fs.readFile(fx.durableRequests.storePath, 'utf8');
    assert.ok(!persisted.includes('{"action":'));
    assert.ok(persisted.includes('finish'));
  } finally {
    await fx.close();
  }
});

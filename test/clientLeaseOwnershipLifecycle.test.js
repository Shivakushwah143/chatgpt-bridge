import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserBridge } from '../src/browserBridge.js';

let revision = 0;
const trackedBridges = [];

function trackBridge(hub) {
  const bridge = new BrowserBridge(hub);
  trackedBridges.push(bridge);
  return bridge;
}

afterEach(async () => {
  while (trackedBridges.length) {
    try { await trackedBridges.pop().close({ cancelPending: true }); } catch {}
  }
});

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeClient(id) {
  return {
    id,
    ready: true,
    compatible: true,
    compatibility: { compatible: true },
    url: 'https://chatgpt.com/c/conversation-1',
    title: 'test conversation',
    activeRequest: null,
    tabObservation: null,
  };
}

/**
 * Emulates the extension side of the lease contract. A release is acknowledged
 * on a macrotask so that a test can prove the bridge waited for it before it
 * settled the request. `releaseFailure` keeps the lease, as a tab whose cleanup
 * could not be proven would.
 */
class FakeHub extends EventEmitter {
  constructor({ releaseFailure = false } = {}) {
    super();
    this.serverInstanceId = 'server-test';
    this.sent = [];
    this.releaseAcks = 0;
    this.releaseFailure = releaseFailure;
    this.byId = new Map([['client-1', makeClient('client-1')]]);
  }

  get clients() { return Array.from(this.byId.values()); }
  get selectedClientId() { return ''; }
  get needsSelection() { return false; }
  get activeClient() { return this.byId.get('client-1'); }

  #apply(client, payload) {
    this.sent.push({ clientId: client.id, payload });
    setImmediate(() => {
      if (payload.type === 'request.release') {
        if (this.releaseFailure) {
          // The extension reports an unproven release as a quarantine, never as
          // a plain command failure, and it keeps the lease in place.
          client.quarantined = true;
          client.quarantineReason = 'release cleanup could not be proven';
          this.emit('client.message', {
            clientId: client.id,
            payload: {
              type: 'lease.quarantined',
              commandId: payload.commandId,
              requestId: payload.requestId,
              code: 'RELEASE_CLEANUP_FAILED',
              message: 'release cleanup could not be proven',
            },
          });
          return;
        }
        this.releaseAcks += 1;
        if (client.activeRequest?.requestId === payload.requestId) client.activeRequest = null;
        this.emit('client.message', {
          clientId: client.id,
          payload: {
            type: 'lease.released',
            commandId: payload.commandId,
            requestId: payload.requestId,
            released: true,
            activeRequest: null,
          },
        });
        this.emit('client.changed', { ...client });
        return;
      }
      if (payload.type === 'prompt.cancel') {
        // Physical cancellation is the only canonical cancellation evidence.
        const effectId = String(payload.effect?.effectId || '');
        this.emit('client.message', {
          clientId: client.id,
          payload: { type: 'request.effect.started', requestId: payload.requestId, effectId, effectType: 'prompt.cancel' },
        });
        this.emit('client.message', {
          clientId: client.id,
          payload: {
            type: 'request.effect.succeeded',
            requestId: payload.requestId,
            effectId,
            effectType: 'prompt.cancel',
            result: { cancelled: true },
          },
        });
        return;
      }
      if (payload.commandId) {
        this.emit('client.message', {
          clientId: client.id,
          payload: { type: 'command.result', commandId: payload.commandId, requestId: payload.requestId, resultType: 'command.completed' },
        });
      }
    });
  }

  sendToClientWithDelivery(clientId, payload) {
    const client = this.byId.get(clientId) || makeClient(clientId);
    this.#apply(client, payload);
    return { client, delivered: Promise.resolve({ clientId, deliveredAt: Date.now() }) };
  }

  sendToActiveWithDelivery(payload) {
    return this.sendToClientWithDelivery(this.activeClient.id, payload);
  }

  sendToClient(clientId, payload) {
    const client = this.byId.get(clientId) || makeClient(clientId);
    this.#apply(client, payload);
    return client;
  }
}

function releases(hub, requestId = '') {
  return hub.sent.filter((entry) => entry.payload.type === 'request.release'
    && (!requestId || entry.payload.requestId === requestId));
}

function setClientLease(hub, clientId, requestId, source) {
  const client = hub.byId.get(clientId);
  client.activeRequest = {
    requestId,
    leaseId: String(source.leaseId || ''),
    ownerServerInstanceId: String(source.ownerServerInstanceId || ''),
    responseEpoch: 0,
    submittedUserTurnKey: '',
    submittedUserTurnIndex: -1,
    assistantTurnKey: '',
    assistantTurnIndex: -1,
  };
  return client.activeRequest;
}

function submitPrompt(hub, requestId, submittedUserTurnKey, clientId = 'client-1') {
  hub.emit('client.message', { clientId, payload: { type: 'prompt.accepted', requestId } });
  hub.emit('client.message', {
    clientId,
    payload: { type: 'request.effect.started', requestId, effectId: `${requestId}:prompt.submit`, effectType: 'prompt.submit' },
  });
  hub.emit('client.message', {
    clientId,
    payload: {
      type: 'request.effect.succeeded',
      requestId,
      effectId: `${requestId}:prompt.submit`,
      effectType: 'prompt.submit',
      result: { submitted: true, submittedUserTurnKey },
    },
  });
}

function observe(hub, {
  requestId,
  clientId = 'client-1',
  conversationId = 'conversation-1',
  userTurnKey = 'user-1',
  assistantTurnKey = 'assistant-1',
  answer = 'final answer',
} = {}) {
  revision += 1;
  const client = hub.byId.get(clientId);
  const active = {
    requestId,
    leaseId: String(client.activeRequest?.leaseId || ''),
    ownerServerInstanceId: String(client.activeRequest?.ownerServerInstanceId || ''),
    responseEpoch: 0,
    submittedUserTurnKey: userTurnKey,
    submittedUserTurnIndex: 0,
    assistantTurnKey,
    assistantTurnIndex: 1,
  };
  const observation = {
    schemaVersion: 4,
    observerId: 'tab-observer-test',
    revision,
    observedAt: Date.now(),
    stableForMs: 2_000,
    url: `https://chatgpt.com/c/${conversationId}`,
    conversationId,
    activeRequest: active,
    turn: {
      key: assistantTurnKey,
      index: 1,
      userKey: userTurnKey,
      userIndex: 0,
      userPrompt: 'prompt',
      promptBoundary: { submittedUserTurnKey: userTurnKey, submittedUserTurnIndex: 0 },
    },
    generation: { state: 'stopped', stopVisible: false },
    blocker: { state: 'none' },
    output: {
      state: 'final',
      answer,
      thinking: '',
      progress: '',
      progressItems: [],
      finalMessage: true,
      responseBlocks: [],
      reasoningHistory: [],
      codeBlocks: [],
    },
    artifact: { state: 'not_expected', count: 0 },
    artifacts: [],
  };
  client.tabObservation = observation;
  client.activeRequest = active;
  hub.emit('client.activity', {
    clientId,
    client,
    payload: { type: 'tab.observation', observation, session: { id: conversationId } },
  });
  return observation;
}

async function startRequest(bridge, hub, { message = 'task', sessionId, signal } = {}) {
  const seen = hub.sent.length;
  const promise = bridge.sendRequest({ message, ...(sessionId ? { sessionId } : {}) }, {}, signal ? { signal } : {});
  await nextTick();
  const prompt = hub.sent.slice(seen).find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt, 'prompt.send should be delivered to the connected tab');
  return { promise, requestId: prompt.requestId, prompt, clientId: hub.sent.slice(seen).find((entry) => entry.payload.type === 'prompt.send')?.clientId };
}

async function completeRequest(bridge, hub, started, { answer = 'final answer' } = {}) {
  const source = bridge.requestStateDiagnostics(started.requestId).state.source;
  setClientLease(hub, started.clientId, started.requestId, source);
  submitPrompt(hub, started.requestId, 'user-1', started.clientId);
  observe(hub, { requestId: started.requestId, clientId: started.clientId, answer });
  return await started.promise;
}

test('a completed request releases the tab before the response settles', async () => {
  const hub = new FakeHub();
  const bridge = trackBridge(hub);
  const started = await startRequest(bridge, hub);
  const response = await completeRequest(bridge, hub, started);

  assert.equal(response.answer, 'final answer');
  // The acknowledgement runs on a macrotask, so this can only hold if the
  // request settled after cleanup completed.
  assert.equal(hub.releaseAcks, 1, 'the lease must be released and acknowledged before the request settles');
  assert.equal(hub.byId.get('client-1').activeRequest, null, 'the tab must be idle when its request settles');
  const state = bridge.requestStateDiagnostics(started.requestId).state;
  assert.equal(state.lifecycle, 'completed');
  assert.equal(state.terminal.code, 'completed');
  assert.equal(bridge.requestDiagnostics().some((item) => item.requestId === started.requestId), false, 'completed requests leave no pending state');
  const sent = releases(hub, started.requestId);
  assert.equal(sent.length, 1, 'a completed request releases its lease exactly once');
  assert.equal(sent[0].payload.terminalCode, 'completed');
  await bridge.close({ cancelPending: false });
});

test('the same single tab is reused for the next sequential request', async () => {
  const hub = new FakeHub();
  const bridge = trackBridge(hub);
  const first = await startRequest(bridge, hub, { message: 'first' });
  await completeRequest(bridge, hub, first, { answer: 'first answer' });
  assert.equal(hub.byId.get('client-1').activeRequest, null);

  const second = await startRequest(bridge, hub, { message: 'second', sessionId: 'conversation-1' });
  assert.notEqual(second.requestId, first.requestId);
  assert.equal(second.clientId, 'client-1', 'the second request must reuse the same tab');
  const response = await completeRequest(bridge, hub, second, { answer: 'second answer' });

  assert.equal(response.answer, 'second answer');
  assert.equal(hub.byId.get('client-1').activeRequest, null);
  assert.equal(releases(hub, first.requestId).length, 1);
  assert.equal(releases(hub, second.requestId).length, 1);
  assert.equal(hub.releaseAcks, 2);
  await bridge.close({ cancelPending: false });
});

test('a failed request releases the tab so the next request can reuse it', async () => {
  const hub = new FakeHub();
  const bridge = trackBridge(hub);
  const failed = await startRequest(bridge, hub, { sessionId: 'conversation-1' });
  const source = bridge.requestStateDiagnostics(failed.requestId).state.source;
  setClientLease(hub, failed.clientId, failed.requestId, source);
  submitPrompt(hub, failed.requestId, 'user-1', failed.clientId);
  const rejection = assert.rejects(failed.promise, (error) => {
    assert.equal(error.code, 'CANONICAL_CONVERSATION_CHANGED');
    return true;
  });
  observe(hub, { requestId: failed.requestId, conversationId: 'conversation-2', userTurnKey: 'user-other', assistantTurnKey: 'assistant-other' });
  await rejection;

  assert.equal(hub.byId.get('client-1').activeRequest, null, 'a failed request must release its tab');
  const sent = releases(hub, failed.requestId);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.terminalCode, 'conversation_changed');

  const next = await startRequest(bridge, hub, { message: 'retry', sessionId: 'conversation-1' });
  assert.equal(next.clientId, 'client-1');
  const response = await completeRequest(bridge, hub, next, { answer: 'recovered' });
  assert.equal(response.answer, 'recovered');
  assert.equal(hub.releaseAcks, 2);
  await bridge.close({ cancelPending: false });
});

test('duplicate terminal observations release the tab exactly once', async () => {
  const hub = new FakeHub();
  const bridge = trackBridge(hub);
  const started = await startRequest(bridge, hub);
  const source = bridge.requestStateDiagnostics(started.requestId).state.source;
  setClientLease(hub, started.clientId, started.requestId, source);
  submitPrompt(hub, started.requestId, 'user-1', started.clientId);
  observe(hub, { requestId: started.requestId, answer: 'once' });
  await started.promise;
  observe(hub, { requestId: started.requestId, answer: 'once' });
  observe(hub, { requestId: started.requestId, answer: 'once' });
  await nextTick();

  assert.equal(releases(hub, started.requestId).length, 1, 'double finalization must not dispatch a second release');
  assert.equal(hub.releaseAcks, 1);
  await bridge.close({ cancelPending: false });
});

test('a release the extension rejects is attempted once and never loses the result', async () => {
  const hub = new FakeHub({ releaseFailure: true });
  const bridge = trackBridge(hub);
  const started = await startRequest(bridge, hub);
  const response = await completeRequest(bridge, hub, started, { answer: 'answer kept' });

  assert.equal(response.answer, 'answer kept', 'cleanup failure must not swallow a materialized result');
  assert.equal(releases(hub, started.requestId).length, 1, 'release is attempted once, not retried unboundedly');
  assert.equal(hub.byId.get('client-1').activeRequest?.requestId, started.requestId, 'an unproven release keeps the lease visible to reconciliation');
  await bridge.close({ cancelPending: false });
});

test('a cancelled request releases the tab', async () => {
  const hub = new FakeHub();
  const bridge = trackBridge(hub);
  const controller = new AbortController();
  const started = await startRequest(bridge, hub, { signal: controller.signal });
  const source = bridge.requestStateDiagnostics(started.requestId).state.source;
  setClientLease(hub, started.clientId, started.requestId, source);
  submitPrompt(hub, started.requestId, 'user-1', started.clientId);

  const rejection = assert.rejects(started.promise, (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
  controller.abort('cancelled by caller');
  await rejection;

  assert.equal(hub.byId.get('client-1').activeRequest, null, 'a cancelled request must release its tab');
  assert.equal(releases(hub, started.requestId).length, 1);
  await bridge.close({ cancelPending: false });
});

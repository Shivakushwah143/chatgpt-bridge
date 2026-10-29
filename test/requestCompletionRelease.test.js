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
 * Emulates the extension side of the contract: a release command clears the
 * persisted active request and is acknowledged like the content runtime does.
 */
class FakeHub extends EventEmitter {
  constructor() {
    super();
    this.serverInstanceId = 'server-test';
    this.sent = [];
    this.byId = new Map([['client-1', makeClient('client-1')]]);
  }

  get clients() { return Array.from(this.byId.values()); }
  get selectedClientId() { return ''; }
  get needsSelection() { return false; }
  get activeClient() { return this.byId.get('client-1'); }

  #apply(client, payload) {
    this.sent.push({ clientId: client.id, payload });
    if (payload.type !== 'request.release') return;
    queueMicrotask(() => {
      if (client.activeRequest?.requestId) client.activeRequest = null;
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

function releases(hub) {
  return hub.sent.filter((entry) => entry.payload.type === 'request.release');
}

function setClientLease(hub, clientId, requestId, source, overrides = {}) {
  const client = hub.byId.get(clientId);
  client.activeRequest = {
    requestId,
    leaseId: String(source.leaseId || ''),
    ownerServerInstanceId: String(source.ownerServerInstanceId || ''),
    responseEpoch: Number(source.responseEpoch) || 0,
    submittedUserTurnKey: '',
    submittedUserTurnIndex: -1,
    assistantTurnKey: '',
    assistantTurnIndex: -1,
    ...overrides,
  };
  return client.activeRequest;
}

function submitPrompt(hub, requestId, submittedUserTurnKey, clientId = 'client-1') {
  hub.emit('client.message', { clientId, payload: { type: 'prompt.accepted', requestId } });
  submitPromptEffect(hub, requestId, submittedUserTurnKey, clientId);
}

function submitPromptEffect(hub, requestId, submittedUserTurnKey, clientId = 'client-1') {
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
  generation = 'stopped',
  outputState = 'final',
  answer = 'final answer',
  finalMessage = true,
  activeRequest = true,
} = {}) {
  revision += 1;
  const client = hub.byId.get(clientId);
  const active = activeRequest
    ? {
      requestId,
      leaseId: String(client.activeRequest?.leaseId || ''),
      ownerServerInstanceId: String(client.activeRequest?.ownerServerInstanceId || ''),
      responseEpoch: 0,
      submittedUserTurnKey: userTurnKey,
      submittedUserTurnIndex: 0,
      assistantTurnKey,
      assistantTurnIndex: 1,
    }
    : null;
  const observation = {
    schemaVersion: 4,
    observerId: 'tab-observer-test',
    revision,
    observedAt: Date.now(),
    stableForMs: generation === 'active' ? 0 : 2_000,
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
    generation: { state: generation, stopVisible: generation === 'active' },
    blocker: { state: 'none' },
    output: {
      state: outputState,
      answer,
      thinking: '',
      progress: '',
      progressItems: [],
      finalMessage,
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

async function startRequest(bridge, hub, { message = 'task', sessionId } = {}) {
  const seen = hub.sent.length;
  const promise = bridge.sendRequest({ message, ...(sessionId ? { sessionId } : {}) });
  await nextTick();
  const prompt = hub.sent.slice(seen).find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt, 'prompt.send should be delivered');
  return { promise, requestId: prompt.requestId, prompt };
}

test('assistant final completes the request, clears activeRequest and releases the lease', async () => {
  const hub = new FakeHub();
  const bridge = trackBridge(hub);
  const { promise, requestId, prompt } = await startRequest(bridge, hub);
  const source = bridge.requestStateDiagnostics(requestId).state.source;
  setClientLease(hub, 'client-1', requestId, source, { leaseId: prompt.leaseId || source.leaseId });
  submitPrompt(hub, requestId, 'user-1');
  observe(hub, { requestId, answer: 'final answer' });

  const response = await promise;
  assert.equal(response.answer, 'final answer');
  await nextTick();

  const completed = bridge.requestStateDiagnostics(requestId).state;
  assert.equal(completed.lifecycle, 'completed');
  assert.equal(completed.terminal.code, 'completed');
  assert.equal(hub.byId.get('client-1').activeRequest, null, 'activeRequest must be cleared after final output');
  const sent = releases(hub).filter((entry) => entry.payload.requestId === requestId);
  assert.equal(sent.length, 1, 'a completed request releases its lease exactly once');
  assert.equal(sent[0].payload.terminalCode, 'completed');
  await bridge.close({ cancelPending: false });
});

test('the same ChatGPT conversation is reusable for the next request', async () => {
  const hub = new FakeHub();
  const bridge = trackBridge(hub);
  const first = await startRequest(bridge, hub, { message: 'first' });
  const source = bridge.requestStateDiagnostics(first.requestId).state.source;
  setClientLease(hub, 'client-1', first.requestId, source);
  submitPrompt(hub, first.requestId, 'user-1');
  observe(hub, { requestId: first.requestId });
  await first.promise;
  await nextTick();

  const second = await startRequest(bridge, hub, { message: 'second', sessionId: 'conversation-1' });
  assert.notEqual(second.requestId, first.requestId);
  assert.equal(hub.byId.get('client-1').url, 'https://chatgpt.com/c/conversation-1');
  hub.emit('client.closed', { id: 'client-1' });
  await bridge.close({ cancelPending: true });
});

test('reconnect after a completed response does not resurrect the active request', async () => {
  const hub = new FakeHub();
  const bridge = trackBridge(hub);
  const { promise, requestId } = await startRequest(bridge, hub);
  const source = bridge.requestStateDiagnostics(requestId).state.source;
  setClientLease(hub, 'client-1', requestId, source);
  submitPrompt(hub, requestId, 'user-1');
  observe(hub, { requestId });
  await promise;
  await nextTick();
  assert.equal(releases(hub).length, 1);

  // The content runtime reloads and reports the finished lease again.
  const reconnected = makeClient('client-2');
  hub.byId.set('client-2', reconnected);
  reconnected.activeRequest = {
    requestId,
    leaseId: String(source.leaseId || ''),
    ownerServerInstanceId: String(source.ownerServerInstanceId || ''),
    responseEpoch: 0,
  };
  observe(hub, { requestId, clientId: 'client-2', generation: 'stopped', userTurnKey: 'user-1' });
  reconnected.activeRequest = {
    requestId,
    leaseId: String(source.leaseId || ''),
    ownerServerInstanceId: String(source.ownerServerInstanceId || ''),
    responseEpoch: 0,
  };
  hub.emit('client.ready', { ...reconnected });

  await nextTick();
  await nextTick();
  const reconnectedReleases = releases(hub).filter((entry) => entry.clientId === 'client-2' && entry.payload.requestId === requestId);
  assert.equal(reconnectedReleases.length, 1, 'a completed request must be released again after reconnect');
  assert.equal(bridge.requestStateDiagnostics(requestId).state.terminal.code, 'completed', 'completion survives reconnect');
  await bridge.close({ cancelPending: false });
});

test('reconnect during genuine generation preserves recovery state and never releases the lease', async () => {
  const hub = new FakeHub();
  const bridge = trackBridge(hub);
  const { promise, requestId } = await startRequest(bridge, hub);
  const source = bridge.requestStateDiagnostics(requestId).state.source;
  setClientLease(hub, 'client-1', requestId, source);
  submitPrompt(hub, requestId, 'user-1');
  observe(hub, { requestId, generation: 'active', outputState: 'streaming', answer: 'partial', finalMessage: false });

  const reconnected = hub.byId.get('client-1');
  hub.emit('client.ready', { ...reconnected });
  await nextTick();
  await nextTick();

  assert.equal(releases(hub).filter((entry) => entry.payload.requestId === requestId).length, 0);
  assert.equal(bridge.requestDiagnostics().some((item) => item.requestId === requestId), true, 'active request stays tracked');
  assert.equal(bridge.requestStateDiagnostics(requestId).state.submission, 'submitted');

  observe(hub, { requestId, answer: 'recovered final' });
  assert.equal((await promise).answer, 'recovered final');
  await bridge.close({ cancelPending: false });
});

test('unrelated final assistant content cannot complete the current request', async () => {
  const hub = new FakeHub();
  const bridge = trackBridge(hub);
  const { promise, requestId } = await startRequest(bridge, hub, { sessionId: 'conversation-1' });
  const source = bridge.requestStateDiagnostics(requestId).state.source;
  setClientLease(hub, 'client-1', requestId, source);
  submitPrompt(hub, requestId, 'user-1');

  observe(hub, { requestId, userTurnKey: 'user-other', assistantTurnKey: 'assistant-other', answer: 'old answer' });
  await nextTick();

  assert.equal(bridge.requestStateDiagnostics(requestId).state.terminal, null);
  assert.equal(bridge.requestDiagnostics().some((item) => item.requestId === requestId), true);
  assert.equal(releases(hub).length, 0);

  // The request is still completable by its own turn once it appears.
  observe(hub, { requestId, userTurnKey: 'user-1', answer: 'the real answer' });
  assert.equal((await promise).answer, 'the real answer');
  await bridge.close({ cancelPending: false });
});

test('a wrong conversation cannot complete the current request', async () => {
  const hub = new FakeHub();
  const bridge = trackBridge(hub);
  const { promise, requestId } = await startRequest(bridge, hub, { sessionId: 'conversation-1' });
  submitPrompt(hub, requestId, 'user-1');
  const rejection = assert.rejects(promise, (error) => {
    assert.equal(error.code, 'CANONICAL_CONVERSATION_CHANGED');
    return true;
  });

  observe(hub, { requestId, conversationId: 'conversation-2', userTurnKey: 'user-other', assistantTurnKey: 'assistant-other' });
  await rejection;
  assert.equal(bridge.requestStateDiagnostics(requestId).state.terminal.code, 'conversation_changed');
  assert.equal(hub.byId.get('client-1').activeRequest, null);
  await bridge.close({ cancelPending: false });
});

test('duplicate final observations are idempotent', async () => {
  const hub = new FakeHub();
  const bridge = trackBridge(hub);
  const { promise, requestId } = await startRequest(bridge, hub);
  const source = bridge.requestStateDiagnostics(requestId).state.source;
  setClientLease(hub, 'client-1', requestId, source);
  submitPrompt(hub, requestId, 'user-1');
  observe(hub, { requestId, answer: 'once' });
  const response = await promise;
  observe(hub, { requestId, answer: 'once' });
  observe(hub, { requestId, answer: 'once' });
  await nextTick();

  assert.equal(response.answer, 'once');
  assert.equal(releases(hub).filter((entry) => entry.payload.requestId === requestId).length, 1);
  assert.equal(bridge.requestStateDiagnostics(requestId).state.terminal.code, 'completed');
  await bridge.close({ cancelPending: false });
});

test('terminal completion stays safe when the client disconnects immediately after final', async () => {
  const hub = new FakeHub();
  const bridge = trackBridge(hub);
  const { promise, requestId } = await startRequest(bridge, hub);
  submitPrompt(hub, requestId, 'user-1');
  observe(hub, { requestId, answer: 'published before disconnect' });
  hub.emit('client.closed', { id: 'client-1' });

  const response = await promise;
  assert.equal(response.answer, 'published before disconnect');
  assert.equal(bridge.requestStateDiagnostics(requestId).state.terminal.code, 'completed');
  await bridge.close({ cancelPending: false });
});

test('a placeholder conversation is promoted to the real ChatGPT conversation instead of failing', async (t) => {
  const hub = new FakeHub();
  const bridge = trackBridge(hub);
  t.after(() => bridge.close({ cancelPending: true }));
  const { promise, requestId } = await startRequest(bridge, hub);
  setClientLease(hub, 'client-1', requestId, bridge.requestStateDiagnostics(requestId).state.source);

  // The tab is still on a local placeholder id while the prompt is accepted.
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId } });
  observe(hub, {
    requestId,
    conversationId: 'local-chatgpt%3Aa057658a-6c08-4bca-a318-c69d340adb78',
    userTurnKey: '',
    assistantTurnKey: '',
    generation: 'idle',
    outputState: 'none',
    answer: '',
    finalMessage: false,
    activeRequest: false,
  });
  assert.equal(
    bridge.requestStateDiagnostics(requestId).state.source.conversationId,
    'local-chatgpt%3Aa057658a-6c08-4bca-a318-c69d340adb78',
  );

  submitPromptEffect(hub, requestId, 'user-1');
  observe(hub, { requestId, conversationId: 'conversation-real', userTurnKey: 'user-1' });

  const response = await promise;
  assert.equal(response.answer, 'final answer');
  const state = bridge.requestStateDiagnostics(requestId).state;
  assert.equal(state.lifecycle, 'completed');
  assert.equal(state.source.conversationId, 'conversation-real');
  assert.ok(state.diagnostics.some((entry) => entry.code === 'conversation_id_canonicalized'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BrowserBridge } from '../src/browserBridge.js';
import { DurableRequestService } from '../src/kodevra/durableRequestService.js';
import { commandResult, emitPromptSubmitted, emitTabObservation } from './support/bridgeObservation.js';

const ROOT_CLIENT_ID = 'extension:tab:719098608';
const LAUNCHED_CLIENT_ID = 'extension:tab:719098609';

function makeClient(id, overrides = {}) {
  return {
    id,
    ready: true,
    compatible: true,
    compatibility: { compatible: true },
    capabilities: { browserTabs: true },
    activeRequest: null,
    launchToken: '',
    url: 'https://chatgpt.com/',
    title: 'ChatGPT',
    session: { id: 'new', url: 'https://chatgpt.com/', title: 'ChatGPT', active: true },
    tabObservation: null,
    focused: false,
    visibilityState: 'visible',
    ...overrides,
  };
}

/**
 * One bridge generation with a user root tab. Opening a dedicated agent tab
 * creates the launched client; a reconnect replaces that client's transient
 * connection identity while keeping the tab's launch token, exactly as a tab
 * that navigates from `/` to `/c/...` and reconnects does.
 */
class NavigationHub extends EventEmitter {
  constructor(clients = []) {
    super();
    this.clientList = clients;
    this.sent = [];
    this.activeId = clients[0]?.id || '';
  }

  get clients() { return this.clientList; }
  get activeClient() {
    return this.clientList.find((client) => client.id === this.activeId)
      || this.clientList[0]
      || null;
  }
  get selectedClientId() { return this.activeId || ''; }
  get needsSelection() { return false; }
  get debugEvents() { return []; }

  selectClient(clientId) {
    this.activeId = clientId;
    return this.clientList.find((client) => client.id === clientId) || null;
  }

  sendToClient(clientId, payload) {
    return this.sendToClientWithDelivery(clientId, payload).client;
  }

  sendToActiveWithDelivery(payload) {
    return this.sendToClientWithDelivery(this.activeId, payload);
  }

  sendToClientWithDelivery(clientId, payload = {}) {
    const client = this.clientList.find((candidate) => candidate.id === clientId);
    if (!client) throw new Error(`Browser extension client not found: ${clientId}`);
    this.sent.push({ clientId, payload });
    if (payload.type === 'browser.tab.open') {
      const launched = makeClient(LAUNCHED_CLIENT_ID, {
        launchToken: String(payload.launchToken || ''),
        url: 'https://chatgpt.com/',
      });
      this.clientList.push(launched);
      this.respond(clientId, payload, { resultType: 'browser.tab.opened', tabId: 2, launchToken: payload.launchToken });
      setImmediate(() => this.emit('client.ready', launched));
    } else if (payload.type === 'request.resume') {
      this.respond(clientId, payload, {
        resultType: 'request.resumed',
        activeRequest: { requestId: payload.requestId },
        boundaryStatus: 'matched',
        submittedUserTurnKey: payload.projection?.submittedUserTurnKey || '',
        assistantTurnKey: payload.projection?.assistantTurnKey || '',
      });
    } else if (payload.type === 'request.release') {
      setImmediate(() => this.emit('client.message', {
        clientId,
        payload: {
          type: 'lease.released',
          commandId: payload.commandId,
          requestId: payload.requestId,
          released: true,
          activeRequest: null,
        },
      }));
    } else if (payload.type === 'browser.tab.close') {
      this.respond(clientId, payload, { resultType: 'browser.tab.closed', closed: true });
    }
    return { client, delivered: Promise.resolve({ clientId, deliveredAt: Date.now() }) };
  }

  respond(clientId, payload, data = {}) {
    setImmediate(() => this.emit('client.message', {
      clientId,
      payload: commandResult(payload.commandId, data.resultType || 'ok', data),
    }));
  }

  sentOfType(type) {
    return this.sent.filter((entry) => entry.payload.type === type);
  }

  disconnect(clientId, reason = 'tab.navigation') {
    this.clientList = this.clientList.filter((client) => client.id !== clientId);
    const client = { id: clientId };
    setImmediate(() => this.emit('client.closed', client));
    return reason;
  }

  reconnect({ id, launchToken, url, activeRequest = null, sessionId = 'new-conversation' }) {
    const client = makeClient(id, {
      launchToken,
      url,
      activeRequest,
      session: { id: sessionId, url, title: 'New conversation', active: true },
    });
    this.clientList.push(client);
    this.emit('client.ready', client);
    return client;
  }
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

async function startRequest(hub, message = 'return the action json', { durable = null } = {}) {
  const promise = durable
    ? null
    : hub.bridge.sendRequest({ message, dedicatedTab: true, newSession: true }, {}, { fullResponse: true });
  if (durable) {
    const submitted = durable.submit({ idempotency_key: `key-${message.length}-${Date.now()}`, message, dedicated_tab: true, new_session: true });
    await nextTick();
    await nextTick();
    const prompt = hub.sentOfType('prompt.send')[0]?.payload;
    assert.ok(prompt, 'the durable submit must reach the browser');
    return { requestId: prompt.requestId, durableId: submitted.record.request_id, prompt, promise: null };
  }
  await nextTick();
  await nextTick();
  const prompt = hub.sentOfType('prompt.send')[0]?.payload;
  assert.ok(prompt, 'the request must be delivered to the dedicated agent tab');
  return { requestId: prompt.requestId, prompt, promise };
}

function promptIdentity(hub) {
  const prompt = hub.sentOfType('prompt.send')[0]?.payload;
  assert.ok(prompt, 'expected exactly one delivered prompt');
  return {
    requestId: prompt.requestId,
    leaseId: prompt.leaseId || prompt.executionPlan?.request?.leaseId || '',
    ownerServerInstanceId: prompt.serverInstanceId,
  };
}

function launchedReady(hub, requestId) {
  const prompt = promptIdentity(hub);
  const launchedId = hub.sentOfType('prompt.send')[0].clientId;
  assert.equal(launchedId, LAUNCHED_CLIENT_ID, 'the prompt is delivered to the launched agent tab');
  const launchToken = String(hub.clientList.find((client) => client.id === launchedId)?.launchToken || '');
  assert.ok(launchToken, 'the launched tab keeps its stable launch identity');
  emitPromptSubmitted(hub, { requestId, clientId: launchedId });
  emitTabObservation(hub, {
    requestId,
    clientId: launchedId,
    conversationId: 'new-conversation',
    userTurnKey: 'user-launch',
    assistantTurnKey: 'assistant-launch',
    generation: 'active',
    outputState: 'streaming',
    answer: 'partial',
  });
  return { ...prompt, launchedId, launchToken };
}

test('root client -> launched client -> /c/... reconnect moves ownership to the conversation client', async () => {
  const hub = new NavigationHub([makeClient(ROOT_CLIENT_ID)]);
  const bridge = new BrowserBridge(hub);
  hub.bridge = bridge;
  try {
    const { requestId, promise } = await startRequest(hub);
    const { leaseId, ownerServerInstanceId, launchedId, launchToken } = launchedReady(hub, requestId);
    assert.notEqual(launchedId, ROOT_CLIENT_ID);

    hub.disconnect(launchedId);
    const reconnectedId = 'extension:tab:719098609:conversation';
    hub.reconnect({
      id: reconnectedId,
      launchToken,
      url: 'https://chatgpt.com/c/new-conversation',
      activeRequest: { requestId, leaseId, ownerServerInstanceId, responseEpoch: 0 },
    });
    await nextTick();

    const resume = hub.sentOfType('request.resume').at(-1);
    assert.ok(resume, 'the reconnected conversation tab must be asked to prove the submitted turn');
    assert.equal(resume.clientId, reconnectedId);
    assert.equal(hub.sent.filter((entry) => entry.payload.type === 'request.resume' && entry.clientId === ROOT_CLIENT_ID).length, 0);
    assert.equal(bridge.requestDiagnostics()[0].clientId, reconnectedId);

    emitTabObservation(hub, {
      requestId,
      clientId: reconnectedId,
      conversationId: 'new-conversation',
      userTurnKey: 'user-launch',
      assistantTurnKey: 'assistant-launch',
      answer: '{"action":"finish"}',
    });

    const response = await promise;
    assert.equal(response.answer, '{"action":"finish"}');
  } finally {
    await bridge.close();
  }
});

test('request ownership follows the launch identity even when the reconnect cannot report its lease', async () => {
  const hub = new NavigationHub([makeClient(ROOT_CLIENT_ID)]);
  const bridge = new BrowserBridge(hub);
  hub.bridge = bridge;
  try {
    const { requestId } = await startRequest(hub);
    const { launchedId, launchToken } = launchedReady(hub, requestId);

    hub.disconnect(launchedId);
    const reconnectedId = 'extension:tab:719098609:navigation';
    hub.reconnect({
      id: reconnectedId,
      launchToken,
      url: 'https://chatgpt.com/c/new-conversation',
      activeRequest: null,
    });
    await nextTick();

    // Page activity without any content projection: ownership is still the
    // launch tab's, so the bridge re-projects instead of waiting forever.
    emitTabObservation(hub, {
      requestId,
      clientId: reconnectedId,
      conversationId: 'new-conversation',
      userTurnKey: 'user-launch',
      assistantTurnKey: 'assistant-launch',
      answer: '',
      generation: 'active',
      outputState: 'streaming',
      activeRequest: false,
    });
    await nextTick();

    const resumes = hub.sent.filter((entry) => entry.payload.type === 'request.resume');
    assert.ok(resumes.some((entry) => entry.clientId === reconnectedId), 'the launch tab is rehydrated');
    assert.equal(resumes.some((entry) => entry.clientId === launchedId), false, 'the replaced connection is never addressed');
    assert.equal(bridge.requestDiagnostics()[0].clientId, reconnectedId);
    assert.equal(hub.sentOfType('prompt.send').length, 1);
  } finally {
    await bridge.close();
  }
});

test('live deltas continue from the new owning conversation client', async () => {
  const hub = new NavigationHub([makeClient(ROOT_CLIENT_ID)]);
  const bridge = new BrowserBridge(hub);
  hub.bridge = bridge;
  const deltas = [];
  bridge.setLiveDeltaHandler((requestId, payload) => deltas.push({ requestId, ...payload }));
  try {
    const { requestId } = await startRequest(hub);
    const { launchedId, leaseId, ownerServerInstanceId, launchToken } = launchedReady(hub, requestId);
    hub.disconnect(launchedId);
    const reconnectedId = 'extension:tab:719098609:stream';
    hub.reconnect({
      id: reconnectedId,
      launchToken,
      url: 'https://chatgpt.com/c/new-conversation',
      activeRequest: { requestId, leaseId, ownerServerInstanceId, responseEpoch: 0 },
    });
    await nextTick();

    hub.emit('client.message', {
      clientId: reconnectedId,
      payload: { type: 'response.delta', requestId, delta: '{"action":', answerLength: 10, turnKey: 'assistant-launch' },
    });
    hub.emit('client.message', {
      clientId: reconnectedId,
      payload: { type: 'response.delta', requestId, delta: '"finish"}', answerLength: 19, turnKey: 'assistant-launch' },
    });
    hub.emit('client.message', {
      clientId: ROOT_CLIENT_ID,
      payload: { type: 'response.delta', requestId, delta: 'stolen', answerLength: 6, turnKey: 'assistant-launch' },
    });
    await nextTick();

    assert.deepEqual(deltas.map((delta) => delta.delta), ['{"action":', '"finish"}']);
    assert.equal(deltas.every((delta) => delta.requestId === requestId), true);
  } finally {
    await bridge.close();
  }
});

test('the final answer on the owning conversation tab completes the durable request', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-ownership-'));
  const hub = new NavigationHub([makeClient(ROOT_CLIENT_ID)]);
  const bridge = new BrowserBridge(hub);
  hub.bridge = bridge;
  const durable = new DurableRequestService({ bridge, dataDir, progressPersistMs: 0 });
  try {
    const { requestId, durableId } = await startRequest(hub, 'durable navigation turn', { durable });
    const { launchedId, leaseId, ownerServerInstanceId, launchToken } = launchedReady(hub, requestId);

    hub.disconnect(launchedId);
    const reconnectedId = 'extension:tab:719098609:durable';
    hub.reconnect({
      id: reconnectedId,
      launchToken,
      url: 'https://chatgpt.com/c/new-conversation',
      activeRequest: { requestId, leaseId, ownerServerInstanceId, responseEpoch: 0 },
    });
    await nextTick();

    emitTabObservation(hub, {
      requestId,
      clientId: reconnectedId,
      conversationId: 'new-conversation',
      userTurnKey: 'user-launch',
      assistantTurnKey: 'assistant-launch',
      answer: '{"action":"finish","summary":"navigation ok"}',
    });

    const view = await durable.waitFor(durableId, { timeoutMs: 4_000 });
    assert.equal(view.status, 'completed');
    assert.equal(view.response.answer, '{"action":"finish","summary":"navigation ok"}');
    assert.equal(hub.sentOfType('prompt.send').length, 1);
  } finally {
    await bridge.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('an older root tab cannot steal ownership or contribute the answer', async () => {
  const hub = new NavigationHub([makeClient(ROOT_CLIENT_ID)]);
  const bridge = new BrowserBridge(hub);
  hub.bridge = bridge;
  try {
    const { requestId, promise } = await startRequest(hub);
    const { launchedId, leaseId, ownerServerInstanceId, launchToken } = launchedReady(hub, requestId);
    hub.disconnect(launchedId);
    const reconnectedId = 'extension:tab:719098609:owner';
    hub.reconnect({
      id: reconnectedId,
      launchToken,
      url: 'https://chatgpt.com/c/new-conversation',
      activeRequest: { requestId, leaseId, ownerServerInstanceId, responseEpoch: 0 },
    });
    await nextTick();
    assert.equal(bridge.requestDiagnostics()[0].clientId, reconnectedId, 'the conversation client owns the request after reconnect');

    const root = hub.clientList.find((client) => client.id === ROOT_CLIENT_ID);
    root.activeRequest = { requestId, leaseId: 'foreign-lease', ownerServerInstanceId: 'foreign-server', responseEpoch: 0 };
    hub.emit('client.ready', root);
    hub.emit('client.changed', root);
    emitTabObservation(hub, {
      requestId,
      clientId: ROOT_CLIENT_ID,
      conversationId: 'new-conversation',
      userTurnKey: 'user-launch',
      assistantTurnKey: 'assistant-launch',
      answer: 'root tab answer',
    });
    await nextTick();

    assert.equal(hub.sent.some((entry) => entry.payload.type === 'request.resume' && entry.clientId === ROOT_CLIENT_ID), false);
    assert.equal(bridge.requestDiagnostics()[0].clientId, reconnectedId);

    emitTabObservation(hub, {
      requestId,
      clientId: reconnectedId,
      conversationId: 'new-conversation',
      userTurnKey: 'user-launch',
      assistantTurnKey: 'assistant-launch',
      answer: 'owning tab answer',
    });
    const response = await promise;
    assert.equal(response.answer, 'owning tab answer');
  } finally {
    await bridge.close();
  }
});

test('a same-tab reconnect whose content projection is gone is re-projected instead of hanging in recovery', async () => {
  const hub = new NavigationHub([makeClient(ROOT_CLIENT_ID)]);
  const bridge = new BrowserBridge(hub);
  hub.bridge = bridge;
  try {
    const { requestId, promise } = await startRequest(hub);
    const { launchedId, leaseId, ownerServerInstanceId, launchToken } = launchedReady(hub, requestId);

    hub.disconnect(launchedId);
    // The tab reconnects under the same client id but on /c/... and without a
    // content-side projection: the bridge must ask it to prove the turn again.
    hub.reconnect({
      id: launchedId,
      launchToken,
      url: 'https://chatgpt.com/c/new-conversation',
      activeRequest: null,
    });
    await nextTick();
    assert.equal(
      hub.sent.filter((entry) => entry.payload.type === 'request.resume').length,
      0,
      'readiness alone cannot reattach without page evidence',
    );

    // The repainted conversation reports page activity without any projection.
    emitTabObservation(hub, {
      requestId,
      clientId: launchedId,
      conversationId: 'new-conversation',
      userTurnKey: 'user-launch',
      assistantTurnKey: 'assistant-launch',
      answer: '',
      generation: 'active',
      outputState: 'streaming',
      activeRequest: false,
    });
    await nextTick();

    const resume = hub.sent.filter((entry) => entry.payload.type === 'request.resume').at(-1);
    assert.ok(resume, 'a missing projection is repaired with a read-only resume');
    assert.equal(resume.clientId, launchedId);
    assert.equal(resume.payload.projection.submittedUserTurnKey, 'user-launch');

    emitTabObservation(hub, {
      requestId,
      clientId: launchedId,
      conversationId: 'new-conversation',
      userTurnKey: 'user-launch',
      assistantTurnKey: 'assistant-launch',
      answer: 'visible after reconnect',
      activeRequest: { leaseId, ownerServerInstanceId, responseEpoch: 0 },
    });
    const response = await promise;
    assert.equal(response.answer, 'visible after reconnect');
  } finally {
    await bridge.close();
  }
});

test('a reconnect and its projection recovery never submit the prompt a second time', async () => {
  const hub = new NavigationHub([makeClient(ROOT_CLIENT_ID)]);
  const bridge = new BrowserBridge(hub);
  hub.bridge = bridge;
  try {
    const { requestId, promise } = await startRequest(hub);
    const { launchedId, leaseId, ownerServerInstanceId, launchToken } = launchedReady(hub, requestId);
    hub.disconnect(launchedId);
    const reconnectedId = 'extension:tab:719098609:no-dup';
    hub.reconnect({
      id: reconnectedId,
      launchToken,
      url: 'https://chatgpt.com/c/new-conversation',
      activeRequest: { requestId, leaseId, ownerServerInstanceId, responseEpoch: 0 },
    });
    await nextTick();
    emitTabObservation(hub, {
      requestId,
      clientId: reconnectedId,
      conversationId: 'new-conversation',
      userTurnKey: 'user-launch',
      assistantTurnKey: 'assistant-launch',
      answer: '',
      generation: 'active',
      outputState: 'streaming',
      activeRequest: false,
    });
    hub.emit('client.changed', hub.clientList.find((client) => client.id === reconnectedId));
    await nextTick();

    assert.equal(hub.sentOfType('prompt.send').length, 1, 'the prompt is delivered exactly once');

    emitTabObservation(hub, {
      requestId,
      clientId: reconnectedId,
      conversationId: 'new-conversation',
      userTurnKey: 'user-launch',
      assistantTurnKey: 'assistant-launch',
      answer: 'done once',
    });
    const response = await promise;
    assert.equal(response.answer, 'done once');
  } finally {
    await bridge.close();
  }
});

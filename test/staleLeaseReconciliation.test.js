import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserBridge } from '../src/browserBridge.js';
import { EventBus } from '../src/eventBus.js';
import { StaleLeaseReconciliationCoordinator } from '../src/bridge/coordinator/staleLeaseReconciliationCoordinator.js';

const OLD_SERVER = '5fd2cb17-19a2-44d0-bb43-5b8948c7243b';
const OLD_REQUEST = 'mvq87qyx-4618q54m';
const OLD_LEASE = '60aec3e2-f03d-4387-9b32-6afc3e0021df';
const NEW_SERVER = 'server-new-instance';

let revision = 0;
const tracked = [];

function track(instance) {
  tracked.push(instance);
  return instance;
}

afterEach(async () => {
  while (tracked.length) {
    try { await tracked.pop().close({ cancelPending: true }); } catch {}
  }
});

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, label = 'condition', timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await nextTick();
  }
  assert.fail(`timed out waiting for ${label}`);
}

function makeClient(id = 'client-1') {
  return {
    id,
    ready: true,
    compatible: true,
    compatibility: { compatible: true },
    url: 'https://chatgpt.com/c/conversation-1',
    title: 'test conversation',
    browserTabId: 719096738,
    backgroundEpoch: 'background-old',
    contentEpoch: 'content-old',
    activeRequest: null,
    tabObservation: null,
  };
}

function staleLease(overrides = {}) {
  return {
    requestId: OLD_REQUEST,
    leaseId: OLD_LEASE,
    ownerServerInstanceId: OLD_SERVER,
    responseEpoch: 0,
    submittedUserTurnKey: 'old-user',
    submittedUserTurnIndex: 0,
    assistantTurnKey: 'old-assistant',
    assistantTurnIndex: 1,
    ...overrides,
  };
}

/**
 * Models the extension side of the reconnect contract: the persisted lease is
 * re-advertised after a server restart, and `request.release` with
 * `recoveryMode: 'stale_lease'` is the only way to prove and clear it.
 */
class FakeHub extends EventEmitter {
  constructor({ serverInstanceId = NEW_SERVER, releaseOutcome = 'released' } = {}) {
    super();
    this.serverInstanceId = serverInstanceId;
    this.sent = [];
    this.releaseOutcome = releaseOutcome;
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
        if (this.releaseOutcome !== 'released') {
          client.quarantined = true;
          client.quarantineReason = 'stale lease release could not be proven';
          this.emit('client.message', {
            clientId: client.id,
            payload: {
              type: 'lease.quarantined',
              commandId: payload.commandId,
              requestId: payload.requestId,
              code: 'RELEASE_CLEANUP_FAILED',
              message: 'stale lease release could not be proven',
            },
          });
          return;
        }
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
        return;
      }
      if (payload.type === 'prompt.cancel') {
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

function observation({
  activeRequest = null,
  conversationId = 'conversation-1',
  userTurnKey = '',
  assistantTurnKey = '',
  generation = 'stopped',
  outputState = 'none',
  answer = '',
  finalMessage = false,
} = {}) {
  revision += 1;
  return {
    schemaVersion: 4,
    observerId: 'tab-observer-test',
    revision,
    observedAt: Date.now(),
    stableForMs: generation === 'active' ? 0 : 2_000,
    url: `https://chatgpt.com/c/${conversationId}`,
    conversationId,
    activeRequest,
    turn: {
      key: assistantTurnKey,
      index: assistantTurnKey ? 1 : -1,
      userKey: userTurnKey,
      userIndex: userTurnKey ? 0 : -1,
      userPrompt: userTurnKey ? 'prompt' : '',
      promptBoundary: userTurnKey ? { submittedUserTurnKey: userTurnKey, submittedUserTurnIndex: 0 } : null,
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
}

function emitActivity(hub, payload, clientId = 'client-1') {
  hub.emit('client.activity', { clientId, client: { ...hub.byId.get(clientId) }, payload });
}

/** A reconnected tab reports idle generation while still advertising its lease. */
function advertiseStaleLease(hub, options = {}) {
  const client = hub.byId.get('client-1');
  const active = staleLease();
  client.activeRequest = active;
  client.tabObservation = observation({ ...options, activeRequest: active });
  emitActivity(hub, { type: 'tab.observation', observation: client.tabObservation, session: { id: 'conversation-1' } });
  return client.tabObservation;
}

// Simulates the dead process: a new Hub/BrowserBridge pair receives the
// extension hello. A transport hello carries the persisted lease but no tab
// observation (that arrives with the next page status/observation).
function restartServer(hub, { serverInstanceId = NEW_SERVER, releaseOutcome = 'released' } = {}) {
  const previous = hub.byId.get('client-1');
  const next = new FakeHub({ serverInstanceId, releaseOutcome });
  next.byId.set('client-1', {
    ...previous,
    ready: true,
    quarantined: false,
    quarantineReason: '',
    activeRequest: { ...previous.activeRequest },
    tabObservation: null,
  });
  return next;
}

function staleReleases(hub) {
  return hub.sent.filter((entry) => entry.payload.type === 'request.release' && entry.payload.recoveryMode === 'stale_lease');
}

function allReleases(hub) {
  return hub.sent.filter((entry) => entry.payload.type === 'request.release');
}

function setClientLease(hub, requestId, source) {
  const client = hub.byId.get('client-1');
  client.activeRequest = {
    requestId,
    leaseId: String(source.leaseId || ''),
    ownerServerInstanceId: String(source.ownerServerInstanceId || NEW_SERVER),
    responseEpoch: 0,
    submittedUserTurnKey: '',
    submittedUserTurnIndex: -1,
    assistantTurnKey: '',
    assistantTurnIndex: -1,
  };
  return client.activeRequest;
}

function submitPrompt(hub, requestId, submittedUserTurnKey) {
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId } });
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: { type: 'request.effect.started', requestId, effectId: `${requestId}:prompt.submit`, effectType: 'prompt.submit' },
  });
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'request.effect.succeeded',
      requestId,
      effectId: `${requestId}:prompt.submit`,
      effectType: 'prompt.submit',
      result: { submitted: true, submittedUserTurnKey },
    },
  });
}

function completeRequest(hub, requestId, { answer = 'final answer', userTurnKey = 'user-1' } = {}) {
  const client = hub.byId.get('client-1');
  const active = {
    ...client.activeRequest,
    submittedUserTurnKey: userTurnKey,
    submittedUserTurnIndex: 0,
    assistantTurnKey: 'assistant-1',
    assistantTurnIndex: 1,
  };
  client.activeRequest = active;
  const finalObservation = observation({
    activeRequest: active,
    userTurnKey,
    assistantTurnKey: 'assistant-1',
    generation: 'stopped',
    outputState: 'final',
    answer,
    finalMessage: true,
  });
  client.tabObservation = finalObservation;
  emitActivity(hub, { type: 'tab.observation', observation: finalObservation, session: { id: 'conversation-1' } });
}

async function startRequest(bridge, hub, message = 'task') {
  const seen = hub.sent.length;
  const promise = bridge.sendRequest({ message });
  let failure = null;
  promise.catch((error) => { failure = error; });
  await waitFor(
    () => failure || hub.sent.slice(seen).some((entry) => entry.payload.type === 'prompt.send'),
    'prompt.send or request failure',
  );
  if (failure) throw failure;
  const delivered = hub.sent.slice(seen).find((entry) => entry.payload.type === 'prompt.send');
  return { promise, requestId: delivered?.payload?.requestId || '', clientId: delivered?.clientId || '' };
}

test('a tab reconnected to a new bridge releases a lease owned by the dead server', async () => {
  const oldHub = new FakeHub({ serverInstanceId: OLD_SERVER });
  track(new BrowserBridge(oldHub));
  oldHub.byId.get('client-1').activeRequest = staleLease();

  // The old process is gone; the same extension reconnects to a new one.
  const hub = restartServer(oldHub);
  const bridge = track(new BrowserBridge(hub));
  const client = hub.byId.get('client-1');
  assert.equal(client.activeRequest.ownerServerInstanceId, OLD_SERVER);

  hub.emit('client.ready', { ...client });
  await nextTick();
  assert.equal(staleReleases(hub).length, 0, 'hello alone carries no idle tab evidence');

  advertiseStaleLease(hub);
  await waitFor(() => client.activeRequest === null, 'stale lease release');

  assert.equal(staleReleases(hub).length, 1);
  assert.equal(staleReleases(hub)[0].payload.requestId, OLD_REQUEST);
  assert.equal(client.activeRequest, null, 'the dead generation lease must be cleared');
  assert.equal(bridge.requestStateDiagnostics(OLD_REQUEST).state, null, 'a foreign lease never fabricates local canonical state');
});

test('the first request on the new bridge reuses the reconnected tab instead of failing busy', async () => {
  const oldHub = new FakeHub({ serverInstanceId: OLD_SERVER });
  track(new BrowserBridge(oldHub));
  oldHub.byId.get('client-1').activeRequest = staleLease();

  const hub = restartServer(oldHub);
  const bridge = track(new BrowserBridge(hub));
  const client = hub.byId.get('client-1');
  hub.emit('client.ready', { ...client });
  // The observation lands in the same turn as the request: selection has to
  // reconcile inline instead of failing with "No idle ChatGPT tab is available".
  advertiseStaleLease(hub);

  const started = await startRequest(bridge, hub, 'first request on server-new');
  assert.ok(started.requestId, 'the first request must reach the reconnected tab');
  assert.equal(started.clientId, 'client-1');
  assert.equal(client.activeRequest, null);

  const source = bridge.requestStateDiagnostics(started.requestId).state.source;
  setClientLease(hub, started.requestId, source);
  submitPrompt(hub, started.requestId, 'user-1');
  completeRequest(hub, started.requestId, { answer: 'new answer' });

  const response = await started.promise;
  assert.equal(response.answer, 'new answer');
  assert.equal(bridge.requestStateDiagnostics(started.requestId).state.terminal.code, 'completed');
});

test('repeated reconnect and observation events release a stale lease exactly once', async () => {
  const oldHub = new FakeHub({ serverInstanceId: OLD_SERVER });
  track(new BrowserBridge(oldHub));
  oldHub.byId.get('client-1').activeRequest = staleLease();

  const hub = restartServer(oldHub);
  const bridge = track(new BrowserBridge(hub));
  const client = hub.byId.get('client-1');
  hub.emit('client.ready', { ...client });
  advertiseStaleLease(hub);
  await waitFor(() => client.activeRequest === null, 'stale lease release');

  // The extension re-delivers the same reconnect evidence: a queued observation,
  // a repeated hello, and a client.changed projection. The lease identity was
  // already reconciled, so no second command may be dispatched.
  advertiseStaleLease(hub);
  hub.emit('client.changed', { ...client });
  hub.emit('client.ready', { ...client });
  advertiseStaleLease(hub);
  await nextTick();
  await nextTick();

  assert.equal(staleReleases(hub).length, 1, 'reconciliation must be idempotent per lease identity');

  // Once the extension applies the release it stops advertising the lease, and
  // the repeated reconnect noise must not leave the tab unusable.
  client.activeRequest = null;
  const started = await startRequest(bridge, hub, 'request after repeated reconnects');
  assert.equal(started.clientId, 'client-1');
  assert.ok(started.requestId);
});

test('a lease whose request is still valid in this generation is never released', async () => {
  const hub = new FakeHub({ serverInstanceId: NEW_SERVER });
  const bridge = track(new BrowserBridge(hub));
  const started = await startRequest(bridge, hub, 'live request');
  assert.ok(started.requestId);
  const source = bridge.requestStateDiagnostics(started.requestId).state.source;
  const live = setClientLease(hub, started.requestId, source);
  hub.emit('client.ready', { ...hub.byId.get('client-1') });
  hub.byId.get('client-1').tabObservation = observation({ activeRequest: live, generation: 'active', outputState: 'streaming', answer: 'partial' });
  emitActivity(hub, {
    type: 'tab.observation',
    observation: hub.byId.get('client-1').tabObservation,
    session: { id: 'conversation-1' },
  });
  await nextTick();
  await nextTick();

  assert.equal(staleReleases(hub).length, 0, 'a live local request keeps its lease');
  assert.equal(bridge.requestStateDiagnostics(started.requestId).state.terminal, null);
  assert.equal(hub.byId.get('client-1').activeRequest.requestId, started.requestId);

  const supervisor = track(new StaleLeaseReconciliationCoordinator({
    hub,
    serverInstanceId: NEW_SERVER,
    getCanonicalRequestState: (requestId) => bridge.requestStateDiagnostics(requestId).state,
    releaseStaleLease: async () => ({ status: 'confirmed' }),
  }));
  const outcome = await supervisor.reconcileClient('client-1', 'test');
  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.reason, 'not_stale');
});

test('a stale release that cannot be proven keeps the tab non-selectable and emits a diagnostic', async () => {
  const oldHub = new FakeHub({ serverInstanceId: OLD_SERVER });
  track(new BrowserBridge(oldHub));
  oldHub.byId.get('client-1').activeRequest = staleLease();

  const hub = restartServer(oldHub, { releaseOutcome: 'rejected' });
  const eventBus = new EventBus();
  const bridge = track(new BrowserBridge(hub, null, eventBus));
  const client = hub.byId.get('client-1');
  hub.emit('client.ready', { ...client });
  advertiseStaleLease(hub);
  await waitFor(() => client.quarantined === true, 'failed stale release');

  assert.equal(staleReleases(hub).length, 1);
  assert.equal(client.activeRequest?.requestId, OLD_REQUEST, 'an unproven release must not free the tab');
  assert.equal(client.quarantined, true);
  assert.ok(
    eventBus.recentDebugEvents(200).some((event) => event.type === 'client.stale_lease.release_failed'),
    'a failed reconciliation must be diagnosable',
  );

  const seen = hub.sent.length;
  await assert.rejects(
    bridge.sendRequest({ message: 'must not use an unproven tab' }),
    (error) => {
      assert.match(error.message, /No idle ChatGPT tab is available/);
      assert.match(error.message, new RegExp(OLD_REQUEST));
      return true;
    },
  );
  assert.equal(hub.sent.slice(seen).some((entry) => entry.payload.type === 'prompt.send'), false);
});

test('a fresh client with no stale ownership keeps normal behaviour', async () => {
  const hub = new FakeHub({ serverInstanceId: NEW_SERVER });
  const bridge = track(new BrowserBridge(hub));
  const client = hub.byId.get('client-1');
  hub.emit('client.ready', { ...client });
  client.tabObservation = observation();
  emitActivity(hub, { type: 'page.status', url: client.url, title: client.title, activeRequest: null, tabObservation: client.tabObservation });
  await nextTick();
  await nextTick();
  assert.equal(allReleases(hub).length, 0, 'a normal reconnect dispatches no release');

  const started = await startRequest(bridge, hub, 'ordinary request');
  assert.ok(started.requestId);
  const source = bridge.requestStateDiagnostics(started.requestId).state.source;
  setClientLease(hub, started.requestId, source);
  submitPrompt(hub, started.requestId, 'user-1');
  completeRequest(hub, started.requestId, { answer: 'ordinary answer' });

  const response = await started.promise;
  assert.equal(response.answer, 'ordinary answer');
  assert.equal(bridge.requestStateDiagnostics(started.requestId).state.terminal.code, 'completed');
  assert.equal(allReleases(hub).length, 1, 'only the normal terminal release is dispatched');
  assert.equal(allReleases(hub)[0].payload.recoveryMode, undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserBridge } from '../src/browserBridge.js';
import { emitTabObservation } from './support/bridgeObservation.js';

class DedicatedTabHub extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    // One long-lived, always-connected dedicated tab, exactly like the live
    // extension client: ready, compatible, and idle between requests.
    this.client = {
      id: 'client-1',
      ready: true,
      compatible: true,
      url: 'https://chatgpt.com/c/session-1',
      session: { id: 'session-1' },
      activeRequest: null,
    };
  }
  get clients() { return [this.client]; }
  get activeClient() { return this.client; }
  get selectedClientId() { return ''; }
  get needsSelection() { return false; }
  get debugEvents() { return []; }
  sendToActiveWithDelivery(payload) { return this.sendToClientWithDelivery('client-1', payload); }
  sendToActive(payload) { return this.sendToClient('client-1', payload); }
  sendToClientWithDelivery(clientId, payload) {
    const client = this.sendToClient(clientId, payload);
    // The real extension acknowledges the physical lease release. Without that
    // acknowledgement the bridge keeps a release barrier on the tab and the next
    // sequential prompt can never be dispatched to the still-connected client.
    if (payload.type === 'request.release') {
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
    }
    return { client, delivered: Promise.resolve({ clientId, deliveredAt: Date.now() }) };
  }
  sendToClient(clientId, payload) {
    this.sent.push({ clientId, payload });
    return { ...this.client, id: clientId };
  }
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Mirrors the live content runtime's prompt.submit effect result: the submitted
 * user turn is proved during submission and its key is returned to the bridge,
 * which stores it as the canonical response boundary for that request.
 */
function submitPrompt(hub, { requestId, submittedUserTurnKey, clientId = 'client-1' }) {
  hub.emit('client.message', { clientId, payload: { type: 'prompt.accepted', requestId } });
  const effectId = `${requestId}:prompt.submit`;
  hub.emit('client.message', {
    clientId,
    payload: { type: 'request.effect.started', requestId, effectId, effectType: 'prompt.submit' },
  });
  hub.emit('client.message', {
    clientId,
    payload: {
      type: 'request.effect.succeeded',
      requestId,
      effectId,
      effectType: 'prompt.submit',
      result: { submitted: true, submittedUserTurnKey },
    },
  });
}

function sentPrompts(hub) {
  return hub.sent.filter((entry) => entry.payload.type === 'prompt.send').map((entry) => entry.payload);
}

async function completeTurn(hub, bridge, { message, conversationId, userTurnKey, assistantTurnKey, answer }) {
  const responsePromise = bridge.sendRequest({ message });
  await nextTick();
  const prompt = sentPrompts(hub).at(-1);
  assert.ok(prompt, 'prompt.send must reach the dedicated tab');
  submitPrompt(hub, { requestId: prompt.requestId, submittedUserTurnKey: userTurnKey });
  emitTabObservation(hub, {
    requestId: prompt.requestId,
    conversationId,
    userTurnKey,
    assistantTurnKey,
    answer,
    generation: 'stopped',
  });
  const response = await responsePromise;
  assert.equal(response.answer, answer);
  return prompt;
}

test('sequential turns on one dedicated tab never replace the next request', async () => {
  const hub = new DedicatedTabHub();
  const bridge = new BrowserBridge(hub);
  try {
    const firstPrompt = await completeTurn(hub, bridge, {
      message: 'turn one',
      conversationId: 'session-1',
      userTurnKey: 'user-1',
      assistantTurnKey: 'assistant-1',
      answer: 'one',
    });

    const secondPromise = bridge.sendRequest({ message: 'turn two' });
    secondPromise.catch(() => {});
    await nextTick();
    assert.equal(sentPrompts(hub).length, 2, 'the next turn must be dispatched to the same dedicated tab');
    const secondPrompt = sentPrompts(hub).at(-1);
    assert.notEqual(secondPrompt.requestId, firstPrompt.requestId);
    submitPrompt(hub, { requestId: secondPrompt.requestId, submittedUserTurnKey: 'user-2' });

    // The previous turn's capture was queued before the tab adopted the new
    // prompt, so it still names the request that already completed.
    emitTabObservation(hub, {
      requestId: secondPrompt.requestId,
      activeRequest: { requestId: firstPrompt.requestId },
      conversationId: 'session-1',
      userTurnKey: 'user-1',
      assistantTurnKey: 'assistant-1',
      answer: 'one',
      generation: 'stopped',
    });
    await nextTick();

    emitTabObservation(hub, {
      requestId: secondPrompt.requestId,
      conversationId: 'session-1',
      userTurnKey: 'user-2',
      assistantTurnKey: 'assistant-2',
      answer: 'two',
      generation: 'stopped',
    });
    const response = await secondPromise;
    assert.equal(response.answer, 'two');
    assert.equal(response.requestId, secondPrompt.requestId);
  } finally {
    await bridge.close();
  }
});

test('an unrelated request still takes ownership and fails the active request closed', async () => {
  const hub = new DedicatedTabHub();
  const bridge = new BrowserBridge(hub);
  try {
    const responsePromise = bridge.sendRequest({ message: 'guarded turn' });
    responsePromise.catch(() => {});
    await nextTick();
    const prompt = sentPrompts(hub).at(-1);
    assert.ok(prompt);
    submitPrompt(hub, { requestId: prompt.requestId, submittedUserTurnKey: 'user-1' });

    emitTabObservation(hub, {
      requestId: prompt.requestId,
      activeRequest: { requestId: 'request-owned-by-someone-else' },
      conversationId: 'session-1',
    });

    let rejection = null;
    try {
      await responsePromise;
    } catch (error) {
      rejection = error;
    }
    assert.ok(rejection, 'a request the bridge never proved terminal must still fail closed');
    assert.match(rejection.message, /Source tab replaced the active request/);
    assert.equal(rejection.code, 'CANONICAL_REQUEST_REPLACED');
    assert.equal(rejection.canonicalTerminal.code, 'request_replaced');
  } finally {
    await bridge.close();
  }
});

import { config } from '../../config.js';
import { makeEvent } from '../requestState.js';
import { hubActivityToCanonicalEvent } from '../adapters/hubObservationAdapter.js';
import { RequestEventType } from '../state/requestEvents.js';
import { isRequestRuntimeFinished } from './requestRuntimeProjection.js';

// A reloaded page keeps painting for a while: the conversation has to be
// re-fetched and re-rendered before its newest user turn exists again. Boundary
// recovery therefore keeps re-reading durable evidence inside this window
// before it is allowed to fail closed.
const BOUNDARY_RECOVERY_WINDOW_MS = Math.max(2_000, Number(config.requestBoundaryRecoveryMs) || 30_000);
const BOUNDARY_RECOVERY_RETRY_MS = Math.max(250, Number(config.requestBoundaryRecoveryRetryMs) || 1_500);

/**
 * Identity of the content runtime behind one browser client. A tab that merely
 * reports new page state keeps the same identity; a reloaded content script,
 * re-injected runtime or restarted tab observer gets a new one.
 */
export function clientRuntimeIdentity(client = {}) {
  return String(
    client?.contentEpoch
    || client?.contentClientId
    || client?.tabObservation?.observationEpoch
    || client?.tabObservation?.observerId
    || '',
  );
}

/**
 * Reconciles a newly connected content executor with the canonical request
 * reducer. It never resubmits an ambiguous write and never owns a lease.
 */
export class RequestReattachmentCoordinator {
  constructor({ pending, lifecycle, eventBus = null, sendCommand = null }) {
    this.pending = pending;
    this.lifecycle = lifecycle;
    this.eventBus = eventBus;
    this.sendCommand = sendCommand;
  }

  canonicalProjectionForState(state) {
    const canonical = this.lifecycle.getState(state.requestId);
    const last = canonical?.lastObservation?.data || {};
    const observation = last.observation || {};
    const submittedUserTurnKey = String(
      canonical?.response?.userTurnKey
      || last.submittedUserTurnKey
      || (last.responseBoundaryEstablished ? observation.turn?.userKey : '')
      || '',
    );
    const scopedAssistantTurnKey = last.scopedToRequest === true && last.responseBoundaryEstablished === true
      ? String(last.turnKey || observation.turn?.key || '')
      : '';
    return {
      responseEpoch: Math.max(0, Number(canonical?.response?.epoch) || 0),
      submittedUserTurnKey,
      submittedUserTurnIndex: Number(observation.turn?.userIndex ?? observation.activeRequest?.submittedUserTurnIndex ?? -1),
      assistantTurnKey: String(scopedAssistantTurnKey || state.progress?.assistantTurnKey || ''),
      assistantTurnIndex: Number(last.turnIndex ?? observation.turn?.index ?? state.progress?.assistantTurnIndex ?? -1),
      sentAt: Number(observation.activeRequest?.sentAt || state.progress?.sentAt || 0),
      submittedPromptText: String(state.promptPayload?.message || ''),
    };
  }

  promptSubmitted(state) {
    return this.lifecycle.getState(state.requestId)?.submission === 'submitted';
  }

  /**
   * The stable identity of the browser effect behind one request. A request is
   * launched into a specific tab (its `launchToken` keeps that tab's identity
   * across navigations and WebSocket reconnects) and the tab itself reports the
   * exact lease it is executing. Both survive a connection replacement; the
   * transient `clientId` does not have to.
   */
  #carriesRequestBody(state, client = {}) {
    // Only the client projection counts here, never a single page observation:
    // an observation may omit lease identity, and an older tab that renders the
    // same request id must not be able to claim the request with it.
    const activeRequest = client?.activeRequest || null;
    if (!activeRequest || activeRequest.requestId !== state.requestId) return false;
    const identity = this.lifecycle.requestIdentity(state);
    if (!identity) return false;
    return Boolean(activeRequest.leaseId)
      && Boolean(activeRequest.ownerServerInstanceId)
      && activeRequest.leaseId === identity.leaseId
      && activeRequest.ownerServerInstanceId === identity.ownerServerInstanceId;
  }

  #launchOwnsState(state, client = {}) {
    const launchToken = String(state.launchToken || '');
    return Boolean(launchToken) && String(client?.launchToken || '') === launchToken;
  }

  /**
   * True when this client is either the bound owner or provably the browser
   * effect of this request. Ownership is never inferred from mere readiness or
   * from another tab's page state: an unrelated or older ChatGPT tab has no
   * launch token for this request and does not hold its lease.
   */
  ownsState(state, client = {}) {
    if (!state || !client?.id) return false;
    if (state.clientId === client.id) return true;
    return this.#launchOwnsState(state, client) || this.#carriesRequestBody(state, client);
  }

  /**
   * Moves request ownership from the transient connection that received the
   * prompt to the client that is actually executing it. This is a bookkeeping
   * transfer only: it never submits, resubmits or releases anything, and it is
   * only allowed once the prompt submission is already proved.
   */
  claimOwnership(state, client = {}, reason = 'ownership_transfer') {
    if (!state || !client?.id) return false;
    if (state.clientId === client.id) return true;
    if (!this.promptSubmitted(state)) return false;
    if (!this.ownsState(state, client)) return false;
    const previousClientId = String(state.clientId || '');
    state.clientId = String(client.id);
    if (!state.launchToken) state.launchToken = String(client.launchToken || '');
    const identity = this.lifecycle.requestIdentity(state);
    this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.CONNECTION_CHANGED, {
      connected: true,
      connection: 'connected',
      clientId: String(client.id),
      url: String(client.url || ''),
      leaseId: String(identity?.leaseId || ''),
      ownerServerInstanceId: String(identity?.ownerServerInstanceId || ''),
    }, 'ownership_transfer'));
    this.eventBus?.emitDebug({
      type: 'request.ownership.transferred',
      requestId: state.requestId,
      data: {
        previousClientId,
        clientId: String(client.id),
        launchToken: String(state.launchToken || ''),
        url: String(client.url || ''),
        reason,
      },
    });
    this.lifecycle.emitRequestEvent(state, makeEvent('request.owner.moved', {
      requestId: state.requestId,
      previousClientId,
      clientId: String(client.id),
      reason,
    }));
    return true;
  }

  /**
   * A negative boundary read is not automatically proof of loss. It is proof
   * only when the reloaded conversation surface had already settled; a surface
   * that was still painting (or empty) reports `settled: false` and must be
   * re-read instead of terminalizing a live request.
   */
  #boundaryReadIsProvisional(response = {}) {
    const evidence = response?.boundaryEvidence || {};
    return evidence.settled === false || evidence.unsettled === true;
  }

  #clearBoundaryRecovery(state, reason = '') {
    const recovery = state?.boundaryRecovery;
    if (!recovery) return;
    if (recovery.timer) clearTimeout(recovery.timer);
    state.boundaryRecovery = null;
    this.eventBus?.emitDebug({
      type: 'request.boundary_recovery.cleared',
      requestId: state.requestId,
      data: { reason, attempts: Math.max(0, Number(recovery.attempts) || 0) },
    });
  }

  /**
   * Keeps the request alive while the reloaded page is still painting, so the
   * submitted turn can be proved again with fresh durable evidence. Nothing here
   * submits, resubmits or releases: recovery stays read-only and the same
   * request identity keeps owning the turn.
   */
  #beginBoundaryRecovery(state, client, projection, response = {}) {
    const now = Date.now();
    const recovery = state.boundaryRecovery || {
      startedAt: now,
      attempts: 0,
      deadlineAt: now + BOUNDARY_RECOVERY_WINDOW_MS,
      timer: null,
      lastEvidence: null,
      client: null,
    };
    recovery.attempts += 1;
    recovery.client = client || recovery.client;
    recovery.lastEvidence = response.boundaryEvidence || null;
    state.boundaryRecovery = recovery;
    this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.RESPONSE_BOUNDARY_PENDING, {
      attempt: recovery.attempts,
      submittedUserTurnKey: projection.submittedUserTurnKey,
      submittedUserTurnIndex: projection.submittedUserTurnIndex,
      assistantTurnKey: projection.assistantTurnKey,
      deadlineAt: recovery.deadlineAt,
      evidence: recovery.lastEvidence,
      reasonCode: 'SUBMITTED_TURN_NOT_RENDERED_AFTER_RELOAD',
      message: 'The submitted user turn is not rendered yet after content reload; canonical recovery is retrying before declaring it lost.',
    }, 'browser_reconnect'));
    this.eventBus?.emitDebug({
      type: 'request.boundary_recovery.pending',
      requestId: state.requestId,
      data: {
        clientId: state.clientId,
        attempt: recovery.attempts,
        deadlineAt: recovery.deadlineAt,
        evidence: recovery.lastEvidence,
      },
    });
    return true;
  }

  #scheduleBoundaryRecoveryRetry(state) {
    const recovery = state?.boundaryRecovery;
    if (!recovery || recovery.timer) return;
    const remaining = Number(recovery.deadlineAt || 0) - Date.now();
    const delayMs = Math.max(0, Math.min(BOUNDARY_RECOVERY_RETRY_MS, remaining));
    recovery.timer = setTimeout(() => {
      recovery.timer = null;
      this.#retryBoundaryRecovery(state);
    }, delayMs);
    // The retry window must never hold the process open on its own.
    recovery.timer?.unref?.();
  }

  #retryBoundaryRecovery(state) {
    const recovery = state?.boundaryRecovery;
    if (!recovery) return;
    if (isRequestRuntimeFinished(state) || !this.pending.has(state.requestId)) {
      this.#clearBoundaryRecovery(state, 'request_finished');
      return;
    }
    if (Date.now() >= Number(recovery.deadlineAt || 0)) {
      this.#failBoundaryRecovery(state);
      return;
    }
    if (!recovery.client || state.projectionHydrationInFlight) {
      this.#scheduleBoundaryRecoveryRetry(state);
      return;
    }
    this.rehydrateClientProjection(state, recovery.client, { force: true });
  }

  /**
   * The bounded window expired without page evidence for the submitted turn.
   * This is the unchanged fail-closed outcome: the prompt may or may not have
   * been submitted, so it is never resubmitted.
   */
  #failBoundaryRecovery(state) {
    const recovery = state.boundaryRecovery;
    const projection = this.canonicalProjectionForState(state);
    this.#clearBoundaryRecovery(state, 'recovery_window_expired');
    this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.RESPONSE_BOUNDARY_LOST, {
      submittedUserTurnKey: projection.submittedUserTurnKey,
      submittedUserTurnIndex: projection.submittedUserTurnIndex,
      evidence: recovery?.lastEvidence || null,
      attempts: Math.max(0, Number(recovery?.attempts) || 0),
      waitedMs: Math.max(0, Date.now() - Number(recovery?.startedAt || Date.now())),
      reasonCode: 'SUBMITTED_TURN_MISSING_AFTER_RELOAD',
      message: 'The submitted user turn disappeared after content reload; repeating prompt.submit would be ambiguous and is forbidden.',
    }, 'browser_reconnect'));
  }

  rehydrateClientProjection(state, client, options = {}) {
    if (!this.sendCommand || isRequestRuntimeFinished(state) || !this.promptSubmitted(state)) return;
    const projection = this.canonicalProjectionForState(state);
    if (!projection.submittedUserTurnKey) return;
    const observerId = String(client.tabObservation?.observerId || 'ready');
    const key = `${observerId}:${projection.responseEpoch}:${projection.submittedUserTurnKey}:${projection.assistantTurnKey}`;
    if (state.projectionHydrationInFlight === key) return;
    if (state.lastProjectionHydrationKey === key && options.force !== true) return;
    state.projectionHydrationInFlight = key;
    void this.sendCommand('request.resume', {
      requestId: state.requestId,
      projection,
    }, {
      sourceClientId: state.clientId,
      timeoutMs: 12_000,
      request: this.lifecycle.requestIdentity(state),
    }).then((response = {}) => {
      const boundaryStatus = String(response.boundaryStatus || 'matched');
      if (boundaryStatus === 'rebound') {
        this.#clearBoundaryRecovery(state, 'boundary_rebound');
        this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.RESPONSE_BOUNDARY_REBOUND, {
          submittedUserTurnKey: String(response.submittedUserTurnKey || ''),
          submittedUserTurnIndex: Number(response.submittedUserTurnIndex ?? -1),
          previousSubmittedUserTurnKey: projection.submittedUserTurnKey,
          evidence: response.boundaryEvidence || null,
          message: 'Submitted user-turn identity was rebound after content reload using submitted-prompt evidence.',
        }, 'browser_reconnect'));
      } else if (boundaryStatus === 'missing') {
        // An unsettled read (empty surface, or a turn list that kept changing)
        // is not evidence that the submitted turn is gone: keep ownership and
        // re-read durable evidence until the bounded recovery window expires.
        if (this.#boundaryReadIsProvisional(response)) {
          this.#beginBoundaryRecovery(state, client, projection, response);
          return;
        }
        this.#clearBoundaryRecovery(state, 'boundary_lost');
        this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.RESPONSE_BOUNDARY_LOST, {
          submittedUserTurnKey: projection.submittedUserTurnKey,
          submittedUserTurnIndex: projection.submittedUserTurnIndex,
          evidence: response.boundaryEvidence || null,
          reasonCode: 'SUBMITTED_TURN_MISSING_AFTER_RELOAD',
          message: 'The submitted user turn disappeared after content reload; repeating prompt.submit would be ambiguous and is forbidden.',
        }, 'browser_reconnect'));
        return;
      } else {
        this.#clearBoundaryRecovery(state, 'boundary_matched');
      }
      state.lastProjectionHydrationKey = key;
      this.eventBus?.emitDebug({
        type: 'request.projection.rehydrated',
        requestId: state.requestId,
        data: {
          clientId: state.clientId,
          observerId,
          responseEpoch: projection.responseEpoch,
          boundaryStatus,
        },
      });
    }).catch((error) => {
      this.eventBus?.emitDebug({
        type: 'request.projection.rehydrate_failed',
        requestId: state.requestId,
        data: { clientId: state.clientId, message: error.message || String(error) },
      });
    }).finally(() => {
      if (state.projectionHydrationInFlight === key) state.projectionHydrationInFlight = '';
      if (state.boundaryRecovery) this.#scheduleBoundaryRecoveryRetry(state);
    });
  }

  #reattachSubmittedState(state, clientId, client, activeRequest) {
    if (activeRequest?.requestId !== state.requestId) return false;
    // A pending boundary recovery keeps re-reading through the newest content
    // runtime, because that is the one that will paint the conversation first.
    if (state.boundaryRecovery) state.boundaryRecovery.client = client;
    const now = Date.now();
    state.lastHeartbeatAt = now;
    const heartbeatEvent = hubActivityToCanonicalEvent(state.requestId, clientId, client, {}, now);
    if (heartbeatEvent) this.lifecycle.ingestRequestTransition(state, heartbeatEvent);
    if (client.tabObservation?.generation?.state === 'active') state.generationActivityAt = now;
    if (now - (state.lastReattachAt || 0) < 1_000) {
      this.rehydrateClientProjection(state, client);
      return true;
    }

    state.lastReattachAt = now;
    this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.CONNECTION_CHANGED, {
      connected: true,
      connection: 'connected',
      clientId,
    }, 'browser_reconnect'));
    this.lifecycle.emitRequestEvent(state, makeEvent('request.reattached', {
      requestId: state.requestId,
      clientId,
      responseEpoch: Number(this.lifecycle.getState(state.requestId)?.response?.epoch || 0),
    }));
    state.callbacks.onStatus?.('reattached', { requestId: state.requestId, clientId, activeRequest });
    this.rehydrateClientProjection(state, client);
    return true;
  }

  /**
   * A reload is only a reload when the content runtime actually restarted.
   * Ordinary page.status / page.changed traffic keeps the same identity, and
   * treating it as a reload used to invalidate a perfectly healthy in-flight
   * effect and re-dispatch its execution step.
   */
  #contentRuntimeRestarted(state, client) {
    const identity = clientRuntimeIdentity(client);
    if (!identity) return false;
    const known = String(state.boundContentEpoch || '');
    if (!known) {
      state.boundContentEpoch = identity;
      return false;
    }
    if (identity === known) return false;
    state.boundContentEpoch = identity;
    return true;
  }

  #recoverUnsubmittedReload(state, clientId, activeRequest = null) {
    if (!state.promptPayload) return false;
    const now = Date.now();
    if (now - (state.lastUnsubmittedReloadRecoveryAt || 0) < 1_000) return false;
    state.lastUnsubmittedReloadRecoveryAt = now;
    const canonical = this.lifecycle.getState(state.requestId);
    const activeEffect = canonical?.effect?.browser || null;
    const activeIdentity = activeEffect?.activeIdentity || null;
    const effectId = String(activeEffect?.activeId || `${state.requestId}:prompt.submit:unconfirmed`);
    const effectType = String(activeEffect?.activeType || 'prompt.submit');
    // Quote the identity the browser actually recorded for this effect. The
    // effect id ("<request>:<kind>:attempt:<n>") is not the logical idempotency
    // key, and an empty preconditions hash can never be accepted as evidence.
    this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.EFFECT_UNCERTAIN, {
      effectId,
      effectType,
      effectDomain: 'browser',
      idempotencyKey: String(activeIdentity?.idempotencyKey || effectId),
      preconditions: activeIdentity?.preconditions || {},
      preconditionsHash: String(activeIdentity?.preconditionsHash || ''),
      attempt: Math.max(1, Number(activeIdentity?.attempt) || 1),
      code: 'PROMPT_SUBMISSION_UNCERTAIN_AFTER_RELOAD',
      message: 'Content runtime reloaded before prompt submission could be proved; automatic resend is forbidden.',
      recoveryTimeoutMs: 30_000,
      recoverable: true,
      evidence: { clientId, activeRequestId: activeRequest?.requestId || '' },
    }, 'browser_reconnect'));
    this.lifecycle.emitRequestEvent(state, makeEvent('prompt.reconcile_required_after_navigation', {
      requestId: state.requestId,
      clientId,
      effectId,
    }));
    return true;
  }

  handleClientReady(client = {}) {
    if (client.compatible === false || client.compatibility?.compatible === false) return;
    const clientId = String(client.id || '');
    if (!clientId) return;
    for (const state of this.pending.values()) {
      if (isRequestRuntimeFinished(state)) { this.#clearBoundaryRecovery(state, 'request_finished'); continue; }
      if (!this.ownsState(state, client)) continue;
      if (this.promptSubmitted(state)) {
        this.claimOwnership(state, client, 'client_ready');
        const activeRequest = client.tabObservation?.activeRequest || client.activeRequest || null;
        state.awaitingReattachAfterReload = activeRequest?.requestId !== state.requestId;
        if (activeRequest?.requestId === state.requestId) this.#reattachSubmittedState(state, state.clientId, client, activeRequest);
        continue;
      }
      if (state.clientId !== clientId) continue;
      const activeRequest = client.tabObservation?.activeRequest || client.activeRequest || null;

      // Reload before a proved prompt submission is an uncertain write boundary.
      // Never resend the prompt from readiness handling: reconciliation must
      // prove whether the original effect happened or fail recoverably. Only a
      // content-runtime restart counts as reload evidence.
      if (!this.#contentRuntimeRestarted(state, client)) continue;
      this.#recoverUnsubmittedReload(state, clientId, activeRequest);
    }
  }

  handleClientChanged(client = {}) {
    if (client.compatible === false || client.compatibility?.compatible === false) return;
    const clientId = String(client.id || '');
    if (!clientId) return;
    for (const state of this.pending.values()) {
      if (isRequestRuntimeFinished(state)) { this.#clearBoundaryRecovery(state, 'request_finished'); continue; }
      if (!this.ownsState(state, client)) continue;
      const activeRequest = client.tabObservation?.activeRequest || client.activeRequest || null;
      if (this.promptSubmitted(state)) {
        this.claimOwnership(state, client, 'client_changed');
        state.awaitingReattachAfterReload = activeRequest?.requestId !== state.requestId;
        if (activeRequest?.requestId === state.requestId) this.#reattachSubmittedState(state, state.clientId, client, activeRequest);
        continue;
      }
      if (state.clientId !== clientId) continue;
      if (!this.#contentRuntimeRestarted(state, client)) continue;
      this.#recoverUnsubmittedReload(state, clientId, activeRequest);
    }
  }

  handleClientActivity(clientIdValue = '', client = {}, payload = {}) {
    const clientId = String(clientIdValue || client?.id || '');
    if (!clientId || client?.compatible === false || client?.compatibility?.compatible === false) return;
    const observation = payload?.observation && typeof payload.observation === 'object'
      ? payload.observation
      : payload?.tabObservation && typeof payload.tabObservation === 'object'
        ? payload.tabObservation
        : client?.tabObservation || null;
    const activeRequest = observation?.activeRequest || client?.activeRequest || payload?.activeRequest || null;
    const activityClient = { ...client, id: clientId, tabObservation: observation || client?.tabObservation || null };

    for (const state of this.pending.values()) {
      if (isRequestRuntimeFinished(state)) { this.#clearBoundaryRecovery(state, 'request_finished'); continue; }
      if (!this.promptSubmitted(state)) continue;
      if (!this.ownsState(state, activityClient)) continue;
      const moved = this.claimOwnership(state, activityClient, 'client_activity');
      if (!moved) continue;
      if (activeRequest?.requestId !== state.requestId) {
        // The owning launch tab reconnected on the canonical conversation URL
        // without its disposable content projection. One read-only hydration
        // asks it to prove the submitted turn again instead of waiting forever.
        this.rehydrateClientProjection(state, activityClient, { reason: 'client_activity' });
        continue;
      }
      // Page activity is the earliest signal that the reloaded conversation was
      // repainted, so a pending boundary recovery is fed by it as well.
      if (!state.awaitingReattachAfterReload && !state.boundaryRecovery) continue;
      const reattached = this.#reattachSubmittedState(state, state.clientId, activityClient, activeRequest);
      if (reattached) state.awaitingReattachAfterReload = false;
    }
  }
}

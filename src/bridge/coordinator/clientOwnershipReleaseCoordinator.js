import { SubmissionState } from '../state/requestEvents.js';

/**
 * Owns release of the browser tab a request held. It is the only place a
 * `request.release` command is dispatched, so the canonical terminal effect, the
 * request-level `finally` guard, and any recovery path cannot release the same
 * lease twice.
 *
 * Local ownership (the reserved client) is dropped even when no lease was ever
 * claimed, and a failed release never rejects its caller: terminal results are
 * already materialized and must not be lost to cleanup bookkeeping.
 */
export class ClientOwnershipReleaseCoordinator {
  constructor({
    hub,
    getState,
    requestIdentity,
    sendCommand,
    eventBus = null,
    releaseTimeoutMs = 10_000,
    retainedReleases = 256,
  } = {}) {
    if (!hub || typeof getState !== 'function' || typeof requestIdentity !== 'function' || typeof sendCommand !== 'function') {
      throw new TypeError('ClientOwnershipReleaseCoordinator requires hub, canonical lookup, request identity, and sendCommand');
    }
    this.hub = hub;
    this.getState = getState;
    this.requestIdentity = requestIdentity;
    this.sendCommand = sendCommand;
    this.eventBus = eventBus;
    this.releaseTimeoutMs = Math.max(1_000, Number(releaseTimeoutMs) || 10_000);
    this.retainedReleases = Math.max(16, Number(retainedReleases) || 256);
    this.releases = new Map();
  }

  /**
   * Idempotent per request: the first real release attempt is remembered, so
   * double finalization and later guards await the same command. A skipped
   * attempt (no lease to release yet) is not remembered, because a later caller
   * may observe the lease once prompt delivery has caught up.
   */
  release(state, options = {}) {
    const requestId = String(state?.requestId || '');
    if (!requestId) return Promise.resolve({ attempted: false, released: false, reason: 'request_missing' });
    const recorded = this.releases.get(requestId);
    if (recorded) return recorded.promise;
    const entry = { attempted: false, promise: null };
    entry.promise = (async () => {
      const result = await this.#dispatch(state, options);
      entry.attempted = Boolean(result?.attempted);
      if (!entry.attempted && this.releases.get(requestId) === entry) this.releases.delete(requestId);
      return result;
    })();
    this.releases.set(requestId, entry);
    while (this.releases.size > this.retainedReleases) {
      const oldest = this.releases.keys().next().value;
      if (oldest === requestId) break;
      this.releases.delete(oldest);
    }
    return entry.promise;
  }

  #holdsLease(state, clientId) {
    const client = Array.from(this.hub.clients || []).find((candidate) => String(candidate?.id || '') === clientId);
    if (!client) return false;
    const requestId = String(state?.requestId || '');
    const activeRequestId = String(client.activeRequest?.requestId || '');
    // Never release a lease that the tab says belongs to another request.
    if (activeRequestId) return activeRequestId === requestId;
    // The Hub projection can lag the persisted lease; a submitted prompt proves
    // the tab accepted this request even when no active request is visible yet.
    return this.getState(requestId)?.submission === SubmissionState.SUBMITTED;
  }

  async #dispatch(state, options = {}) {
    const requestId = String(state?.requestId || '');
    const reservedClientId = String(state?.reservedClientId || '');
    if (state) state.reservedClientId = '';
    const clientId = String(state?.clientId || this.getState(requestId)?.source?.clientId || '');
    const skipped = (reason) => ({ attempted: false, released: false, reason, requestId, clientId });
    if (!clientId) return skipped(reservedClientId ? 'reservation_only' : 'no_client_binding');
    if (!this.#holdsLease(state, clientId)) return skipped('lease_not_held');
    const request = this.requestIdentity(state);
    if (!request) return skipped('request_identity_missing');
    try {
      const result = await this.sendCommand('request.release', {
        requestId,
        terminalCode: String(options.terminalCode || ''),
        reason: String(options.reason || 'request_terminal'),
      }, {
        sourceClientId: clientId,
        timeoutMs: this.releaseTimeoutMs,
        request,
      });
      const released = result?.released !== false;
      this.eventBus?.emitDebug({
        type: 'request.release.settled',
        requestId,
        data: { clientId, source: options.source || 'lifecycle', terminalCode: String(options.terminalCode || ''), released },
      });
      return { attempted: true, released, requestId, clientId };
    } catch (error) {
      this.eventBus?.emitDebug({
        type: 'request.release.failed',
        requestId,
        data: {
          clientId,
          source: options.source || 'lifecycle',
          terminalCode: String(options.terminalCode || ''),
          message: String(error?.message || error),
        },
      });
      return { attempted: true, released: false, reason: 'release_failed', message: String(error?.message || error), requestId, clientId };
    }
  }
}

import { config } from '../../config.js';

const DISPATCH_ATTEMPTS = new Set(['ambiguous', 'confirmed']);
const RECONCILE_PASSES = 3;

/**
 * Reconciles browser-tab leases that cannot belong to a live request of this
 * bridge generation.
 *
 * A lease is stale only when its identity proves it: it was advertised by the
 * tab with an `ownerServerInstanceId` of another bridge process (that process is
 * gone; this one owns the transport now), or it belongs to this instance and the
 * canonical runtime already recorded its terminal outcome. Ownership of a live
 * local request, an unknown owner, or a client that cannot present fresh idle
 * tab evidence is never touched.
 *
 * The exact release stays in `StaleRequestReleaseCoordinator`, which
 * re-validates readiness, lease identity, observation freshness, local pending
 * requests, and canonical terminality before dispatching. This coordinator owns
 * *when* to ask: it deduplicates concurrent triggers, bounds real dispatches per
 * lease, and keeps the client non-selectable while an unproven release remains.
 */
export class StaleLeaseReconciliationCoordinator {
  constructor({
    hub,
    getCanonicalRequestState,
    releaseStaleLease,
    serverInstanceId = '',
    eventBus = null,
    now = () => Date.now(),
    observationFreshnessMs = config.clientStaleMs,
    maxReleaseAttempts = 2,
    retainedLeases = 64,
  } = {}) {
    if (!hub || typeof getCanonicalRequestState !== 'function' || typeof releaseStaleLease !== 'function') {
      throw new TypeError('StaleLeaseReconciliationCoordinator requires hub, canonical lookup, and stale lease release');
    }
    this.hub = hub;
    this.getCanonicalRequestState = getCanonicalRequestState;
    this.releaseStaleLease = releaseStaleLease;
    this.serverInstanceId = String(serverInstanceId || '').trim();
    this.eventBus = eventBus;
    this.now = typeof now === 'function' ? now : () => Date.now();
    const freshness = Number(observationFreshnessMs);
    this.observationFreshnessMs = Number.isFinite(freshness) && freshness > 0
      ? freshness
      : Number(config.clientStaleMs) || 30_000;
    this.maxReleaseAttempts = Math.max(1, Number(maxReleaseAttempts) || 2);
    this.retainedLeases = Math.max(8, Number(retainedLeases) || 64);
    this.entries = new Map();
  }

  #clientById(clientId) {
    const id = String(clientId || '');
    if (!id) return null;
    return Array.from(this.hub.clients || []).find((client) => String(client?.id || '') === id) || null;
  }

  /**
   * Classifies the lease a tab advertises. Returns null unless ownership is
   * provably stale for this bridge generation.
   */
  classify(client = {}) {
    const active = client?.activeRequest || null;
    const requestId = String(active?.requestId || '');
    const leaseId = String(active?.leaseId || '');
    const ownerServerInstanceId = String(active?.ownerServerInstanceId || '');
    if (!requestId || !leaseId || !ownerServerInstanceId) return null;
    // A quarantined tab still needs reconciliation: the extension's stale-lease
    // recovery path is exactly what proves its lease safe again.
    if (client.ready !== true || client.compatible === false
      || client.compatibility?.compatible === false) return null;
    const identity = {
      requestId,
      clientId: String(client.id || ''),
      leaseId,
      ownerServerInstanceId,
      responseEpoch: Math.max(0, Number(active.responseEpoch) || 0),
    };
    if (ownerServerInstanceId === this.serverInstanceId) {
      const canonical = this.#canonical(requestId);
      if (!canonical?.terminal) return null;
      return { reason: 'terminal_local_lease', identity };
    }
    return { reason: 'foreign_server_lease', identity };
  }

  #canonical(requestId) {
    try { return this.getCanonicalRequestState(requestId) || null; } catch { return null; }
  }

  /**
   * Reconciles one client. Safe to call from every reconnect/observation
   * trigger: classification short-circuits, concurrent calls share one
   * dispatch, and repeated calls cannot release the same lease twice.
   */
  async reconcileClient(clientId, trigger = 'client_activity') {
    const client = this.#clientById(clientId);
    if (!client) return { status: 'skipped', reason: 'client_missing' };
    // A reconnect and its first tab observation can land in the same turn, so
    // this trigger may join an attempt that was dispatched before the evidence
    // it needs existed. Joining is not enough: the lease is still stale, so the
    // later trigger has to carry it through instead of returning the earlier
    // deferral. Only real dispatches consume attempts, so this stays bounded.
    for (let pass = 0; pass < RECONCILE_PASSES; pass += 1) {
      const candidate = this.classify(client);
      if (!candidate) break;
      const entry = this.#entryFor(client, candidate.identity);
      if (entry.confirmed) return { status: 'confirmed', reason: 'already_released' };
      if (entry.inFlight) {
        await entry.inFlight.catch(() => {});
        continue;
      }
      if (entry.attempts >= this.maxReleaseAttempts) {
        return { status: 'skipped', reason: 'attempts_exhausted' };
      }
      return await this.#dispatch(candidate, entry, trigger);
    }
    return { status: 'skipped', reason: 'not_stale' };
  }

  #entryFor(client, identity) {
    const key = `${identity.clientId}:${identity.requestId}:${identity.leaseId}`;
    const connectionKey = `${client.backgroundEpoch || ''}:${client.contentEpoch || ''}`;
    let entry = this.entries.get(key);
    if (entry && entry.connectionKey !== connectionKey) entry = null;
    if (!entry) {
      entry = { attempts: 0, connectionKey, inFlight: null, confirmed: false };
      this.entries.set(key, entry);
      this.#prune();
    }
    return entry;
  }

  async #dispatch(candidate, entry, trigger) {
    const { identity } = candidate;
    entry.inFlight = (async () => {
      let outcome;
      try {
        outcome = await this.releaseStaleLease(identity);
      } catch (error) {
        outcome = { status: 'ambiguous', reason: 'release_failed', message: String(error?.message || error) };
      }
      const status = String(outcome?.status || 'ambiguous');
      if (status === 'confirmed') entry.confirmed = true;
      // Only a dispatched command consumes an attempt: eligibility rejections
      // (no observation yet, release barrier still open, ...) may be retried by
      // the next reconnect/observation trigger without a retry storm.
      if (DISPATCH_ATTEMPTS.has(status)) entry.attempts += 1;
      this.eventBus?.emitDebug({
        type: status === 'confirmed'
          ? 'client.stale_lease.reconciled'
          : status === 'ambiguous' ? 'client.stale_lease.release_failed' : 'client.stale_lease.deferred',
        requestId: identity.requestId,
        clientId: identity.clientId,
        data: {
          trigger,
          leaseId: identity.leaseId,
          ownerServerInstanceId: identity.ownerServerInstanceId,
          classification: candidate.reason,
          status,
          reason: String(outcome?.reason || ''),
          message: String(outcome?.message || ''),
          attempts: entry.attempts,
        },
      });
      return { status, reason: String(outcome?.reason || ''), classification: candidate.reason };
    })();
    try {
      return await entry.inFlight;
    } finally {
      entry.inFlight = null;
    }
  }

  /**
   * Reconciles every provably stale client in one bounded pass and reports how
   * many leases became free. Used by request selection, so the first request
   * after a reconnect cannot race background reconciliation.
   */
  async reconcileClients(clients = []) {
    const stale = (Array.isArray(clients) ? clients : []).filter((client) => this.classify(client));
    if (!stale.length) return 0;
    const outcomes = await Promise.all(stale.map((client) => this.reconcileClient(client.id, 'request_selection')));
    return outcomes.filter((outcome) => outcome?.status === 'confirmed').length;
  }

  forgetClient(clientId = '') {
    const prefix = `${String(clientId || '')}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  #prune() {
    while (this.entries.size > this.retainedLeases) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }
}

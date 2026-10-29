import { PROVIDER_STATUS } from './providerCatalog.js';
import { probePort } from './providerProcess.js';

/**
 * Truthful status probes. A process existing is never enough: each provider
 * exposes its own readiness evidence, and the UI derives from that evidence.
 *
 * - ChatGPT Web: the bridge's own client registry (extension connection) plus
 *   the canonical selected client. Readiness is an extension/session fact.
 * - DeepSeek Web: FreeDeepseekAPI `/health` (service identity, saved-login
 *   state) and `/readyz` (an account that can actually serve right now).
 */

const DEFAULT_TIMEOUT_MS = 4_000;

async function fetchJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(Math.max(500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)),
      headers: { accept: 'application/json' },
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { ok: response.ok, status: response.status, body, error: '' };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: String(error?.message || error) };
  }
}

function accountCounts(accounts = []) {
  let ready = 0;
  let busy = 0;
  let cooling = 0;
  let noCredentials = 0;
  let disabled = 0;
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const hasCredentials = account?.token !== false && account?.ready !== false;
    const enabled = account?.enabled !== false;
    const isCooling = account?.cooldown === true || Number(account?.cooldown_remaining_sec) > 0;
    if (!hasCredentials) { noCredentials += 1; continue; }
    if (!enabled) { disabled += 1; continue; }
    if (isCooling) { cooling += 1; continue; }
    if (account?.busy === true) { busy += 1; continue; }
    ready += 1;
  }
  return {
    total: Array.isArray(accounts) ? accounts.length : 0,
    ready,
    busy,
    cooling,
    noCredentials,
    disabled,
    usable: ready + busy,
  };
}

/** Sanitized DeepSeek probe. Never returns tokens, cookies or auth file paths. */
export async function probeDeepSeekWeb({ port } = {}) {
  const target = Math.max(1, Math.min(65_535, Number(port) || 0));
  const portState = await probePort(target);
  if (portState === 'closed') {
    return {
      reachable: false,
      portState,
      port: target,
      healthy: false,
      serviceMatches: false,
      ready: false,
      detail: `nothing answers on 127.0.0.1:${target}`,
    };
  }
  if (portState !== 'open') {
    return {
      reachable: false,
      portState,
      port: target,
      healthy: false,
      serviceMatches: false,
      ready: false,
      detail: `127.0.0.1:${target} answered abnormally`,
    };
  }
  const origin = `http://127.0.0.1:${target}`;
  const health = await fetchJson(`${origin}/health`);
  if (!health.body || typeof health.body !== 'object') {
    return {
      reachable: true,
      portState,
      port: target,
      healthy: false,
      serviceMatches: false,
      ready: false,
      detail: `127.0.0.1:${target} is open but does not answer like FreeDeepseekAPI`,
    };
  }
  const service = String(health.body.service || '');
  const serviceMatches = service === 'FreeDeepseekAPI';
  if (!serviceMatches) {
    return {
      reachable: true,
      portState,
      port: target,
      healthy: false,
      serviceMatches: false,
      ready: false,
      detail: `port ${target} is owned by another service (${service || 'unknown'})`,
      observedService: service,
    };
  }
  const ready = await fetchJson(`${origin}/readyz`);
  const counts = accountCounts(health.body.accounts);
  const configReady = health.body.config_ready === true || counts.total > 0;
  const readyNow = ready.ok && ready.body?.ready === true;
  const detail = readyNow
    ? `${counts.usable}/${counts.total || counts.usable} saved login(s) can serve`
    : counts.total === 0
      ? 'no saved DeepSeek Web login'
      : counts.noCredentials > 0
        ? `${counts.noCredentials} saved login(s) have no credentials`
        : counts.cooling > 0
          ? `${counts.cooling} saved login(s) cooling down`
          : 'no saved login can serve right now';
  return {
    reachable: true,
    portState,
    port: target,
    origin,
    healthy: true,
    serviceMatches: true,
    service,
    version: String(health.body.version || ''),
    configReady,
    ready: readyNow,
    readyStatus: Number(ready.status) || 0,
    counts,
    models: Array.isArray(health.body.models) ? health.body.models.map(String).slice(0, 20) : [],
    inFlight: Math.max(0, Number(health.body.in_flight) || 0),
    detail,
  };
}

/** Whitelisted ChatGPT extension projection; clients carry no secrets. */
export function sanitizeBridgeClients(clients = []) {
  return (Array.isArray(clients) ? clients : []).map((client) => ({
    id: String(client?.id || ''),
    ready: client?.ready !== false,
    compatible: client?.compatible !== false && client?.compatibility?.compatible !== false,
    transport: String(client?.transport || ''),
    runtime: String(client?.runtime || ''),
    extensionVersion: String(client?.extensionVersion || client?.clientVersion || ''),
    contentVersion: String(client?.clientVersion || ''),
    url: String(client?.url || ''),
    sessionId: String(client?.session?.id || ''),
    sessionTitle: String(client?.session?.title || ''),
    quarantined: client?.quarantined === true,
    compatibilityMessage: String(client?.compatibility?.message || ''),
  }));
}

export function chatGptRows(health = {}) {
  const clients = sanitizeBridgeClients(health.clients);
  const compatible = clients.filter((client) => client.compatible && client.ready);
  const incompatible = clients.filter((client) => !client.compatible);
  const activeClient = health.activeClient ? sanitizeBridgeClients([health.activeClient])[0] : null;

  const extension = incompatible.length
    ? { state: PROVIDER_STATUS.ERROR, detail: incompatible[0].compatibilityMessage || 'extension update required' }
    : compatible.length
      ? {
        state: PROVIDER_STATUS.CONNECTED,
        detail: `${compatible.length} compatible tab${compatible.length === 1 ? '' : 's'}${compatible[0].extensionVersion ? ` · extension ${compatible[0].extensionVersion}` : ''}`,
      }
      : { state: PROVIDER_STATUS.WAITING_FOR_BROWSER, detail: 'no ChatGPT tab has the bridge extension connected' };

  let session;
  if (activeClient) {
    session = {
      state: PROVIDER_STATUS.READY,
      detail: `${activeClient.sessionTitle || activeClient.sessionId || activeClient.id}${activeClient.sessionId ? ` · session ${activeClient.sessionId.slice(0, 8)}` : ''}`,
    };
  } else if (health.needsSelection === true) {
    session = { state: PROVIDER_STATUS.CONNECTED, detail: 'multiple tabs connected; select one in the bridge (/tab <id>)' };
  } else if (compatible.length) {
    session = { state: PROVIDER_STATUS.STARTING, detail: 'connected tab has not been selected yet' };
  } else {
    session = { state: PROVIDER_STATUS.WAITING_FOR_BROWSER, detail: 'waiting for a connected ChatGPT tab' };
  }

  const overall = session.state === PROVIDER_STATUS.READY
    ? PROVIDER_STATUS.READY
    : extension.state === PROVIDER_STATUS.ERROR
      ? PROVIDER_STATUS.ERROR
      : extension.state === PROVIDER_STATUS.CONNECTED
        ? PROVIDER_STATUS.CONNECTED
        : PROVIDER_STATUS.WAITING_FOR_BROWSER;

  return {
    clients,
    rows: [
      { label: 'Browser Extension', state: extension.state, detail: extension.detail },
      { label: 'Session', state: session.state, detail: session.detail },
    ],
    overall,
  };
}

export function deepSeekRows(probe) {
  const counts = probe?.counts || accountCounts([]);
  if (!probe?.reachable) {
    return {
      rows: [
        { label: 'Browser/Session', state: PROVIDER_STATUS.STOPPED, detail: 'the proxy is not running, so the saved login is not in use' },
        { label: 'Status', state: PROVIDER_STATUS.STOPPED, detail: 'provider stopped' },
      ],
      overall: PROVIDER_STATUS.STOPPED,
    };
  }
  if (!probe.serviceMatches) {
    return {
      rows: [
        { label: 'Browser/Session', state: PROVIDER_STATUS.ERROR, detail: probe.detail || 'unknown service on the provider port' },
        { label: 'Status', state: PROVIDER_STATUS.ERROR, detail: 'port answered by a different service; it is not owned or terminated' },
      ],
      overall: PROVIDER_STATUS.ERROR,
    };
  }
  const session = counts.total === 0
    ? { state: PROVIDER_STATUS.WAITING_FOR_BROWSER, detail: 'no saved DeepSeek Web login (sign in once with npm run auth)' }
    : counts.noCredentials > 0 && counts.usable === 0
      ? { state: PROVIDER_STATUS.ERROR, detail: 'saved login has no credentials; sign in again' }
      : counts.usable > 0
        ? {
          state: PROVIDER_STATUS.CONNECTED,
          detail: `${counts.usable} usable login(s)${counts.busy ? ` · ${counts.busy} busy` : ''}${counts.cooling ? ` · ${counts.cooling} cooling` : ''}`,
        }
        : { state: PROVIDER_STATUS.CONNECTED, detail: `${counts.cooling} login(s) cooling down` };

  const status = probe.ready
    ? { state: PROVIDER_STATUS.READY, detail: probe.detail }
    : session.state === PROVIDER_STATUS.ERROR
      ? { state: PROVIDER_STATUS.ERROR, detail: probe.detail }
      : { state: PROVIDER_STATUS.WAITING_FOR_BROWSER, detail: probe.detail };

  const overall = status.state === PROVIDER_STATUS.READY
    ? PROVIDER_STATUS.READY
    : status.state === PROVIDER_STATUS.ERROR
      ? PROVIDER_STATUS.ERROR
      : session.state === PROVIDER_STATUS.WAITING_FOR_BROWSER || status.state === PROVIDER_STATUS.WAITING_FOR_BROWSER
        ? PROVIDER_STATUS.WAITING_FOR_BROWSER
        : PROVIDER_STATUS.CONNECTED;

  return {
    rows: [
      { label: 'Browser/Session', state: session.state, detail: session.detail },
      { label: 'Status', state: status.state, detail: status.detail },
    ],
    overall,
  };
}

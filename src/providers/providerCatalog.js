import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static catalogue of the providers this control center can operate.
 *
 * Every provider entry is descriptive, never executable input: the manager only
 * ever runs `<repoPath>/<entry>` with the fixed arguments below. Nothing from a
 * browser request can select an executable, an argument, a shell, or a working
 * directory that is not one of these declared shapes.
 */

const BRIDGE_REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const CATALOG = Object.freeze({
  'chatgpt-web': Object.freeze({
    id: 'chatgpt-web',
    label: 'ChatGPT Web',
    // The bridge service that serves this page. It is the only provider whose
    // "process" is allowed to be the current process.
    kind: 'bridge',
    summary: 'Local bridge server plus the Chrome extension driving a logged-in ChatGPT tab.',
    repoRoot: BRIDGE_REPO_ROOT,
    entry: 'src/index.js',
    args: Object.freeze(['--server']),
    defaultPort: 8080,
    logFile: 'chatgpt-bridge.log',
    // The extension reports itself over the bridge WebSocket; readiness is not a
    // port probe.
    healthKind: 'bridge',
    autostartSupported: true,
  }),
  'deepseek-web': Object.freeze({
    id: 'deepseek-web',
    label: 'DeepSeek Web',
    // FreeDeepseekAPI: a loopback OpenAI-compatible proxy in front of a saved
    // DeepSeek Web login (chat.deepseek.com). Discovered in the Kodevra
    // repository at integrations/FreeDeepseekAPI; it is a real local server with
    // a real saved browser session, and it exposes /health and /readyz.
    kind: 'local-proxy',
    summary: 'FreeDeepseekAPI loopback proxy in front of a saved DeepSeek Web browser session.',
    repoRoot: '',
    entry: 'server.js',
    args: Object.freeze([]),
    defaultPort: 9655,
    logFile: 'deepseek-web.log',
    healthKind: 'free-deepseek-api',
    healthServiceName: 'FreeDeepseekAPI',
    healthPath: '/health',
    readyPath: '/readyz',
    dashboardPath: '/',
    modelsPath: '/v1/models',
    signInCommand: 'npm run auth',
    doctorCommand: 'npm run doctor',
    // The saved login lives next to the proxy checkout.
    authFile: 'deepseek-auth.json',
    autostartSupported: true,
  }),
});

export const PROVIDER_IDS = Object.freeze(Object.keys(CATALOG));

export const PROVIDER_STATUS = Object.freeze({
  STOPPED: 'STOPPED',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  WAITING_FOR_BROWSER: 'WAITING_FOR_BROWSER',
  CONNECTED: 'CONNECTED',
  READY: 'READY',
  ERROR: 'ERROR',
  EXTERNAL_PROCESS: 'EXTERNAL_PROCESS',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
});

export function getProvider(id) {
  const key = String(id || '').trim();
  return Object.prototype.hasOwnProperty.call(CATALOG, key) ? CATALOG[key] : null;
}

export function isProviderId(id) {
  return Boolean(getProvider(id));
}

export function isProviderKind(id, kind) {
  return getProvider(id)?.kind === kind;
}

export function listProviders() {
  return PROVIDER_IDS.map((id) => CATALOG[id]);
}

export function providerEntryPath(provider, repoPath) {
  if (!provider?.entry) return '';
  return path.join(String(repoPath || ''), provider.entry);
}

/** True when `repoPath` looks like this provider's real checkout. */
export function looksLikeProviderRoot(provider, repoPath) {
  return Boolean(provider && repoPath && path.isAbsolute(String(repoPath)));
}

export function providerOrigin(port) {
  return `http://127.0.0.1:${Math.max(1, Math.min(65_535, Number(port) || 0))}`;
}

export const BRIDGE_REPO_PATH = BRIDGE_REPO_ROOT;

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getProvider, isProviderId, providerEntryPath, PROVIDER_IDS } from './providerCatalog.js';

/**
 * Persisted control-plane state for the provider manager.
 *
 * One local file holds the settings plus the exact ownership records of the
 * processes this manager started. Ownership is a durable fact, not an inference:
 * a pid only counts as ours while the record exists and its identity can still
 * be proved (see providerProcess.js). Nothing secret is stored here; tokens keep
 * living in .env and provider-owned auth files.
 */

const STATE_VERSION = 1;
const MIN_HEALTH_INTERVAL_MS = 1_000;
const MAX_HEALTH_INTERVAL_MS = 30_000;
const MIN_LOG_LINES = 50;
const MAX_LOG_LINES = 2_000;

function controlDir() {
  return path.join(config.dataDir, 'providers');
}

export function providerControlPath() {
  return path.join(controlDir(), 'control.json');
}

export function providerLogsDir() {
  return path.join(config.dataDir, 'logs');
}

export function providerLockDir() {
  return path.join(controlDir(), 'locks');
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {}
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizePort(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65_535) return fallback;
  return number;
}

function absolutePathOrEmpty(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return path.isAbsolute(text) ? path.normalize(text) : '';
}

function defaultState() {
  const providers = {};
  for (const id of PROVIDER_IDS) {
    const provider = getProvider(id);
    providers[id] = {
      autostart: false,
      // The bridge's own port is whatever this installation serves on, not the
      // catalogue's example port.
      port: provider.kind === 'bridge' ? (Number(config.port) || provider.defaultPort) : provider.defaultPort,
      repoPath: provider.kind === 'bridge' ? provider.repoRoot : '',
    };
  }
  return {
    version: STATE_VERSION,
    settings: {
      healthIntervalMs: 3_000,
      logRetentionLines: 400,
      providers,
    },
    owned: {},
    autostart: { installed: false, path: '', installedAt: 0, method: '' },
  };
}

function normalizeProviderSettings(id, raw = {}, fallback = {}) {
  const provider = getProvider(id);
  return {
    autostart: raw.autostart === true,
    port: normalizePort(raw.port, fallback.port ?? provider?.defaultPort ?? 0),
    repoPath: absolutePathOrEmpty(raw.repoPath ?? fallback.repoPath ?? ''),
  };
}

function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  const state = base;
  state.settings.healthIntervalMs = clampInt(
    raw?.settings?.healthIntervalMs,
    base.settings.healthIntervalMs,
    MIN_HEALTH_INTERVAL_MS,
    MAX_HEALTH_INTERVAL_MS,
  );
  state.settings.logRetentionLines = clampInt(
    raw?.settings?.logRetentionLines,
    base.settings.logRetentionLines,
    MIN_LOG_LINES,
    MAX_LOG_LINES,
  );
  for (const id of PROVIDER_IDS) {
    state.settings.providers[id] = normalizeProviderSettings(
      id,
      raw?.settings?.providers?.[id] || {},
      base.settings.providers[id],
    );
  }
  const owned = raw?.owned && typeof raw.owned === 'object' ? raw.owned : {};
  for (const id of PROVIDER_IDS) {
    const record = owned[id];
    if (!record || typeof record !== 'object') continue;
    const pid = Number(record.pid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    state.owned[id] = {
      pid,
      startedAt: Number(record.startedAt) || 0,
      port: normalizePort(record.port, state.settings.providers[id].port),
      cwd: absolutePathOrEmpty(record.cwd),
      entry: String(record.entry || ''),
      logPath: String(record.logPath || ''),
      source: String(record.source || 'manager'),
    };
  }
  const autostart = raw?.autostart && typeof raw.autostart === 'object' ? raw.autostart : {};
  state.autostart = {
    installed: autostart.installed === true,
    path: String(autostart.path || ''),
    installedAt: Number(autostart.installedAt) || 0,
    method: String(autostart.method || ''),
  };
  return state;
}

export function readProviderControl() {
  try {
    const raw = JSON.parse(fs.readFileSync(providerControlPath(), 'utf8'));
    return normalizeState(raw);
  } catch {
    return normalizeState(null);
  }
}

function writeProviderControl(state) {
  ensureDir(controlDir());
  const target = providerControlPath();
  const temporary = `${target}.${process.pid}.tmp`;
  const payload = JSON.stringify(normalizeState(state), null, 2);
  fs.writeFileSync(temporary, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);
  try { fs.chmodSync(target, 0o600); } catch {}
}

export function updateProviderControl(mutator) {
  const state = readProviderControl();
  const result = typeof mutator === 'function' ? mutator(state) : null;
  writeProviderControl(state);
  return { state, result };
}

/**
 * Environment overrides keep machine-specific paths out of source files.
 * They only apply to values the settings file leaves empty.
 */
function applyEnvironmentOverrides(state) {
  const deepseek = state.settings.providers['deepseek-web'];
  if (deepseek) {
    const envDir = absolutePathOrEmpty(process.env.BRIDGE_PROVIDER_DEEPSEEK_DIR || process.env.DEEPSEEK_API_DIR || '');
    if (envDir) deepseek.repoPath = envDir;
    const envPort = Number(process.env.BRIDGE_PROVIDER_DEEPSEEK_PORT || process.env.DEEPSEEK_API_PORT || 0);
    if (Number.isInteger(envPort) && envPort > 0) deepseek.port = normalizePort(envPort, deepseek.port);
  }
  return state;
}

export function readEffectiveProviderControl() {
  return applyEnvironmentOverrides(readProviderControl());
}

export function providerSettings(id) {
  if (!isProviderId(id)) return null;
  return readEffectiveProviderControl().settings.providers[id] || null;
}

export function providerLogPath(id) {
  const provider = getProvider(id);
  if (!provider) return '';
  return path.join(providerLogsDir(), provider.logFile);
}

/**
 * A configured provider root must exist and must contain the declared entry
 * file. That is the whole validation surface: the browser can never point the
 * manager at a different executable.
 */
export function validateProviderRoot(id, repoPath) {
  const provider = getProvider(id);
  if (!provider) return { ok: false, reason: 'unknown_provider' };
  const root = absolutePathOrEmpty(repoPath);
  if (!root) return { ok: false, reason: 'path_required' };
  let stat = null;
  try { stat = fs.statSync(root); } catch { return { ok: false, reason: 'path_missing', path: root }; }
  if (!stat.isDirectory()) return { ok: false, reason: 'not_a_directory', path: root };
  const entryPath = providerEntryPath(provider, root);
  if (!fs.existsSync(entryPath)) {
    return { ok: false, reason: 'entry_missing', path: root, entry: provider.entry };
  }
  return { ok: true, path: root, entryPath };
}

export function summarizeProviderSettings() {
  const state = readEffectiveProviderControl();
  const providers = {};
  for (const id of PROVIDER_IDS) {
    const provider = getProvider(id);
    const settings = state.settings.providers[id];
    const validation = validateProviderRoot(id, settings.repoPath);
    providers[id] = {
      autostart: settings.autostart,
      port: settings.port,
      repoPath: settings.repoPath,
      configured: validation.ok,
      configurationError: validation.ok ? '' : validation.reason,
      entry: provider.entry,
      defaultPort: provider.defaultPort,
    };
  }
  return {
    healthIntervalMs: state.settings.healthIntervalMs,
    logRetentionLines: state.settings.logRetentionLines,
    providers,
    autostart: state.autostart,
  };
}

/** Applies a settings patch coming from the local UI. Never accepts commands. */
export function saveProviderSettings(patch = {}) {
  const warnings = [];
  const { state } = updateProviderControl((draft) => {
    if (patch.healthIntervalMs != null) {
      draft.settings.healthIntervalMs = clampInt(patch.healthIntervalMs, draft.settings.healthIntervalMs, MIN_HEALTH_INTERVAL_MS, MAX_HEALTH_INTERVAL_MS);
    }
    if (patch.logRetentionLines != null) {
      draft.settings.logRetentionLines = clampInt(patch.logRetentionLines, draft.settings.logRetentionLines, MIN_LOG_LINES, MAX_LOG_LINES);
    }
    const incoming = patch.providers && typeof patch.providers === 'object' ? patch.providers : {};
    for (const id of Object.keys(incoming)) {
      if (!isProviderId(id)) {
        warnings.push(`Ignored unknown provider "${id}"`);
        continue;
      }
      const provider = getProvider(id);
      const next = incoming[id] || {};
      const current = draft.settings.providers[id];
      if (next.port != null) {
        const port = normalizePort(next.port, current.port);
        if (port !== Number(next.port)) warnings.push(`${provider.label}: port must be an integer between 1 and 65535`);
        current.port = port;
      }
      if (next.repoPath != null) {
        const repoPath = absolutePathOrEmpty(next.repoPath);
        if (String(next.repoPath).trim() && !repoPath) {
          warnings.push(`${provider.label}: path must be absolute`);
        } else {
          current.repoPath = repoPath;
        }
      }
      if (next.autostart != null) current.autostart = next.autostart === true;
    }
  });
  return { state: summarizeProviderSettings(), warnings };
}

export function setOwnedProcess(id, record) {
  if (!isProviderId(id)) return;
  updateProviderControl((draft) => {
    if (!record) delete draft.owned[id];
    else draft.owned[id] = { ...record };
  });
}

export function clearOwnedProcess(id) {
  setOwnedProcess(id, null);
}

export function ownedProcess(id) {
  if (!isProviderId(id)) return null;
  return readEffectiveProviderControl().owned[id] || null;
}

export function setAutostartRecord(record) {
  updateProviderControl((draft) => {
    draft.autostart = { ...draft.autostart, ...record };
  });
}

export function autostartRecord() {
  return readEffectiveProviderControl().autostart;
}

export function ensureProviderDirectories() {
  ensureDir(controlDir());
  ensureDir(providerLogsDir());
  ensureDir(providerLockDir());
}

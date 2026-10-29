import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { BRIDGE_REPO_PATH, PROVIDER_STATUS, getProvider, isProviderId, providerOrigin } from './providerCatalog.js';
import {
  clearOwnedProcess,
  providerLogPath,
  providerSettings,
  readEffectiveProviderControl,
  saveProviderSettings,
  setOwnedProcess,
  summarizeProviderSettings,
  validateProviderRoot,
} from './providerControlStore.js';
import {
  autostartStatus,
  installAutostart,
  launcherScriptPath,
  removeAutostart,
} from './providerAutostart.js';
import { chatGptRows, deepSeekRows, probeDeepSeekWeb } from './providerHealth.js';
import {
  isPidAlive,
  ownedProcessSummary,
  startProviderProcess,
  stopProviderProcess,
  tailProviderLog,
} from './providerProcess.js';

const START_FAILURES = Object.freeze({
  path_required: 'Set the FreeDeepseekAPI folder in Settings first.',
  path_missing: 'The configured FreeDeepseekAPI folder does not exist.',
  not_a_directory: 'The configured provider path is not a folder.',
  entry_missing: 'The configured folder does not contain server.js.',
  already_owned_and_running: 'This provider is already running under control-center ownership.',
  port_in_use_by_unknown_process: 'That port belongs to another process; it will not be terminated.',
  another_provider_operation_is_running: 'Another provider operation is already in progress.',
  process_exited_during_startup: 'The provider exited during startup; read its log.',
  spawn_failed: 'The provider process could not be spawned.',
});

const STOP_FAILURES = Object.freeze({
  not_owned: 'Only a process this control center started can be stopped.',
  ownership_unverified: 'The recorded process could not be proved to be this provider, so nothing was terminated.',
  pid_identity_mismatch: 'The pid no longer matches the provider this control center started.',
  process_did_not_exit: 'The provider did not exit after the stop request.',
});

function readableFailure(result, table) {
  if (!result || result.ok !== false) return result;
  const reason = String(result.error || '');
  return { ...result, message: result.message || table[reason] || reason || 'The operation was refused.' };
}

/**
 * One facade over the two providers this bridge can actually operate.
 *
 * It never invents capability: the ChatGPT provider's process is the bridge that
 * serves this page, and its readiness is the extension/session state. The
 * DeepSeek provider is the real FreeDeepseekAPI loopback proxy, whose readiness
 * is `/readyz` (an account that can serve), not the mere existence of a process.
 */
export class ProviderService {
  #bridge;
  #processInfo;
  #requestShutdown;
  #operations = new Map();

  constructor({ bridge = null, processInfo = {}, requestShutdown = null } = {}) {
    this.#bridge = bridge;
    this.#processInfo = processInfo || {};
    this.#requestShutdown = typeof requestShutdown === 'function' ? requestShutdown : null;
    // A bridge spawned by the launcher/restart path carries this marker, so it
    // records itself as manager-owned immediately. A bridge started by hand
    // stays EXTERNAL_PROCESS and is never terminated by this page.
    if (process.env.PROVIDER_MANAGED_BY === 'chatgpt-bridge-provider-control') {
      try {
        setOwnedProcess('chatgpt-web', {
          pid: process.pid,
          startedAt: Number(this.#processInfo.startedAt) || Date.now(),
          port: Number(config.port) || 0,
          cwd: BRIDGE_REPO_PATH,
          entry: path.join(BRIDGE_REPO_PATH, 'src', 'index.js'),
          logPath: providerLogPath('chatgpt-web'),
          source: 'autostart',
        });
      } catch {}
    }
  }

  #operationOf(id) {
    const operation = this.#operations.get(id);
    if (!operation) return null;
    return { action: operation.action, startedAt: operation.startedAt, ageMs: Date.now() - operation.startedAt };
  }

  async #chatGptProvider(settings) {
    const health = this.#bridge?.health?.() || { clients: [] };
    const served = chatGptRows(health);
    const ownership = ownedProcessSummary('chatgpt-web');
    const owned = Boolean(ownership.record && ownership.record.pid === process.pid);
    const port = Number(config.port) || 0;
    const configuredPort = Number(settings?.port) || port;
    const notes = [];
    if (configuredPort !== port) {
      notes.push(`Settings say port ${configuredPort}, but the bridge serving this page listens on ${port}.`);
    }
    if (ownership.record && !owned && !ownership.alive) {
      // The recorded bridge died (crash or a Stop). Drop the record instead of
      // reporting a stale ownership claim forever.
      try { clearOwnedProcess('chatgpt-web'); } catch {}
    }
    return {
      state: served.overall,
      process: {
        state: owned ? PROVIDER_STATUS.RUNNING : PROVIDER_STATUS.EXTERNAL_PROCESS,
        owned,
        pid: process.pid,
        port,
        startedAt: Number(this.#processInfo.startedAt) || 0,
        detail: owned
          ? `pid ${process.pid} · started by this control center`
          : `pid ${process.pid} · started outside the control center (health monitored, not owned)`,
        logPath: providerLogPath('chatgpt-web'),
      },
      rows: served.rows,
      clients: served.clients,
      controls: {
        start: {
          enabled: false,
          reason: 'the bridge is already serving this page, so there is nothing to start',
        },
        stop: {
          enabled: Boolean(this.#requestShutdown),
          reason: this.#requestShutdown
            ? 'stops this bridge process: the page disconnects and in-flight requests fail'
            : 'graceful shutdown is not wired into this runtime',
        },
        restart: {
          enabled: Boolean(this.#requestShutdown),
          reason: this.#requestShutdown
            ? 'restarts the bridge through the detached launcher; this page reconnects in a few seconds'
            : 'graceful shutdown is not wired into this runtime',
        },
        logs: { enabled: true, reason: '' },
      },
      notes,
    };
  }

  async #deepSeekProvider(settings) {
    const validation = validateProviderRoot('deepseek-web', settings?.repoPath);
    const port = Number(settings?.port) || 9655;
    const origin = providerOrigin(port);
    const notes = [];
    if (!validation.ok) {
      const reasonText = {
        path_required: 'the FreeDeepseekAPI folder is not configured yet',
        path_missing: 'the configured FreeDeepseekAPI folder does not exist',
        not_a_directory: 'the configured path is not a folder',
        entry_missing: 'the configured folder does not contain server.js',
      }[validation.reason] || 'the provider path is not usable';
      return {
        state: PROVIDER_STATUS.NOT_CONFIGURED,
        configured: false,
        process: {
          state: PROVIDER_STATUS.NOT_CONFIGURED,
          owned: false,
          pid: 0,
          port,
          startedAt: 0,
          detail: reasonText,
          logPath: providerLogPath('deepseek-web'),
        },
        probe: null,
        rows: [
          { label: 'Browser/Session', state: PROVIDER_STATUS.NOT_CONFIGURED, detail: 'unknown until the provider path is set' },
          { label: 'Status', state: PROVIDER_STATUS.NOT_CONFIGURED, detail: reasonText },
        ],
        controls: {
          start: { enabled: false, reason: 'set the FreeDeepseekAPI folder in Settings first' },
          stop: { enabled: false, reason: 'nothing is owned' },
          restart: { enabled: false, reason: 'nothing is owned' },
          logs: { enabled: true, reason: '' },
        },
        notes,
      };
    }

    const probe = await probeDeepSeekWeb({ port });
    const ownership = ownedProcessSummary('deepseek-web');
    const record = ownership.record;
    const alive = Boolean(record && isPidAlive(record.pid));
    const owned = Boolean(record && alive);

    let processState;
    let detail;
    if (probe.serviceMatches) {
      processState = owned ? PROVIDER_STATUS.RUNNING : PROVIDER_STATUS.EXTERNAL_PROCESS;
      detail = owned
        ? `pid ${record.pid} · started by this control center`
        : `started outside the control center (health monitored, not owned)`;
    } else if (probe.portState === 'open') {
      processState = PROVIDER_STATUS.ERROR;
      detail = probe.detail || `port ${port} is owned by another service`;
      notes.push(`Refusing to touch port ${port}: it answers, but not as ${probe.service || 'FreeDeepseekAPI'}.`);
    } else if (alive) {
      processState = PROVIDER_STATUS.STARTING;
      detail = `pid ${record.pid} is running, the proxy is not answering yet`;
    } else {
      processState = PROVIDER_STATUS.STOPPED;
      detail = `nothing answers on ${origin}`;
    }

    const derived = deepSeekRows(probe);
    const overall = processState === PROVIDER_STATUS.ERROR
      ? PROVIDER_STATUS.ERROR
      : processState === PROVIDER_STATUS.NOT_CONFIGURED
        ? PROVIDER_STATUS.NOT_CONFIGURED
        : processState === PROVIDER_STATUS.STOPPED
          ? PROVIDER_STATUS.STOPPED
          : derived.overall;

    const portIsForeign = probe.portState === 'open' && !probe.serviceMatches;
    const canStart = !alive && !portIsForeign && processState !== PROVIDER_STATUS.RUNNING && processState !== PROVIDER_STATUS.EXTERNAL_PROCESS;
    const canStop = owned;
    return {
      state: overall,
      configured: true,
      process: {
        state: processState,
        owned: owned || (probe.serviceMatches && processState === PROVIDER_STATUS.EXTERNAL_PROCESS),
        pid: record?.pid || 0,
        port,
        startedAt: Number(record?.startedAt) || 0,
        detail,
        logPath: providerLogPath('deepseek-web'),
        origin,
      },
      probe: {
        reachable: probe.reachable,
        service: probe.service || '',
        version: probe.version || '',
        configReady: probe.configReady === true,
        ready: probe.ready === true,
        counts: probe.counts || null,
        models: probe.models || [],
        inFlight: probe.inFlight || 0,
      },
      rows: derived.rows,
      controls: {
        start: {
          enabled: canStart,
          reason: canStart
            ? ''
            : portIsForeign
              ? `port ${port} is owned by another process; it will not be terminated`
              : 'the provider process is already running',
        },
        stop: {
          enabled: canStop,
          reason: canStop ? '' : 'only a process this control center started can be stopped',
        },
        restart: {
          enabled: canStop,
          reason: canStop ? '' : 'restart needs an owned process; an external one is never terminated',
        },
        logs: { enabled: true, reason: '' },
      },
      notes,
    };
  }

  async statusFor(id) {
    const provider = getProvider(id);
    if (!provider) return null;
    const settings = providerSettings(id);
    const base = {
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      summary: provider.summary,
      description: provider.summary,
      origin: provider.kind === 'bridge' ? `http://127.0.0.1:${config.port}` : providerOrigin(settings?.port || provider.defaultPort),
      operation: this.#operationOf(id),
      setup: provider.kind === 'bridge'
        ? {
          repoPath: BRIDGE_REPO_PATH,
          configured: true,
          configurationError: '',
          entry: provider.entry,
          port: Number(config.port) || 0,
          settingsPort: Number(settings?.port) || 0,
          settingsPath: path.join(config.dataDir, 'providers', 'control.json'),
          launcher: launcherScriptPath(),
        }
        : {
          repoPath: settings?.repoPath || '',
          configured: validateProviderRoot(id, settings?.repoPath).ok,
          configurationError: validateProviderRoot(id, settings?.repoPath).reason || '',
          entry: provider.entry,
          port: Number(settings?.port) || provider.defaultPort,
          dashboardUrl: `${providerOrigin(settings?.port || provider.defaultPort)}${provider.dashboardPath}`,
          modelsUrl: `${providerOrigin(settings?.port || provider.defaultPort)}${provider.modelsPath}`,
          signInCommand: provider.signInCommand,
          doctorCommand: provider.doctorCommand,
          authFile: path.join(settings?.repoPath || '', provider.authFile || ''),
        },
    };
    const detail = provider.kind === 'bridge'
      ? await this.#chatGptProvider(settings)
      : await this.#deepSeekProvider(settings);
    return { ...base, ...detail };
  }

  async status() {
    const providers = [];
    for (const id of ['chatgpt-web', 'deepseek-web']) {
      const status = await this.statusFor(id);
      if (status) providers.push(status);
    }
    const settings = summarizeProviderSettings();
    return {
      ok: true,
      generatedAt: Date.now(),
      refreshMs: settings.healthIntervalMs,
      providers,
      settings,
      autostart: { ...autostartStatus(), perProvider: settings.providers },
    };
  }

  async start(id) {
    const provider = getProvider(id);
    if (!provider) return { ok: false, error: 'unknown_provider' };
    if (this.#operations.has(id)) return { ok: false, error: 'operation_in_progress' };
    if (provider.kind === 'bridge') {
      return {
        ok: false,
        error: 'bridge_serves_this_page',
        message: 'This page is served by the bridge process itself. Use Restart to relaunch it, or enable auto-start so it starts at login.',
      };
    }
    this.#operations.set(id, { action: 'start', startedAt: Date.now() });
    try {
      const settings = providerSettings(id);
      const result = await startProviderProcess({
        id,
        settings,
        probe: async ({ port }) => probeDeepSeekWeb({ port }),
        source: 'control-center',
      });
      return readableFailure({ ok: Boolean(result.started || result.adopted), ...result }, START_FAILURES);
    } finally {
      this.#operations.delete(id);
    }
  }

  async stop(id) {
    const provider = getProvider(id);
    if (!provider) return { ok: false, error: 'unknown_provider' };
    if (this.#operations.has(id)) return { ok: false, error: 'operation_in_progress' };
    if (provider.kind === 'bridge') {
      if (!this.#requestShutdown) return { ok: false, error: 'graceful_shutdown_unavailable' };
      setTimeout(() => { try { this.#requestShutdown(); } catch {} }, 300).unref?.();
      return {
        ok: true,
        stopping: true,
        message: 'The bridge is stopping. This page will disconnect; auto-start brings it back at the next login.',
      };
    }
    this.#operations.set(id, { action: 'stop', startedAt: Date.now() });
    try {
      const result = await stopProviderProcess(id);
      return readableFailure({ ok: Boolean(result.stopped), ...result }, STOP_FAILURES);
    } finally {
      this.#operations.delete(id);
    }
  }

  async restart(id) {
    const provider = getProvider(id);
    if (!provider) return { ok: false, error: 'unknown_provider' };
    if (this.#operations.has(id)) return { ok: false, error: 'operation_in_progress' };
    if (provider.kind === 'bridge') {
      if (!this.#requestShutdown) return { ok: false, error: 'graceful_shutdown_unavailable' };
      const script = launcherScriptPath();
      try {
        const child = spawn(process.execPath, [script, '--restart-bridge', '--pid', String(process.pid)], {
          cwd: BRIDGE_REPO_PATH,
          env: { ...process.env, PROVIDER_MANAGED_BY: 'chatgpt-bridge-provider-control' },
          detached: true,
          windowsHide: true,
          stdio: 'ignore',
        });
        child.unref();
      } catch (error) {
        return { ok: false, error: 'relauncher_failed', message: error?.message || String(error) };
      }
      setTimeout(() => { try { this.#requestShutdown(); } catch {} }, 600).unref?.();
      return {
        ok: true,
        restarting: true,
        message: 'The bridge is restarting through the detached launcher. This page reconnects in a few seconds.',
      };
    }
    this.#operations.set(id, { action: 'restart', startedAt: Date.now() });
    try {
      const current = ownedProcessSummary(id);
      if (!current.owned || !current.alive) {
        const startResult = await startProviderProcess({
          id,
          settings: providerSettings(id),
          probe: async ({ port }) => probeDeepSeekWeb({ port }),
          source: 'control-center',
        });
        return readableFailure(
          { ok: Boolean(startResult.started || startResult.adopted), restartMode: 'start_only', ...startResult },
          START_FAILURES,
        );
      }
      const stopped = await stopProviderProcess(id);
      if (!stopped.stopped) return readableFailure({ ok: false, error: stopped.error || 'stop_failed', ...stopped }, STOP_FAILURES);
      const started = await startProviderProcess({
        id,
        settings: providerSettings(id),
        probe: async ({ port }) => probeDeepSeekWeb({ port }),
        source: 'control-center',
      });
      return { ok: Boolean(started.started), restartMode: 'stop_then_start', stopped, started };
    } finally {
      this.#operations.delete(id);
    }
  }

  logs(id, lines = null) {
    const provider = getProvider(id);
    if (!provider) return { ok: false, error: 'unknown_provider', lines: [] };
    const limit = lines == null ? readEffectiveProviderControl().settings.logRetentionLines : lines;
    return tailProviderLog(id, limit);
  }

  settings() {
    return summarizeProviderSettings();
  }

  saveSettings(patch) {
    return saveProviderSettings(patch);
  }

  autostart() {
    return autostartStatus();
  }

  installAutostart() {
    return installAutostart();
  }

  removeAutostart() {
    return removeAutostart();
  }

  isKnownProvider(id) {
    return isProviderId(id);
  }
}

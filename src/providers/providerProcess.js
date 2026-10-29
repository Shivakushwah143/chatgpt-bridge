import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getProvider, providerEntryPath } from './providerCatalog.js';
import {
  clearOwnedProcess,
  ensureProviderDirectories,
  ownedProcess,
  providerLockDir,
  providerLogPath,
  setOwnedProcess,
  validateProviderRoot,
} from './providerControlStore.js';

const LOCK_STALE_MS = 60_000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_TAIL_READ_BYTES = 512 * 1024;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function isPidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Best-effort command line for a pid. Used only to prove that a recorded pid is
 * still the process this manager started before any kill. A failure returns ''
 * and the caller must then refuse to terminate anything.
 */
export async function readProcessCommandLine(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return '';
  if (process.platform !== 'win32') {
    try {
      return fs.readFileSync(`/proc/${value}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch {
      return '';
    }
  }
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (text) => {
      if (settled) return;
      settled = true;
      resolve(String(text || '').trim());
    };
    try {
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${value}" -ErrorAction SilentlyContinue).CommandLine`,
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout?.on('data', (chunk) => { output += String(chunk); });
      child.on('error', () => finish(''));
      child.on('close', () => finish(output));
      setTimeout(() => { try { child.kill(); } catch {} finish(output); }, 5_000).unref?.();
    } catch {
      finish('');
    }
  });
}

export async function probePort(port, { host = '127.0.0.1', timeoutMs = 700 } = {}) {
  const value = Number(port);
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) return 'closed';
  return await new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(result);
    };
    socket.setTimeout(Math.max(150, Number(timeoutMs) || 700));
    socket.once('connect', () => finish('open'));
    socket.once('timeout', () => finish('closed'));
    socket.once('error', (error) => finish(error?.code === 'ECONNREFUSED' ? 'closed' : 'unknown'));
    try { socket.connect(value, host); } catch { finish('unknown'); }
  });
}

function rotateLog(logPath) {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size < LOG_MAX_BYTES) return;
    const previous = `${logPath}.1`;
    try { fs.rmSync(previous, { force: true }); } catch {}
    fs.renameSync(logPath, previous);
  } catch {}
}

function openLogFile(logPath) {
  ensureProviderDirectories();
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 }); } catch {}
  rotateLog(logPath);
  return fs.openSync(logPath, 'a', 0o600);
}

export function redactLogText(text = '') {
  return String(text)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g, 'Bearer <redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}\b/g, '<redacted-jwt>')
    .replace(/((?:api[_-]?token|bridge[_-]?token|proxy[_-]?api[_-]?key|authorization|cookie|set-cookie|secret|password|token)\s*[:=]\s*)(?!<redacted>)([^\s,;"']{4,})/gi, '$1<redacted>');
}

export function tailProviderLog(id, lines = 400) {
  const provider = getProvider(id);
  if (!provider) return { ok: false, reason: 'unknown_provider', lines: [] };
  const logPath = providerLogPath(id);
  let stat = null;
  try { stat = fs.statSync(logPath); } catch {
    return { ok: true, logPath, exists: false, lines: [], bytes: 0 };
  }
  const requested = Math.max(1, Math.min(2_000, Math.round(Number(lines) || 400)));
  const readBytes = Math.min(stat.size, LOG_TAIL_READ_BYTES);
  let text = '';
  try {
    const fd = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(readBytes);
      fs.readSync(fd, buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return { ok: false, reason: 'log_read_failed', message: error?.message || String(error), logPath, lines: [] };
  }
  if (readBytes < stat.size) {
    const firstBreak = text.indexOf('\n');
    if (firstBreak >= 0) text = text.slice(firstBreak + 1);
  }
  const all = text.split(/\r?\n/);
  const tail = all.slice(Math.max(0, all.length - requested));
  return {
    ok: true,
    logPath,
    exists: true,
    bytes: stat.size,
    updatedAt: stat.mtimeMs,
    lines: tail.map((line) => redactLogText(line)),
  };
}

function readLockFile(file) {
  try {
    return { file, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { file, pid: 0, at: 0 };
  }
}

function acquireLock(id, owner = '') {
  ensureProviderDirectories();
  const file = path.join(providerLockDir(), `${id}.lock`);
  const existing = readLockFile(file);
  const fresh = Number(existing.at) > 0 && Date.now() - Number(existing.at) < LOCK_STALE_MS;
  if (fresh && (existing.pid === process.pid || isPidAlive(existing.pid))) {
    return { ok: false, reason: 'another_provider_operation_is_running', holder: { pid: existing.pid, at: existing.at } };
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), owner }), { mode: 0o600 });
  } catch {}
  return { ok: true, file };
}

function releaseLock(lock) {
  if (!lock?.file) return;
  const current = readLockFile(lock.file);
  if (current.pid && current.pid !== process.pid) return;
  try { fs.rmSync(lock.file, { force: true }); } catch {}
}

export function resolveStartSpec(id, settings = {}) {
  const provider = getProvider(id);
  if (!provider) return { ok: false, reason: 'unknown_provider' };
  const validation = validateProviderRoot(id, settings.repoPath);
  if (!validation.ok) return { ok: false, reason: validation.reason, path: settings.repoPath || '' };
  const port = Math.max(1, Math.min(65_535, Number(settings.port) || provider.defaultPort));
  const env = {
    ...process.env,
    // Bind providers to loopback only, whatever the caller environment says.
    HOST: '127.0.0.1',
    PORT: String(port),
  };
  if (provider.kind === 'local-proxy') {
    env.NON_INTERACTIVE = '1';
    env.SKIP_ACCOUNT_MENU = '1';
  }
  // The marker lets the started process recognise itself as manager-started, so
  // ownership is a fact from its first second instead of an inference.
  env.PROVIDER_MANAGED_BY = 'chatgpt-bridge-provider-control';
  return {
    ok: true,
    provider,
    cwd: validation.path,
    entryPath: providerEntryPath(provider, validation.path),
    args: [...provider.args],
    port,
    env,
  };
}

/**
 * Starts one provider as an owned, detached, windowless process.
 * `probe` must return { healthy, serviceMatches } for the configured port.
 */
export async function startProviderProcess({ id, settings, probe, source = 'manager', waitMs = 20_000 }) {
  const lock = acquireLock(id, 'start');
  if (!lock.ok) return { started: false, error: lock.reason, holder: lock.holder };
  try {
    const spec = resolveStartSpec(id, settings);
    if (!spec.ok) return { started: false, error: spec.reason, path: spec.path || '' };

    const existing = ownedProcess(id);
    if (existing && isPidAlive(existing.pid)) {
      return { started: false, error: 'already_owned_and_running', pid: existing.pid };
    }
    if (existing) clearOwnedProcess(id);

    const before = await probe({ port: spec.port });
    if (before?.healthy) {
      return { started: false, adopted: true, external: true, port: spec.port, detail: 'a healthy provider already answers on this port' };
    }
    if (before?.portState === 'open') {
      return { started: false, error: 'port_in_use_by_unknown_process', port: spec.port };
    }

    const logPath = providerLogPath(id);
    const fd = openLogFile(logPath);
    let child = null;
    try {
      child = spawn(process.execPath, [spec.entryPath, ...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
      });
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
    if (!child?.pid) return { started: false, error: 'spawn_failed' };
    child.unref();

    setOwnedProcess(id, {
      pid: child.pid,
      startedAt: Date.now(),
      port: spec.port,
      cwd: spec.cwd,
      entry: spec.entryPath,
      logPath,
      source,
    });

    const startedAt = Date.now();
    let last = null;
    while (Date.now() - startedAt < Math.max(1_000, Number(waitMs) || 20_000)) {
      await sleep(400);
      if (!isPidAlive(child.pid)) {
        clearOwnedProcess(id);
        return { started: false, error: 'process_exited_during_startup', pid: child.pid, logPath };
      }
      last = await probe({ port: spec.port });
      if (last?.healthy) {
        return { started: true, pid: child.pid, port: spec.port, healthy: true, logPath, probe: last };
      }
    }
    return { started: true, pid: child.pid, port: spec.port, healthy: false, logPath, probe: last };
  } finally {
    releaseLock(lock);
  }
}

/**
 * Ownership proof. Returns ok only when the recorded pid can still be shown to
 * be the process this manager started; anything else must not be terminated.
 */
export async function verifyProcessOwnership(id, record) {
  const provider = getProvider(id);
  if (!provider) return { ok: false, reason: 'unknown_provider' };
  if (!record?.pid) return { ok: false, reason: 'not_owned' };
  if (!isPidAlive(record.pid)) return { ok: false, reason: 'not_running' };
  if (record.pid === process.pid) {
    return provider.kind === 'bridge'
      ? { ok: true, reason: 'current_process' }
      : { ok: false, reason: 'refuses_to_terminate_manager_process' };
  }
  const commandLine = await readProcessCommandLine(record.pid);
  if (!commandLine) return { ok: false, reason: 'ownership_unverified' };
  if (record.entry && !commandLine.includes(record.entry)) return { ok: false, reason: 'pid_identity_mismatch' };
  return { ok: true, reason: 'command_line', commandLine: redactLogText(commandLine) };
}

export async function stopProviderProcess(id, { timeoutMs = 8_000 } = {}) {
  const provider = getProvider(id);
  if (!provider) return { stopped: false, error: 'unknown_provider' };
  const record = ownedProcess(id);
  if (!record) return { stopped: false, error: 'not_owned' };
  const ownership = await verifyProcessOwnership(id, record);
  if (!ownership.ok) {
    if (ownership.reason === 'not_running') {
      clearOwnedProcess(id);
      return { stopped: false, error: 'already_stopped', pid: record.pid };
    }
    return { stopped: false, error: ownership.reason, pid: record.pid };
  }
  if (record.pid === process.pid) {
    return { stopped: false, error: 'current_process_requires_graceful_shutdown', pid: record.pid };
  }

  const kill = (signalMode) => {
    if (process.platform === 'win32') {
      const args = ['/PID', String(record.pid), '/T'];
      if (signalMode === 'force') args.push('/F');
      try { spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }).unref(); } catch {}
      return;
    }
    try { process.kill(record.pid, signalMode === 'force' ? 'SIGKILL' : 'SIGTERM'); } catch {}
  };

  // A windowless detached Node process has no window to receive a polite
  // taskkill and no console handler for SIGTERM, so the polite phase would just
  // burn the whole timeout. On Windows, terminate the verified pid tree directly.
  if (process.platform === 'win32') {
    kill('force');
    const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || 8_000);
    while (Date.now() < deadline) {
      await sleep(150);
      if (!isPidAlive(record.pid)) {
        clearOwnedProcess(id);
        return { stopped: true, pid: record.pid, forced: true };
      }
    }
    return { stopped: false, pid: record.pid, forced: true, error: 'process_did_not_exit' };
  }

  kill('polite');
  const startedAt = Date.now();
  while (Date.now() - startedAt < Math.max(1_000, Number(timeoutMs) || 8_000)) {
    await sleep(250);
    if (!isPidAlive(record.pid)) {
      clearOwnedProcess(id);
      return { stopped: true, pid: record.pid, forced: false };
    }
  }
  kill('force');
  await sleep(400);
  const alive = isPidAlive(record.pid);
  if (!alive) clearOwnedProcess(id);
  return { stopped: !alive, pid: record.pid, forced: true, error: alive ? 'process_did_not_exit' : undefined };
}

export function ownedProcessSummary(id) {
  const record = ownedProcess(id);
  if (!record) return { owned: false, record: null, alive: false };
  return { owned: true, record, alive: isPidAlive(record.pid) };
}

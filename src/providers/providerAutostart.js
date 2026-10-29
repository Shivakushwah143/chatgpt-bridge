import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BRIDGE_REPO_PATH } from './providerCatalog.js';
import { autostartRecord, providerControlPath, setAutostartRecord } from './providerControlStore.js';

/**
 * Optional per-user auto-start.
 *
 * The mechanism is the simplest one this project can support without admin
 * rights on Windows: a hidden VBScript launcher in the current user's Startup
 * folder. It runs the provider auto-start CLI, which checks every provider's
 * real health before it starts anything, so a login never spawns duplicates.
 * No Windows Service and no elevation are involved.
 *
 * Non-Windows hosts get a clear "unsupported" answer instead of a fake toggle.
 */

const MARKER = "' chatgpt-bridge provider control center (managed; remove it from the Providers page)";
const LAUNCHER_SCRIPT = path.join(BRIDGE_REPO_PATH, 'scripts', 'provider-autostart.js');

export function autostartSupported() {
  return process.platform === 'win32';
}

export function startupFolderPath() {
  const appData = String(process.env.APPDATA || '').trim() || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function startupLauncherPath() {
  return path.join(startupFolderPath(), 'chatgpt-bridge-providers.vbs');
}

export function launcherScriptPath() {
  return LAUNCHER_SCRIPT;
}

function quoteVbs(value) {
  return String(value || '').replace(/"/g, '""');
}

export function buildLauncherScript() {
  const nodePath = process.execPath;
  const script = LAUNCHER_SCRIPT;
  return [
    MARKER,
    "' Starts the provider services at logon with no terminal window.",
    "' It is idempotent: an already healthy provider is never started twice.",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = "${quoteVbs(BRIDGE_REPO_PATH)}"`,
    `shell.Run """${quoteVbs(nodePath)}"" ""${quoteVbs(script)}"" --run", 0, False`,
    '',
  ].join('\r\n');
}

export function autostartStatus() {
  const supported = autostartSupported();
  const launcherPath = startupLauncherPath();
  const record = autostartRecord();
  let installed = false;
  let error = '';
  let markerMatches = false;
  if (supported) {
    try {
      const text = fs.readFileSync(launcherPath, 'utf8');
      markerMatches = text.includes(MARKER);
      installed = markerMatches;
      if (!markerMatches) error = 'the startup entry exists but was not created by this control center';
    } catch {
      installed = false;
    }
  }
  return {
    supported,
    method: 'startup-folder-vbs',
    hidden: true,
    requiresAdmin: false,
    installed,
    markerMatches,
    path: launcherPath,
    script: LAUNCHER_SCRIPT,
    nodePath: process.execPath,
    repoPath: BRIDGE_REPO_PATH,
    installedAt: Number(record.installedAt) || 0,
    recordPath: providerControlPath(),
    error: supported ? error : 'auto-start is implemented for the Windows per-user Startup folder only',
  };
}

export function installAutostart() {
  if (!autostartSupported()) {
    const error = new Error('Auto-start is implemented for Windows (per-user Startup folder) only');
    error.code = 'AUTOSTART_UNSUPPORTED';
    throw error;
  }
  if (!fs.existsSync(LAUNCHER_SCRIPT)) {
    const error = new Error(`Auto-start launcher script is missing: ${LAUNCHER_SCRIPT}`);
    error.code = 'AUTOSTART_SCRIPT_MISSING';
    throw error;
  }
  const target = startupLauncherPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    // Never overwrite a file this control center did not create.
    const existing = fs.readFileSync(target, 'utf8');
    if (!existing.includes(MARKER)) {
      const error = new Error(`Refusing to overwrite a foreign startup entry: ${target}`);
      error.code = 'AUTOSTART_FOREIGN_ENTRY';
      throw error;
    }
  }
  fs.writeFileSync(target, buildLauncherScript(), { encoding: 'utf8' });
  setAutostartRecord({
    installed: true,
    path: target,
    installedAt: Date.now(),
    method: 'startup-folder-vbs',
  });
  return autostartStatus();
}

export function removeAutostart() {
  if (!autostartSupported()) {
    const error = new Error('Auto-start is implemented for Windows (per-user Startup folder) only');
    error.code = 'AUTOSTART_UNSUPPORTED';
    throw error;
  }
  const target = startupLauncherPath();
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, 'utf8');
    if (!existing.includes(MARKER)) {
      const error = new Error(`Refusing to delete a startup entry this control center did not create: ${target}`);
      error.code = 'AUTOSTART_FOREIGN_ENTRY';
      throw error;
    }
    fs.rmSync(target, { force: true });
  }
  setAutostartRecord({ installed: false, path: '', installedAt: 0, method: '' });
  return autostartStatus();
}

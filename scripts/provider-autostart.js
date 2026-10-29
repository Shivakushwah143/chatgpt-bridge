#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { BRIDGE_REPO_PATH, providerOrigin } from '../src/providers/providerCatalog.js';
import {
  ensureProviderDirectories,
  providerLogsDir,
  readEffectiveProviderControl,
  setOwnedProcess,
} from '../src/providers/providerControlStore.js';
import { isPidAlive, probePort, sleep, startProviderProcess } from '../src/providers/providerProcess.js';
import { probeDeepSeekWeb } from '../src/providers/providerHealth.js';

/**
 * Provider auto-start runner.
 *
 * Invoked at logon by the hidden per-user Startup launcher, and by the control
 * center's bridge Restart. It is deliberately idempotent: it never starts a
 * provider whose real health already answers, so a login (or a double click)
 * cannot create duplicates.
 *
 *   node scripts/provider-autostart.js --run
 *   node scripts/provider-autostart.js --restart-bridge --pid 1234
 *   node scripts/provider-autostart.js --status
 */

const MANAGED_ENV = 'chatgpt-bridge-provider-control';

function usage() {
  return [
    'Usage: node scripts/provider-autostart.js [--run] [--status] [--restart-bridge --pid <pid>]',
    '',
    '  --run                   start the providers whose auto-start setting is enabled',
    '  --restart-bridge --pid  wait for that bridge pid to exit, then start it again',
    '  --status                probe both providers and print JSON (no changes)',
  ].join('\n');
}

/** The bridge is healthy when its own JSON status answers on its port. */
async function probeBridge({ port }) {
  const portState = await probePort(port);
  if (portState !== 'open') return { healthy: false, portState };
  try {
    const response = await fetch(`${providerOrigin(port)}/setup/status`, {
      signal: AbortSignal.timeout(2500),
      headers: { accept: 'application/json' },
    });
    const body = await response.json().catch(() => null);
    const healthy = Boolean(body && (body.bridgeVersion || body.setupUrl || body.ok === true));
    return {
      healthy,
      portState,
      serviceMatches: healthy,
      detail: healthy ? 'the bridge answers on this port' : 'the port answers, but not as this bridge',
    };
  } catch (error) {
    return { healthy: false, portState, serviceMatches: false, detail: String(error?.message || error) };
  }
}

function appendRunLog(line) {
  try {
    ensureProviderDirectories();
    const file = path.join(providerLogsDir(), 'provider-autostart.log');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {}
}

function startBridge(settings) {
  return startProviderProcess({
    id: 'chatgpt-web',
    settings,
    probe: probeBridge,
    source: 'autostart',
  });
}

async function runAutoStart() {
  const state = readEffectiveProviderControl();
  const started = [];
  for (const id of ['chatgpt-web', 'deepseek-web']) {
    const settings = state.settings.providers[id];
    if (!settings?.autostart) {
      started.push({ id, action: 'skipped', reason: 'auto-start is disabled for this provider' });
      continue;
    }
    const result = id === 'chatgpt-web'
      ? await startBridge(settings)
      : await startProviderProcess({
        id,
        settings,
        probe: async ({ port }) => probeDeepSeekWeb({ port }),
        source: 'autostart',
      });
    const action = result.started
      ? 'started'
      : result.adopted
        ? 'already_healthy'
        : 'not_started';
    started.push({ id, action, ...result });
    appendRunLog(`${id}: ${action}${result.error ? ` (${result.error})` : ''}`);
  }
  return started;
}

async function restartBridge(pid) {
  const value = Number(pid);
  if (Number.isInteger(value) && value > 0) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && isPidAlive(value)) await sleep(300);
    // A bridge that refuses to exit is left alone: starting a second one would
    // fight over the port.
    if (isPidAlive(value)) {
      appendRunLog(`chatgpt-web: restart aborted, pid ${value} is still running`);
      return [{ id: 'chatgpt-web', action: 'not_started', error: 'previous_bridge_still_running', pid: value }];
    }
  }
  const settings = readEffectiveProviderControl().settings.providers['chatgpt-web'];
  const result = await startBridge(settings);
  appendRunLog(`chatgpt-web: restart ${result.started ? 'started' : result.adopted ? 'already_healthy' : 'not_started'}${result.error ? ` (${result.error})` : ''}`);
  return [{ id: 'chatgpt-web', action: result.started ? 'restarted' : result.adopted ? 'already_healthy' : 'not_started', ...result }];
}

async function status() {
  const state = readEffectiveProviderControl();
  const bridgeSettings = state.settings.providers['chatgpt-web'];
  const deepseekSettings = state.settings.providers['deepseek-web'];
  const bridgeProbe = await probeBridge({ port: Number(bridgeSettings.port) || config.port });
  const deepseekProbe = deepseekSettings.repoPath
    ? await probeDeepSeekWeb({ port: Number(deepseekSettings.port) || 9655 })
    : { reachable: false, detail: 'the FreeDeepseekAPI folder is not configured' };
  return {
    generatedAt: Date.now(),
    bridgeRepo: BRIDGE_REPO_PATH,
    providers: {
      'chatgpt-web': { port: bridgeSettings.port, autostart: bridgeSettings.autostart, probe: bridgeProbe },
      'deepseek-web': { port: deepseekSettings.port, autostart: deepseekSettings.autostart, configured: Boolean(deepseekSettings.repoPath), probe: deepseekProbe },
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return;
  }
  if (argv.includes('--status')) {
    console.log(JSON.stringify(await status(), null, 2));
    return;
  }
  if (argv.includes('--restart-bridge')) {
    const index = argv.indexOf('--pid');
    const result = await restartBridge(index >= 0 ? argv[index + 1] : 0);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!argv.includes('--run')) {
    console.log(usage());
    process.exitCode = 1;
    return;
  }
  // Touch the record so a manually deleted process file never hides ownership of
  // the bridge this runner is about to spawn from the launcher.
  const result = await runAutoStart();
  console.log(JSON.stringify(result, null, 2));
  const owned = readEffectiveProviderControl().owned['chatgpt-web'];
  if (owned?.pid && !isPidAlive(owned.pid)) {
    setOwnedProcess('chatgpt-web', null);
  }
}

main().catch((error) => {
  appendRunLog(`fatal: ${error?.message || error}`);
  console.error(error);
  process.exitCode = 1;
});

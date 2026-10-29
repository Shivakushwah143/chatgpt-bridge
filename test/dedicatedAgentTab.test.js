import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserClientCoordinator } from '../src/bridge/coordinator/browserClientCoordinator.js';
import { normalizeOptions } from '../src/bridge/requestState.js';

function client(id, overrides = {}) {
  return {
    id,
    ready: true,
    compatible: true,
    compatibility: { compatible: true },
    activeRequest: null,
    launchToken: '',
    url: 'https://chatgpt.com/',
    session: { id: 'new' },
    ...overrides,
  };
}

function makeCoordinator(clients = []) {
  const selected = [];
  const opened = [];
  const closed = [];
  const coordinator = new BrowserClientCoordinator({
    hub: {
      clients,
      activeClient: null,
      selectClient(clientId) {
        selected.push(clientId);
        return clients.find((item) => item.id === clientId) || null;
      },
    },
    pending: new Map(),
    lifecycle: { emitRequestEvent() {} },
    runtimeOptions: {
      autoOpenTab: false,
      autoOpenTabTimeoutMs: 30_000,
      autoOpenTabBootstrapWaitMs: 0,
    },
    async sendCommand() { throw new Error('unexpected command'); },
  });
  coordinator.tabs = {
    browserControlClients() { return clients.filter((item) => item.ready && item.capabilities?.browserTabs !== false); },
    async closeBrowserTab(options) {
      closed.push(options);
      return { closed: true };
    },
    async openBrowserTab(options) {
      opened.push(options);
      return {
        client: client('agent-tab', {
          launchToken: options.launchToken,
          url: options.url,
          session: { id: options.url.includes('/c/') ? options.url.split('/c/')[1] : 'new' },
        }),
        openedBy: 'extension',
      };
    },
  };
  return { coordinator, selected, opened, closed };
}

test('agent API requests never use a user ChatGPT tab and open a dedicated tab instead', async () => {
  const userTab = client('user-tab', { focused: true, visibilityState: 'visible' });
  const otherUserTab = client('user-tab-2', { url: 'https://chatgpt.com/c/user-conversation' });
  const { coordinator, selected, opened } = makeCoordinator([userTab, otherUserTab]);

  const target = await coordinator.resolvePromptClient(
    { requestId: 'request-agent-1' },
    { dedicatedTab: true, newSession: true },
    {},
  );

  assert.equal(target.client.id, 'agent-tab');
  assert.equal(target.reason, 'dedicated_agent_tab_opened');
  assert.deepEqual(selected, ['agent-tab']);
  assert.equal(opened.length, 1);
  assert.match(opened[0].launchToken, /^bridge-agent-/);
  assert.equal(opened[0].url, 'https://chatgpt.com/');
});

test('agent API traffic reuses the bound dedicated tab for the requested session', async () => {
  const userTab = client('user-tab');
  const agentTab = client('agent-tab', {
    launchToken: 'bridge-agent-existing',
    url: 'https://chatgpt.com/c/session-agent',
    session: { id: 'session-agent' },
  });
  const { coordinator, selected, opened } = makeCoordinator([userTab, agentTab]);

  const target = await coordinator.resolvePromptClient(
    { requestId: 'request-agent-2' },
    { dedicatedTab: true, sessionId: 'session-agent' },
    {},
  );

  assert.equal(target.client.id, 'agent-tab');
  assert.equal(target.reason, 'dedicated_agent_tab');
  assert.deepEqual(selected, ['agent-tab']);
  assert.equal(opened.length, 0);
});

test('a user tab on the same session is not reused for agent traffic', async () => {
  const userTab = client('user-tab', {
    url: 'https://chatgpt.com/c/session-agent',
    session: { id: 'session-agent' },
  });
  const { coordinator, selected, opened } = makeCoordinator([userTab]);

  const target = await coordinator.resolvePromptClient(
    { requestId: 'request-agent-3' },
    { dedicatedTab: true, sessionId: 'session-agent' },
    {},
  );

  assert.equal(target.client.id, 'agent-tab');
  assert.deepEqual(selected, ['agent-tab']);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].url, 'https://chatgpt.com/c/session-agent');
});

test('stale Kodevra agent tabs are closed and one agent tab is kept selected', async () => {
  const userTab = client('user-tab');
  const staleA = client('agent-a', {
    launchToken: 'bridge-agent-old-a',
    url: 'https://chatgpt.com/c/old-a',
    session: { id: 'old-a' },
  });
  const staleB = client('agent-b', {
    launchToken: 'bridge-agent-old-b',
    url: 'https://chatgpt.com/c/old-b',
    session: { id: 'old-b' },
  });
  const { coordinator, selected, opened, closed } = makeCoordinator([userTab, staleA, staleB]);

  const target = await coordinator.resolvePromptClient(
    { requestId: 'request-agent-cleanup' },
    { dedicatedTab: true, newSession: true },
    {},
  );

  assert.equal(target.client.id, 'agent-a', 'an existing Kodevra tab is reused');
  assert.equal(target.reason, 'dedicated_agent_tab');
  assert.deepEqual(closed.map((entry) => entry.expectedLaunchToken), ['bridge-agent-old-b']);
  assert.equal(closed[0].sourceClientId, 'agent-a');
  assert.ok(!closed.some((entry) => entry.expectedLaunchToken === userTab.launchToken));
  assert.deepEqual(selected, ['agent-a']);
  assert.equal(opened.length, 0);
});

test('a busy Kodevra tab is not closed while a fresh agent tab is opened', async () => {
  const userTab = client('user-tab');
  const busyAgent = client('agent-busy', {
    launchToken: 'bridge-agent-busy',
    activeRequest: { requestId: 'in-flight' },
  });
  const { coordinator, selected, opened, closed } = makeCoordinator([userTab, busyAgent]);

  const target = await coordinator.resolvePromptClient(
    { requestId: 'request-agent-busy' },
    { dedicatedTab: true, newSession: true },
    {},
  );

  assert.equal(target.client.id, 'agent-tab');
  assert.equal(closed.length, 0);
  assert.equal(opened.length, 1);
  assert.deepEqual(selected, ['agent-tab']);
});

test('dedicatedTab survives option normalization', () => {
  assert.equal(normalizeOptions({ dedicatedTab: true }).dedicatedTab, true);
  assert.equal(normalizeOptions({}).dedicatedTab, false);
});

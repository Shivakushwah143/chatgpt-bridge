import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const CONTENT = path.resolve('tools/chrome-bridge-extension/content');

function normalizeComparable(value = '') {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}

function normalizeText(value = '') {
  return String(value || '').trim();
}

/**
 * Minimal composer toolbar: a model chip and an effort chip, exactly the shape
 * ChatGPT renders next to the composer. Nothing here opens a menu - the point of
 * these tests is that model/effort selection never has to.
 */
function chip(text) {
  const element = {
    nodeType: 1,
    signal: text,
    get innerText() { return element.signal; },
    get textContent() { return element.signal; },
    parentElement: null,
    getAttribute(name) { return name === 'aria-haspopup' ? 'menu' : ''; },
    hasAttribute() { return false; },
    closest() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 10, right: 110, top: 10, bottom: 40, width: 100, height: 30 }; },
  };
  return element;
}

async function createHarness({ pathname = '/c/conversation-1', modelText = 'ChatGPT 5', effortText = 'Medium' } = {}) {
  const modelChip = chip(modelText);
  const effortChip = chip(effortText);
  const composerRoot = {
    nodeType: 1,
    parentElement: null,
    contains: () => true,
    querySelectorAll: () => [modelChip, effortChip],
    closest: () => null,
  };
  const composer = {
    nodeType: 1,
    parentElement: composerRoot,
    isConnected: true,
    disabled: false,
    readOnly: false,
    closest: () => null,
    getBoundingClientRect: () => ({ left: 10, right: 400, top: 0, bottom: 60, width: 390, height: 60 }),
  };
  const clickListeners = [];
  const documentStub = {
    readyState: 'complete',
    activeElement: null,
    body: { nodeType: 1 },
    addEventListener(type, handler) { if (type === 'click') clickListeners.push(handler); },
    removeEventListener() {},
    querySelectorAll: () => [],
    getElementById: () => null,
    dispatchEvent: () => true,
  };
  const context = {
    Node: { ELEMENT_NODE: 1 },
    KeyboardEvent: class {},
    MouseEvent: class {},
    PointerEvent: class {},
    setTimeout,
    clearTimeout,
    console,
    document: documentStub,
    location: { pathname, href: `https://chatgpt.com${pathname}` },
    window: {
      KeyboardEvent: class {},
      MouseEvent: class {},
      PointerEvent: class {},
      getComputedStyle: () => ({ visibility: 'visible', display: 'block', contentVisibility: 'visible', opacity: '1' }),
      addEventListener() {},
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(await fs.readFile(path.join(CONTENT, 'domUtilities.js'), 'utf8'), context);
  vm.runInContext(await fs.readFile(path.resolve('tools/chrome-bridge-extension/artifactParserCore.js'), 'utf8'), context);
  vm.runInContext(await fs.readFile(path.resolve('tools/chrome-bridge-extension/domParserCore.js'), 'utf8'), context);
  vm.runInContext(await fs.readFile(path.join(CONTENT, 'intelligenceCommands.js'), 'utf8'), context);
  vm.runInContext(await fs.readFile(path.join(CONTENT, 'requestPreparation.js'), 'utf8'), context);

  const intelligence = context.ChatGptIntelligenceCommands.createIntelligenceCommands({
    DOM_PARSER: context.ChatGptDomParserCore,
    buttonSignalText: (element) => element.signal,
    delay: async () => {},
    diagnostic: () => {},
    findComposer: () => composer,
    findComposerRootStrict: () => composerRoot,
    isPrimaryChatSurfaceElement: context.ChatGptDomUtilities.isPrimaryChatSurfaceElement,
    isUsableButton: () => true,
    isVisible: () => true,
    normalizeComparable,
    normalizeText,
    send: () => {},
    unique: (values) => [...new Set(values)],
    visibleText: (element) => element.signal,
  });

  const counters = { modelSelections: 0, effortSelections: 0, selectionAttempts: 0 };
  const sent = [];
  const diagnostics = [];
  const state = { availableEfforts: ['low', 'medium', 'high'] };

  async function trySelectIntelligenceOption(label, kind) {
    counters.selectionAttempts += 1;
    const wanted = normalizeComparable(label);
    if (kind === 'model') {
      counters.modelSelections += 1;
      if (normalizeComparable(modelChip.signal) === wanted) return { matched: true, clicked: false, alreadySelected: true };
      modelChip.signal = String(label);
      return { matched: true, clicked: true, alreadySelected: false, proven: true, option: { label: String(label) } };
    }
    counters.effortSelections += 1;
    if (!state.availableEfforts.includes(wanted)) return { matched: false, clicked: false, alreadySelected: false };
    if (normalizeComparable(effortChip.signal) === wanted) return { matched: true, clicked: false, alreadySelected: true };
    effortChip.signal = String(label);
    // Mirror the real selector: a change records its own latency.
    intelligence.noteIntelligenceSelection(12);
    return { matched: true, clicked: true, alreadySelected: false, proven: true, option: { id: wanted, label: String(label) } };
  }

  async function readIntelligenceState({ includeModels = true } = {}) {
    return {
      models: includeModels ? [{ id: 'model-chatgpt-5', label: modelChip.signal, selected: true }] : [],
      efforts: state.availableEfforts.map((id) => ({ id, label: id, selected: id === normalizeComparable(effortChip.signal) })),
      selectedModel: { id: 'model-chatgpt-5', label: modelChip.signal },
      selectedEffort: { id: normalizeComparable(effortChip.signal), label: effortChip.signal },
      capturedAt: Date.now(),
    };
  }

  const preparation = context.ChatGptRequestPreparation.createRequestPreparation({
    CONFIG: { pageReadyTimeoutMs: 1_000, pageReadySettleMs: 100 },
    DOM_PARSER: context.ChatGptDomParserCore,
    INTELLIGENCE_UI_TIMING: intelligence.INTELLIGENCE_UI_TIMING,
    beginIntelligenceTurn: intelligence.beginIntelligenceTurn,
    currentIntelligenceTurnMetrics: intelligence.currentIntelligenceTurnMetrics,
    delay: async () => {},
    diagnostic: (name, data) => diagnostics.push({ name, data }),
    emitChatEvent: () => {},
    findChatMain: () => composer,
    findComposer: () => composer,
    isVisible: () => true,
    openNewSession: async () => ({}),
    planIntelligenceAdjustment: intelligence.planIntelligenceAdjustment,
    readCachedIntelligence: intelligence.readCachedIntelligence,
    readIntelligenceState,
    readIntelligenceTrigger: intelligence.readIntelligenceTrigger,
    recordIntelligenceConfirmation: intelligence.recordIntelligenceConfirmation,
    schedulePageStatus: () => {},
    selectSessionById: async () => ({}),
    send: (payload) => sent.push(payload),
    trySelectIntelligenceOption,
  });

  return {
    intelligence,
    counters,
    sent,
    diagnostics,
    state,
    chips: { modelChip, effortChip },
    setEffort(text) { effortChip.signal = text; },
    setModel(text) { modelChip.signal = text; },
    navigate(nextPathname) { context.location.pathname = nextPathname; },
    simulateUserPick() {
      const menu = { nodeType: 1 };
      const option = {
        nodeType: 1,
        closest(selector) {
          if (/menuitemradio/.test(selector)) return option;
          if (/role="menu"|composer-intelligence-picker-content/.test(selector)) return menu;
          return null;
        },
      };
      for (const listener of clickListeners) listener({ target: option });
    },
    apply: (options, extra = {}) => preparation.applyModelOptions(options, { requestId: 'req-1' }, extra),
  };
}

test('desired Medium with current Medium needs zero menu interaction', async () => {
  const harness = await createHarness({ effortText: 'Medium' });
  const result = await harness.apply({ model: 'ChatGPT 5', effort: 'medium' });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'already-current');
  assert.equal(harness.counters.modelSelections, 0);
  assert.equal(harness.counters.effortSelections, 0);
  assert.equal(result.interactions.modelMenuOpens, 0);
  assert.equal(result.interactions.effortMenuOpens, 0);
});

test('desired Medium with current Low makes exactly one change', async () => {
  const harness = await createHarness({ effortText: 'Low' });
  const result = await harness.apply({ model: 'ChatGPT 5', effort: 'medium' });

  assert.equal(result.skipped, false);
  assert.equal(result.reason, 'effort-mismatch');
  assert.equal(harness.counters.effortSelections, 1);
  assert.equal(harness.counters.modelSelections, 0);
  assert.equal(result.effortApplied, true);
  assert.equal(harness.chips.effortChip.signal, 'medium');
});

test('the next turn with the same model and effort reselects nothing', async () => {
  const harness = await createHarness({ effortText: 'Low' });
  await harness.apply({ model: 'ChatGPT 5', effort: 'medium' });
  harness.counters.effortSelections = 0;

  for (let turn = 0; turn < 4; turn += 1) {
    const result = await harness.apply({ model: 'ChatGPT 5', effort: 'medium' });
    assert.equal(result.skipped, true, `turn ${turn + 1} should be a no-op`);
  }
  assert.equal(harness.counters.effortSelections, 0);
  assert.equal(harness.counters.modelSelections, 0);
});

test('a user changing effort by hand invalidates the cache', async () => {
  const harness = await createHarness({ effortText: 'Medium' });
  await harness.apply({ model: 'ChatGPT 5', effort: 'medium' });
  assert.equal(harness.intelligence.readCachedIntelligence().confirmed, true);

  harness.setEffort('High');
  assert.equal(harness.intelligence.readCachedIntelligence().confirmed, false);

  // A menu click is direct evidence too: the cache is dropped immediately.
  await harness.apply({ model: 'ChatGPT 5', effort: 'high' });
  harness.simulateUserPick();
  const afterClick = harness.intelligence.readCachedIntelligence();
  assert.equal(afterClick.confirmed, false);
  assert.equal(afterClick.source, 'trigger');
});

test('an effort the account does not offer falls back once instead of looping', async () => {
  const harness = await createHarness({ effortText: 'Medium' });
  const result = await harness.apply({ model: 'ChatGPT 5', effort: 'xhigh' });

  assert.equal(harness.counters.effortSelections, 1);
  assert.equal(result.fallback, 'kept-current-effort');
  assert.equal(result.warnings.length, 1);
  assert.equal(result.effortApplied, false);
  assert.equal(harness.chips.effortChip.signal, 'Medium');
});

test('a reloaded tab re-detects the state once from the composer trigger', async () => {
  // A fresh content runtime is a tab reload: module memory is empty.
  const harness = await createHarness({ effortText: 'Medium' });
  const first = await harness.apply({ model: 'ChatGPT 5', effort: 'medium' });

  assert.equal(first.skipped, true);
  assert.equal(harness.counters.selectionAttempts, 0);
  // Re-detected once, then cached as confirmed from the trigger itself.
  const cached = harness.intelligence.readCachedIntelligence();
  assert.equal(cached.confirmed, true);
  assert.equal(cached.source, 'cache');
});

test('a conversation change drops the confirmed cache', async () => {
  const harness = await createHarness({ effortText: 'Medium' });
  await harness.apply({ model: 'ChatGPT 5', effort: 'medium' });
  assert.equal(harness.intelligence.readCachedIntelligence().confirmed, true);

  harness.navigate('/c/conversation-2');
  const afterNavigation = harness.intelligence.readCachedIntelligence();
  assert.equal(afterNavigation.confirmed, false);
  assert.equal(afterNavigation.key, '/c/conversation-2');
});

test('a five-turn run reports one selection and no menu opens afterwards', async () => {
  const harness = await createHarness({ effortText: 'Low' });
  const turns = [];
  for (let turn = 0; turn < 5; turn += 1) {
    turns.push(await harness.apply({ model: 'ChatGPT 5', effort: 'medium' }));
  }

  assert.equal(harness.counters.effortSelections, 1);
  assert.equal(harness.counters.selectionAttempts, 1);
  assert.deepEqual(turns.map((result) => result.skipped), [false, true, true, true, true]);

  const metrics = harness.intelligence.reportIntelligenceMetrics({ requestId: 'req-1', submissionMs: 42, step: 'prompt.submit' });
  // The reported turn is the last one: no menus, no selection.
  assert.equal(metrics.turn.selections, 0);
  assert.equal(metrics.totals.selections, 1);
  assert.equal(metrics.turn.modelMenuOpens, 0);
  assert.equal(metrics.turn.effortMenuOpens, 0);
  assert.equal(metrics.submissionMs, 42);
  assert.equal(metrics.totals.detectReads > 0, true);
});

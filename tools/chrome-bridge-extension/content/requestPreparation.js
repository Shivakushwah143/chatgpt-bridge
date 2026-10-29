// Chat page readiness and session/model request preparation.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createRequestPreparation(deps = {}) {
    const {
      CONFIG,
      DOM_PARSER,
      INTELLIGENCE_UI_TIMING,
      beginIntelligenceTurn,
      currentIntelligenceTurnMetrics,
      delay,
      diagnostic,
      emitChatEvent,
      findChatMain,
      findComposer,
      isVisible,
      openNewSession,
      planIntelligenceAdjustment,
      readCachedIntelligence,
      readIntelligenceState,
      readIntelligenceTrigger,
      recordIntelligenceConfirmation,
      schedulePageStatus,
      selectSessionById,
      send,
      trySelectIntelligenceOption,
    } = deps;

    function waitForDocumentReady(timeoutMs = 0) {
      if (document.readyState !== 'loading') return Promise.resolve();
      const budget = Math.max(0, Number(timeoutMs) || 0);
      return new Promise((resolve, reject) => {
        let timer = null;
        const done = (error = null) => {
          if (timer) clearTimeout(timer);
          if (error) reject(error); else resolve();
        };
        document.addEventListener('DOMContentLoaded', () => done(), { once: true });
        if (budget) timer = setTimeout(() => done(new Error(`CHAT_DOCUMENT_NOT_READY: ChatGPT document did not become ready after ${budget}ms`)), budget);
      });
    }
  
    function chatPageReadiness() {
      const chatMain = findChatMain();
      const composer = findComposer();
      const composerReady = Boolean(composer && composer.isConnected && isVisible(composer) && !composer.disabled && !composer.readOnly);
      const chatMainReady = Boolean(chatMain && chatMain.isConnected && isVisible(chatMain));
      return {
        ready: document.readyState !== 'loading' && chatMainReady && composerReady,
        chatMainReady,
        composerReady,
        composer,
        url: location.href,
      };
    }
  
    async function waitForChatPageReady(request, options = {}) {
      const timeoutMs = Math.max(5_000, Number(options.timeoutMs || request?.options?.pageReadyTimeoutMs || CONFIG.pageReadyTimeoutMs) || CONFIG.pageReadyTimeoutMs);
      const settleMs = Math.max(150, Number(options.settleMs ?? request?.options?.pageReadySettleMs ?? CONFIG.pageReadySettleMs) || CONFIG.pageReadySettleMs);
      const stage = String(options.stage || 'prompt');
      const started = Date.now();
      let readySince = 0;
      let readyUrl = '';
      let lastState = '';
  
      emitChatEvent(request, 'page.ready.wait', { stage, timeoutMs, settleMs });
      while (Date.now() - started < timeoutMs) {
        const state = chatPageReadiness();
        const signature = JSON.stringify([document.readyState, state.chatMainReady, state.composerReady, state.url]);
        if (signature !== lastState) {
          lastState = signature;
          diagnostic('page.ready.state', {
            requestId: request?.requestId,
            stage,
            documentReadyState: document.readyState,
            chatMainReady: state.chatMainReady,
            composerReady: state.composerReady,
            url: state.url,
          });
        }
        if (state.ready) {
          if (!readySince || readyUrl !== state.url) {
            readySince = Date.now();
            readyUrl = state.url;
          }
          if (Date.now() - readySince >= settleMs) {
            diagnostic('page.ready', { requestId: request?.requestId, stage, waitedMs: Date.now() - started, settleMs, url: state.url });
            emitChatEvent(request, 'page.ready', { stage, waitedMs: Date.now() - started, settleMs, url: state.url });
            schedulePageStatus('page.changed', 0);
            return state;
          }
        } else {
          readySince = 0;
          readyUrl = '';
        }
        await delay(200);
      }
  
      const state = chatPageReadiness();
      diagnostic('page.ready.timeout', {
        requestId: request?.requestId,
        stage,
        timeoutMs,
        documentReadyState: document.readyState,
        chatMainReady: state.chatMainReady,
        composerReady: state.composerReady,
        url: state.url,
      });
      throw new Error(`CHAT_PAGE_NOT_READY: ChatGPT composer did not become stable during ${stage} after ${timeoutMs}ms`);
    }
  
    async function applySessionOptions(options, request) {
      if (options.newSession) {
        emitChatEvent(request, 'session.new.started');
        const session = await openNewSession();
        emitChatEvent(request, 'session.new.done', { session });
        return;
      }
  
      if (options.sessionId) {
        emitChatEvent(request, 'session.select.started', { sessionId: options.sessionId });
        const session = await selectSessionById(options.sessionId);
        emitChatEvent(request, 'session.select.done', { session });
      }
    }
  
    /**
     * Idempotent model/effort preparation.
     *
     * Cost order: cached state, then one composer-trigger read, then - only for a
     * dimension that actually differs - one menu interaction. A turn whose model
     * and effort already match therefore opens no menus at all. Selection is
     * attempted at most once per dimension, and an effort the account does not
     * expose leaves ChatGPT on its current effort with a warning instead of
     * retrying.
     */
    async function applyModelOptions(options, request, { emitEvents = true } = {}) {
      const model = String(options.model || '').trim();
      const effort = String(options.effort || '').trim();
      if (!model && !effort) return;

      beginIntelligenceTurn();
      if (emitEvents) emitChatEvent(request, 'model.apply.started', { model, effort });
      diagnostic('model.apply.started', { requestId: request.requestId, model, effort });

      const current = readCachedIntelligence();
      const plan = planIntelligenceAdjustment({ model, effort, current });
      if (!plan.model && !plan.effort) {
        // The composer trigger just proved the live state for both dimensions,
        // so this is a confirmation, not a guess: cache it and stop here.
        if (current.trigger) {
          recordIntelligenceConfirmation({
            modelLabel: current.trigger.modelLabel,
            effortId: current.trigger.effortId,
            signature: current.trigger.signature,
            source: 'composer-trigger',
          });
        }
        const skipped = {
          model,
          effort,
          modelApplied: Boolean(model),
          effortApplied: Boolean(effort),
          skipped: true,
          reason: plan.reason,
          warnings: [],
          current: { model: current.modelLabel || '', effort: current.effortId || '', source: current.source },
          interactions: currentIntelligenceTurnMetrics(),
        };
        diagnostic('model.apply.skipped', {
          requestId: request.requestId,
          model,
          effort,
          reason: plan.reason,
          source: current.source,
          interactions: skipped.interactions,
        });
        return skipped;
      }

      const result = { model, effort, modelApplied: false, effortApplied: false, skipped: false, reason: plan.reason, warnings: [] };
      let modelSelection = null;
      let effortSelection = null;

      if (model && plan.model) {
        modelSelection = await trySelectIntelligenceOption(model, 'model', request);
        if (!modelSelection.matched) result.warnings.push(`Could not find model option: ${model}`);
      }

      if (effort && plan.effort) {
        const effortLabel = effortLabelFromValue(effort);
        effortSelection = await trySelectIntelligenceOption(effortLabel, 'effort', request);
        if (!effortSelection.matched) {
          // Documented fallback: keep whatever effort the account already has.
          // No second attempt, no loop.
          result.fallback = 'kept-current-effort';
          result.warnings.push(`Effort "${effort}" is not offered by this account; kept the current ChatGPT effort.`);
        }
      }

      // Verification starts with the cheap composer read; the picker is only
      // opened when neither the trigger nor the completed selection proves the
      // state on its own.
      const trigger = readIntelligenceTrigger();
      const modelSelectionProven = Boolean(modelSelection && (modelSelection.alreadySelected || modelSelection.proven));
      const effortSelectionProven = Boolean(effortSelection && (effortSelection.alreadySelected || effortSelection.proven));
      const modelKnown = !model
        || (modelSelection ? modelSelectionProven : (trigger?.modelLabel ? DOM_PARSER.intelligenceOptionMatches({ label: trigger.modelLabel }, model) : null));
      const effortKnown = !effort
        || (effortSelection ? effortSelectionProven : (trigger?.effortId ? DOM_PARSER.intelligenceOptionMatches({ id: trigger.effortId, label: effortLabelFromValue(effort) }, effortLabelFromValue(effort)) : null));
      let state = null;
      if (modelKnown === null || effortKnown === null) {
        diagnostic('model.apply.verification.menu_read', { requestId: request.requestId, model, effort });
        try {
          state = await readIntelligenceState({ includeModels: Boolean(model) });
        } catch (err) {
          result.warnings.push(`Verification detail: ${err.message || String(err)}`);
        }
      }

      const appliedModel = state?.selectedModel
        || (trigger?.modelLabel ? { label: trigger.modelLabel } : null)
        || (modelSelectionProven ? modelSelection?.option || null : null);
      const appliedEffort = state?.selectedEffort
        || (trigger?.effortId ? { id: trigger.effortId, label: trigger.effortId } : null)
        || (effortSelectionProven ? effortSelection?.option || null : null);
      result.modelApplied = model
        ? Boolean(appliedModel && DOM_PARSER.intelligenceOptionMatches(appliedModel, model))
        : false;
      result.effortApplied = effort
        ? Boolean(appliedEffort && DOM_PARSER.intelligenceOptionMatches(appliedEffort, effortLabelFromValue(effort)))
        : false;

      if (model && !result.modelApplied) result.warnings.push(`Could not confirm model selection: ${model}`);
      if (effort && !result.effortApplied && result.fallback !== 'kept-current-effort') {
        result.warnings.push(`Could not confirm effort selection: ${effort}`);
      }

      recordIntelligenceConfirmation({
        modelLabel: appliedModel?.label || '',
        effortId: appliedEffort?.id || appliedEffort?.label || '',
        signature: trigger?.signature || '',
        source: 'model.apply',
      });

      result.current = { model: appliedModel?.label || '', effort: appliedEffort?.id || appliedEffort?.label || '', source: state ? 'picker' : 'composer-trigger' };
      result.interactions = currentIntelligenceTurnMetrics();
      const completedResult = {
        ...result,
        intelligence: state ? {
          models: Array.isArray(state.models) ? state.models : [],
          efforts: Array.isArray(state.efforts) ? state.efforts : [],
          selectedModel: state.selectedModel || null,
          selectedEffort: state.selectedEffort || null,
          capturedAt: state.capturedAt || Date.now(),
        } : null,
      };
      diagnostic('model.apply.done', {
        requestId: request.requestId,
        ...completedResult,
        modelSelection: modelSelection ? { matched: modelSelection.matched, clicked: modelSelection.clicked, alreadySelected: modelSelection.alreadySelected } : null,
        effortSelection: effortSelection ? { matched: effortSelection.matched, clicked: effortSelection.clicked, alreadySelected: effortSelection.alreadySelected } : null,
        selectedModel: appliedModel?.label || '',
        selectedEffort: appliedEffort?.id || appliedEffort?.label || '',
        interactions: completedResult.interactions,
      });
      return completedResult;
    }
  
    function effortLabelFromValue(value) {
      const normalized = String(value || '').toLowerCase();
      const map = {
        low: 'low',
        medium: 'medium',
        med: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        'x-high': 'xhigh',
        auto: 'auto',
        instant: 'instant',
        thinking: 'thinking',
      };
      return map[normalized] || value;
    }
  
  
    return Object.freeze({
      applyModelOptions,
      applySessionOptions,
      chatPageReadiness,
      waitForChatPageReady,
      waitForDocumentReady,
    });
  }

  globalThis.ChatGptRequestPreparation = Object.freeze({ createRequestPreparation });
})();

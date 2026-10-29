// Focused request-command family. Loaded before requestCommands.js.
(() => {
  'use strict';

  function createRequestResumeCommands(deps = {}) {
    const {
      DOM_PARSER,
      REQUEST_STATE,
      applyModelOptions,
      applySessionOptions,
      attachFiles,
      baselinePassiveTurns,
      clickStopButton,
      collectAndEmit,
      conversationIdFromUrl,
      delay,
      diagnostic,
      emitChatEvent,
      enterPrompt,
      findStopButton,
      findComposer,
      findComposerRootStrict,
      getActiveRequest,
      getAssistantNodes,
      getConnectedServerInstanceId,
      getCurrentSession,
      getTurnNodes,
      isGenerating,
      markRequestProgress,
      normalizeText,
      readUserTurnPromptText,
      refreshRequestTurnAnchors,
      registerPassivePromptBoundary,
      releaseRequest,
      settleEffectReconciliation,
      settleReleaseCleanup,
      runObservedRequestEffect,
      settleUnexecutableEffect,
      schedulePageStatus,
      schedulePassiveTurnScan,
      scheduleTabObservation,
      send,
      setActiveRequest,
      setRequestPhase,
      simpleHash,
      startDomMonitor,
      turnKey,
      turnRole: resolveTurnRole,
      waitForChatPageReady,
      waitForDocumentReady,
      waitForSubmittedUserTurnAnchor,
      pagePresence,
      readIntelligenceState,
      resumeBoundaryTimeoutMs = 2_500,
    } = deps;
    const { publicRequestStatus } = deps;
    if (typeof publicRequestStatus !== 'function') throw new TypeError('Request resume commands require publicRequestStatus');

    // Turn roles must come from the same layout-aware resolver the submission
    // path uses. The current ChatGPT conversation DOM has no data-turn/
    // data-message-author-role wrapper on user turns (they are
    // [data-chatgpt-search-message-ids] nodes) and assistant turns only hang off
    // [data-chatgpt-agent-turn-start], so reading the legacy attributes alone
    // classified every turn as role-less during recovery: the submitted prompt
    // could never be proved present and a live request was declared lost.
    function turnRole(turn) {
      const resolved = typeof resolveTurnRole === 'function' ? String(resolveTurnRole(turn) || '') : '';
      if (resolved) return resolved;
      return String(turn?.getAttribute?.('data-turn')
        || turn?.querySelector?.('[data-message-author-role]')?.getAttribute?.('data-message-author-role')
        || turn?.getAttribute?.('data-message-author-role')
        || '');
    }

    function turnText(turn) {
      const value = String(turn?.innerText || turn?.textContent || '');
      return typeof normalizeText === 'function' ? normalizeText(value) : value.trim().replace(/\s+/g, ' ');
    }

    // Comparable prompt text: whitespace differences between the submitted
    // string and the rendered bubble must not hide a submitted turn.
    function comparableText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }
    // ChatGPT collapses long user messages into a shortened preview followed by
    // a "Show more" control, so the rendered bubble is an exact prefix of the
    // submitted prompt plus a truncation marker.
    function withoutTruncationMarker(value) {
      return String(value || '')
        .replace(/\s*(?:…|\.{3})\s*(?:show more|read more|показать полностью|показать целиком)?\s*$/i, '')
        .trim();
    }
    // A truncated preview is only proof when it is long enough to identify the
    // prompt; short prompts still require exact text.
    const MIN_TRUNCATED_PROMPT_PREFIX = 64;

    // Submission proves the user turn with DOM_PARSER.userTurnMatchesExpectedText
    // against the bubble text. Recovery after a content reload must use the same
    // predicate, otherwise a turn whose anchor id changed across the reload is
    // declared lost even though it is visibly the submitted prompt.
    function promptEvidence(rendered, expectedText) {
      const actual = comparableText(rendered);
      if (!actual) return '';
      if (actual === expectedText) return 'exact';
      const matches = DOM_PARSER?.userTurnMatchesExpectedText;
      if (typeof matches === 'function' && matches(actual, expectedText) === true) return 'similar';
      // The full submitted prompt followed by rendered UI such as "Show more".
      if (actual.startsWith(expectedText)) return 'prompt_with_trailing_ui';
      // A collapsed preview of the submitted prompt.
      const prefix = withoutTruncationMarker(actual);
      if (prefix.length >= MIN_TRUNCATED_PROMPT_PREFIX && expectedText.startsWith(prefix)) return 'truncated_prefix';
      return '';
    }

    // Identity of the rendered turn list. A boundary verdict is only evidence
    // when this list has stopped changing: a page that renders nothing yet, or
    // that keeps re-rendering during the whole resolution window, cannot prove
    // that a submitted turn is gone.
    function turnListSignature(records = []) {
      return records.map((record) => `${record.role}:${record.key}:${String(record.text || '').length}`).join('|');
    }

    function projectedBoundaryEvidence(projection = {}) {
      const records = Array.from(getTurnNodes?.() || []).map((turn, index) => {
        const role = turnRole(turn);
        // Read user turns from the prompt bubble exactly like submission does;
        // the turn container also holds action labels that are not the prompt.
        const promptText = role === 'user' && typeof readUserTurnPromptText === 'function'
          ? String(readUserTurnPromptText(turn) || '')
          : '';
        return {
          turn,
          index,
          key: String(turnKey?.(turn, index) || ''),
          role,
          text: promptText || turnText(turn),
        };
      });
      const expectedKey = String(projection.submittedUserTurnKey || '');
      const expectedText = comparableText(projection.submittedPromptText || '');
      let user = records.find((record) => record.role === 'user' && record.key === expectedKey) || null;
      let status = user ? 'matched' : '';
      let promptMatch = '';
      if (!user && expectedText) {
        const userRecords = records.filter((record) => record.role === 'user');
        const lastUserIndex = userRecords.at(-1)?.index ?? -1;
        const candidate = userRecords.at(-1) || null;
        const evidence = candidate ? promptEvidence(candidate.text, expectedText) : '';
        // The submitted turn is the newest user turn; matching an older turn
        // would rebind the response to the wrong prompt.
        if (candidate && candidate.index === lastUserIndex && evidence) {
          user = candidate;
          promptMatch = evidence;
          status = 'rebound';
        }
      }
      if (!user) {
        // A still-rendered assistant turn proves the request's response after a
        // reload when the user bubble is virtualized away entirely. When other
        // user turns are present but none is the submitted prompt, the boundary
        // stays ambiguous and is reported missing on purpose.
        const expectedAssistantKey = String(projection.assistantTurnKey || '');
        const assistantOnly = expectedAssistantKey && !records.some((record) => record.role === 'user')
          ? records.find((record) => record.role === 'assistant' && record.key === expectedAssistantKey) || null
          : null;
        if (assistantOnly) {
          return {
            status: 'rebound',
            submittedUserTurnKey: expectedKey,
            submittedUserTurnIndex: Number(projection.submittedUserTurnIndex ?? -1),
            assistantTurnKey: assistantOnly.key,
            assistantTurnIndex: assistantOnly.index,
            evidence: {
              expectedKey,
              assistantOnly: true,
              matchedAssistantKey: assistantOnly.key,
              turnCount: records.length,
              turnSignature: turnListSignature(records),
            },
          };
        }
        return {
          status: 'missing',
          submittedUserTurnKey: expectedKey,
          submittedUserTurnIndex: Number(projection.submittedUserTurnIndex ?? -1),
          assistantTurnKey: '',
          assistantTurnIndex: -1,
          evidence: {
            expectedKey,
            expectedPromptLength: expectedText.length,
            turnCount: records.length,
            userTurnCount: records.filter((record) => record.role === 'user').length,
            turnSignature: turnListSignature(records),
          },
        };
      }
      const expectedAssistantKey = String(projection.assistantTurnKey || '');
      let assistant = records.find((record) => record.role === 'assistant'
        && record.key === expectedAssistantKey
        && record.index > user.index) || null;
      if (!assistant) {
        assistant = records.filter((record) => record.role === 'assistant' && record.index > user.index).at(-1) || null;
      }
      return {
        status,
        submittedUserTurnKey: user.key,
        submittedUserTurnIndex: user.index,
        assistantTurnKey: assistant?.key || '',
        assistantTurnIndex: assistant?.index ?? -1,
        evidence: {
          expectedKey,
          matchedKey: user.key,
          exactKeyMatch: user.key === expectedKey,
          promptTextMatched: Boolean(promptMatch),
          promptTextMatch: promptMatch || 'key',
          truncatedPromptPrefix: promptMatch === 'truncated_prefix',
          turnCount: records.length,
          turnSignature: turnListSignature(records),
        },
      };
    }

    async function resolveProjectedBoundary(activeRequest, projection = {}) {
      if (!projection.submittedUserTurnKey) return {
        status: 'none',
        submittedUserTurnKey: '',
        submittedUserTurnIndex: -1,
        assistantTurnKey: '',
        assistantTurnIndex: -1,
        evidence: { reason: 'projection_has_no_submitted_user_turn' },
      };
      await waitForChatPageReady?.(activeRequest, { stage: 'request.resume', timeoutMs: 5_000, settleMs: 300 });
      const startedAt = Date.now();
      let result = projectedBoundaryEvidence(projection);
      const firstSignature = String(result.evidence?.turnSignature || '');
      const timeoutMs = Math.max(0, Number(resumeBoundaryTimeoutMs) || 0);
      while (result.status === 'missing' && Date.now() - startedAt < timeoutMs) {
        if (typeof delay === 'function') await delay(150);
        else await new Promise((resolve) => setTimeout(resolve, 150));
        result = projectedBoundaryEvidence(projection);
      }
      if (result.status === 'missing') {
        // A negative read is proof only when the conversation surface had
        // already settled. An empty surface, or a turn list that kept changing
        // for the whole window, is a page that is still painting after the
        // reload and cannot be used to declare the submitted turn lost.
        const lastSignature = String(result.evidence?.turnSignature || '');
        const settled = Boolean(lastSignature) && lastSignature === firstSignature;
        result.evidence = {
          ...(result.evidence || {}),
          settled,
          waitedMs: Date.now() - startedAt,
          firstTurnSignature: firstSignature,
        };
      }
      return result;
    }

    async function handleRequestResume(payload) {
      const activeRequest = getActiveRequest();
      const commandId = payload.commandId;
      const expectedRequestId = String(payload.requestId || '');
      if (!activeRequest) {
        send({ type: 'command.error', commandId, message: 'No active ChatGPT prompt is running in this tab.' });
        diagnostic('request.resume.no_active', { commandId });
        return;
      }
      if (expectedRequestId && activeRequest.requestId !== expectedRequestId) {
        send({ type: 'command.error', commandId, message: `Active prompt is ${activeRequest.requestId}, not ${expectedRequestId}.` });
        diagnostic('request.resume.request_mismatch', { commandId, expectedRequestId, activeRequestId: activeRequest.requestId });
        return;
      }

      if (payload.leaseId || payload.ownerServerInstanceId) {
        activeRequest.update('request.identity_updated', {
          commandId,
          leaseId: String(payload.leaseId || activeRequest.leaseId || ''),
          ownerServerInstanceId: String(payload.ownerServerInstanceId || activeRequest.ownerServerInstanceId || ''),
        });
      }

      const projection = payload.projection && typeof payload.projection === 'object' ? payload.projection : null;
      let boundary = {
        status: 'none', submittedUserTurnKey: '', submittedUserTurnIndex: -1,
        assistantTurnKey: '', assistantTurnIndex: -1, evidence: null,
      };
      if (projection) {
        boundary = await resolveProjectedBoundary(activeRequest, projection);
        const anchorPatch = {
          responseEpoch: Math.max(0, Number(projection.responseEpoch) || 0),
          submittedUserTurnKey: String(boundary.submittedUserTurnKey || projection.submittedUserTurnKey || ''),
          submittedUserTurnIndex: Number.isInteger(boundary.submittedUserTurnIndex)
            ? boundary.submittedUserTurnIndex
            : Number(projection.submittedUserTurnIndex ?? -1),
          assistantTurnKey: String(boundary.assistantTurnKey || ''),
          assistantTurnIndex: Number.isInteger(boundary.assistantTurnIndex) ? boundary.assistantTurnIndex : -1,
        };
        if (Number(projection.sentAt) > 0) anchorPatch.sentAt = Number(projection.sentAt);
        activeRequest.update('request.anchor_updated', anchorPatch);
        diagnostic('request.resume.projection_applied', {
          commandId,
          requestId: activeRequest.requestId,
          responseEpoch: anchorPatch.responseEpoch,
          submittedUserTurnKey: anchorPatch.submittedUserTurnKey || '',
          assistantTurnKey: anchorPatch.assistantTurnKey || '',
          boundaryStatus: boundary.status,
          boundaryEvidence: boundary.evidence,
        });
      }

      const status = publicRequestStatus(activeRequest);
      send({
        type: 'request.resumed', commandId, activeRequest: status, session: getCurrentSession(),
        url: location.href, title: document.title,
        boundaryStatus: boundary.status,
        boundaryEvidence: boundary.evidence,
        submittedUserTurnKey: boundary.submittedUserTurnKey || '',
        submittedUserTurnIndex: boundary.submittedUserTurnIndex,
        assistantTurnKey: boundary.assistantTurnKey || '',
        assistantTurnIndex: boundary.assistantTurnIndex,
      });
      diagnostic('request.resume.attached', { commandId, requestId: activeRequest.requestId, promptPreview: activeRequest.promptPreview || '' });

      // Resumption requests one fresh normalized observation. Cached fragments
      // are never replayed independently because their identity cannot be proven.
      startDomMonitor(activeRequest);
      collectAndEmit(activeRequest, 'request.resume');
    }

    return Object.freeze({
      handleRequestResume
    });
  }

  globalThis.ChatGptRequestResumeCommands = Object.freeze({ createRequestResumeCommands });
})();

// Incremental assistant-response text for live display in Kodevra.
//
// The tab observer already reads the correctly bound assistant response on every
// DOM mutation (see pageStatusRuntime.js). This module only turns that growing
// canonical answer into deltas: it remembers how much text was already sent for
// the current request/turn and emits the new tail. It never parses JSON, never
// executes anything and never changes request state — the durable final answer is
// still produced by the same canonical extractor when the turn completes.
(() => {
  'use strict';

  // One wire frame per chunk keeps a first observation of a long answer from
  // becoming a single oversized message; the cumulative length stays contiguous.
  const MAX_DELTA_CHARS = 8_000;

  function createResponseStream({ getActiveRequest, send } = {}) {
    if (typeof getActiveRequest !== 'function') throw new TypeError('Response stream requires getActiveRequest()');
    if (typeof send !== 'function') throw new TypeError('Response stream requires send()');

    let current = null;

    function reset() {
      current = null;
    }

    function observe(observation = {}) {
      const request = getActiveRequest();
      const requestId = String(request?.requestId || '');
      if (!requestId) {
        reset();
        return null;
      }
      const boundRequestId = String(observation?.activeRequest?.requestId || '');
      if (boundRequestId && boundRequestId !== requestId) return null;

      const answer = String(observation?.output?.answer || '');
      const turnKey = String(observation?.turn?.key || '');
      const expectedTurnKey = String(request?.assistantTurnKey || '');
      // Only the assistant turn this request is bound to may stream. While the
      // binding is still pending the observation carries no assistant turn yet,
      // so there is nothing to emit.
      if (!turnKey) return null;
      if (expectedTurnKey && turnKey !== expectedTurnKey) return null;

      if (!answer) {
        if (current?.requestId !== requestId) reset();
        return null;
      }

      if (!current || current.requestId !== requestId || current.turnKey !== turnKey) {
        current = { requestId, turnKey, length: 0, seq: 0 };
      }

      if (answer.length < current.length) {
        // The response rewound (a new branch or a re-render). Re-baseline to the
        // current text instead of inventing a delta; a duplicate is preferable
        // to splicing text into the wrong position, and the final answer is
        // unaffected either way.
        current.length = answer.length;
        return null;
      }
      if (answer.length === current.length) return null;

      const previousLength = current.length;
      const fresh = answer.slice(previousLength);
      current.length = answer.length;
      const sessionId = String(observation?.conversationId || '');
      for (let sent = 0; sent < fresh.length;) {
        const delta = fresh.slice(sent, sent + MAX_DELTA_CHARS);
        sent += delta.length;
        current.seq += 1;
        send({
          type: 'response.delta',
          requestId,
          sessionId,
          turnKey,
          seq: current.seq,
          delta,
          answerLength: previousLength + sent,
          answerState: String(observation?.output?.state || ''),
        });
      }
      return fresh;
    }

    return Object.freeze({ observe, current: () => current, reset });
  }

  globalThis.ChatGptResponseStreamRuntime = Object.freeze({ createResponseStream });
})();

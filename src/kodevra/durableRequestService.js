import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { HttpError } from '../httpError.js';
import { log } from '../logger.js';
import { extractRequestFromOpenAIPayload } from '../openaiPayload.js';

/**
 * Durable request lifecycle for Kodevra's chatgpt-web transport.
 *
 * The synchronous `/v1/chat/completions` route keeps one HTTP request open for
 * the whole ChatGPT turn. That is fine for a 40 second answer and wrong for an
 * eight minute one: the client's transport deadline (Undici's 300s headers
 * timeout) becomes the real model timeout, and any reconnect drops the request.
 *
 * This service inverts the lifecycle instead of raising a timeout:
 *
 *   POST /kodevra/requests          -> 202 { request_id, status } immediately
 *   GET  /kodevra/requests/:id      -> current status + progress + response
 *
 * The turn itself keeps running through the existing BrowserBridge request
 * machinery (canonical recovery, tab leases, transient retries), so a temporary
 * extension disconnect is a status change here, not a lost prompt. Nothing in
 * this file reimplements the browser protocol; it only owns the record.
 *
 * State is persisted so a bridge restart can answer truthfully. A turn that was
 * in flight when the process died is reported as unrecoverable - it is never
 * resubmitted, because the prompt may already be in the ChatGPT tab and a blind
 * resubmission would duplicate a model turn.
 */

export const DURABLE_REQUEST_STATUSES = Object.freeze([
  'pending',
  'submitted',
  'waiting_for_model',
  'recovering',
  'completed',
  'failed',
  'cancelled',
]);

export const DURABLE_ERROR_CODES = Object.freeze({
  MODEL_REQUEST_FAILED: 'MODEL_REQUEST_FAILED',
  MODEL_RECOVERY_FAILED: 'MODEL_RECOVERY_FAILED',
  MODEL_RESPONSE_TIMEOUT: 'MODEL_RESPONSE_TIMEOUT',
  BRIDGE_RESTART_UNRECOVERABLE: 'BRIDGE_RESTART_UNRECOVERABLE',
  REQUEST_CANCELLED: 'REQUEST_CANCELLED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
});

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const RECOVERING_PATTERN = /recover|rebind|reattach|resume|relaunch|reload|watchdog/i;
const ANSWER_CHARS = 400_000;
const THINKING_CHARS = 16_000;
const MESSAGE_CHARS = 1_200;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function clampText(value, limit) {
  const text = `${value ?? ''}`;
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

function isTerminal(record) {
  return TERMINAL_STATUSES.has(record.status);
}

/**
 * One record per logical model turn. `request_id` is the bridge's identity;
 * `idempotency_key` is the caller's, and it is what makes a client retry safe.
 */
function newRecord({ id, idempotencyKey, promptHash, request, deadlineMs, now }) {
  const createdAt = now();
  return {
    requestId: id,
    idempotencyKey,
    promptHash,
    promptPreview: clampText(String(request.message).slice(0, 200).replaceAll('\n', '\\n'), 200),
    model: request.model || '',
    effort: request.effort || '',
    sessionId: request.sessionId || '',
    newSession: Boolean(request.newSession),
    freshTab: Boolean(request.freshTab),
    dedicatedTab: request.dedicatedTab !== false,
    createdAt,
    updatedAt: createdAt,
    lastProgressAt: createdAt,
    phase: 'pending',
    progressPreview: '',
    status: 'pending',
    terminal: false,
    deadlineAt: deadlineMs > 0 ? createdAt + deadlineMs : 0,
    completedAt: 0,
    response: null,
    error: null,
  };
}

export class DurableRequestService {
  #bridge;
  #storePath;
  #now;
  #maxRecords;
  #progressPersistMs;
  #records = new Map();
  #byIdempotencyKey = new Map();
  #deadlineTimers = new Map();
  #persistTimer = null;
  #instanceStartedAt;
  #liveStream;
  // Display cursors are memory-only on purpose: a delta is never persisted and
  // never influences the durable record.
  #liveCursors = new Map();

  constructor({ bridge, dataDir, storePath = null, now = () => Date.now(), maxRecords = 200, progressPersistMs = 500, liveStream = null } = {}) {
    if (!bridge) throw new Error('DurableRequestService requires a bridge');
    this.#bridge = bridge;
    this.#now = now;
    this.#liveStream = liveStream;
    this.#maxRecords = Math.max(20, Number(maxRecords) || 200);
    this.#progressPersistMs = Math.max(0, Number(progressPersistMs) || 0);
    this.#instanceStartedAt = now();
    this.#storePath = storePath || path.join(dataDir || process.cwd(), 'kodevra-requests.json');
    this.#restore();
  }

  get storePath() {
    return this.#storePath;
  }

  /** Submit one model turn. Returns immediately; the turn keeps running. */
  submit(body = {}) {
    const idempotencyKey = String(body.idempotency_key ?? body.idempotencyKey ?? '').trim();
    if (!idempotencyKey) {
      throw new HttpError(400, 'idempotency_key is required so a retry cannot duplicate a model turn');
    }
    if (idempotencyKey.length > 200) {
      throw new HttpError(400, 'idempotency_key must be at most 200 characters');
    }

    const request = this.#normalizeRequest(body);
    if (!request.message) throw new HttpError(400, 'No user message provided');
    const promptHash = sha256(request.message);

    const existing = this.#byIdempotencyKey.get(idempotencyKey);
    if (existing) {
      if (existing.promptHash !== promptHash) {
        throw new HttpError(
          409,
          `idempotency_key ${idempotencyKey} already belongs to request ${existing.requestId} with a different prompt; refusing to duplicate or overwrite it`,
        );
      }
      // Same key and same prompt: this is the caller retrying an ambiguous
      // submit, so the existing turn is the answer. It is never resubmitted.
      this.#settleDeadline(existing);
      if (!isTerminal(existing)) this.#touchProgress(existing, existing.phase || 'submit.accepted');
      return { record: this.#view(existing), replayed: true };
    }

    const deadlineMs = Math.max(0, Number(body.deadline_ms ?? body.deadlineMs) || 0);
    const record = newRecord({
      id: crypto.randomUUID(),
      idempotencyKey,
      promptHash,
      request,
      deadlineMs,
      now: this.#now,
    });
    this.#records.set(record.requestId, record);
    this.#byIdempotencyKey.set(idempotencyKey, record);
    this.#persist();
    log(
      `[kodevra] accepted request ${record.requestId} (key ${idempotencyKey}, ${request.message.length} chars, deadline ${
        deadlineMs > 0 ? `${Math.round(deadlineMs / 1000)}s` : 'none'
      })`,
    );
    void this.#run(record, request).catch((error) => this.#fail(record, error));
    return { record: this.#view(record), replayed: false };
  }

  /**
   * Display-only delta from the extension. Unknown or terminal requests are
   * ignored: a late delta can never resurrect a finished turn.
   */
  acceptLiveDelta(requestId, payload = {}) {
    const record = this.#records.get(String(requestId || ''));
    if (!record || isTerminal(record)) return false;
    this.#onEvent(record, { ...payload, type: 'response.delta', requestId: record.requestId });
    return true;
  }

  /** Current state of one request, or null when it was never accepted here. */
  status(requestId) {
    const record = this.#records.get(String(requestId || ''));
    if (!record) return null;
    this.#settleDeadline(record);
    return this.#view(record);
  }

  list({ limit = 50 } = {}) {
    const records = [...this.#records.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 50)));
    return records.map((record) => this.#view(record, { includeResponse: false }));
  }

  /** Explicit cancellation. The turn is terminal afterwards; it is not resumed. */
  cancel(requestId, reason = 'Cancelled by client') {
    const record = this.#records.get(String(requestId || ''));
    if (!record) return null;
    if (!isTerminal(record)) {
      this.#clearDeadlineTimer(record);
      try {
        this.#bridge.cancelRequest?.(record.requestId, reason);
      } catch (error) {
        log(`[kodevra] cancel of ${record.requestId} reported: ${error?.message || error}`);
      }
      record.status = 'cancelled';
      record.phase = 'cancelled';
      record.terminal = true;
      record.completedAt = this.#now();
      record.error = { code: DURABLE_ERROR_CODES.REQUEST_CANCELLED, message: String(reason) };
      this.#touch(record);
      this.#persist();
      this.#closeLiveStream(record);
    }
    return this.#view(record);
  }

  /** Awaitable handle for tests: resolves when a request reaches a terminal state. */
  async waitFor(requestId, { timeoutMs = 30_000, intervalMs = 25 } = {}) {
    const deadlineAt = Date.now() + Math.max(1, timeoutMs);
    for (;;) {
      const view = this.status(requestId);
      if (!view) return null;
      if (view.terminal) return view;
      if (Date.now() >= deadlineAt) return view;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  #normalizeRequest(body = {}) {
    const openai = extractRequestFromOpenAIPayload(body);
    const prompt = typeof body.prompt === 'string' ? body.prompt : typeof body.message === 'string' ? body.message : '';
    return {
      message: prompt || openai.message || '',
      model: typeof body.model === 'string' && body.model ? body.model : openai.model,
      effort: typeof body.effort === 'string' && body.effort ? body.effort : openai.effort,
      sessionId: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : openai.sessionId,
      newSession: Boolean(body.newSession ?? openai.newSession),
      freshTab: Boolean(body.freshTab ?? openai.freshTab),
      dedicatedTab: body.dedicatedTab !== false && body.dedicated_tab !== false,
      attachments: Array.isArray(body.attachments) ? body.attachments : openai.attachments || [],
    };
  }

  async #run(record, request) {
    if (isTerminal(record)) return;
    record.status = 'submitted';
    record.phase = 'submit.accepted';
    this.#touch(record);
    this.#persist();
    // The deadline frees the browser even if the client stops polling, so a
    // walking-away client cannot leave a tab owned by an abandoned turn.
    if (record.deadlineAt) {
      const timer = setTimeout(() => this.#settleDeadline(record), Math.max(0, record.deadlineAt + 5_000 - this.#now()));
      timer.unref?.();
      this.#deadlineTimers.set(record.requestId, timer);
    }
    try {
      const response = await this.#bridge.sendRequest(
        {
          message: request.message,
          attachments: Array.isArray(request.attachments) ? request.attachments : [],
          model: request.model,
          effort: request.effort,
          sessionId: request.sessionId,
          newSession: request.newSession,
          freshTab: request.freshTab,
          dedicatedTab: request.dedicatedTab,
        },
        {
          onStatus: (phase, info) => this.#onStatus(record, phase, info),
          onProgressUpdate: (text, meta) => this.#onProgress(record, text, meta),
          onEvent: (event) => this.#onEvent(record, event),
        },
        { fullResponse: true },
      );
      this.#complete(record, response);
    } catch (error) {
      this.#fail(record, error);
    }
  }

  #onStatus(record, phase, info = {}) {
    if (isTerminal(record)) return;
    const name = String(phase || '');
    const detailPhase = String(info?.phase || '');
    record.phase = detailPhase || name || record.phase;
    if (RECOVERING_PATTERN.test(name) || RECOVERING_PATTERN.test(detailPhase)) {
      record.status = 'recovering';
      const cursor = this.#liveCursor(record.requestId);
      if (!cursor.recovering) {
        cursor.recovering = true;
        this.#liveStream?.publish(record.requestId, { type: 'response.recovering', phase: record.phase, source: 'durable' });
      }
    } else {
      if (record.status === 'submitted' || record.status === 'pending') record.status = 'waiting_for_model';
      const cursor = this.#liveCursor(record.requestId);
      cursor.recovering = false;
    }
    this.#touchProgress(record, record.phase);
  }

  #liveCursor(requestId) {
    let cursor = this.#liveCursors.get(requestId);
    if (!cursor) {
      cursor = { length: 0, turnKey: '', started: false, recovering: false };
      this.#liveCursors.set(requestId, cursor);
    }
    return cursor;
  }

  /**
   * Display-only delta forwarding. Contiguity is checked against the last
   * emitted length so a reconnecting browser can never splice text into the
   * middle of the terminal output. A gap pauses the display; the durable
   * answer is unaffected either way.
   */
  #onLiveDelta(record, event = {}) {
    if (isTerminal(record)) return;
    const delta = String(event.delta || '');
    if (!delta) return;
    const answerLength = Math.max(0, Number(event.answerLength) || 0);
    const cursor = this.#liveCursor(record.requestId);
    const turnKey = String(event.turnKey || '');
    const sessionId = String(event.sessionId || '');
    if (turnKey && cursor.turnKey && turnKey !== cursor.turnKey) {
      if (answerLength > 0 && answerLength < cursor.length) {
        cursor.length = 0;
        cursor.started = false;
      }
    }
    if (turnKey) cursor.turnKey = turnKey;
    let text = delta;
    if (answerLength > 0) {
      const start = answerLength - delta.length;
      if (start < 0) return;
      if (start < cursor.length) text = delta.slice(cursor.length - start);
      else if (start > cursor.length) return;
      if (!text) return;
      cursor.length = answerLength;
    } else {
      cursor.length += text.length;
    }
    if (!cursor.started) {
      cursor.started = true;
      this.#liveStream?.publish(record.requestId, {
        type: 'response.started',
        turnKey: cursor.turnKey,
        sessionId,
        source: 'tab.stream',
      });
    }
    this.#liveStream?.publish(record.requestId, {
      type: 'response.delta',
      delta: text,
      deltaLength: text.length,
      answerLength: cursor.length,
      turnKey: cursor.turnKey,
      sessionId,
      source: 'tab.stream',
    });
    // A delta is liveness evidence for the durable record; only timestamps are
    // persisted by the existing progress throttle, never the text.
    this.#touchProgress(record, record.phase);
  }

  #onProgress(record, text, meta = {}) {
    if (isTerminal(record)) return;
    if (meta?.phase) record.phase = String(meta.phase);
    record.progressPreview = clampText(String(text ?? '').slice(0, 160).replaceAll('\n', ' '), 160);
    if (record.status === 'submitted' || record.status === 'pending') record.status = 'waiting_for_model';
    this.#touchProgress(record, record.phase);
  }

  #onEvent(record, event = {}) {
    if (isTerminal(record)) return;
    const type = String(event?.type || '');
    if (!type) return;
    if (type === 'response.delta') {
      this.#onLiveDelta(record, event);
      return;
    }
    if (type === 'prompt.delivered') {
      if (record.status !== 'recovering') record.status = 'waiting_for_model';
      this.#touchProgress(record, 'prompt_delivered');
      return;
    }
    if (RECOVERING_PATTERN.test(type)) {
      record.status = 'recovering';
      const cursor = this.#liveCursor(record.requestId);
      if (!cursor.recovering) {
        cursor.recovering = true;
        this.#liveStream?.publish(record.requestId, { type: 'response.recovering', phase: type, source: 'durable' });
      }
      this.#touchProgress(record, type);
      return;
    }
    // Generation deltas are liveness evidence: the browser is reasoning, which
    // must not be mistaken for an idle transport.
    if (/delta|generat|progress|thinking|answer|stream/i.test(type)) {
      this.#touchProgress(record, record.phase);
    }
  }

  #clearDeadlineTimer(record) {
    const timer = this.#deadlineTimers.get(record.requestId);
    if (timer) clearTimeout(timer);
    this.#deadlineTimers.delete(record.requestId);
  }

  #complete(record, response = {}) {
    if (isTerminal(record)) return;
    this.#clearDeadlineTimer(record);
    const payload = typeof response === 'string' ? { answer: response } : response || {};
    record.status = 'completed';
    record.phase = 'completed';
    record.terminal = true;
    record.completedAt = this.#now();
    record.response = {
      answer: clampText(payload.answer ?? payload.response ?? '', ANSWER_CHARS),
      thinking: clampText(payload.thinking ?? '', THINKING_CHARS),
      session: payload.session ?? null,
      url: payload.url ?? null,
      title: payload.title ?? null,
      model: payload.model ?? record.model ?? null,
      effort: payload.effort ?? record.effort ?? null,
      finishReason: payload.finishReason ?? 'stop',
      artifacts: Array.isArray(payload.artifacts) ? payload.artifacts.length : 0,
    };
    this.#touch(record);
    this.#persist();
    this.#closeLiveStream(record);
    log(
      `[kodevra] request ${record.requestId} completed in ${((record.completedAt - record.createdAt) / 1000).toFixed(1)}s (${record.response.answer.length} chars)`,
    );
  }

  #closeLiveStream(record) {
    const cursor = this.#liveCursors.get(record.requestId);
    this.#liveStream?.publish(record.requestId, {
      type: 'response.completed',
      status: record.status,
      answerLength: cursor?.length || 0,
      turnKey: cursor?.turnKey || '',
      source: 'durable',
    });
    this.#liveCursors.delete(record.requestId);
  }

  #fail(record, error) {
    if (isTerminal(record)) return;
    this.#clearDeadlineTimer(record);
    const cancelled = error?.name === 'AbortError' || Number(error?.statusCode) === 499 || error?.code === 'CANCELLED';
    record.status = cancelled ? 'cancelled' : 'failed';
    record.phase = record.status;
    record.terminal = true;
    record.completedAt = this.#now();
    const bridgeCode = String(error?.code || error?.name || '');
    const recoveryFailed = !cancelled && /canonical|recover|ambiguous|reattach/i.test(bridgeCode);
    record.error = {
      code: cancelled
        ? DURABLE_ERROR_CODES.REQUEST_CANCELLED
        : recoveryFailed
          ? DURABLE_ERROR_CODES.MODEL_RECOVERY_FAILED
          : DURABLE_ERROR_CODES.MODEL_REQUEST_FAILED,
      message: clampText(error?.message || String(error), MESSAGE_CHARS),
      bridgeCode: bridgeCode || null,
    };
    this.#touch(record);
    this.#persist();
    this.#closeLiveStream(record);
    log(`[kodevra] request ${record.requestId} ${record.status}: ${record.error.code} ${record.error.message}`);
  }

  /**
   * A turn whose configured deadline passed is over. The browser is told to stop
   * so the tab is not held by an abandoned prompt; the record keeps the reason.
   */
  #settleDeadline(record) {
    if (isTerminal(record)) return;
    if (!record.deadlineAt) return;
    // Kodevra enforces the same deadline and is the primary reporter; the small
    // grace keeps the two from racing and leaves the tab free either way.
    if (this.#now() < record.deadlineAt + 5_000) return;
    const wasStatus = record.status;
    this.#clearDeadlineTimer(record);
    try {
      this.#bridge.cancelRequest?.(record.requestId, 'Configured model deadline exceeded');
    } catch {}
    record.status = 'failed';
    record.phase = 'deadline_exceeded';
    record.terminal = true;
    record.completedAt = this.#now();
    record.error = {
      code: DURABLE_ERROR_CODES.MODEL_RESPONSE_TIMEOUT,
      message: `The configured model deadline of ${Math.round((record.deadlineAt - record.createdAt) / 1000)}s expired while the request was ${wasStatus}.`,
      bridgeCode: null,
    };
    this.#touch(record);
    this.#persist();
    this.#closeLiveStream(record);
  }

  #touch(record) {
    record.updatedAt = this.#now();
  }

  #touchProgress(record, phase) {
    record.lastProgressAt = this.#now();
    if (phase) record.phase = String(phase);
    record.updatedAt = record.lastProgressAt;
    this.#persistSoon();
  }

  #view(record, { includeResponse = true } = {}) {
    const now = this.#now();
    return {
      request_id: record.requestId,
      idempotency_key: record.idempotencyKey,
      prompt_hash: record.promptHash,
      status: record.status,
      phase: record.phase,
      terminal: isTerminal(record),
      created_at: iso(record.createdAt),
      updated_at: iso(record.updatedAt),
      last_progress_at: iso(record.lastProgressAt),
      elapsed_ms: Math.max(0, (record.completedAt || now) - record.createdAt),
      silent_for_ms: Math.max(0, now - record.lastProgressAt),
      progress_preview: record.progressPreview || '',
      response: includeResponse && record.status === 'completed' ? record.response : null,
      error: record.error,
    };
  }

  #restore() {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.#storePath, 'utf8'));
    } catch {
      parsed = null;
    }
    const stored = parsed && typeof parsed === 'object' && parsed.requests && typeof parsed.requests === 'object'
      ? parsed.requests
      : {};
    for (const [id, record] of Object.entries(stored)) {
      if (!record || typeof record !== 'object') continue;
      const hydrated = {
        ...record,
        requestId: record.requestId || id,
        createdAt: Number(record.createdAt) || this.#now(),
        updatedAt: Number(record.updatedAt) || Number(record.createdAt) || this.#now(),
        lastProgressAt: Number(record.lastProgressAt) || Number(record.createdAt) || this.#now(),
        deadlineAt: Number(record.deadlineAt) || 0,
        terminal: Boolean(record.terminal),
      };
      this.#records.set(hydrated.requestId, hydrated);
      if (hydrated.idempotencyKey) this.#byIdempotencyKey.set(hydrated.idempotencyKey, hydrated);
    }
    // Any non-terminal record on disk belonged to a previous process. Resuming it
    // would mean guessing whether the prompt reached the tab, so it is failed
    // explicitly instead of being resubmitted. Honest beats clever here.
    let stranded = 0;
    for (const record of this.#records.values()) {
      if (record.terminal) continue;
      stranded += 1;
      record.status = 'failed';
      record.phase = 'bridge_restart_unrecoverable';
      record.terminal = true;
      record.completedAt = this.#now();
      record.error = {
        code: DURABLE_ERROR_CODES.BRIDGE_RESTART_UNRECOVERABLE,
        message:
          `The bridge restarted while request ${record.requestId} was ${record.status}. ` +
          'The prompt may already have been delivered to the ChatGPT tab, so it was not resubmitted. ' +
          'Start the turn again with a new idempotency key.',
        bridgeCode: null,
      };
      record.updatedAt = record.completedAt;
    }
    if (stranded) {
      log(`[kodevra] ${stranded} request(s) from a previous bridge process were closed as unrecoverable (no prompt was resubmitted)`);
      this.#persist();
    }
  }

  #persistSoon() {
    if (this.#persistTimer || this.#progressPersistMs === 0) return;
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      this.#persist();
    }, this.#progressPersistMs);
    this.#persistTimer.unref?.();
  }

  #prune() {
    if (this.#records.size <= this.#maxRecords) return;
    const terminal = [...this.#records.values()]
      .filter((record) => record.terminal)
      .sort((a, b) => a.updatedAt - b.updatedAt);
    const excess = this.#records.size - this.#maxRecords;
    for (const record of terminal.slice(0, excess)) {
      this.#records.delete(record.requestId);
      if (this.#byIdempotencyKey.get(record.idempotencyKey) === record) this.#byIdempotencyKey.delete(record.idempotencyKey);
    }
  }

  #persist() {
    if (this.#persistTimer) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
    }
    this.#prune();
    const requests = {};
    for (const record of this.#records.values()) requests[record.requestId] = record;
    const payload = {
      version: 1,
      instanceStartedAt: iso(this.#instanceStartedAt),
      updatedAt: iso(this.#now()),
      requests,
    };
    try {
      fs.mkdirSync(path.dirname(this.#storePath), { recursive: true });
      const temporary = `${this.#storePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, this.#storePath);
    } catch (error) {
      // Persistence is a convenience for restart honesty, not a turn requirement:
      // an unwritable data directory must not fail a request that is running.
      log(`[kodevra] could not persist request state: ${error?.message || error}`);
    }
  }
}

export function createDurableRequestService(options = {}) {
  return new DurableRequestService(options);
}

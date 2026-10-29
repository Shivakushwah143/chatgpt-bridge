/**
 * Ephemeral live response events for Kodevra's chatgpt-web display.
 *
 * This is a side channel only. Deltas are never persisted, never replayed as
 * state and never used to decide that a turn finished: the durable record in
 * DurableRequestService remains the only source of truth for the answer. A
 * client that misses every event still gets the complete response from
 * GET /kodevra/requests/:id.
 *
 * Sequence numbers are assigned here, per request, so a reconnecting client can
 * resume with ?after=<last seen seq> instead of replaying the whole response.
 * The buffer is deliberately small: it exists to bridge a reconnect, not to
 * reconstruct a long answer.
 */

const MAX_EVENTS_PER_REQUEST = 64;
const MAX_BUFFERED_DELTA_CHARS = 48_000;
const MAX_STREAMS = 64;
const STREAM_TTL_MS = 5 * 60_000;

function nowMs() {
  return Date.now();
}

export class LiveResponseStream {
  #streams = new Map();

  #stream(requestId) {
    const existing = this.#streams.get(requestId);
    if (existing) return existing;
    const created = { seq: 0, events: [], bufferedChars: 0, listeners: new Set(), updatedAt: nowMs(), closed: false };
    this.#streams.set(requestId, created);
    this.#prune();
    return created;
  }

  #prune() {
    const cutoff = nowMs() - STREAM_TTL_MS;
    for (const [requestId, stream] of this.#streams) {
      if (stream.listeners.size) continue;
      if (stream.closed && stream.updatedAt < cutoff) this.#streams.delete(requestId);
    }
    while (this.#streams.size > MAX_STREAMS) {
      const oldest = [...this.#streams.entries()]
        .filter(([, stream]) => stream.listeners.size === 0)
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0];
      if (!oldest) break;
      this.#streams.delete(oldest[0]);
    }
  }

  /** Publish one display event. Returns the stored event, or null if invalid. */
  publish(requestId, event = {}) {
    const id = String(requestId || '');
    if (!id) return null;
    const type = String(event.type || '');
    if (!type) return null;
    const stream = this.#stream(id);
    stream.seq += 1;
    stream.updatedAt = nowMs();
    // A delta is forwarded verbatim: truncating it here would break the answer
    // length it was measured against, and the buffer trimming below already
    // bounds what this process retains.
    const delta = String(event.delta || '');
    const payload = Object.freeze({
      ...event,
      requestId: id,
      type,
      seq: stream.seq,
      delta,
      at: new Date(stream.updatedAt).toISOString(),
    });
    stream.events.push(payload);
    stream.bufferedChars += delta.length;
    while (stream.events.length > 1 && (stream.events.length > MAX_EVENTS_PER_REQUEST || stream.bufferedChars > MAX_BUFFERED_DELTA_CHARS)) {
      const removed = stream.events.shift();
      if (!removed) break;
      stream.bufferedChars = Math.max(0, stream.bufferedChars - removed.delta.length);
    }
    if (type === 'response.completed') stream.closed = true;
    for (const listener of [...stream.listeners]) {
      try {
        listener(payload);
      } catch {
        stream.listeners.delete(listener);
      }
    }
    return payload;
  }

  /**
   * Subscribe to one request. Buffered events newer than `after` are replayed
   * first, so a reconnect resumes where it stopped rather than from zero.
   */
  subscribe(requestId, listener, { after = 0 } = {}) {
    const id = String(requestId || '');
    if (!id || typeof listener !== 'function') return () => {};
    const stream = this.#stream(id);
    stream.listeners.add(listener);
    const resumeAfter = Math.max(0, Number(after) || 0);
    for (const event of stream.events) {
      if (event.seq <= resumeAfter) continue;
      try {
        listener(event);
      } catch {
        stream.listeners.delete(listener);
        break;
      }
    }
    return () => {
      stream.listeners.delete(listener);
      this.#prune();
    };
  }

  /** Diagnostics for tests and /diagnostics: no answer text, only counters. */
  stats(requestId) {
    const stream = this.#streams.get(String(requestId || ''));
    if (!stream) return null;
    return { seq: stream.seq, buffered: stream.events.length, listeners: stream.listeners.size, closed: stream.closed };
  }
}

export function createLiveResponseStream() {
  return new LiveResponseStream();
}

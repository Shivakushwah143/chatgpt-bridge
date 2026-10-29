import { MessageType } from './protocolV5.js';

function enqueueTerminal(state, backgroundState, envelope) {
  return backgroundState.transition(state.tabId, {
    type: 'outbox.enqueued', envelope, contentEpoch: state.contentEpoch,
  });
}

/**
 * Replays the exact persisted terminal envelope of a recorded release command.
 * The envelope identity never changes, so a duplicate delivery of the same
 * command re-emits one acknowledgement instead of hanging on a silent return.
 */
export async function replayRecordedReleaseTerminal({ state, backgroundState, command, flushCriticalOutbox }) {
  const terminalEnvelope = command?.terminalEnvelope;
  if (!terminalEnvelope) return false;
  const queued = await enqueueTerminal(state, backgroundState, terminalEnvelope);
  if (!queued.accepted && queued.reason !== 'duplicate_outbox_message') return false;
  await flushCriticalOutbox(state);
  return true;
}

/**
 * Terminally acknowledges a release of an exact lease identity that a recorded
 * release command already completed. The new command ID is answered with a
 * fresh `lease.released` envelope so its promise settles without re-dispatching
 * anything to the page.
 */
export async function emitReleaseTerminal({
  state, backgroundState, createEnvelopeDraft, flushCriticalOutbox, request, commandId, causationId,
}) {
  const terminalEnvelope = createEnvelopeDraft(state, MessageType.LEASE_RELEASED, {
    commandId, requestId: String(request.requestId || ''), released: true, activeRequest: null,
  }, { commandId, causationId, lease: request });
  const queued = await enqueueTerminal(state, backgroundState, terminalEnvelope);
  if (!queued.accepted && queued.reason !== 'duplicate_outbox_message') {
    throw new Error(`Release acknowledgement could not be persisted: ${queued.reason}`);
  }
  await flushCriticalOutbox(state);
}

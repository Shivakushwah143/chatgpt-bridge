import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { createAssistantFixtureParser } from './helpers/offlineChatDom.js';

const FULL = '{"action":"batch","operations":[{"action":"list","path":"."}]}';

async function loadResponseStream() {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/responseStreamRuntime.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: 'responseStreamRuntime.js' });
  return context.ChatGptResponseStreamRuntime;
}

function turnHtml(answerText, { status = 'Worked for 11m 23s', turnKey = 'turn-stream', requestId = 'req_1' } = {}) {
  return `
    <main>
      <div data-turn-key="${turnKey}">
        <div class="user-branch">
          <div class="group/user-message" data-chatgpt-search-unit-key="u" data-chatgpt-search-message-ids="u1"><p>List the workspace</p></div>
        </div>
        <div class="assistant-branch">
          <span hidden data-chatgpt-agent-turn-start></span>
          <div data-content-search-unit-key="a" data-chatgpt-search-unit-key="a" data-chatgpt-search-message-ids="a1" data-stream-request="${requestId}">
            ${status ? `<div class="text-token-text-tertiary" role="status"><span>${status}</span></div>` : ''}
            <div class="MarkdownRoot-abc"><p>${answerText}</p></div>
          </div>
        </div>
      </div>
    </main>`;
}

/** Feed the canonical snapshot through the same shape the tab observer emits. */
function observationFor(snapshot, { requestId = 'req_1', turnKey = 'turn-stream' } = {}) {
  return {
    activeRequest: { requestId },
    turn: { key: turnKey },
    output: { answer: snapshot.answer, state: snapshot.answer ? 'streaming' : 'reasoning' },
  };
}

test('growing canonical answer produces ordered deltas and never includes status chrome', async () => {
  const { createResponseStream } = await loadResponseStream();
  const parser = await createAssistantFixtureParser();
  const sent = [];
  const stream = createResponseStream({
    getActiveRequest: () => ({ requestId: 'req_1', assistantTurnKey: 'turn-stream' }),
    send: (payload) => sent.push(payload),
  });

  const steps = ['{"action":', '{"action":"batch",', FULL];
  for (const step of steps) {
    const snapshot = parser.parse(turnHtml(step));
    stream.observe(observationFor(snapshot));
  }

  assert.deepEqual(Array.from(sent, (payload) => payload.seq), [1, 2, 3]);
  assert.deepEqual(Array.from(sent, (payload) => payload.delta), ['{"action":', '"batch",', '"operations":[{"action":"list","path":"."}]}']);
  assert.equal(sent.map((payload) => payload.delta).join(''), FULL);
  for (const payload of sent) {
    assert.equal(payload.type, 'response.delta');
    assert.equal(payload.requestId, 'req_1');
    assert.equal(payload.turnKey, 'turn-stream');
    assert.ok(!/Worked for|Thinking|Thought for|Copy|Share|Retry|Run/.test(payload.delta), payload.delta);
  }
});

test('an assistant turn with only status text emits no deltas', async () => {
  const { createResponseStream } = await loadResponseStream();
  const parser = await createAssistantFixtureParser();
  const sent = [];
  const stream = createResponseStream({
    getActiveRequest: () => ({ requestId: 'req_1', assistantTurnKey: 'turn-stream' }),
    send: (payload) => sent.push(payload),
  });
  const snapshot = parser.parse(turnHtml('', { status: 'Thinking...' }));
  stream.observe(observationFor(snapshot));
  assert.equal(snapshot.answer, '');
  assert.deepEqual(sent, []);
});

test('the same answer observed twice emits only the growth', async () => {
  const { createResponseStream } = await loadResponseStream();
  const parser = await createAssistantFixtureParser();
  const sent = [];
  const stream = createResponseStream({
    getActiveRequest: () => ({ requestId: 'req_1', assistantTurnKey: 'turn-stream' }),
    send: (payload) => sent.push(payload),
  });
  const snapshot = parser.parse(turnHtml(FULL));
  stream.observe(observationFor(snapshot));
  stream.observe(observationFor(snapshot));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].delta, FULL);
});

test('a rewound answer re-baselines instead of splicing text', async () => {
  const { createResponseStream } = await loadResponseStream();
  const parser = await createAssistantFixtureParser();
  const sent = [];
  const stream = createResponseStream({
    getActiveRequest: () => ({ requestId: 'req_1', assistantTurnKey: 'turn-stream' }),
    send: (payload) => sent.push(payload),
  });
  stream.observe(observationFor(parser.parse(turnHtml('{"action":"batch","operations":[...]}'))));
  stream.observe(observationFor(parser.parse(turnHtml('{"action":'))));
  stream.observe(observationFor(parser.parse(turnHtml(FULL))));

  assert.equal(sent.map((payload) => payload.delta).join(''), '{"action":"batch","operations":[...]}' + FULL.slice('{"action":'.length));
  assert.equal(sent.every((payload) => payload.answerLength >= payload.delta.length), true);
});

test('a large first delta is sent as contiguous chunks', async () => {
  const { createResponseStream } = await loadResponseStream();
  const parser = await createAssistantFixtureParser();
  const sent = [];
  const stream = createResponseStream({
    getActiveRequest: () => ({ requestId: 'req_1', assistantTurnKey: 'turn-stream' }),
    send: (payload) => sent.push(payload),
  });
  const long = 'x'.repeat(20_000);
  stream.observe(observationFor(parser.parse(turnHtml(long))));

  assert.ok(sent.length >= 3);
  assert.equal(sent.map((payload) => payload.delta).join(''), long);
  assert.deepEqual(Array.from(sent, (payload) => payload.seq), sent.map((_, index) => index + 1));
  let cumulative = 0;
  assert.deepEqual(Array.from(sent, (payload) => payload.answerLength), sent.map((payload) => (cumulative += payload.delta.length)));
  assert.equal(sent.at(-1).answerLength, long.length);
  assert.equal(sent.every((payload) => payload.delta.length <= 8_000), true);
});

test('only the bound assistant turn is streamed', async () => {
  const { createResponseStream } = await loadResponseStream();
  const parser = await createAssistantFixtureParser();
  const sent = [];
  const stream = createResponseStream({
    getActiveRequest: () => ({ requestId: 'req_1', assistantTurnKey: 'turn-bound' }),
    send: (payload) => sent.push(payload),
  });
  stream.observe(observationFor(parser.parse(turnHtml(FULL, { turnKey: 'turn-other' })), { turnKey: 'turn-other' }));
  stream.observe({
    activeRequest: { requestId: 'req_other' },
    turn: { key: 'turn-bound' },
    output: { answer: FULL },
  });
  assert.deepEqual(sent, []);
});

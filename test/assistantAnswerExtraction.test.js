import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantFixtureParser } from './helpers/offlineChatDom.js';

const ACTION = '{"action":"batch","operations":[{"action":"list","path":"."}]}';

const userBranch = `
  <div class="user-branch">
    <div class="group/user-message" data-chatgpt-search-unit-key="user-unit" data-chatgpt-search-message-ids="user-message-id">
      <p>List the workspace</p>
    </div>
  </div>`;

const statusRow = (text) => `<div class="text-token-text-tertiary" role="status"><span>${text}</span></div>`;

function assistantTurn({ status = '', content, turnKey = 'turn-answer' } = {}) {
  return `
    <main>
      <div data-turn-key="${turnKey}">
        ${userBranch}
        <div class="assistant-branch">
          <span hidden data-chatgpt-agent-turn-start></span>
          <div data-content-search-unit-key="assistant-unit" data-chatgpt-search-unit-key="assistant-unit" data-chatgpt-search-message-ids="assistant-message-id">
            ${status ? statusRow(status) : ''}
            ${content}
          </div>
        </div>
      </div>
    </main>`;
}

function codeWidget({ language, code }) {
  return `
    <pre class="code-widget">
      <div class="code-toolbar">
        <span class="font-medium">${language}</span>
        <div>
          <button aria-label="Copy">Copy</button>
          <button aria-label="Run">Run</button>
        </div>
      </div>
      <div class="cm-editor">
        <pre class="cm-content readonly"><code>${code}</code></pre>
      </div>
    </pre>`;
}

test('a completed turn extracts the JSON answer and drops the "Worked for" status row', async () => {
  const parser = await createAssistantFixtureParser();
  const parsed = parser.parse(assistantTurn({
    status: 'Worked for 11m 23s',
    content: `<div class="MarkdownRoot-abc"><p>${ACTION}</p></div>`,
  }));

  assert.equal(parsed.answer, ACTION);
  assert.ok(!parsed.answer.includes('Worked for'));
  assert.deepEqual(Array.from(parsed.responseBlocks, (block) => block.text || block.markdown), [ACTION]);
});

test('a short "Worked for" duration is status text as well', async () => {
  const parser = await createAssistantFixtureParser();
  const parsed = parser.parse(assistantTurn({
    status: 'Worked for 42s',
    content: `<div class="MarkdownRoot-abc"><p>${ACTION}</p></div>`,
  }));

  assert.equal(parsed.answer, ACTION);
});

test('"Thought for" reasoning status never becomes the answer', async () => {
  const parser = await createAssistantFixtureParser();
  const parsed = parser.parse(assistantTurn({
    status: 'Thought for 4m 12s',
    content: `<div class="MarkdownRoot-abc"><p>${ACTION}</p></div>`,
  }));

  assert.equal(parsed.answer, ACTION);
});

test('plain prose answers are preserved intact next to progress chrome', async () => {
  const parser = await createAssistantFixtureParser();
  const parsed = parser.parse(assistantTurn({
    status: 'Thinking...',
    content: '<div class="MarkdownRoot-abc"><p>The workspace contains two files and one directory.</p></div>',
  }));

  assert.equal(parsed.answer, 'The workspace contains two files and one directory.');
});

test('code blocks keep their code and exclude Copy/Run UI chrome', async () => {
  const parser = await createAssistantFixtureParser();
  const parsed = parser.parse(assistantTurn({
    status: 'Worked for 42s',
    content: `<div class="MarkdownRoot-abc"><p>Here is the file:</p></div>
      ${codeWidget({ language: 'JavaScript', code: 'const answer = 42;\nconsole.log(answer);' })}`,
  }));

  const code = parsed.codeBlocks[0];
  assert.ok(code, 'expected a parsed code block');
  assert.equal(code.code.trimEnd(), 'const answer = 42;\nconsole.log(answer);');
  assert.ok(parsed.answer.includes('const answer = 42;'));
  assert.ok(!/Copy|Run\b|Worked for/.test(parsed.answer), `unexpected UI chrome in answer: ${parsed.answer}`);
});

test('reload/recovery reads the same canonical answer as normal completion', async () => {
  const parser = await createAssistantFixtureParser();
  const html = assistantTurn({
    status: 'Worked for 11m 23s',
    content: `<div class="MarkdownRoot-abc"><p>${ACTION}</p></div>`,
  });

  const completed = parser.parse(html);
  assert.equal(completed.answer, ACTION);

  const mounted = parser.mount(html);
  const byTurnKey = parser.snapshots.readAssistantSnapshotByTurnKey('turn-answer::assistant');
  assert.ok(byTurnKey, 'expected a turn-key snapshot');
  assert.equal(byTurnKey.answer, ACTION);

  const recovered = parser.snapshots.readRecentAssistantSnapshots();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].answer, ACTION);
  assert.equal(recovered[0].turnKey, 'turn-answer::assistant');
  assert.ok(mounted);
});

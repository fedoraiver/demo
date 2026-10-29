const assert = require('node:assert/strict');
const test = require('node:test');
const { renumberTasks, synchronizeIssue } = require('./renumber_issue_tasks.cjs');

function issueContext(overrides = {}) {
  return {
    repo: { owner: 'fedoraiver', repo: 'demo' },
    eventName: 'issues',
    payload: {
      action: 'edited',
      issue: { number: 11, body: '1. [ ] Stale event body' },
      changes: { body: { from: 'Previous body' } },
    },
    ...overrides,
  };
}

function fakeApi(bodies) {
  const reads = [];
  const writes = [];
  const messages = [];
  return {
    reads,
    writes,
    messages,
    core: { info: (message) => messages.push(message) },
    github: {
      rest: {
        issues: {
          async get(parameters) {
            assert.ok(reads.length < bodies.length, 'Unexpected issue read');
            const body = bodies[reads.length];
            reads.push(parameters);
            return { data: { body } };
          },
          async update(parameters) {
            writes.push(parameters);
            return { data: { body: parameters.body } };
          },
        },
      },
    },
  };
}

test('numbers top-level tasks, including completed tasks, without changing list markers', () => {
  const body = '1. [ ] First\n22) [x] Second\n- [X] Third\n* [ ] Fourth\n+ [ ] Fifth';
  assert.equal(
    renumberTasks(body),
    '1. [ ] **1.** First\n22) [x] **2.** Second\n- [X] **3.** Third\n* [ ] **4.** Fourth\n+ [ ] **5.** Fifth',
  );
});

test('renumbers moved tasks and does not accumulate generated prefixes', () => {
  const body = '1. [x] **3.** Last moved first\n1. [ ] **1.** First\n1. [ ] **2.** Middle';
  const expected = '1. [x] **1.** Last moved first\n1. [ ] **2.** First\n1. [ ] **3.** Middle';
  assert.equal(renumberTasks(body), expected);
  assert.equal(renumberTasks(expected), expected);
});

test('numbers inserted tasks and closes gaps after deleting a task', () => {
  const body = '- [ ] **1.** Existing\n- [ ] Inserted\n- [x] **4.** Remaining';
  assert.equal(
    renumberTasks(body),
    '- [ ] **1.** Existing\n- [ ] **2.** Inserted\n- [x] **3.** Remaining',
  );
});

test('preserves whitespace, CRLF endings, and text that starts with literal numbers', () => {
  const body = '-  [ ]\t2. Literal content  \r\n\r\n3. [x]  **9.**  Item\r\n';
  assert.equal(
    renumberTasks(body),
    '-  [ ]\t**1.** 2. Literal content  \r\n\r\n3. [x]  **2.**  Item\r\n',
  );
});

test('keeps multiline descriptions, Rust code, and images attached to a 21-task list', () => {
  // 对应 Issue 的多行说明、三空格缩进代码块及末尾图片，防止重编号拆散任务正文。
  const tasks = Array.from({ length: 21 }, (_, index) => {
    const number = index + 1;
    let content = `Task ${number}`;
    if (number === 3) content += '\nresume_interpolation相对应。';
    if (number === 11) {
      content += '\n\n   ```rust\n   pub(crate) fn path() -> &\'static str {\n       "models/props/prop_crate.glb"\n   }\n   ```';
    }
    if (number === 20 || number === 21) {
      content += `\n\n   <img width="890" alt="Image" src="https://github.com/user-attachments/assets/image-${number}" />`;
    }
    return { content, checked: number === 4 ? 'x' : ' ' };
  });
  const body = tasks.map(({ content, checked }) => `1. [${checked}] ${content}`).join('\n');
  const expected = tasks.map(({ content, checked }, index) => `1. [${checked}] **${index + 1}.** ${content}`).join('\n');
  assert.equal(renumberTasks(body), expected);
  assert.equal(renumberTasks(expected), expected);
});

test('skips nested tasks, blockquotes, indented code, and non-task lists', () => {
  const body = [
    '- [ ] Parent',
    '  - [ ] Nested task',
    '    1. [ ] Indented code',
    '\t- [ ] Tab-indented code',
    '> - [ ] Quoted task',
    '- Ordinary list item',
    '[ ] Plain text',
    '- [no] Plain text',
    '- [ ] Next parent',
  ].join('\n');
  assert.equal(
    renumberTasks(body),
    body.replace('- [ ] Parent', '- [ ] **1.** Parent').replace('- [ ] Next parent', '- [ ] **2.** Next parent'),
  );
});

test('ignores tasks inside backtick and tilde fences, including longer fences', () => {
  const body = [
    '- [ ] Before',
    '   ````markdown',
    '- [ ] In code',
    '```',
    '- [ ] Still in code',
    '   ````',
    '~~~markdown',
    '1. [ ] Also in code',
    '~~~',
    '- [x] After',
  ].join('\n');
  assert.equal(
    renumberTasks(body),
    body.replace('- [ ] Before', '- [ ] **1.** Before').replace('- [x] After', '- [x] **2.** After'),
  );
});

test('keeps an unfinished fenced example and bodies without tasks unchanged', () => {
  for (const body of ['', 'Plain text\n', '```markdown\n- [ ] Example']) {
    assert.equal(renumberTasks(body), body);
  }
});

test('synchronizes the current body rather than the event snapshot and patches only the body', async () => {
  const api = fakeApi(['1. [ ] Current body', '1. [ ] Current body']);
  const result = await synchronizeIssue({ ...api, context: issueContext() });
  assert.equal(result.changed, true);
  assert.deepEqual(api.reads, [
    { owner: 'fedoraiver', repo: 'demo', issue_number: 11 },
    { owner: 'fedoraiver', repo: 'demo', issue_number: 11 },
  ]);
  assert.deepEqual(api.writes, [{
    owner: 'fedoraiver',
    repo: 'demo',
    issue_number: 11,
    body: '1. [ ] **1.** Current body',
  }]);
});

test('does not write when current numbering is already correct or the body is empty', async () => {
  for (const body of ['1. [ ] **1.** Correct', '', null]) {
    const api = fakeApi([body]);
    const result = await synchronizeIssue({ ...api, context: issueContext() });
    assert.equal(result.changed, false);
    assert.equal(api.reads.length, 1);
    assert.deepEqual(api.writes, []);
  }
});

test('recomputes after an intervening edit instead of overwriting that edit', async () => {
  const editedBody = '1. [x] New first\n1. [ ] Original';
  const api = fakeApi(['1. [ ] Original', editedBody, editedBody, editedBody]);
  const result = await synchronizeIssue({ ...api, context: issueContext() });
  assert.equal(result.changed, true);
  assert.equal(api.reads.length, 4);
  assert.equal(api.writes.length, 1);
  assert.equal(api.writes[0].body, '1. [x] **1.** New first\n1. [ ] **2.** Original');
});

test('can succeed on the third and final synchronization attempt', async () => {
  const api = fakeApi([
    '- [ ] A', '- [ ] B',
    '- [ ] B', '- [ ] C',
    '- [ ] C', '- [ ] C',
  ]);
  const result = await synchronizeIssue({ ...api, context: issueContext() });
  assert.equal(result.changed, true);
  assert.equal(api.reads.length, 6);
  assert.equal(api.writes[0].body, '- [ ] **1.** C');
});

test('fails after three unstable attempts without issuing a stale update', async () => {
  const api = fakeApi(['- [ ] A', '- [ ] B', '- [ ] B', '- [ ] C', '- [ ] C', '- [ ] D']);
  await assert.rejects(synchronizeIssue({ ...api, context: issueContext() }));
  assert.equal(api.reads.length, 6);
  assert.deepEqual(api.writes, []);
});

test('manual dispatch initializes issue 11 without an issue event payload', async () => {
  const api = fakeApi(['- [ ] First', '- [ ] First']);
  const context = issueContext({ eventName: 'workflow_dispatch', payload: {} });
  const result = await synchronizeIssue({ ...api, context });
  assert.equal(result.changed, true);
  assert.equal(api.writes[0].issue_number, 11);
});

test('ignores other issues, repositories, activity types, and title-only edits', async () => {
  const base = issueContext();
  const contexts = [
    issueContext({ repo: { owner: 'someone-else', repo: 'demo' } }),
    issueContext({ repo: { owner: 'fedoraiver', repo: 'another-repo' } }),
    issueContext({ payload: { ...base.payload, issue: { number: 12 } } }),
    issueContext({ payload: { ...base.payload, action: 'opened' } }),
    issueContext({ payload: { ...base.payload, changes: { title: { from: 'Old title' } } } }),
    issueContext({ eventName: 'push', payload: {} }),
  ];
  for (const context of contexts) {
    const api = fakeApi([]);
    const result = await synchronizeIssue({ ...api, context });
    assert.equal(result.changed, false);
    assert.equal(result.skipped, true);
    assert.deepEqual(api.reads, []);
    assert.deepEqual(api.writes, []);
  }
});

test('propagates API failures instead of reporting successful synchronization', async () => {
  const api = fakeApi(['- [ ] First', '- [ ] First']);
  api.github.rest.issues.update = async () => { throw new Error('Write denied'); };
  await assert.rejects(
    synchronizeIssue({ ...api, context: issueContext() }),
    /Write denied/,
  );
});

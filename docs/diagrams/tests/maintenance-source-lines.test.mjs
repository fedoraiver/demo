import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repositoryRoot } from '../src/paths.mjs';
import { fixSourceLines, planSourceLineFixes, applySourceLineFixes } from '../src/maintenance-source-lines.mjs';

function fixture(t, { code = '// 说明\r\n\r\npub struct DemoPlugin;\r\npub fn tick() {}\r\n', model } = {}) {
  const parent = path.join(repositoryRoot, 'tmp/ecs-architecture/source-lines-tests');
  fs.mkdirSync(parent, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(parent, 'case-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, 'docs/diagrams/catalog'), { recursive: true }); fs.mkdirSync(path.join(workspace, 'src'));
  const catalog = path.join(workspace, 'docs/diagrams/catalog/ecs-data.json'), source = path.join(workspace, 'src/demo.rs');
  model ||= { features: [{ id: 'demo', plugin: 'DemoPlugin', source: { path: 'src/demo.rs', line: 1 } }], systems: [{ id: 'tick', name: 'tick', kind: 'System', source: { path: 'src/demo.rs', line: 1 }, definition_source: { path: 'src/demo.rs', line: 1 } }], note: '保留 \"line\": 987 和转义文字' };
  const text = JSON.stringify(model, null, 3).replaceAll('\n', '\r\n') + '\r\n';
  fs.writeFileSync(catalog, text); fs.writeFileSync(source, code);
  return { workspace, catalog, source, text, model };
}

test('dry run proposes only reviewed unique definitions without modifying bytes', async t => {
  const f = fixture(t), result = await fixSourceLines({ workspace: f.workspace });
  assert.equal(result.applied, false); assert.equal(result.changed, 0);
  assert.deepEqual(result.proposals.map(p => [p.symbol, p.from, p.to]), [['DemoPlugin', 1, 3], ['tick', 1, 4]]);
  assert(result.ignored.some(entry => entry.entry === '/systems/0/source' && entry.role === 'unclassified'));
  assert.equal(fs.readFileSync(f.catalog, 'utf8'), f.text);
});

test('apply replaces numeric line tokens and preserves every unrelated byte and CRLF', async t => {
  const f = fixture(t), plan = planSourceLineFixes({ workspace: f.workspace });
  let expected = f.text;
  for (const p of [...plan.proposals].sort((a, b) => b.start - a.start)) expected = expected.slice(0, p.start) + p.to + expected.slice(p.end);
  const result = await fixSourceLines({ workspace: f.workspace, apply: true });
  assert.equal(result.changed, 2); assert.deepEqual(fs.readFileSync(f.catalog), Buffer.from(expected));
  const again = await fixSourceLines({ workspace: f.workspace, apply: true });
  assert.equal(again.changed, 0);
});

test('already correct reviewed line produces no proposal', async t => {
  const f = fixture(t, { code: 'pub struct DemoPlugin;\nfn tick() {}\n' });
  f.model.systems[0].definition_source.line = 2; fs.writeFileSync(f.catalog, JSON.stringify(f.model));
  assert.deepEqual((await fixSourceLines({ workspace: f.workspace })).proposals, []);
});

for (const [label, code, pattern] of [
  ['missing', 'fn unrelated() {}\n', /found 0/],
  ['ambiguous', 'struct DemoPlugin;\nstruct DemoPlugin;\nfn tick() {}\n', /found 2/],
]) test(label + ' declaration refuses all changes even if another definition is unique', async t => {
  const f = fixture(t, { code });
  await assert.rejects(fixSourceLines({ workspace: f.workspace, apply: true }), pattern);
  assert.equal(fs.readFileSync(f.catalog, 'utf8'), f.text);
});

test('unsupported roles, bare sources, generics, registrations and dependencies are ignored', async t => {
  const model = { systems: [
    { id: 'bare', kind: 'System', name: 'tick', source: { path: 'src/demo.rs', line: 99 } },
    { id: 'registration', kind: 'Observer', name: 'tick', source: { path: 'src/demo.rs', line: 99, role: 'registration' } },
    { id: 'generic', kind: 'System', name: 'tick<T>', definition_source: { path: 'src/demo.rs', line: 99 } },
    { id: 'dependency', kind: 'System', name: 'tick', definition_source: { path: 'src/demo.rs', line: 99, dependency: { name: 'dep' } } },
  ], entities: [{ id: 'x', components: [{ name: 'DemoPlugin', source: { role: 'definition', path: 'src/demo.rs', line: 99 } }] }] };
  const f = fixture(t, { model }), result = await fixSourceLines({ workspace: f.workspace, apply: true });
  assert.equal(result.changed, 0); assert.equal(result.ignored.length, 5); assert.equal(fs.readFileSync(f.catalog, 'utf8'), f.text);
});

test('explicit definition roles work for System, Observer and Plugin', async t => {
  const model = { nodes: [{ id: 'plugin', name: 'DemoPlugin', kind: 'Plugin', sourceEntries: [{ role: 'definition', path: 'src/demo.rs', line: 1 }] }], systems: [{ id: 'observer', name: 'tick', kind: 'Observer', source: { role: 'definition', path: 'src/demo.rs', line: 1 } }] };
  const f = fixture(t, { model });
  assert.deepEqual((await fixSourceLines({ workspace: f.workspace })).proposals.map(p => p.to), [3, 4]);
});

for (const target of ['source', 'catalog']) test(target + ' input race refuses whole plan', t => {
  const f = fixture(t), plan = planSourceLineFixes({ workspace: f.workspace });
  fs.appendFileSync(f[target], target === 'source' ? '// raced\n' : ' ');
  const before = fs.readFileSync(f.catalog);
  assert.throws(() => applySourceLineFixes(plan), /input changed/);
  assert.deepEqual(fs.readFileSync(f.catalog), before);
});

test('comments, strings and wrong specified files never provide declaration matches', async t => {
  const f = fixture(t, { code: '// struct DemoPlugin;\nconst TEXT: &str = "struct DemoPlugin;";\nfn tick() {}\n' });
  fs.writeFileSync(path.join(f.workspace, 'src/elsewhere.rs'), 'struct DemoPlugin;\n');
  await assert.rejects(fixSourceLines({ workspace: f.workspace }), /found 0/);
});

for (const operation of ['change', 'add', 'remove']) test('unrelated source ' + operation + ' refuses the complete plan', t => {
  const f = fixture(t), other = path.join(f.workspace, 'src/other.rs');
  if (operation !== 'add') fs.writeFileSync(other, '// unrelated\n');
  const plan = planSourceLineFixes({ workspace: f.workspace });
  if (operation === 'remove') fs.unlinkSync(other); else fs.writeFileSync(other, '// changed\n');
  assert.throws(() => applySourceLineFixes(plan), /input changed/);
  assert.equal(fs.readFileSync(f.catalog, 'utf8'), f.text);
});

test('multiple declarations on one line are ambiguous', async t => {
  const f = fixture(t, { code: 'struct DemoPlugin; struct DemoPlugin; fn tick() {}\n' });
  await assert.rejects(fixSourceLines({ workspace: f.workspace, apply: true }), /found 2/);
});

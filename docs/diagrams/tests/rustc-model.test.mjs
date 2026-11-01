import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateCompilerModel, validateCompilerCallGraph, readCompilerModel, createCompilerObjectCatalog, compilerSourceResolver, bindCompilerSchedules, sourceKey, viewerModel, summarizeAnalysisGaps } from '../src/rustc-model.mjs';
import { summarizeModel } from '../../../.agents/skills/update-ecs-architecture/scripts/maintenance-summary.mjs';
import { sourceFingerprint } from '../src/debugdump-input.mjs';
import { renderGraphView } from '../src/architecture-renderer.mjs';
import { checkObjectViews } from '../src/check-ecs.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const parent = path.join(root, 'tmp/ecs-architecture/compiler-model-tests'); fs.mkdirSync(parent, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(parent, 'model-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'Cargo.toml'), '[package]\nname="fixture"\nversion="0.1.0"\n');
  fs.writeFileSync(path.join(workspace, 'Cargo.lock'), '');
  const content = 'fn system() {}\n'; fs.writeFileSync(path.join(workspace, 'src/main.rs'), content);
  const source = { path: 'src/main.rs', line: 1, column: 1, role: 'definition' };
  const object = (id, kind) => ({ id, kind, name: id, description: '具体职责。', display_summary: '具体职责。', feature: 'project', sourceEntries: [source], sourceGaps: [] });
  const model = { schemaVersion: 1, compiler: 'pinned-compiler', configuration: { target: 'host', features: ['debugdump'] },
    inputs: { sourceFingerprint: sourceFingerprint(workspace) }, features: [{ id: 'project', label: '项目' }],
    objects: [object('decl-plugin', 'Plugin'), object('registration-1', 'System'), object('registration-2', 'System'), object('template-root', 'Entity'), object('type-component', 'Component'), object('isolated', 'Resource')],
    relations: [
      { id: 'install', from: 'decl-plugin', to: 'registration-1', kind: 'registration', sourceEntries: [source] },
      { id: 'contains', from: 'template-root', to: 'type-component', kind: 'contains', sourceEntries: [source] },
      { id: 'read', from: 'type-component', to: 'registration-1', kind: 'read', sourceEntries: [source] },
      { id: 'mutable', from: 'registration-2', to: 'type-component', kind: 'mutable_access', sourceEntries: [source] },
      { id: 'entity-reference', from: 'registration-1', to: 'template-root', kind: 'reference', sourceEntries: [source] },
    ], sourceFiles: [{ path: 'src/main.rs', content, sha256: sha(content) }], annotationsRequired: [], scheduleInteractions: { schemaVersion: 1, views: [] } };
  return { workspace, model, object };
}

test('compiler model is the sole input and requires declared source evidence', t => {
  const { workspace, model } = fixture(t);
  assert.doesNotThrow(() => validateCompilerModel(model, { workspace }));
  assert.throws(() => readCompilerModel(workspace), /Missing compiler architecture model/);
  const missing = structuredClone(model); missing.sourceFiles = [];
  assert.throws(() => validateCompilerModel(missing), /no matching snapshot/);
  const forged = structuredClone(model); forged.sourceFiles[0].content += '// forged';
  assert.throws(() => validateCompilerModel(forged), /Invalid or duplicate compiler source snapshot/);
});

test('explicit identities preserve duplicate registrations and isolated objects', t => {
  const { model } = fixture(t); model.objects[1].name = model.objects[2].name = 'same_function';
  const catalog = createCompilerObjectCatalog(model);
  assert.equal(catalog.objects.length, model.objects.length);
  assert.equal(catalog.objectById['registration-1'].id, 'registration-1');
  assert.equal(catalog.objectById['registration-2'].id, 'registration-2');
  assert.equal(catalog.graphFor('isolated').nodes.length, 1);
  const duplicate = structuredClone(model); duplicate.objects.push(duplicate.objects[0]);
  assert.throws(() => validateCompilerModel(duplicate), /Duplicate compiler object identity/);
});

test('one-hop presentation keeps full facts while hiding Entity components and Plugin neighbors', t => {
  const { model } = fixture(t), registry = Object.fromEntries(model.objects.map(object => [object.id, object]));
  const catalog = createCompilerObjectCatalog(model, registry);
  assert.equal(catalog.links.length, model.relations.length);
  assert.deepEqual(catalog.graphFor('decl-plugin').nodes.map(node => node.id), ['decl-plugin']);
  assert.equal(catalog.graphFor('decl-plugin').links.length, 0);
  assert.deepEqual(new Set(catalog.graphFor('template-root').nodes.map(node => node.id)), new Set(['template-root', 'registration-1']));
  assert.deepEqual(catalog.graphFor('type-component').links.map(link => link.id), ['contains', 'read', 'mutable']);
  assert.equal(catalog.graphFor('type-component').links.find(link => link.id === 'mutable').kind, 'write');
  assert.equal(catalog.graphFor('type-component').links.find(link => link.id === 'mutable').factKind, 'mutable_access');
  const views = catalog.objects.map(object => renderGraphView({ id: object.viewId, objectId: object.id, centerNodeId: object.id,
    feature: object.feature, aspect: 'object', label: object.id, summary: '一跳对象关系。' }, catalog.graphFor(object.id), registry, model.features));
  assert.equal(checkObjectViews(views, catalog), catalog.objects.length);
  const view = views.find(view => view.objectId === 'type-component'); view.links.pop();
  assert.throws(() => checkObjectViews(views, catalog), /incident-link coverage mismatch/);
  assert.deepEqual(viewerModel(model).entities, [{ id: 'template-root', canonical_entity: 'template-root', components: [{ id: 'type-component' }] }]);
});

test('runtime predicates keep their own objects and reference the guarded object without fabricated DOT nodes', t => {
  const { model, object } = fixture(t);
  model.objects.push({ ...object('runtime-predicate', 'System'), registrationScope: 'runtime-system-condition' });
  model.relations.push({ id: 'runtime-guard', from: 'runtime-predicate', to: 'registration-1', kind: 'condition', label: '运行条件', evidence: 'runtime', sourceEntries: [] });
  const before = JSON.stringify(model), catalog = createCompilerObjectCatalog(model), graph = catalog.graphFor('runtime-predicate');
  assert.doesNotThrow(() => validateCompilerModel(model));
  assert.deepEqual(graph.nodes.map(node => node.id), ['runtime-predicate', 'registration-1']);
  assert.deepEqual(graph.links[0], { ...model.relations.at(-1), kind: 'reference', factKind: 'condition', operation: 'condition' });
  const registry = Object.fromEntries(model.objects.map(record => [record.id, record]));
  const view = renderGraphView({ id: catalog.objectById['runtime-predicate'].viewId, objectId: 'runtime-predicate', centerNodeId: 'runtime-predicate',
    feature: 'project', aspect: 'object', label: '运行条件', summary: '谓词及直接受控对象。' }, graph, registry, model.features);
  assert.equal(view.links[0].displayLabel, '运行条件');
  assert.deepEqual(model.scheduleInteractions.views, []);
  assert.equal(JSON.stringify(model), before);
});

test('compiler event access and trigger operations render exact observe and emit semantics', t => {
  const { model, object } = fixture(t);
  model.objects.push(object('typed-event', 'Event'), object('typed-entity-event', 'EntityEvent'), object('registered-observer', 'Observer'));
  const sources = model.objects[0].sourceEntries;
  const facts = [{ id: 'global-observation', from: 'typed-event', to: 'registered-observer', kind: 'event', label: '观察事件', sourceEntries: sources },
    { id: 'entity-observation', from: 'typed-entity-event', to: 'registered-observer', kind: 'event', sourceEntries: sources },
    { id: 'body-trigger', from: 'registration-1', to: 'typed-event', kind: 'trigger', label: '触发事件', sourceEntries: sources }];
  model.relations.push(...facts);
  const before = JSON.stringify(model), registry = Object.fromEntries(model.objects.map(record => [record.id, record]));
  const catalog = createCompilerObjectCatalog(model), graph = catalog.graphFor('typed-event');
  const view = renderGraphView({ id: catalog.objectById['typed-event'].viewId, objectId: 'typed-event', centerNodeId: 'typed-event',
    feature: 'project', aspect: 'object', label: '事件关系', summary: '编译器事件事实。' }, graph, registry, model.features);
  for (const [fact, semantic] of [[facts[0], 'observe'], [facts[2], 'emit']]) {
    const link = view.links.find(link => link.id === fact.id);
    assert.deepEqual([link.from, link.to, link.kind, link.edgeSemantic, link.factKind, link.operation],
      [fact.from, fact.to, semantic, semantic, fact.kind, fact.kind]);
    assert.deepEqual(link.sourceEntries, fact.sourceEntries);
  }
  assert.equal(catalog.links.find(link => link.id === 'entity-observation').kind, 'observe');
  assert.deepEqual(model.scheduleInteractions.views, []);
  assert.equal(catalog.objects.length, model.objects.length);
  assert.equal(JSON.stringify(model), before);
});

test('pending Chinese purposes stop publication without changing compiler facts', t => {
  const { model } = fixture(t); model.annotationsRequired = [{ key: 'decl::new', evidenceHash: 'current' }];
  const before = JSON.stringify(model.relations);
  assert.throws(() => validateCompilerModel(model), error => error.code === 'ANNOTATIONS_REQUIRED' && error.requests.length === 1);
  assert.doesNotThrow(() => validateCompilerModel(model, { allowPending: true }));
  assert.equal(JSON.stringify(model.relations), before);
  model.bindingErrors = ['missing rustc declaration'];
  assert.throws(() => validateCompilerModel(model, { allowPending: true }), /binding is incomplete/);
});

test('Schedule binding accepts only actual graph names and exact DOT bytes', t => {
  const { model } = fixture(t); const dot = 'digraph { real [label="renamed"] }';
  model.scheduleInteractions.views = [{ viewId: 'schedule-real', dotSha256: sha(dot), bindings: [{ id: 'bound-1', kind: 'system', graphName: 'real', objectId: 'registration-1' }] }];
  const views = [{ id: 'schedule-real', dot, scheduleGraph: { nodes: [{ name: 'real', attributes: { tooltip: 'runtime display' } }], subgraphs: [] } }];
  assert.doesNotThrow(() => bindCompilerSchedules(model, views));
  assert.throws(() => bindCompilerSchedules(model, [{ ...views[0], dot: dot + ' ' }]), /DOT binding mismatch/);
  assert.throws(() => bindCompilerSchedules(model, [{ ...views[0], scheduleGraph: { nodes: [{ name: 'same_display_name' }], subgraphs: [] } }]), /does not exist in DOT/);
  const incomplete = structuredClone(model); incomplete.scheduleInteractions.views[0].bindings = [];
  assert.throws(() => bindCompilerSchedules(incomplete, views), /missing an actual Schedule system/);
  const setView = structuredClone(views); setView[0].scheduleGraph.subgraphs.push({ name: 'clusternode_Set(SystemSetKey(1v1))' });
  assert.throws(() => bindCompilerSchedules(model, setView), /missing an actual Schedule set/);
});

test('source snapshots retain complete text and allow only newline differences', t => {
  const { workspace, model } = fixture(t);
  fs.writeFileSync(path.join(workspace, 'src/main.rs'), 'fn system() {}\r\n');
  assert.doesNotThrow(() => validateCompilerModel(model, { workspace }));
  assert.equal(compilerSourceResolver(model).read({ path: 'src/main.rs' }).text, model.sourceFiles[0].content);
  fs.writeFileSync(path.join(workspace, 'src/main.rs'), 'fn system() { changed(); }\n');
  assert.throws(() => validateCompilerModel(model, { workspace }), /fingerprint is stale/);
  assert.throws(() => sourceKey({ path: '../secret.rs' }), /Unsafe compiler source path/);
  assert.throws(() => sourceKey({ path: 'src/lib.rs', dependency: { name: '../bad', version: '1.0.0' } }), /Invalid compiler dependency/);
});

function callGraphFixture(t) {
  const { model } = fixture(t), content = 'if enabled { helper(); }\nelse { commands.queue(helper); }\n';
  model.sourceFiles.push({ path: 'src/guards.rs', content, sha256: sha(content) });
  const entry = line => ({ path: 'src/guards.rs', line, column: 1, role: 'call' });
  const edge = (id, line, deferred, expression, guardKind = 'condition') => ({ id, caller: 'callable::registered_root', callee: 'callable::shared_helper', declaration: 'declaration::shared_helper',
    registeredOwners: ['registration-1', 'registration-2'], deferred, sourceEntries: [entry(line)], conditions: [{ ...entry(line), role: 'operation', expression, guardKind }] });
  model.callGraph = { schemaVersion: 1, edges: [edge('branch-direct', 1, false, 'enabled'), edge('branch-deferred', 2, true, 'enabled', 'unless'),
    { ...edge('helper-recursion', 1, false, 'retry'), caller: 'callable::shared_helper' }] };
  return model;
}

test('typed call graph preserves alternative guards, deferred calls and recursion without object IDs for callables', t => {
  const model = callGraphFixture(t), before = JSON.stringify(model.callGraph);
  assert.doesNotThrow(() => validateCompilerModel(model));
  assert.equal(JSON.stringify(model.callGraph), before);
  assert.deepEqual(model.callGraph.edges.slice(0, 2).map(({ callee, deferred, conditions }) => [callee, deferred, conditions[0].expression, conditions[0].guardKind, conditions[0].role]),
    [['callable::shared_helper', false, 'enabled', 'condition', 'operation'], ['callable::shared_helper', true, 'enabled', 'unless', 'operation']]);
  const unresolved = structuredClone(model); unresolved.callGraph.edges[0].callee = unresolved.callGraph.edges[0].declaration = null;
  assert.doesNotThrow(() => validateCompilerModel(unresolved));
  for (const guardKind of ['match-value', 'match-arm']) {
    const match = structuredClone(model); match.callGraph.edges[0].conditions[0].guardKind = guardKind;
    assert.doesNotThrow(() => validateCompilerModel(match));
    assert.equal(match.callGraph.edges[0].conditions[0].guardKind, guardKind);
    assert.equal(match.callGraph.edges[0].conditions[0].role, 'operation');
  }
});

test('call graph rejects duplicate edge identities, unknown registrations and malformed evidence', t => {
  const model = callGraphFixture(t), duplicate = structuredClone(model);
  duplicate.callGraph.edges.push(duplicate.callGraph.edges[0]);
  assert.throws(() => validateCompilerModel(duplicate), /duplicate compiler call edge identity/);
  const owner = structuredClone(model); owner.callGraph.edges[0].registeredOwners = ['callable::registered_root'];
  assert.throws(() => validateCompilerModel(owner), /Unknown compiler call registration owner/);
  const malformed = structuredClone(model); malformed.callGraph.edges[0].sourceEntries[0].line = '1';
  assert.throws(() => validateCompilerModel(malformed), /Invalid compiler call evidence/);
  const schema = structuredClone(model); schema.callGraph.schemaVersion = 2;
  assert.throws(() => validateCompilerModel(schema), /Unsupported compiler call graph/);
  const guard = structuredClone(model); guard.callGraph.edges[0].conditions[0].guardKind = 'invented';
  assert.throws(() => validateCompilerModel(guard), /Invalid compiler guard kind/);
});

test('call graph and guard spans require matching complete source snapshots and valid hashes', t => {
  const model = callGraphFixture(t), call = structuredClone(model);
  call.callGraph.edges[0].sourceEntries[0].path = 'src/missing.rs';
  assert.throws(() => validateCompilerModel(call), /no matching snapshot: src\/missing.rs/);
  const guard = structuredClone(model); guard.callGraph.edges[0].conditions[0].line = 99;
  assert.throws(() => validateCompilerModel(guard), /no matching snapshot: src\/guards.rs/);
  const hash = structuredClone(model); hash.sourceFiles.find(source => source.path === 'src/guards.rs').sha256 = '0'.repeat(64);
  assert.throws(() => validateCompilerModel(hash), /Invalid or duplicate compiler source snapshot: src\/guards.rs/);
});

test('global analysis boundaries preserve compiler owners, complete evidence and visible summaries', t => {
  const { model } = fixture(t);
  model.analysisGaps = [{ unit: 'crate-a#hash', owner: 'unit', kind: 'mir-budget', reason: 'MIR 分析达到预算上限。', sourceEntries: [] },
    { unit: 'crate-b#hash', owner: 'callable::unmatched', kind: 'unmatched', reason: '未找到对应注册。', sourceEntries: [{ path: 'src/main.rs', line: 1, role: 'related' }] },
    { unit: 'crate-b#hash', owner: 'type::opaque', kind: 'unmatched', reason: '类型拥有的分析边界。', sourceEntries: [] }];
  assert.doesNotThrow(() => validateCompilerModel(model));
  const summary = summarizeModel({ model, registry: Object.fromEntries(model.objects.map(object => [object.id, object])) });
  assert.deepEqual(summary.analysisGaps, model.analysisGaps);
  assert.deepEqual(summary.analysisGapSummary, { count: 3, byKind: { 'mir-budget': 1, unmatched: 2 }, byUnit: { 'crate-a#hash': 1, 'crate-b#hash': 2 } });
  assert.deepEqual(summarizeAnalysisGaps({}), { count: 0, byKind: {}, byUnit: {} });
  const source = structuredClone(model); source.analysisGaps[1].sourceEntries[0].path = 'src/not-snapshotted.rs';
  assert.throws(() => validateCompilerModel(source), /no matching snapshot: src\/not-snapshotted.rs/);
  const malformed = structuredClone(model); malformed.analysisGaps[0].reason = 3;
  assert.throws(() => validateCompilerModel(malformed), /Invalid compiler analysis gap/);
  const list = structuredClone(model); list.analysisGaps = {};
  assert.throws(() => validateCompilerModel(list), /Invalid compiler analysis gap list/);
});

test('unresolved operation targets retain raw call contexts without inventing entities or relations', t => {
  const { model } = fixture(t), source = { path: 'src/main.rs', line: 1, role: 'operation' };
  model.analysisGaps = [{ unit: 'model', owner: 'callable::helper', kind: 'operation-target', reason: '尚未建立实际实体目标的连接。', sourceEntries: [source],
    operation: { id: 'operation::despawn', kind: 'despawn', method: 'despawn', targetType: null, apiDeferred: true, scope: 'deferred',
      conditions: [{ ...source, expression: 'enabled', guardKind: 'unless' }], callContexts: [{ registeredOwner: 'registration-1', deferred: true }] }, registeredOwners: ['registration-1'] }];
  const before = JSON.stringify(model);
  assert.doesNotThrow(() => validateCompilerModel(model));
  const catalog = createCompilerObjectCatalog(model);
  assert.equal(catalog.objects.length, model.objects.length); assert.equal(catalog.links.length, model.relations.length);
  assert.deepEqual(summarizeModel({ model }).analysisGaps, model.analysisGaps);
  assert.equal(JSON.stringify(model), before);
  model.analysisGaps[0].operation.conditions[0].line = 99;
  assert.throws(() => validateCompilerModel(model), /no matching snapshot: src\/main.rs/);
});

function sidecarFixture(t) {
  const { workspace } = fixture(t), model = callGraphFixture(t), edges = model.callGraph.edges;
  const modelDirectory = path.join(workspace, 'compiler'); fs.mkdirSync(modelDirectory);
  const filename = path.join(modelDirectory, 'model.calls.ndjson');
  const write = records => {
    const text = records.map(record => JSON.stringify(record)).join('\n') + '\n'; fs.writeFileSync(filename, text);
    model.callGraph = { schemaVersion: 2, format: 'ndjson', file: 'model.calls.ndjson', sha256: sha(text), edgeCount: records.length };
  };
  write(edges);
  return { workspace, model, modelDirectory, filename, edges, write };
}

test('call graph sidecar is streamed without materializing a whole-file string or edge array', t => {
  const f = sidecarFixture(t), read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (filename, ...args) => {
    assert.notEqual(path.resolve(String(filename)), f.filename, 'NDJSON must use chunked reads');
    return read(filename, ...args);
  });
  assert.doesNotThrow(() => validateCompilerModel(f.model, { modelDirectory: f.modelDirectory }));
  assert.deepEqual(validateCompilerCallGraph(f.model, { modelDirectory: f.modelDirectory }),
    { edgeCount: f.edges.length, sha256: f.model.callGraph.sha256, bytes: fs.statSync(f.filename).size });
  assert.equal(f.model.callGraph.edges, undefined);
  for (const source of f.model.sourceFiles) fs.writeFileSync(path.join(f.workspace, source.path), source.content);
  f.model.inputs.sourceFingerprint = sourceFingerprint(f.workspace);
  const core = path.join(f.modelDirectory, 'model.json'); fs.writeFileSync(core, JSON.stringify(f.model));
  assert.deepEqual(readCompilerModel(f.workspace, { filename: core }).model.callGraph, f.model.callGraph);
});

test('sidecar validation checks every proof, identity, SHA, edge count and safe relative path', t => {
  const f = sidecarFixture(t), check = () => validateCompilerModel(f.model, { modelDirectory: f.modelDirectory });
  f.model.callGraph.edgeCount++; assert.throws(check, /edge count mismatch/); f.write(f.edges);
  f.model.callGraph.sha256 = '0'.repeat(64); assert.throws(check, /hash mismatch/); f.write(f.edges);
  f.write([...f.edges, f.edges[0]]); assert.throws(check, /duplicate compiler call edge identity/);
  const missing = structuredClone(f.edges); missing.at(-1).conditions[0].path = 'src/missing.rs';
  f.write(missing); assert.throws(check, /no matching snapshot: src\/missing.rs/);
  const owner = structuredClone(f.edges); owner.at(-1).registeredOwners.push('missing-object');
  f.write(owner); assert.throws(check, /Unknown compiler call registration owner/);
  f.write(f.edges); f.model.callGraph.file = '../model.calls.ndjson'; assert.throws(check, /Unsafe compiler source path/);
  f.model.callGraph.file = 'missing.calls.ndjson'; assert.throws(check, /ENOENT/);
  f.write(f.edges); fs.writeFileSync(f.filename, '{malformed}\n'); assert.throws(check, /Invalid compiler call graph JSON at line 1/);
});

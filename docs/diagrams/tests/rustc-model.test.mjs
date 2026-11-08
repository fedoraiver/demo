import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateCompilerModel as validateCompilerModelData, validateCompilerCallGraph, readCompilerModel, createCompilerObjectCatalog, compilerSourceResolver, bindCompilerSchedules, sourceKey, viewerModel, summarizeAnalysisGaps } from '../src/rustc-model.mjs';
import { summarizeModel } from '../src/maintenance-summary.mjs';
import { sourceFingerprint } from '../src/debugdump-input.mjs';
import { renderGraphView } from '../src/architecture-renderer.mjs';
import { checkObjectViews } from '../src/check-ecs.mjs';
import { projectObjectRelation } from '../src/architecture-object-relations.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const modelDirectories = new Map();
// 深拷贝模型继续指向同一真实 sidecar；仅补充调用位置，不替代生产验证。
const validateCompilerModel = (model, options = {}) => validateCompilerModelData(model, { modelDirectory: modelDirectories.get(model.callGraph?.file), ...options });
function fixture(t) {
  const parent = path.join(root, 'tmp/ecs-architecture/compiler-model-tests'); fs.mkdirSync(parent, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(parent, 'model-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'Cargo.toml'), '[package]\nname="fixture"\nversion="0.1.0"\n');
  fs.writeFileSync(path.join(workspace, 'Cargo.lock'), '');
  const content = 'fn system() {}\n'; fs.writeFileSync(path.join(workspace, 'src/main.rs'), content);
  const source = { path: 'src/main.rs', line: 1, column: 1, role: 'definition' };
  const object = (id, kind) => ({ id, kind, name: id, feature: 'project', sourceEntries: [source], sourceGaps: [] });
  const model = { schemaVersion: 2, compiler: 'pinned-compiler', configuration: { target: 'host', features: ['debugdump'] },
    inputs: { sourceFingerprint: sourceFingerprint(workspace) }, features: [{ id: 'project', label: '项目' }],
    objects: [object('decl-plugin', 'Plugin'), object('registration-1', 'System'), object('registration-2', 'System'), object('template-root', 'Entity'), object('type-component', 'Component'), object('isolated', 'Resource')],
    relations: [
      { id: 'install', from: 'decl-plugin', to: 'registration-1', kind: 'registration', sourceEntries: [source] },
      { id: 'contains', from: 'template-root', to: 'type-component', kind: 'contains', sourceEntries: [source] },
      { id: 'read', from: 'type-component', to: 'registration-1', kind: 'read', sourceEntries: [source] },
      { id: 'mutable', from: 'registration-2', to: 'type-component', kind: 'mutable_access', sourceEntries: [source] },
      { id: 'entity-reference', from: 'registration-1', to: 'template-root', kind: 'reference', sourceEntries: [source] },
    ], sourceFiles: [{ path: 'src/main.rs', content, sha256: sha(content) }], scheduleInteractions: { schemaVersion: 1, views: [] } };
  const modelDirectory = path.join(workspace, 'compiler'); fs.mkdirSync(modelDirectory);
  const callFile = path.basename(workspace) + '.calls.ndjson', filename = path.join(modelDirectory, callFile);
  fs.writeFileSync(filename, '');
  model.callGraph = { schemaVersion: 2, format: 'ndjson', file: callFile, sha256: sha(''), edgeCount: 0 };
  modelDirectories.set(callFile, modelDirectory); t.after(() => modelDirectories.delete(callFile));
  return { workspace, model, object, modelDirectory, filename };
}

test('native type declaration identity preserves roles, package evidence and unit-local provenance', t => {
  const { model } = fixture(t), object = model.objects[0];
  object.declarationId = 'decl-native-plugin';
  object.typeIdentity = { declarationId: object.declarationId, crateName: 'demo', defPath: 'demo::project::Plugin', local: false, roles: ['Plugin'] };
  assert.doesNotThrow(() => validateCompilerModel(model, { checkSources: false }));
  const dependency = { name: 'native-plugin', version: '1.2.3', root: 'D:/native-plugin' }, content = 'pub struct Plugin;\n';
  model.sourceFiles.push({ path: 'src/lib.rs', dependency, content, sha256: sha(content) });
  object.sourceEntries.push({ path: 'src/lib.rs', dependency, role: 'definition', line: 1, sha256: sha(content) });
  object.typeIdentity.package = { name: dependency.name, version: dependency.version };
  assert.doesNotThrow(() => validateCompilerModel(model, { checkSources: false }));
  const original = structuredClone(object.typeIdentity);
  for (const change of [identity => identity.declarationId = 'other', identity => identity.crateName = '', identity => identity.defPath = 'Plugin',
    identity => identity.local = 'true', identity => identity.roles = ['Plugin', 'Plugin'], identity => identity.roles = ['Component'],
    identity => identity.package = { name: 'demo', version: '0.1.0' }]) {
    object.typeIdentity = structuredClone(original); change(object.typeIdentity);
    assert.throws(() => validateCompilerModel(model, { checkSources: false }), /type declaration identity|type role differs|package has no definition evidence/);
  }
  object.typeIdentity = { ...original, roles: [] }; object.kind = 'NonSend';
  assert.doesNotThrow(() => validateCompilerModel(model, { checkSources: false }));
  object.typeIdentity = null;
  assert.doesNotThrow(() => validateCompilerModel(model, { checkSources: false }));
});

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

test('object cards fold repeated registrations of one callable without changing raw relations or Schedule identity', t => {
  const { model } = fixture(t);
  for (const [index, record] of model.objects.filter(record => record.kind === 'System').entries()) Object.assign(record, {
    name: 'demo::scene_assembly::spawn_session', callableIds: ['spawn-session-callable'],
    registrations: [{ application: 'main', schedule: index ? 'OnExit(MainMenu)' : 'Startup', scope: 'runtime' }],
  });
  model.relations.push({ id: 'create-second', from: 'registration-2', to: 'template-root', kind: 'create',
    sourceEntries: [{ path: 'src/main.rs', line: 1, column: 8, role: 'create' }], sourceGaps: ['second registration proof'] });
  const registry = Object.fromEntries(model.objects.map(record => [record.id, record]));
  const before = JSON.stringify(model), catalog = createCompilerObjectCatalog(model, registry);
  const graph = catalog.graphFor('type-component');
  assert.deepEqual(graph.nodes.map(node => node.id), ['type-component', 'template-root', 'registration-1']);
  assert.deepEqual(graph.nodes.find(node => node.id === 'registration-1').sourceNodeIds, ['registration-1', 'registration-2']);
  assert.equal(graph.links.find(link => link.id === 'mutable').from, 'registration-2');
  assert.equal(graph.links.find(link => link.id === 'mutable').displayFrom, 'registration-1');
  for (const link of graph.links) {
    const { displayFrom, displayTo, ...fact } = link;
    assert.deepEqual(fact, catalog.links.find(candidate => candidate.id === link.id));
  }
  const entityGraph = catalog.graphFor('template-root');
  assert.deepEqual(entityGraph.nodes.map(node => node.id), ['template-root', 'registration-1']);
  assert.deepEqual(entityGraph.links.map(link => link.id), ['entity-reference', 'create-second']);
  assert.deepEqual(entityGraph.links[1].sourceGaps, ['second registration proof']);
  const secondGraph = catalog.graphFor('registration-2');
  assert.equal(secondGraph.centerNodeId, 'registration-2');
  assert.equal(secondGraph.nodes.filter(node => node.id === 'registration-2').length, 1);
  assert.ok(!secondGraph.nodes.some(node => node.id === 'registration-1'));
  const views = catalog.objects.map(object => renderGraphView({ id: object.viewId, objectId: object.id, centerNodeId: object.id,
    feature: object.feature, aspect: 'object', label: object.id, summary: '一跳对象关系。' }, catalog.graphFor(object.id), registry, model.features));
  assert.equal(checkObjectViews(views, catalog), catalog.objects.length);
  const componentView = views.find(view => view.objectId === 'type-component');
  assert.equal(componentView.links.find(link => link.id === 'read').nativeReverse, true);
  const projected = projectObjectRelation(componentView, 'mutable');
  assert.deepEqual(projected.nodes.map(node => node.id), ['type-component', 'registration-1']);
  assert.equal(projected.links[0].from, 'registration-2');
  assert.equal(projected.links[0].displayFrom, 'registration-1');
  assert.deepEqual(catalog.objects.map(object => object.id), model.objects.map(object => object.id));
  assert.equal(JSON.stringify(model), before);
  componentView.nodes.find(node => node.id === 'registration-1').sourceNodeIds.pop();
  assert.throws(() => checkObjectViews(views, catalog), /direct-neighbor coverage mismatch/);
});

test('card folding never equates names, generic instances, applications, conditions, groups, observers or Local state', t => {
  const { model, object } = fixture(t), source = model.relations[0].sourceEntries;
  const system = (id, extra = {}) => ({ ...object(id, 'System'), name: 'same_function', callableIds: ['same-callable'],
    registrations: [{ application: 'main', schedule: 'Update', scope: 'runtime' }], ...extra });
  const extras = [system('same-a'), system('same-b'), system('other-callable', { callableIds: ['other-generic-callable'], declarationId: 'same-generic-declaration' }),
    system('other-app', { registrations: [{ application: 'RenderApp', schedule: 'Render', scope: 'runtime' }] }),
    system('unknown-app', { registrations: [{ schedule: 'Update', scope: 'runtime' }] }),
    system('condition', { registrationScope: 'runtime-system-condition', registrations: [{ application: 'main', schedule: 'Update', scope: 'runtime-system-condition' }] }),
    system('group', { kind: 'System group', callableIds: ['same-callable', 'other-callable'] }), system('observer', { kind: 'Observer' }),
    system('local-a', { kind: 'Local' }), system('local-b', { kind: 'Local' })];
  extras[0].declarationId = 'same-generic-declaration';
  model.objects.push(...extras);
  for (const record of extras) model.relations.push({ id: 'read-' + record.id, from: record.id, to: 'type-component', kind: 'read', sourceEntries: source });
  const catalog = createCompilerObjectCatalog(model), graph = catalog.graphFor('type-component');
  assert.equal(graph.nodes.filter(node => node.id === 'same-a').length, 1);
  assert.ok(!graph.nodes.some(node => node.id === 'same-b'));
  for (const record of extras.slice(2)) assert.ok(graph.nodes.some(node => node.id === record.id), record.id);
  assert.equal(graph.links.filter(link => link.displayFrom === 'same-a').length, 1);
  assert.deepEqual(graph.nodes.find(node => node.id === 'same-a').sourceNodeIds, ['same-a', 'same-b']);
  const localGraph = catalog.graphFor('local-a');
  assert.deepEqual(localGraph.nodes.map(node => node.id), ['local-a', 'type-component']);
  assert.ok(localGraph.nodes.every(node => !node.sourceNodeIds), 'Unrelated members of a callable family must not imply shared local state');
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

function alternativeFixture(t) {
  const { model, object } = fixture(t);
  const sourceEntries = [{ path: 'src/main.rs', line: 1, column: 1, role: 'assembly' }];
  const candidate = (id, alternativeGroup) => ({ ...object(id, 'Entity'), templateId: 'template::' + id,
    alternativeGroups: [], alternativeGroup, alternativeSelection: 'one-of', alternativeContext: [alternativeGroup], possible: true });
  const owner = model.objects.find(record => record.id === 'template-root');
  Object.assign(owner, { templateId: 'template::root', alternativeGroup: null, alternativeSelection: null, alternativeContext: [], possible: false,
    alternativeGroups: [
      { id: 'layout-choice', candidates: ['candidate-a', 'candidate-b'], selection: 'one-of', sourceEntries },
      { id: 'decoration-choice', candidates: ['candidate-c', 'candidate-d'], selection: 'one-of', sourceEntries },
    ] });
  model.objects.push(candidate('candidate-a', 'layout-choice'), candidate('candidate-b', 'layout-choice'),
    candidate('candidate-c', 'decoration-choice'), candidate('candidate-d', 'decoration-choice'),
    { ...object('candidate-child', 'Entity'), templateId: 'template::child', alternativeGroups: [], alternativeGroup: null, alternativeSelection: null, alternativeContext: ['layout-choice'], possible: true },
    object('type-other', 'Component'));
  model.relations = model.relations.filter(relation => relation.id !== 'contains');
  for (const group of owner.alternativeGroups) for (const to of group.candidates) model.relations.push({
    id: 'alternative-' + to, from: owner.id, to, kind: 'alternative', label: '结构候选', evidence: 'assembly',
    alternativeGroup: group.id, selection: group.selection, alternativeContext: [group.id], possible: true, sourceEntries,
  });
  for (const [from, to] of [['candidate-a', 'type-component'], ['candidate-b', 'type-other']]) model.relations.push({
    id: 'contains-' + from, from, to, kind: 'contains', label: '可能包含', evidence: 'assembly', explicit: true, required: false,
    possible: true, alternativeGroup: 'layout-choice', alternativeContext: ['layout-choice'], sourceEntries,
  });
  model.relations.push({ id: 'candidate-actual-child', from: 'candidate-a', to: 'candidate-child', kind: 'relationship', label: '子实体',
    evidence: 'assembly', possible: true, alternativeGroup: 'layout-choice', alternativeContext: ['layout-choice'], sourceEntries: [] });
  return model;
}

test('same-entity structural candidates stay separate across independent groups and retain readable Entity edges', t => {
  const model = alternativeFixture(t), before = JSON.stringify(model);
  assert.doesNotThrow(() => validateCompilerModel(model));
  const catalog = createCompilerObjectCatalog(model), registry = Object.fromEntries(model.objects.map(record => [record.id, record]));
  const entities = viewerModel(model).entities;
  assert.deepEqual(entities.find(entity => entity.id === 'template-root').components, []);
  assert.deepEqual(entities.find(entity => entity.id === 'candidate-a').components, [{ id: 'type-component' }]);
  assert.deepEqual(entities.find(entity => entity.id === 'candidate-b').components, [{ id: 'type-other' }]);
  assert.equal(entities.length, model.objects.filter(object => object.kind === 'Entity').length);
  const graph = catalog.graphFor('template-root');
  assert.equal(graph.links.filter(link => link.factKind === 'alternative').length, 4);
  assert.ok(graph.nodes.every(node => registry[node.id].kind !== 'Component'));
  const view = renderGraphView({ id: catalog.objectById['template-root'].viewId, objectId: 'template-root', centerNodeId: 'template-root',
    feature: 'project', aspect: 'object', label: '结构候选', summary: '分别保留独立候选组。' }, graph, registry, model.features);
  for (const fact of model.relations.filter(relation => relation.kind === 'alternative')) {
    const link = view.links.find(link => link.id === fact.id);
    assert.deepEqual([link.from, link.to, link.kind, link.edgeSemantic, link.factKind, link.operation, link.displayLabel,
      link.alternativeGroup, link.selection, link.possible, link.alternativeContext],
    [fact.from, fact.to, 'reference', 'reference', 'alternative', 'alternative', '结构候选', fact.alternativeGroup, 'one-of', true, [fact.alternativeGroup]]);
    assert.deepEqual(link.sourceEntries, fact.sourceEntries);
  }
  assert.equal(view.links.filter(link => link.edgeSemantic === 'relationship').length, 0);
  assert.deepEqual(view.entityGroups, []);
  const candidateGraph = catalog.graphFor('candidate-a');
  assert.deepEqual(new Set(candidateGraph.nodes.map(node => node.id)), new Set(['candidate-a', 'template-root', 'candidate-child']));
  assert.equal(candidateGraph.links.find(link => link.id === 'candidate-actual-child').kind, 'relationship');
  assert.equal(candidateGraph.links.find(link => link.id === 'candidate-actual-child').possible, true);
  assert.equal(JSON.stringify(model), before);
});

test('unresolved shared creation contexts keep possible roots without inventing one-of groups or child links', t => {
  const { model, object } = fixture(t);
  for (const id of ['batch-a', 'batch-b']) model.objects.push({ ...object(id, 'Entity'), templateId: 'template::' + id,
    alternativeGroups: [], alternativeGroup: 'unresolved-creation-context', alternativeSelection: 'unresolved', alternativeContext: ['unresolved-creation-context'], possible: true });
  const before = JSON.stringify(model);
  assert.doesNotThrow(() => validateCompilerModel(model));
  const catalog = createCompilerObjectCatalog(model);
  for (const id of ['batch-a', 'batch-b']) assert.deepEqual(catalog.graphFor(id).nodes.map(node => node.id), [id]);
  assert.equal(catalog.links.length, model.relations.length);
  assert.equal(JSON.stringify(model), before);
});

test('nested choices append ancestor context while true children inherit it without becoming group candidates', t => {
  const model = alternativeFixture(t), owner = model.objects.find(object => object.id === 'candidate-child');
  const sourceEntries = owner.sourceEntries;
  owner.alternativeGroups.push({ id: 'nested-choice', candidates: ['nested-a', 'nested-b'], selection: 'one-of', sourceEntries });
  for (const id of ['nested-a', 'nested-b']) {
    const alternativeContext = ['layout-choice', 'nested-choice'];
    model.objects.push({ ...structuredClone(owner), id, templateId: 'template::' + id, alternativeGroups: [], alternativeGroup: 'nested-choice',
      alternativeSelection: 'one-of', alternativeContext, possible: true });
    model.relations.push({ id: 'alternative-' + id, from: owner.id, to: id, kind: 'alternative', label: '结构候选', evidence: 'assembly',
      alternativeGroup: 'nested-choice', selection: 'one-of', alternativeContext, possible: true, sourceEntries });
  }
  const before = JSON.stringify(model);
  assert.doesNotThrow(() => validateCompilerModel(model));
  assert.equal(owner.alternativeGroup, null);
  assert.deepEqual(owner.alternativeContext, ['layout-choice']);
  const catalog = createCompilerObjectCatalog(model), graph = catalog.graphFor(owner.id);
  assert.deepEqual(new Set(graph.nodes.map(node => node.id)), new Set(['candidate-child', 'candidate-a', 'nested-a', 'nested-b']));
  assert.deepEqual(graph.links.find(link => link.to === 'nested-a').alternativeContext, ['layout-choice', 'nested-choice']);
  assert.equal(JSON.stringify(model), before);
});

test('structural candidate validation rejects malformed metadata, crossed groups and missing exact endpoints', t => {
  const cases = [
    [model => { model.objects.find(object => object.id === 'candidate-a').possible = 'true'; }, /Invalid compiler entity possibility/],
    [model => { model.objects.find(object => object.id === 'candidate-a').possible = false; }, /Inconsistent compiler alternative context/],
    [model => { Object.assign(model.objects.find(object => object.id === 'candidate-a'), { alternativeGroup: 'decoration-choice', alternativeContext: ['decoration-choice'] }); }, /candidate crosses its group/],
    [model => { model.objects.find(object => object.id === 'candidate-a').alternativeSelection = 'unresolved'; }, /candidate crosses its group/],
    [model => { model.objects.find(object => object.id === 'candidate-child').alternativeGroup = 'layout-choice'; }, /Inconsistent compiler alternative context/],
    [model => { model.objects.find(object => object.id === 'candidate-a').alternativeContext = {}; }, /Invalid compiler entity alternative context/],
    [model => { model.objects.find(object => object.id === 'candidate-a').alternativeContext.push('layout-choice'); }, /Invalid compiler entity alternative context/],
    [model => { model.objects.find(object => object.id === 'candidate-child').alternativeContext = ['decoration-choice']; }, /child crosses its alternative context/],
    [model => { model.objects.find(object => object.id === 'candidate-child').possible = false; }, /Invalid compiler entity alternative context/],
    [model => { model.objects.find(object => object.id === 'template-root').alternativeGroups[0].candidates[0] = 'type-component'; }, /candidate endpoint/],
    [model => { model.objects.find(object => object.id === 'template-root').alternativeGroups[0].candidates.push('candidate-a'); }, /Invalid compiler alternative group/],
    [model => { model.objects.find(object => object.id === 'template-root').alternativeGroups[1].id = 'layout-choice'; }, /Invalid compiler alternative group/],
    [model => { model.objects.find(object => object.id === 'template-root').alternativeGroups[0].selection = 'all'; }, /Invalid compiler alternative group/],
    [model => { model.objects.find(object => object.id === 'template-root').alternativeGroups = {}; }, /Invalid compiler alternative group list/],
    [model => { model.relations.find(relation => relation.id === 'alternative-candidate-a').from = 'candidate-child'; }, /Invalid compiler alternative relationship/],
    [model => { model.relations.find(relation => relation.id === 'alternative-candidate-a').to = 'candidate-c'; }, /Invalid compiler alternative relationship/],
    [model => { model.relations.find(relation => relation.id === 'alternative-candidate-a').possible = false; }, /Invalid compiler relationship alternative group/],
    [model => { model.relations.find(relation => relation.id === 'alternative-candidate-a').selection = 'unresolved'; }, /Invalid compiler alternative relationship/],
    [model => { model.relations.find(relation => relation.id === 'alternative-candidate-a').alternativeContext = ['decoration-choice']; }, /relationship crosses its context/],
    [model => { model.relations = model.relations.filter(relation => relation.id !== 'alternative-candidate-a'); }, /Missing compiler alternative relationship/],
    [model => { model.relations.find(relation => relation.id === 'contains-candidate-a').alternativeGroup = 'decoration-choice'; }, /crosses its entity context/],
    [model => { model.relations.find(relation => relation.id === 'candidate-actual-child').possible = false; }, /Invalid compiler relationship alternative group/],
    [model => { model.relations.find(relation => relation.id === 'candidate-actual-child').to = 'type-component'; }, /crosses its entity context/],
    [model => { model.relations.find(relation => relation.id === 'contains-candidate-a').alternativeContext = []; }, /crosses its entity context/],
  ];
  for (const [edit, error] of cases) {
    const model = alternativeFixture(t); edit(model);
    assert.throws(() => validateCompilerModel(model), error);
  }
});

test('possible entity contexts require a reachable structural path and nested templates cannot be created as assembly roots', t => {
  const orphan = alternativeFixture(t), original = orphan.objects.find(object => object.id === 'candidate-child');
  orphan.objects.push({ ...structuredClone(original), id: 'orphan', templateId: 'template::orphan' });
  assert.throws(() => validateCompilerModel(orphan), /alternative context is unreachable: orphan/);
  const cycle = alternativeFixture(t), child = cycle.objects.find(object => object.id === 'candidate-child');
  cycle.objects.push({ ...structuredClone(child), id: 'cycle-a', templateId: 'template::cycle-a' },
    { ...structuredClone(child), id: 'cycle-b', templateId: 'template::cycle-b' });
  for (const [from, to] of [['cycle-a', 'cycle-b'], ['cycle-b', 'cycle-a']]) cycle.relations.push({ id: from + '-child', from, to, kind: 'relationship',
    label: '子实体', evidence: 'assembly', alternativeGroup: null, alternativeContext: ['layout-choice'], possible: true, sourceEntries: [] });
  assert.throws(() => validateCompilerModel(cycle), /alternative context is unreachable: cycle-a/);
  const direct = alternativeFixture(t);
  direct.relations.push({ id: 'fabricated-nested-create', from: 'registration-1', to: 'candidate-a', kind: 'create', evidence: 'assembly',
    alternativeGroup: 'layout-choice', alternativeContext: ['layout-choice'], possible: true, sourceEntries: [] });
  assert.throws(() => validateCompilerModel(direct), /create targets a nested template directly/);
});

test('conditional component and child edges cannot omit their complete entity context', t => {
  for (const id of ['contains-candidate-a', 'candidate-actual-child']) {
    for (const fields of [['possible', 'alternativeGroup', 'alternativeContext'], ['possible'], ['alternativeGroup'], ['alternativeContext']]) {
      const model = alternativeFixture(t), relation = model.relations.find(relation => relation.id === id);
      for (const field of fields) delete relation[field];
      assert.throws(() => validateCompilerModel(model), /Invalid compiler relationship alternative group|relationship crosses its entity context/);
    }
  }
});

test('body creates cannot target nested templates while genuine possible roots and ordinary children stay valid', t => {
  for (const evidence of ['body', undefined]) {
    for (const [target, alternativeGroup] of [['candidate-a', 'layout-choice'], ['candidate-child', null]]) {
      const model = alternativeFixture(t);
      model.relations.push({ id: 'fabricated-create', from: 'registration-1', to: target, kind: 'create', evidence,
        alternativeGroup, alternativeContext: ['layout-choice'], possible: true, sourceEntries: [] });
      assert.throws(() => validateCompilerModel(model), /create targets a nested template directly/);
    }
  }
  const model = alternativeFixture(t), original = model.objects.find(object => object.id === 'candidate-child');
  model.objects.push({ ...structuredClone(original), id: 'possible-root', templateId: 'template::possible-root',
    alternativeGroup: 'unresolved-root-context', alternativeSelection: 'unresolved', alternativeContext: ['unresolved-root-context'], possible: true });
  model.relations.push({ id: 'possible-root-create', from: 'registration-1', to: 'possible-root', kind: 'create', evidence: 'body',
    alternativeGroup: 'unresolved-root-context', alternativeContext: ['unresolved-root-context'], possible: true, sourceEntries: [] });
  const ordinary = { ...structuredClone(original), id: 'ordinary-child', templateId: 'template::ordinary-child', alternativeContext: [], possible: false };
  model.objects.push(ordinary);
  model.relations.push({ id: 'ordinary-child-edge', from: 'template-root', to: ordinary.id, kind: 'relationship', evidence: 'assembly', sourceEntries: [] });
  assert.doesNotThrow(() => validateCompilerModel(model));
  const missing = structuredClone(model), relation = missing.relations.find(relation => relation.id === 'possible-root-create');
  for (const field of ['possible', 'alternativeGroup', 'alternativeContext']) delete relation[field];
  assert.throws(() => validateCompilerModel(missing), /relationship crosses its entity context/);
});

test('structural candidate group and edge evidence require identical spans and complete valid snapshots', t => {
  const malformed = alternativeFixture(t);
  malformed.objects.find(object => object.id === 'template-root').alternativeGroups[0].sourceEntries = [{ path: 'src/main.rs', line: '1' }];
  assert.throws(() => validateCompilerModel(malformed), /Invalid compiler alternative group/);
  const mismatch = alternativeFixture(t);
  mismatch.relations.find(relation => relation.id === 'alternative-candidate-a').sourceEntries = [];
  assert.throws(() => validateCompilerModel(mismatch), /evidence differs from its group/);
  const source = alternativeFixture(t);
  source.objects.find(object => object.id === 'template-root').alternativeGroups[0].sourceEntries[0].path = 'src/not-snapshotted.rs';
  assert.throws(() => validateCompilerModel(source), /no matching snapshot/);
  const forged = alternativeFixture(t); forged.sourceFiles[0].sha256 = '0'.repeat(64);
  assert.throws(() => validateCompilerModel(forged), /Invalid or duplicate compiler source snapshot/);
});

test('fact-only models publish without annotations while obsolete schemas and incomplete bindings fail', t => {
  const { model } = fixture(t);
  const before = JSON.stringify(model.relations);
  assert.doesNotThrow(() => validateCompilerModel(model));
  assert.ok(model.objects.every(object => !Object.hasOwn(object, 'description') && !Object.hasOwn(object, 'display_summary')));
  assert.equal(JSON.stringify(model.relations), before);
  assert.throws(() => validateCompilerModel({ ...model, schemaVersion: 1 }), /Unsupported compiler architecture model/);
  model.bindingErrors = ['missing rustc declaration'];
  assert.throws(() => validateCompilerModel(model), /binding is incomplete/);
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
  const f = fixture(t), { model, filename } = f, content = 'if enabled { helper(); }\nelse { commands.queue(helper); }\n';
  model.sourceFiles.push({ path: 'src/guards.rs', content, sha256: sha(content) });
  const entry = line => ({ path: 'src/guards.rs', line, column: 1, role: 'call' });
  const edge = (id, line, deferred, expression, guardKind = 'condition') => ({ id, caller: 'callable::registered_root', callee: 'callable::shared_helper', declaration: 'declaration::shared_helper',
    registeredOwners: ['registration-1', 'registration-2'], deferred, sourceEntries: [entry(line)], conditions: [{ ...entry(line), role: 'operation', expression, guardKind }] });
  const edges = [edge('branch-direct', 1, false, 'enabled'), edge('branch-deferred', 2, true, 'enabled', 'unless'),
    { ...edge('helper-recursion', 1, false, 'retry'), caller: 'callable::shared_helper' }];
  const file = model.callGraph.file;
  const write = records => {
    const text = records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
    fs.writeFileSync(filename, text);
    model.callGraph = { schemaVersion: 2, format: 'ndjson', file, sha256: sha(text), edgeCount: records.length };
  };
  write(edges);
  return { ...f, edges, write };
}

test('typed call graph preserves alternative guards, deferred calls and recursion without object IDs for callables', t => {
  const f = callGraphFixture(t), { model, edges } = f, before = JSON.stringify(model.callGraph);
  assert.doesNotThrow(() => validateCompilerModel(model));
  assert.equal(JSON.stringify(model.callGraph), before);
  assert.deepEqual(edges.slice(0, 2).map(({ callee, deferred, conditions }) => [callee, deferred, conditions[0].expression, conditions[0].guardKind, conditions[0].role]),
    [['callable::shared_helper', false, 'enabled', 'condition', 'operation'], ['callable::shared_helper', true, 'enabled', 'unless', 'operation']]);
  const unresolved = structuredClone(edges); unresolved[0].callee = unresolved[0].declaration = null;
  f.write(unresolved); assert.doesNotThrow(() => validateCompilerModel(model));
  for (const guardKind of ['match-value', 'match-arm']) {
    const match = structuredClone(edges); match[0].conditions[0].guardKind = guardKind;
    f.write(match); assert.doesNotThrow(() => validateCompilerModel(model));
    assert.equal(match[0].conditions[0].guardKind, guardKind);
    assert.equal(match[0].conditions[0].role, 'operation');
  }
});

test('schema 2 models require the full schema 2 NDJSON call graph even when it has no edges', t => {
  const { model, filename } = fixture(t);
  assert.doesNotThrow(() => validateCompilerModel(model));
  const missing = structuredClone(model); delete missing.callGraph;
  assert.throws(() => validateCompilerModel(missing), /Unsupported compiler call graph sidecar/);
  for (const graph of [{ schemaVersion: 1, edges: [] }, { ...model.callGraph, schemaVersion: 1 }, { ...model.callGraph, format: 'json' }]) {
    assert.throws(() => validateCompilerModel({ ...model, callGraph: graph }), /Unsupported compiler call graph sidecar/);
  }
  fs.unlinkSync(filename);
  assert.throws(() => validateCompilerModel(model), /ENOENT/);
});

test('call graph rejects duplicate edge identities, unknown registrations and malformed evidence', t => {
  const f = callGraphFixture(t), { model, edges } = f, check = () => validateCompilerModel(model);
  f.write([...edges, edges[0]]); assert.throws(check, /duplicate compiler call edge identity/);
  const owner = structuredClone(edges); owner[0].registeredOwners = ['callable::registered_root'];
  f.write(owner); assert.throws(check, /Unknown compiler call registration owner/);
  const malformed = structuredClone(edges); malformed[0].sourceEntries[0].line = '1';
  f.write(malformed); assert.throws(check, /Invalid compiler call evidence/);
  f.write(edges); model.callGraph.schemaVersion = 1;
  assert.throws(check, /Unsupported compiler call graph/);
  const guard = structuredClone(edges); guard[0].conditions[0].guardKind = 'invented';
  f.write(guard); assert.throws(check, /Invalid compiler guard kind/);
});

test('call graph and guard spans require matching complete source snapshots and valid hashes', t => {
  const f = callGraphFixture(t), { model, edges } = f, call = structuredClone(edges);
  call[0].sourceEntries[0].path = 'src/missing.rs';
  f.write(call); assert.throws(() => validateCompilerModel(model), /no matching snapshot: src\/missing.rs/);
  const guard = structuredClone(edges); guard[0].conditions[0].line = 99;
  f.write(guard); assert.throws(() => validateCompilerModel(model), /no matching snapshot: src\/guards.rs/);
  f.write(edges); model.sourceFiles.find(source => source.path === 'src/guards.rs').sha256 = '0'.repeat(64);
  assert.throws(() => validateCompilerModel(model), /Invalid or duplicate compiler source snapshot: src\/guards.rs/);
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

test('call graph sidecar is streamed without materializing a whole-file string or edge array', t => {
  const f = callGraphFixture(t), read = fs.readFileSync;
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
  const f = callGraphFixture(t), check = () => validateCompilerModel(f.model, { modelDirectory: f.modelDirectory });
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

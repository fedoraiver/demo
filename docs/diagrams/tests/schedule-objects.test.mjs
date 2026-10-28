import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScheduleObjects, scheduleSetMembers, validateScheduleInteractions } from '../src/schedule-objects.mjs';
import { buildArchitectureModel } from '../src/architecture-model.mjs';
import { buildObjectCatalog } from '../src/architecture-objects.mjs';
import { edgeSemanticOf } from '../src/architecture-style.mjs';

const system = (name, fullName, label = fullName.split('::').at(-1)) => ({ name, attributes: { label, tooltip: fullName, shape: 'box' } });
const marker = name => ({ name, attributes: { style: 'invis', label: '' } });
const group = (name, label, nodes, children = []) => ({ name, attributes: { label, tooltip: label }, nodes, edges: [], subgraphs: children });
const edge = (tail, head, attributes = {}) => ({ tail, head, attributes });
function graph(nodes, subgraphs = [], edges = []) {
  return { schemaVersion: 1, name: '', directed: true, strict: false, attributes: {}, nodes, subgraphs, edges };
}
function view(id = 'schedule-test', scheduleGraph = graph([system('s', 'engine::work')]), overrides = {}) {
  return { id, aspect: 'schedule', application: 'main', scheduleLabel: 'Update', dot: 'digraph ' + id + ' {}', scheduleGraph, nodes: [], links: [], scheduleLinks: [], sections: [], svg: '<svg>untouched</svg>', ...overrides };
}
function base(overrides = {}) {
  return { features: [], systems: [], entities: [], resources: [], nodes: [], relationships: [], system_links: [], ...overrides };
}
const location = (role = 'definition', dependency) => ({ path: 'src/lib.rs', line: 10, role, label: '已核实入口', ...(dependency ? { dependency: { name: dependency, version: '1.0.0', root: 'C:/cargo/' + dependency } } : {}) });
function catalog(overrides = {}) {
  return {
    resolveSystem(fullName) { return { name: fullName, description: '已核实的系统说明。', sourceEntries: [location()], accesses: [] }; },
    resolveSet(label) { return { name: label, description: '已核实的集合说明。', sourceEntries: [location()] }; },
    resolveContext(name) { return { name, kind: name === 'ApplyDeferred' ? 'Synchronization' : 'Scheduling constraint', description: '已核实的原生上下文。', sourceEntries: [location()] }; },
    ...overrides,
  };
}
const build = (model = base(), views = [view()], sourceCatalog = catalog()) => buildScheduleObjects({ model, views, sourceCatalog });
const bindings = result => result.scheduleInteractions.views.flatMap(view => view.bindings);

test('Schedule object augmentation preserves original models, DOT, SVG and graph metadata', () => {
  const model = base(), views = [view()], before = structuredClone({ model, views });
  const result = build(model, views);
  assert.deepEqual({ model, views }, before);
  assert.equal(bindings(result).length, 1);
  const architecture = buildArchitectureModel(result.model), objects = buildObjectCatalog(result.model, architecture.registry);
  const binding = bindings(result)[0], diagram = objects.graphFor(binding.objectId);
  assert.equal(diagram.centerNodeId, binding.objectId);
  assert.ok(diagram.links.some(link => link.kind === 'registration'));
  assert.ok(diagram.nodes.length > 1);
});

test('existing functions use full module paths and exact registration schedules', () => {
  const model = base({ systems: [
    { id: 'fixed', name: 'work', kind: 'System', module: 'feature', source: { path: 'src/feature/mod.rs', line: 2 }, registrations: [{ schedule: 'FixedUpdate' }] },
    { id: 'update', name: 'work', kind: 'System', module: 'feature', source: { path: 'src/feature/mod.rs', line: 2 }, registrations: [{ schedule: 'Update' }] },
  ] });
  const result = build(model, [view('schedule-update', graph([system('s', 'demo::feature::work')]))]);
  assert.equal(bindings(result)[0].objectId, 'update');
  assert.equal(result.model.systems.length, 2);
  const other = build(model, [view('schedule-other', graph([system('s', 'dependency::work')]))]);
  assert.notEqual(bindings(other)[0].objectId, 'update');
});

test('state Debug labels match explicitly qualified project state registrations', () => {
  const model = base({ systems: [{ id: 'enter', name: 'start', kind: 'System', module: 'feature', source: { path: 'src/feature/mod.rs', line: 2 }, registrations: [{ schedule: 'OnEnter(AppState::InGame)' }] }] });
  assert.equal(bindings(build(model, [view('schedule-enter', graph([system('s', 'demo::feature::start')]), { scheduleLabel: 'OnEnter(InGame)' })]))[0].objectId, 'enter');
});

test('same full name in another App and duplicate new registrations keep independent object identities', () => {
  const g = graph([system('a', 'engine::work'), system('b', 'engine::work')]);
  const result = build(base(), [view('schedule-main', g), view('schedule-render', g, { application: 'RenderApp' })]);
  assert.equal(new Set(bindings(result).map(binding => binding.objectId)).size, 4);
  assert.equal(new Set(bindings(result).map(binding => binding.id)).size, 4);
});

test('ambiguous existing registration mapping fails instead of choosing a matching short name', () => {
  const record = { name: 'work', kind: 'System', module: 'feature', source: { path: 'src/feature/mod.rs', line: 2 }, schedule: 'Update' };
  assert.throws(() => build(base({ systems: [{ ...record, id: 'a' }, { ...record, id: 'b' }] }), [view('schedule-test', graph([system('s', 'demo::feature::work')]))]), /Ambiguous existing/);
});

test('known generic dependency instances use their complete authored identity', () => {
  const record = { id: 'native-focused-keyboard-dispatch', name: 'dispatch_focused_input<KeyboardInput>', kind: 'System', schedule: 'PreUpdate' };
  const g = graph([system('keyboard', 'bevy_input_focus::dispatch_focused_input<bevy_input::keyboard::KeyboardInput>'), system('wheel', 'bevy_input_focus::dispatch_focused_input<bevy_input::mouse::MouseWheel>')]);
  const result = build(base({ systems: [record] }), [view('schedule-generic', g, { scheduleLabel: 'PreUpdate' })]);
  assert.equal(bindings(result).find(binding => binding.graphName === 'keyboard').objectId, record.id);
  assert.notEqual(bindings(result).find(binding => binding.graphName === 'wheel').objectId, record.id);
});

test('an existing synchronization is reused only for an exact two-sided dependency boundary', () => {
  const model = base({ systems: [
    { id: 'before', name: 'before', kind: 'System', module: 'feature', source: { path: 'src/feature/mod.rs', line: 2 }, schedule: 'Update' },
    { id: 'after', name: 'after', kind: 'System', module: 'feature', source: { path: 'src/feature/mod.rs', line: 3 }, schedule: 'Update' },
    { id: 'sync', name: 'Known deferred boundary', kind: 'Synchronization', schedule: 'Update' },
  ], system_links: [{ id: 'one', from: 'before', to: 'sync', kind: 'order' }, { id: 'two', from: 'sync', to: 'after', kind: 'order' }] });
  const g = graph([system('before-node', 'demo::feature::before'), system('after-node', 'demo::feature::after'), system('sync-node', 'bevy_ecs::apply_deferred'), system('other-sync', 'bevy_ecs::apply_deferred')], [],
    [edge('before-node', 'sync-node'), edge('sync-node', 'after-node'), edge('before-node', 'other-sync')]);
  const source = catalog({ resolveSystem(fullName) { return { name: 'ApplyDeferred', kind: 'Synchronization', description: '延迟命令同步。', sourceEntries: [location()] }; } });
  const result = build(model, [view('schedule-sync', g)], source);
  assert.equal(bindings(result).find(binding => binding.graphName === 'sync-node').objectId, 'sync');
  assert.notEqual(bindings(result).find(binding => binding.graphName === 'other-sync').objectId, 'sync');
  assert.equal(result.model.systems.length, 4);
});

test('set membership follows nested containers and reverse marker edges across multiple sets', () => {
  const g = graph([system('a', 'engine::a'), system('b', 'engine::b'), marker('outer'), marker('inner'), marker('extra')], [
    group('cluster-outer', 'Outer', ['a', 'outer', 'inner'], ['cluster-inner']), group('cluster-inner', 'Inner', ['inner']), group('cluster-extra', 'Extra', ['extra']),
  ], [edge('b', 'inner', { dir: 'none' }), edge('extra', 'outer', { dir: 'none' }), edge('a', 'extra', { dir: 'none' })]);
  const context = scheduleSetMembers(g);
  assert.deepEqual([...context.members.get('cluster-inner')], ['b']);
  assert.deepEqual(new Set(context.members.get('cluster-outer')), new Set(['a', 'b']));
  const result = build(base(), [view('schedule-sets', g)]), entries = new Map(bindings(result).map(binding => [binding.graphName, binding.objectId]));
  const has = (from, to) => result.model.system_links.some(link => link.from === entries.get(from) && link.to === entries.get(to) && link.kind === 'registration' && !link.label);
  assert.ok(has('cluster-outer', 'cluster-inner'));
  assert.ok(has('cluster-inner', 'b'));
  assert.ok(has('cluster-outer', 'cluster-extra'));
  assert.ok(has('cluster-extra', 'a'));
  assert.ok(!has('cluster-inner', 'a'));
  assert.equal(bindings(result).filter(binding => binding.kind === 'set').length, 3);
  assert.ok(!bindings(result).some(binding => ['outer', 'inner', 'extra'].includes(binding.graphName)));
});

test('source verified set type and package can reuse a known object while same titles stay separate', () => {
  const model = base({ systems: [{ id: 'transform_propagate', name: 'TransformSystems::Propagate', kind: 'SystemSet' }] });
  const g = graph([marker('a'), marker('b')], [group('cluster-a', 'Propagate', ['a']), group('cluster-b', 'Propagate', ['b'])]);
  const source = catalog({ resolveSet(label, context) {
    const dependency = context.graphName === 'cluster-a' ? 'bevy_transform' : 'avian3d';
    return { name: context.graphName === 'cluster-a' ? 'TransformSystems::Propagate' : 'PhysicsSystems::Propagate', description: '核实不同集合声明。', definition: location('definition', dependency), sourceEntries: [location('definition', dependency)] };
  } });
  const result = build(model, [view('schedule-sets', g)], source), entries = bindings(result);
  assert.equal(entries.find(binding => binding.graphName === 'cluster-a').objectId, 'transform_propagate');
  assert.notEqual(entries.find(binding => binding.graphName === 'cluster-b').objectId, 'transform_propagate');
});

test('new project sets retain their definition feature from full Rust identity or project source paths', () => {
  const model = base({ features: [{ id: 'game_flow' }, { id: 'audio' }, { id: 'ui' }] });
  const g = graph([marker('recover'), marker('mix'), marker('build')], [group('cluster-recover', 'Recover', ['recover']), group('cluster-mix', 'Mix', ['mix']), group('cluster-build', 'Build', ['build'])]);
  const source = catalog({ resolveSet(label) {
    const definitions = {
      Recover: { fullName: 'demo::game_flow::FixedGameplaySystems::Recover', definition: { ...location(), path: 'src/game_flow/mod.rs' } },
      Mix: { fullName: 'demo::audio::AudioSystems::Mix', definition: { ...location(), path: 'src/audio/mod.rs' } },
      Build: { definition: { ...location(), path: 'src/ui/mod.rs' } },
    };
    return { name: label, description: '来自真实项目集合定义。', ...definitions[label] };
  } });
  const result = build(model, [view('schedule-project-sets', g)], source);
  const records = result.model.nodes.filter(record => record.kind === 'SystemSet');
  assert.deepEqual(records.map(record => [record.name, record.feature]), [['Recover', 'game_flow'], ['Mix', 'audio'], ['Build', 'ui']]);
  assert.ok(records.every(record => record.registered_by === 'main / Update'));
});

test('anonymous sets remain actual SystemSet objects and context endpoints retain distinct semantic kinds', () => {
  const g = graph([{ name: 'ApplyDeferred', attributes: {} }, { name: '<missing> generate_environment_map_light', attributes: {} }, marker('m')], [group('cluster-a', 'AnonymousSet(0)', ['m'])]);
  const result = build(base(), [view('schedule-context', g)]), ids = new Map(bindings(result).map(binding => [binding.graphName, binding.objectId]));
  const records = [...result.model.nodes, ...result.model.systems];
  assert.equal(records.find(record => record.id === ids.get('cluster-a')).kind, 'SystemSet');
  assert.equal(records.find(record => record.id === ids.get('ApplyDeferred')).kind, 'Synchronization');
  assert.equal(records.find(record => record.id === ids.get('<missing> generate_environment_map_light')).kind, 'Scheduling constraint');
  assert.equal(result.model.systems.length, 0);
  for (const name of ['ApplyDeferred', '<missing> generate_environment_map_light']) {
    const record = records.find(record => record.id === ids.get(name));
    assert.equal(record.registered_by, undefined);
    assert.equal(record.registrations[0].scope, 'dependency-target');
    assert.ok(result.model.system_links.some(link => link.to === record.id && link.kind === 'reference' && link.label === '依赖端点'));
    assert.ok(!result.model.system_links.some(link => link.to === record.id && link.kind === 'registration'));
  }
});

test('a missing target constraint exposes its configuration rather than mislabelling the target function as its own definition', () => {
  const node = { name: '<missing> generate_environment_map_light', attributes: {} }, g = graph([node]);
  const dependency = { name: 'bevy_pbr', version: '0.20.0', root: 'C:/cargo/bevy_pbr' };
  const resolver = { resolve() { return { path: 'src/light_probe/generate.rs', line: 922, dependency }; }, read() { return { lines: ['', 'extract_generated_environment_map_entities.after(generate_environment_map_light),'] }; } };
  const result = buildScheduleObjects({ model: base(), views: [view('schedule-context', g)], resolver, sourceCatalog: { resolveSystem() {}, resolveSet() {} } });
  const record = result.model.nodes.find(record => record.kind === 'Scheduling constraint');
  assert.equal(record.definition_source, undefined);
  assert.deepEqual(record.sourceEntries.map(source => [source.role, source.line]), [['configure', 2]]);
});

test('raw dependency edges preserve direction without creating transitive shortcuts', () => {
  const g = graph([system('a', 'engine::a'), system('b', 'engine::b'), system('c', 'engine::c')], [], [edge('a', 'b'), edge('b', 'c')]);
  const result = build(base(), [view('schedule-order', g)]), ids = new Map(bindings(result).map(binding => [binding.graphName, binding.objectId]));
  const orders = result.model.system_links.filter(link => link.kind === 'order');
  assert.deepEqual(orders.map(link => [link.from, link.to]), [[ids.get('a'), ids.get('b')], [ids.get('b'), ids.get('c')]]);
  assert.ok(orders.every(link => Number.isInteger(link.scheduleEvidence.relations[0].edgeIndex)));
});

test('reviewed access types distinguish apps and locals, preserve complete generic identity and filter semantics', () => {
  const source = catalog({ resolveSystem(fullName) { return { name: fullName, description: '参数访问。', sourceEntries: [location()], accesses: [
    { type: 'Assets<Mesh>', fullName: 'bevy_asset::Assets<bevy_mesh::Mesh>', kind: 'Resource', operation: 'write', sourceEntries: [location()] },
    { type: 'Cache', fullName: 'engine::Cache', kind: 'Local', operation: 'read', sourceEntries: [location()] },
    { type: 'Enabled', fullName: 'engine::Enabled', kind: 'Component', operation: 'filter', sourceEntries: [location()] },
  ] }; } });
  const g = graph([system('a', 'engine::a'), system('b', 'engine::b')]), result = build(base(), [view('schedule-main', g), view('schedule-render', g, { application: 'RenderApp' })], source);
  assert.equal(result.model.nodes.filter(record => record.kind === 'Resource').length, 2);
  assert.equal(result.model.nodes.filter(record => record.kind === 'Local').length, 4);
  assert.equal(result.model.nodes.filter(record => record.kind === 'Component').length, 1);
  assert.equal(result.model.system_links.filter(link => link.kind === 'reference' && link.label === '存在 / 变更过滤').length, 4);
  const component = result.model.nodes.find(record => record.kind === 'Component');
  assert.ok(result.model.systems.every(record => !record.reads.includes(component.id) && !record.writes.includes(component.id)));
});

test('unresolved short access names retain an explicit gap instead of merging dependency types', () => {
  const result = build(base(), [view()], catalog({ resolveSystem() { return { description: '访问尚未唯一定位。', accesses: [{ type: 'State', kind: 'Resource', operation: 'read', sourceEntries: [] }] }; } }));
  assert.equal(result.model.nodes.filter(record => record.kind === 'Resource').length, 0);
  assert.match(result.model.systems[0].sourceGaps[0], /完整声明身份/);
});

test('custom parameter declarations keep a reference relationship without claiming data reads or writes', () => {
  const result = build(base(), [view()], catalog({ resolveSystem() { return { description: '封装参数声明。', sourceEntries: [location()], accesses: [
    { type: 'CustomParam', fullName: 'engine::CustomParam', kind: 'SystemParam', operation: 'reference', sourceEntries: [location()] },
  ] }; } }));
  const record = result.model.systems[0];
  assert.deepEqual(record.reads, []); assert.deepEqual(record.writes, []);
  const link = result.model.system_links.find(link => link.label === '参数 / 查询数据');
  assert.equal(link.kind, 'reference'); assert.equal(link.operation, 'reference'); assert.deepEqual(link.evidence, ['declaration']);
});

test('Extract accesses refer to main-world resources while native RenderApp resources stay separate', () => {
  const source = catalog({ resolveSystem(fullName) { return { description: '区分主世界与渲染世界。', sourceEntries: [location()], accesses: [
    { type: 'Assets<Mesh>', fullName: 'bevy_asset::Assets<bevy_mesh::Mesh>', kind: 'Resource', operation: 'read', scope: fullName.includes('extract') ? 'main' : 'current', sourceEntries: [location()] },
  ] }; } });
  const result = build(base(), [view('schedule-main'), view('schedule-extract', graph([system('a', 'engine::extract'), system('b', 'engine::native')]), { application: 'RenderApp' })], source);
  const systems = result.model.systems, resource = record => record.reads[0];
  assert.equal(resource(systems.find(record => record.scheduleFullName === 'engine::extract')), resource(systems.find(record => record.scheduleFullName === 'engine::work')));
  assert.notEqual(resource(systems.find(record => record.scheduleFullName === 'engine::native')), resource(systems.find(record => record.scheduleFullName === 'engine::work')));
});

test('same-typed Local parameters and distinct Pipe stages remain separate slots in one registration', () => {
  const source = catalog({ resolveSystem() { return { description: '保留独立Local参数槽位。', sourceEntries: [location()], accesses: [
    { type: 'Cache', fullName: 'engine::Cache', kind: 'Local', operation: 'write', parameterKey: 'stage-a/first', sourceEntries: [location()] },
    { type: 'Cache', fullName: 'engine::Cache', kind: 'Local', operation: 'write', parameterKey: 'stage-a/second', sourceEntries: [location()] },
    { type: 'Cache', fullName: 'engine::Cache', kind: 'Local', operation: 'write', parameterKey: 'stage-b/first', sourceEntries: [location()] },
  ] }; } });
  const result = build(base(), [view()], source), locals = result.model.nodes.filter(record => record.kind === 'Local');
  assert.equal(locals.length, 3); assert.equal(new Set(locals.map(record => record.id)).size, 3);
  assert.deepEqual(locals.map(record => record.parameterKey), ['stage-a/first', 'stage-a/second', 'stage-b/first']);
  assert.equal(result.model.systems[0].writes.length, 3);
});

test('canonical message buffers use consume/publish semantics and stay isolated by App world', () => {
  const source = catalog({ resolveSystem(fullName) { return { description: '读写真实消息缓冲。', sourceEntries: [location()], accesses: [
    { type: 'Messages<Input>', fullName: 'bevy_ecs::message::messages::Messages<engine::Input>', kind: 'Messages<T>', operation: fullName.endsWith('writer') ? 'write' : 'read', sourceEntries: [location()] },
  ] }; } });
  const g = graph([system('a', 'engine::reader'), system('b', 'engine::writer')]), result = build(base(), [view('schedule-main', g), view('schedule-render', g, { application: 'RenderApp' })], source);
  assert.equal(result.model.nodes.filter(record => record.kind === 'Messages<T>').length, 2);
  const architecture = buildArchitectureModel(result.model), accesses = result.model.system_links.filter(link => ['read', 'write'].includes(link.kind));
  assert.deepEqual(accesses.map(link => edgeSemanticOf(link, architecture.registry)), ['consume', 'publish', 'consume', 'publish']);
});

test('reviewed existing main-world resources reuse exact generic identities without merging another App or short-name lookalike', () => {
  const model = base({ resources: [
    { id: 'resource.AssetsMesh', kind: 'Resource', name: 'Assets<Mesh>', description: '既有网格资产。' },
    { id: 'resource.KeyboardInputMessages', kind: 'Messages<T>', name: 'Messages<KeyboardInput>', description: '既有键盘缓冲。' },
  ] });
  const source = catalog({ resolveSystem() { return { description: '访问已核实资产与消息。', sourceEntries: [location()], accesses: [
    { type: 'Assets<Mesh>', fullName: 'bevy_asset::assets::Assets<bevy_mesh::mesh::Mesh>', kind: 'Resource', operation: 'read', sourceEntries: [location()] },
    { type: 'Assets<Mesh>', fullName: 'bevy_asset::assets::Assets<other_crate::Mesh>', kind: 'Resource', operation: 'write', sourceEntries: [location()] },
    { type: 'Messages<KeyboardInput>', fullName: 'bevy_ecs::message::messages::Messages<bevy_input::keyboard::KeyboardInput>', kind: 'Messages<T>', operation: 'read', sourceEntries: [location()] },
  ] }; } });
  const before = structuredClone(model.resources), result = build(model, [view('schedule-main'), view('schedule-render', graph([system('s', 'engine::work')]), { application: 'RenderApp' })], source);
  const main = result.model.systems.find(record => record.registrations[0].application === 'main'), render = result.model.systems.find(record => record.registrations[0].application === 'RenderApp');
  assert.ok(main.reads.includes('resource.AssetsMesh')); assert.ok(main.reads.includes('resource.KeyboardInputMessages'));
  assert.ok(!render.reads.includes('resource.AssetsMesh') && !render.reads.includes('resource.KeyboardInputMessages'));
  assert.ok(!main.writes.includes('resource.AssetsMesh')); assert.deepEqual(result.model.resources, before);
});

test('explicit complete Resource and NonSend identities need a known world; Local and Component projections are not reused', () => {
  const model = base({ resources: [
    { id: 'cache', name: 'Cache', kind: 'Resource', fullName: 'engine::Cache', application: 'main' },
    { id: 'window', name: 'Windows', kind: 'NonSend', rust_type: 'engine::Windows', application: 'main' },
    { id: 'unknown-world', name: 'Unknown', kind: 'Resource', fullName: 'engine::Unknown' },
    { id: 'old-local', name: 'Cache', kind: 'Local', fullName: 'engine::Cache', application: 'main' },
  ], nodes: [{ id: 'old-component', name: 'Cache', kind: 'Component', fullName: 'engine::Cache' }] });
  const source = catalog({ resolveSystem() { return { description: '区分精确资源与局部槽位。', sourceEntries: [location()], accesses: [
    { type: 'Cache', fullName: 'engine::Cache', kind: 'Resource', operation: 'read', sourceEntries: [location()] },
    { type: 'Windows', fullName: 'engine::Windows', kind: 'NonSend', operation: 'read', sourceEntries: [location()] },
    { type: 'Unknown', fullName: 'engine::Unknown', kind: 'Resource', operation: 'read', sourceEntries: [location()] },
    { type: 'Cache', fullName: 'engine::Cache', kind: 'Local', operation: 'read', sourceEntries: [location()] },
    { type: 'Cache', fullName: 'engine::Cache', kind: 'Component', operation: 'read', sourceEntries: [location()] },
  ] }; } });
  const result = build(model, [view()], source), reads = result.model.systems[0].reads;
  assert.ok(reads.includes('cache') && reads.includes('window'));
  assert.ok(!reads.includes('unknown-world') && !reads.includes('old-local') && !reads.includes('old-component'));
});

test('access types without a resolved definition retain their own parameter-source gap', () => {
  const result = build(base(), [view()], catalog({ resolveSystem() { return { description: '仅核实参数入口。', sourceEntries: [location()], accesses: [
    { type: 'Vec<Entry>', fullName: 'alloc::vec::Vec<engine::Entry>', kind: 'Local', operation: 'write', sourceEntries: [location('parameter')] },
    { type: 'OpaqueParam', fullName: 'engine::OpaqueParam', kind: 'SystemParam', operation: 'reference', sourceEntries: [location('parameter')] },
  ] }; } }));
  for (const record of result.model.nodes.filter(record => ['Local', 'SystemParam'].includes(record.kind))) {
    assert.equal(record.definition_source, undefined);
    assert.match(record.sourceGaps.join(' '), /类型定义尚未唯一定位.*参数或查询入口/);
    assert.ok(record.sourceEntries.every(entry => entry.role === 'parameter'));
  }
});

test('reviewed type purposes, declaration fields and distinct real usage contexts merge without changing identity', () => {
  const source = catalog({ resolveSystem(name) { const first = name.endsWith('first'); return { description: '已核实系统用途。', sourceEntries: [location()], accesses: [
    { type: 'Cache', fullName: 'engine::Cache', kind: 'Resource', operation: 'read', description: first ? '缓存物理查询的工作数据。' : '保存帧间查询结果供下一阶段读取。', display_summary: '缓存物理查询的工作数据。',
      fields: first ? ['entries: Vec<Entry>'] : ['entries: Vec<Entry>', 'generation: u64'], usageContexts: [first ? 'first：收集本帧查询。' : 'second：发布已完成结果。'], sourceEntries: [location()] },
  ] }; } });
  const result = build(base(), [view('schedule-purpose', graph([system('first', 'engine::first'), system('second', 'engine::second')]))], source);
  const records = result.model.nodes.filter(record => record.kind === 'Resource'); assert.equal(records.length, 1);
  assert.equal(records[0].display_summary, '缓存物理查询的工作数据。');
  assert.match(records[0].description, /缓存物理查询.*保存帧间查询/s);
  assert.deepEqual(records[0].usageContexts, ['first：收集本帧查询。', 'second：发布已完成结果。']);
  assert.equal(records[0].fields.filter(field => field === 'entries: Vec<Entry>').length, 1);
  assert.ok(records[0].fields.includes('generation: u64'));
});

test('generic data captions show instantiated arguments while retaining qualified identity', () => {
  const source = catalog({ resolveSystem() { return { description: '访问具体网格队列。', sourceEntries: [location()], accesses: [
    { type: 'Queue<T>', fullName: 'engine::queue::Queue<engine::mesh::Mesh>', kind: 'Resource', operation: 'read', sourceEntries: [location()] },
  ] }; } });
  const result = build(base(), [view()], source);
  const record = result.model.nodes.find(node => node.scheduleEvidence?.kind === 'access');
  assert.equal(record.name, 'Queue<Mesh>');
  assert.equal(record.scheduleFullName, 'engine::queue::Queue<engine::mesh::Mesh>');
});

test('interaction validation rejects missing coverage, altered versions, duplicate identities and stale DOT hashes', () => {
  const views = [view()], result = build(base(), views), original = result.scheduleInteractions;
  assert.equal(validateScheduleInteractions(original, views), original);
  for (const mutate of [catalog => catalog.schemaVersion++, catalog => catalog.views[0].dotSha256 = '0'.repeat(64), catalog => catalog.views[0].bindings.pop(), catalog => catalog.views[0].bindings.push(catalog.views[0].bindings[0]), catalog => catalog.views[0].bindings[0].id = 'stale']) {
    const changed = structuredClone(original); mutate(changed); assert.throws(() => validateScheduleInteractions(changed, views));
  }
  assert.throws(() => validateScheduleInteractions(original, [{ ...views[0], dot: views[0].dot + ' changed' }]));
  assert.throws(() => validateScheduleInteractions(original, views, new Set()));
});

const bodyOperation = (overrides = {}) => ({ fullName: 'engine::Output', kind: 'Resource', description: '保存本阶段生成的输出数据。', display_summary: '承接阶段输出。', fields: ['输出缓存'], typeSourceEntries: [location()],
  operation: 'insert', via: 'commands', method: 'insert_resource', deferred: true, scope: 'current', sourceEntries: [{ ...location('operation'), line: 21 }], ...overrides });

test('body-only outputs retain actual operation evidence separately from type definitions and parameter declarations', () => {
  const result = build(base(), [view()], catalog({ resolveSystem: () => ({ description: '构造输出资源。', sourceEntries: [location()], accesses: [], bodyOperations: [bodyOperation({ condition: '输入已就绪。', helper: 'engine::build_output' })] }) }));
  const system = result.model.systems[0], target = result.model.nodes.find(record => record.scheduleFullName === 'engine::Output');
  const link = result.model.system_links.find(link => link.operation === 'insert');
  assert.equal(link.from, system.id); assert.equal(link.to, target.id); assert.equal(link.label, '延迟添加');
  assert.deepEqual(link.evidence, ['body']); assert.deepEqual(link.sourceEntries, [{ ...location('operation'), line: 21 }]);
  assert.deepEqual(target.sourceEntries, [location()]); assert.deepEqual(system.reads, []); assert.deepEqual(system.writes, []);
  assert.equal(system.bodyOperations[0].objectId, target.id); assert.equal(system.bodyOperations[0].helper, 'engine::build_output');
  assert.equal(system.bodyOperations[0].condition, '输入已就绪。');
});

test('World body mutable access stays a borrow operation rather than an inferred actual modification', () => {
  const result = build(base(), [view()], catalog({ resolveSystem: () => ({ description: '取得资源借用。', sourceEntries: [location()], accesses: [], bodyOperations: [bodyOperation({ operation: 'mutable_access', via: 'world', method: 'resource_mut', deferred: false })] }) }));
  const system = result.model.systems[0], link = result.model.system_links.find(link => link.operation === 'mutable_access');
  assert.equal(link.label, '正文可变访问'); assert.deepEqual(system.writes, []); assert.equal(link.bodyOperations[0].method, 'resource_mut');
  assert.equal(system.bodyOperations[0].operation, 'mutable_access');
});

test('body-only main-world reads reuse an exact known resource while current subapp outputs remain separate', () => {
  const resource = { id: 'existing', name: 'Global', kind: 'Resource', fullName: 'engine::Output', application: 'main', sourceEntries: [location()] };
  const result = build(base({ resources: [resource] }), [view('render', undefined, { application: 'RenderApp' })], catalog({ resolveSystem: () => ({ description: '提取主世界并生成本地资源。', sourceEntries: [location()], accesses: [], bodyOperations: [bodyOperation({ operation: 'read', via: 'world', method: 'resource', deferred: false, scope: 'main' }), bodyOperation()] }) }));
  assert.equal(result.model.system_links.find(link => link.operation === 'read').from, 'existing');
  assert.notEqual(result.model.system_links.find(link => link.operation === 'insert').to, 'existing');
  assert.deepEqual(result.model.resources[0], resource);
});

test('existing authored systems also expose verified body operations without replacing their identity or declaration sources', () => {
  const original = { id: 'authored', name: 'work', kind: 'System', module: 'feature', source: { path: 'src/feature/mod.rs', line: 2 }, schedule: 'Update', sourceEntries: [location()] };
  const result = build(base({ systems: [original] }), [view('main', graph([system('node', 'demo::feature::work')]))], catalog({ resolveSystem: () => ({ description: '已审阅。', sourceEntries: [location()], accesses: [], bodyOperations: [bodyOperation()] }) }));
  assert.equal(bindings(result)[0].objectId, 'authored'); assert.equal(result.model.systems.length, 1);
  assert.equal(result.model.systems[0].bodyOperations[0].operation, 'insert'); assert.deepEqual(result.model.systems[0].sourceEntries, original.sourceEntries);
});

test('body events, messages and QueryData interfaces retain separate semantic targets', () => {
  const operations = [bodyOperation({ kind: 'EntityEvent', fullName: 'engine::Completed', operation: 'trigger', method: 'trigger' }), bodyOperation({ kind: 'Messages<T>', fullName: 'bevy_ecs::message::messages::Messages<engine::Request>', operation: 'publish', via: 'message_writer', method: 'write', deferred: false }), bodyOperation({ kind: 'QueryData', fullName: 'engine::RenderEntity', operation: 'reference', via: 'world', method: 'query', deferred: false })];
  const result = build(base(), [view()], catalog({ resolveSystem: () => ({ description: '发送完成事件和消息。', sourceEntries: [location()], accesses: [], bodyOperations: operations }) }));
  const architecture = buildArchitectureModel(result.model), links = result.model.system_links;
  assert.equal(edgeSemanticOf(links.find(link => link.operation === 'trigger'), architecture.registry), 'emit');
  assert.equal(edgeSemanticOf(links.find(link => link.operation === 'publish'), architecture.registry), 'publish');
  const reference = links.find(link => link.operation === 'reference'); assert.equal(architecture.registry[reference.from].kind, 'QueryData'); assert.equal(reference.kind, 'reference');
  assert.deepEqual(result.model.systems[0].writes, []);
});

test('body facts require operation proof and cannot disguise an event or query interface as a mutable component', () => {
  const buildWith = operation => build(base(), [view()], catalog({ resolveSystem: () => ({ description: '已审阅。', sourceEntries: [location()], bodyOperations: [operation] }) }));
  assert.throws(() => buildWith(bodyOperation({ sourceEntries: [location()] })), /body operation/);
  assert.throws(() => buildWith(bodyOperation({ kind: 'EntityEvent', operation: 'insert' })), /body target/);
  assert.throws(() => buildWith(bodyOperation({ kind: 'QueryData', operation: 'mutable_access' })), /body target/);
});

test('reviewed Startup fallback remains a separate registration and shares only exact declaration facts', () => {
  const original = { id: 'startup_spawn', name: 'spawn_lighting', kind: 'System', module: 'scene_assembly', feature: 'scene_assembly', registered_by: 'scene_assembly',
    source: { path: 'src/scene_assembly/loading.rs', line: 14 }, reads: ['resource.input'], writes: ['resource.output'], fields: ['已核实声明字段'], filters: [], events: [],
    registrations: [{ schedule: 'OnEnter(AppState::InGame)', scope: 'runtime' }, { schedule: 'Startup', scope: 'headless-test', run_if: ['not(resource_exists::<State<AppState>>)'] }] };
  const source = catalog({ resolveSystem(fullName, context) { assert.equal(context.skipParameterAccess, true); return { name: 'spawn_lighting', description: '生成光照及加载相机。', sourceEntries: [location()], accesses: [] }; } });
  const g = graph([system('spawn', 'demo::scene_assembly::loading::spawn_lighting')]);
  const model = base({ systems: [original], resources: [{ id: 'resource.input', kind: 'Resource' }, { id: 'resource.output', kind: 'Resource' }], nodes: [{ id: 'set', kind: 'SystemSet' }],
    system_links: [{ id: 'read', from: 'resource.input', to: 'startup_spawn', kind: 'read', sourceEntries: [location('parameter')] }, { id: 'order', from: 'set', to: 'startup_spawn', kind: 'order' }, { id: 'member', from: 'set', to: 'startup_spawn', kind: 'registration' }] });
  const result = build(model, [view('startup', g, { scheduleLabel: 'Startup' }), view('enter', g, { scheduleLabel: 'OnEnter(InGame)' })], source);
  const startupId = result.scheduleInteractions.views[0].bindings[0].objectId, enterId = result.scheduleInteractions.views[1].bindings[0].objectId;
  assert.notEqual(startupId, enterId); assert.equal(enterId, 'startup_spawn'); assert.equal(result.model.systems.length, 2);
  const startup = result.model.systems.find(record => record.id === startupId), enter = result.model.systems.find(record => record.id === enterId);
  assert.deepEqual(startup.source, original.source); assert.deepEqual(startup.reads, original.reads); assert.deepEqual(startup.writes, original.writes); assert.deepEqual(startup.fields, original.fields);
  assert.deepEqual(startup.registrations, [{ application: 'main', schedule: 'Startup', scope: 'headless-test', run_if: ['not(resource_exists::<State<AppState>>)'] }]);
  assert.deepEqual(enter.registrations, [{ schedule: 'OnEnter(AppState::InGame)', scope: 'runtime' }]);
  assert.deepEqual(startup.registrationFamilyIds, ['startup_spawn', startupId]); assert.deepEqual(enter.registrationFamilyIds, startup.registrationFamilyIds);
  assert.ok(result.model.system_links.some(link => link.from === 'resource.input' && link.to === startupId && link.kind === 'read'));
  assert.ok(!result.model.system_links.some(link => link.from === 'set' && link.to === startupId));
  assert.deepEqual(model.systems[0], original);
});

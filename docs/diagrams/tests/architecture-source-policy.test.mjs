import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSourceEntry, sourceEntriesFor, sourcePolicyFor, sourcePolicyKindFor, applyArchitectureSourcePolicies, applyArchitectureEdgeSourcePolicies, auditProductionEcsCoverage, createArchitectureSourceContext } from '../src/architecture-source-policy.mjs';
import { buildArchitectureModel } from '../src/architecture-model.mjs';
import { readCargoMetadata, createDependencySourceResolver, attachDependencySources } from '../src/dependency-sources.mjs';
import { DEPENDENCY_SOURCE_DEFINITIONS } from '../catalog/architecture-source-definitions.mjs';
import { buildComponentCatalog } from '../src/architecture-components.mjs';
import { NODE_KINDS } from '../src/architecture-kinds.mjs';
import * as sourceEvidence from '../src/architecture-source-evidence.mjs';
import { pathsForRepository } from '../src/paths.mjs';

const entry = (role, overrides = {}) => ({ role, label: role, path: 'src/example.rs', line: 12, ...overrides });
const dependency = { name: 'bevy_ecs', version: '0.17.3', root: 'C:/cargo/registry/bevy_ecs-0.17.3' };

test('已审阅项目源码描述符均能按真实定位协议解析，旧片段或失效行号不得静默丢失', () => {
  const context = createArchitectureSourceContext({ repository: fileURLToPath(new URL('../../..', import.meta.url)) });
  const descriptors = [];
  const collect = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.path === 'string' && typeof value.contains === 'string') {
      if (!value.package) descriptors.push(value);
      return;
    }
    for (const child of Object.values(value)) collect(child);
  };
  collect(sourceEvidence);
  assert(descriptors.length > 0);
  for (const descriptor of descriptors) {
    const entries = context.resolveEvidence(descriptor);
    assert(entries.length > 0, `${descriptor.path}:${descriptor.line || '*'}: ${descriptor.contains}`);
    if (descriptor.line) assert.deepEqual(entries.map(entry => entry.line), [descriptor.line]);
  }
});

test('Observer 来源保留精确泛型注册、真实发出操作和投影原链证据', () => {
  const model = JSON.parse(fs.readFileSync(new URL('../catalog/ecs-data.json', import.meta.url), 'utf8'));
  const { registry } = buildArchitectureModel(model);
  const metadata = readCargoMetadata(fileURLToPath(new URL('../../..', import.meta.url)));
  const resolver = createDependencySourceResolver(metadata);
  attachDependencySources(registry, resolver, DEPENDENCY_SOURCE_DEFINITIONS);
  const options = { repository: fileURLToPath(new URL('../../..', import.meta.url)), model, registry, dependencyContext: { metadata, resolver } };
  const { context } = applyArchitectureSourcePolicies(registry, options);
  for (const id of ['enhanced-reset-gameplay-action', 'native-focused-keyboard-dispatch', 'ecs-component-lifecycle', 'event-remove-action-of-gameplay']) {
    assert.deepEqual(registry[id].sourceGaps, [], id);
    assert(registry[id].sourceEntries.length, id);
  }
  const reset = registry['enhanced-reset-gameplay-action'];
  assert.equal(reset.schedule, null);
  assert(reset.sourceEntries.some(source => source.role === 'registration' && source.path === 'src/first_person/mod.rs'));
  assert(!reset.sourceEntries.some(source => source.path === 'src/ui/navigation.rs'));
  const actual = source => source.dependency ? resolver.read(source).lines[source.line - 1]
    : fs.readFileSync(new URL(`../../../${source.path}`, import.meta.url), 'utf8').split(/\r?\n/)[source.line - 1];
  assert(reset.sourceEntries.some(source => source.role === 'registration' && /add_observer\(reset_action::<C>\)/.test(actual(source))));
  const links = structuredClone(model.system_links);
  applyArchitectureEdgeSourcePolicies(links, { ...options, context });
  for (const link of links.filter(link => sourceEvidence.EDGE_SOURCE_EVIDENCE[link.id])) {
    assert(link.sourceEntries.length, link.id);
    assert.deepEqual(link.sourceGaps || [], [], link.id);
  }
  const subscriptions = links.filter(link => model.observers.some(observer => link.id === `observer-${observer.system}`));
  for (const subscription of subscriptions) {
    const emissions = links.filter(link => link.kind === 'trigger' && link.to === subscription.from);
    assert(emissions.length, subscription.id);
    for (const emission of emissions) {
      assert(emission.sourceEntries.some(source => source.role === 'operation'), emission.id);
      if (['world_spawn', 'native_pointer_events', 'native_button_up', 'native_button_drag_end', 'native_button_cancel'].includes(emission.from)) {
        assert(emission.notes.some(note => note.includes('命令应用')), `${emission.id}: 延迟命令触发时机`);
      }
      const projection = { id: `derived-${emission.id}-${subscription.id}`, projection: 'observer-trigger', kind: 'trigger',
        from: emission.from, to: subscription.to, eventId: subscription.from, originalLinkIds: [emission.id, subscription.id] };
      applyArchitectureEdgeSourcePolicies([projection], { ...options, context });
      assert(projection.sourceEntries.some(source => source.role === 'operation'), projection.id);
      assert(projection.sourceEntries.some(source => source.role === 'parameter'), projection.id);
      assert.deepEqual(projection.sourceGaps || [], [], projection.id);
    }
  }
  assert(!model.system_links.some(link => link.kind === 'trigger' && link.from === reset.id && registry[link.to]?.name.startsWith('Fire<')));
  const cancel = links.find(link => link.from === reset.id && link.to === 'event-observe_cancel');
  assert(cancel.notes.some(note => note.includes('当前生产') && note.includes('未产生 Ongoing')));
});

test('every semantic card kind has its approved source role scope', () => {
  const cases = {
    Component: ['definition', 'create', 'destroy'], Entity: ['create', 'destroy'], System: ['definition', 'registration'],
    Observer: ['definition', 'registration'], Resource: ['definition', 'initialize', 'insert', 'remove'],
    'Local<T>': ['parameter', 'definition', 'initialize'],
    'NonSend<T>': ['definition', 'initialize', 'insert', 'remove', 'cleanup'], Message: ['definition'],
    'Messages<T>': ['definition', 'message_definition', 'registration', 'initialize', 'remove'],
    EntityEvent: ['definition', 'action_definition'], Plugin: ['definition', 'build', 'install'],
    PluginGroup: ['definition', 'build', 'install'], App: ['create', 'assembly', 'run'],
    SystemSet: ['definition', 'configure'], 'Engine SystemSet': ['definition', 'configure'],
    'Scheduling constraint': ['configure'], 'Shared data contract': ['definition', 'configure', 'parameter'], SystemParam: ['definition', 'configure', 'parameter'],
    QueryData: ['definition', 'configure', 'parameter'], Relationship: ['definition', 'configure', 'parameter'],
    'Entity reference': ['definition', 'configure', 'parameter'],
    sync: ['definition', 'implementation', 'registration', 'configure'],
    'System group': ['configure', 'implementation'], 'Observer group': ['configure', 'implementation'],
    'Engine flow': ['configure', 'implementation'], 'Registration helper': ['definition', 'configure'],
    'External I/O': ['definition', 'create', 'install', 'implementation', 'close'], 'Lifecycle note': ['related'],
    'Platform API': ['definition', 'create', 'install', 'implementation', 'close'],
    'Platform event': ['definition', 'create', 'install', 'implementation', 'close'],
    'BSN layout': ['related'], 'Operation result': ['related'],
  };
  for (const [kind, roles] of Object.entries(cases)) {
    assert.deepEqual(sourcePolicyFor(kind).roles, roles, kind);
    assert.deepEqual(sourceEntriesFor({}, { kind, reviewedEntries: roles.map(role => entry(role)) }).map(source => source.role), roles);
  }
});

test('unknown kinds and aggregate engine visual kinds cannot masquerade as systems', () => {
  for (const kind of [undefined, 'engine', 'rounded', 'Contract', 'Plugin / App', 'random']) {
    assert.deepEqual(sourceEntriesFor({ kind, sources: [entry('definition')] }), []);
  }
});

test('source policy identity follows the shared canonical kind rather than names, IDs or stale policy metadata', () => {
  for (const [kind, descriptor] of Object.entries(NODE_KINDS)) {
    assert.equal(sourcePolicyKindFor({ id: 'inspector_pass', name: 'DefaultPlugins', kind, sourcePolicyKind: 'unrelated' }), descriptor.sourcePolicyKind, kind);
  }
  assert.equal(sourcePolicyKindFor({ kind: 'Plugin', name: 'DefaultPlugins' }), 'plugin');
  assert.equal(sourcePolicyKindFor({ kind: 'Resource', name: 'Messages<Foo>' }), 'resource');
  assert.throws(() => sourcePolicyKindFor({ id: 'inspector_pass', kind: 'engine' }), /Unknown architecture node kind/);
});

test('generic sources are not promoted into definitions; explicit definition_source is accepted', () => {
  assert.deepEqual(sourceEntriesFor({ kind: 'Component', source: entry(undefined), sources: [entry(undefined)] }), []);
  const record = { kind: 'Component', definition_source: { path: 'src/components.rs', line: 34 }, sources: [entry('registration'), entry('operation')] };
  assert.deepEqual(sourceEntriesFor(record).map(source => source.role), ['definition']);
  assert.deepEqual(sourceEntriesFor(record, { reviewedEntries: [] }), []);
});

test('component and system source scopes do not delete the original object or its full body', () => {
  const record = { kind: 'system', description: 'full description', query: ['all components'], sources: [entry('definition'), entry('operation'), entry('registration', { line: 9 })] };
  const before = structuredClone(record);
  assert.deepEqual(sourceEntriesFor(record).map(source => source.role), ['definition', 'registration']);
  assert.deepEqual(record, before);
});

test('deduplication combines purpose labels but retains the first entry label and role identity', () => {
  const sources = [entry('registration', { label: 'FixedUpdate' }), entry('registration', { label: 'Update', column: 1 }), entry('definition', { label: '函数定义' }), entry('registration', { label: 'Other line', line: 13 })];
  const before = structuredClone(sources);
  const result = sourceEntriesFor({}, { kind: 'system', reviewedEntries: sources });
  assert.equal(result.length, 3);
  assert.equal(result[0].role, 'definition');
  assert.equal(result[1].label, 'FixedUpdate');
  assert.deepEqual(result[1].labels, ['FixedUpdate', 'Update']);
  assert.deepEqual(sources, before);
});

test('dependency package, version and root all distinguish source identity', () => {
  const sources = [entry('definition', { dependency }), entry('definition', { dependency: { ...dependency, version: '0.17.4' } }), entry('definition', { dependency: { ...dependency, root: 'D:/other' } })];
  assert.equal(sourceEntriesFor({}, { kind: 'Component', reviewedEntries: sources }).length, 3);
});

test('standard project and dependency locators validate without machine defaults', () => {
  const project = entry('definition');
  const cargo = entry('definition', { path: 'src/component.rs', dependency, column: 3 });
  assert.deepEqual(normalizeSourceEntry(project), project);
  assert.deepEqual(normalizeSourceEntry(cargo), cargo);
  assert.notEqual(normalizeSourceEntry(cargo), cargo);
});

test('old absolute Cargo paths normalize only using supplied package roots', () => {
  const old = entry('definition', { path: `${dependency.root}/src/component.rs` });
  for (const dependencyRoots of [[dependency], { 'bevy_ecs@0.17.3': dependency.root }, { arbitrary: dependency }, new Map([['bevy_ecs@0.17.3', dependency.root]])]) {
    assert.deepEqual(normalizeSourceEntry(old, { dependencyRoots }), { ...old, path: 'src/component.rs', dependency });
  }
  assert.deepEqual(normalizeSourceEntry(old), { ...old, unresolved: true });
});

test('workspace paths use component boundary and Windows case-insensitive matching', () => {
  assert.equal(normalizeSourceEntry(entry('definition', { path: 'd:\\DEMO\\src\\example.rs' }), { workspaceRoot: 'D:/demo/' }).path, 'src/example.rs');
  assert.equal(normalizeSourceEntry(entry('definition', { path: 'D:/demo-other/src/example.rs' }), { workspaceRoot: 'D:/demo' }).unresolved, true);
  assert.equal(normalizeSourceEntry(entry('definition', { path: '/repo/src/example.rs' }), { workspaceRoot: '/repo' }).path, 'src/example.rs');
  assert.equal(normalizeSourceEntry(entry('definition', { path: '/Repo/src/example.rs' }), { workspaceRoot: '/repo' }).unresolved, true);
});

test('unsafe and invalid locators cannot escape a project or dependency root', () => {
  for (const path of ['../secrets.rs', 'src/../../secrets.rs', 'src/./file.rs', 'src//file.rs', 'C:/demo/../secrets.rs', 'C:relative.rs', 'src/file.rs\u0000', 'https://example/file.rs']) {
    assert.throws(() => normalizeSourceEntry(entry('definition', { path }), { workspaceRoot: 'C:/demo' }), path);
  }
  assert.throws(() => normalizeSourceEntry(entry('definition', { path: 'C:/outside/file.rs', dependency })), /escapes/);
  assert.throws(() => normalizeSourceEntry(entry('definition', { dependency: { ...dependency, root: 'relative/root' } })), /Unsafe/);
  assert.throws(() => normalizeSourceEntry(entry('definition', { dependency: { ...dependency, version: 'unknown' } })), /identity/);
  assert.throws(() => normalizeSourceEntry(entry('definition', { line: 0 })), /location/);
  assert.throws(() => normalizeSourceEntry(entry('definition', { column: -1 })), /location/);
});

test('known dependency roots verify standard metadata and reject ambiguity', () => {
  assert.throws(() => normalizeSourceEntry(entry('definition', { dependency }), { dependencyRoots: [{ ...dependency, root: 'D:/wrong' }] }), /mismatch/);
  const absolute = entry('definition', { path: `${dependency.root}/src/component.rs` });
  assert.throws(() => normalizeSourceEntry(absolute, { dependencyRoots: [dependency, { ...dependency, name: 'other_ecs' }] }), /Ambiguous/);
  const known = normalizeSourceEntry({ ...absolute, unresolved: true }, { dependencyRoots: [dependency] });
  assert.equal('unresolved' in known, false);
});

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function sourceFixture(t, text) {
  const temporaryRoot = path.join(repository, 'tmp');
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(temporaryRoot, 'architecture-source-policy-'));
  fs.mkdirSync(path.join(fixture, 'src/example'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'src/example/mod.rs'), text);
  t.after(() => {
    const relative = path.relative(temporaryRoot, fixture);
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    fs.rmSync(fixture, { recursive: true, maxRetries: 3, retryDelay: 20 });
  });
  return fixture;
}

test('Component lifecycle sources keep exact assembly, reviewed insert/remove and owning entity destruction without borrowing other projections', t => {
  const fixture = sourceFixture(t, [
    'pub struct Flag;',
    'fn flag_scene() -> impl Scene {',
    ' bsn! { Name("Courier")',
    '  Flag',
    '  Children [',
    '   Flag',
    '   --',
    '   Flag',
    '  ]',
    ' }',
    '}',
    'fn spawn_other(commands: &mut Commands) { commands.spawn(Flag); }',
    'fn insert_flag(commands: &mut Commands, entity: Entity) { commands.entity(entity).insert(Flag); }',
    'fn remove_flag(commands: &mut Commands, entity: Entity) { commands.entity(entity).remove::<Flag>(); }',
    'fn cleanup(commands: &mut Commands, entity: Entity) { commands.entity(entity).despawn(); }',
    'fn update(mut flags: Query<&mut Flag>) {}',
    'fn foreign_bundle() -> impl Bundle {',
    ' (Flag,)',
    '}',
  ].join('\n'));
  fs.mkdirSync(path.join(fixture, 'src/scene_assembly'), { recursive: true });
  fs.renameSync(path.join(fixture, 'src/example/mod.rs'), path.join(fixture, 'src/scene_assembly/actors.rs'));
  const source = (role, line) => ({ role, path: 'src/scene_assembly/actors.rs', line, label: `line ${line}` });
  const registry = {
    assembled: { id: 'assembled', kind: 'Component', name: 'Flag', source: source(undefined, 2) },
    later: { id: 'later', kind: 'Component', name: 'Flag', source: source(undefined, 1) },
    foreign: { id: 'foreign', kind: 'Component', name: 'Flag', source: source(undefined, 17) },
  };
  const model = { entities: [{ id: 'character', components: [{ id: 'assembled' }, { id: 'later' }] }, { id: 'unrelated', components: [{ id: 'foreign' }] }] };
  const components = { accesses: [
    { component: 'assembled', projectionIds: ['assembled'], operation: 'insert', evidence: 'source', targetScope: 'declared-candidates', sourceEntries: [source('operation', 4)] },
    { component: 'assembled', projectionIds: ['assembled'], operation: 'insert', evidence: 'source', targetScope: 'declared-candidates', sourceEntries: [source('operation', 6)] },
    { component: 'assembled', projectionIds: ['assembled'], operation: 'insert', evidence: 'source', targetScope: 'declared-candidates', sourceEntries: [source('operation', 8)] },
    { component: 'foreign', projectionIds: ['foreign'], operation: 'insert', evidence: 'source', targetScope: 'declared-candidates', sourceEntries: [source('operation', 12)] },
    { component: 'assembled', operation: 'insert', evidence: 'source', targetScope: 'type-only', sourceEntries: [source('operation', 12)] },
    { component: 'foreign', operation: 'insert', evidence: 'reviewed', targetScope: 'type-only', sourceEntries: [source('operation', 12)] },
    { component: 'assembled', projectionIds: ['assembled', 'foreign'], operation: 'insert', evidence: 'source', targetScope: 'declared-candidates', sourceEntries: [source('operation', 4)] },
    { component: 'later', operation: 'insert', evidence: 'reviewed', sourceEntries: [source('operation', 13)] },
    { component: 'later', operation: 'remove', evidence: 'reviewed', sourceEntries: [source('call', 13), source('operation', 14)] },
    { component: 'foreign', operation: 'write', evidence: 'reviewed', sourceEntries: [source('parameter', 16)] },
    { component: 'foreign', projectionIds: ['foreign'], operation: 'insert', evidence: 'source', targetScope: 'declared-candidates', sourceEntries: [source('operation', 18)] },
  ] };
  const before = structuredClone(components);
  const context = createArchitectureSourceContext({ repository: fixture, model, components });
  // 夹具只提供已审阅的所属实体生命周期；普通 spawn 不证明任何组件随其创建。
  context.resolveEvidence = descriptor => [{ ...source(descriptor.role, descriptor.role === 'create' ? 3 : 15), label: descriptor.label }];
  applyArchitectureSourcePolicies(registry, { context });
  assert.deepEqual(registry.assembled.sourceEntries.filter(entry => entry.role === 'create').map(entry => entry.line), [4]);
  assert.deepEqual(registry.later.sourceEntries.filter(entry => entry.role === 'create').map(entry => entry.line), [13]);
  assert.deepEqual(registry.later.sourceEntries.filter(entry => entry.role === 'destroy').map(entry => entry.line), [13, 14, 15]);
  assert(registry.assembled.sourceEntries.some(entry => entry.role === 'destroy' && entry.line === 15 && entry.label.includes('所属实体销毁')));
  assert.deepEqual(registry.foreign.sourceEntries.map(entry => entry.role), ['definition']);
  assert(registry.foreign.sourceGaps.some(gap => gap.includes('创建、装配或插入')));
  assert(registry.foreign.sourceGaps.some(gap => gap.includes('移除或所属实体销毁')));
  assert.deepEqual(components, before);
});

test('Schedule source entries retain exact roles and still reject invalid source locations', t => {
  const fixture = sourceFixture(t, 'fn update<T>() {}\nfn install() {}');
  const entries = [
    { path: 'src/example/mod.rs', line: 1, role: 'definition', label: '泛型函数定义' },
    { path: 'src/example/mod.rs', line: 2, role: 'registration', label: '实际注册入口' },
  ];
  const registry = { exact: { id: 'exact', kind: 'System', name: 'update<Concrete>', scheduleEvidence: { schemaVersion: 1 }, sourceEntries: entries } };
  applyArchitectureSourcePolicies(registry, { repository: fixture });
  assert.deepEqual(registry.exact.sourceEntries.map(({ role, line }) => ({ role, line })), [{ role: 'definition', line: 1 }, { role: 'registration', line: 2 }]);
  assert.deepEqual(registry.exact.sourceGaps, []);
  registry.exact.sourceEntries[0].line = 900;
  assert.throws(() => applyArchitectureSourcePolicies(registry, { repository: fixture }), /Source line out of bounds/);
});

test('semantic kinds distinguish real storage types from visual aggregates', () => {
  assert.equal(sourcePolicyKindFor({ kind: 'SystemSet', name: 'InputSystems' }), 'system_set');
  assert.equal(sourcePolicyKindFor({ kind: 'System', name: 'world_inspector_ui' }), 'system');
  assert.equal(sourcePolicyKindFor({ kind: 'Note', id: 'capture-state' }), 'note');
  assert.equal(sourcePolicyKindFor({ kind: 'Messages<T>', name: 'Messages<SoundRequest>' }), 'message_buffer');
  assert.equal(sourcePolicyKindFor({ kind: 'PluginGroup', name: 'PhysicsPlugins' }), 'plugin_group');
  assert.equal(sourcePolicyKindFor({ kind: 'Platform API' }), 'platform_api');
});

test('real declaration and registration evidence replaces unrelated old provenance', t => {
  const fixture = sourceFixture(t, [
    'pub struct Flag;',
    'fn run(value: Query<&mut Flag>) {}',
    'fn other() {}',
    'fn observed(event: On<Fire>) {}',
    'fn install(app: &mut App) {',
    '  app.add_systems(Update, run.before(other));',
    '  app.add_systems(FixedUpdate, run);',
    '  app.add_systems(PostUpdate, other);',
    '  app.add_observer(observed);',
    '}',
    'fn layout() { bsn! { Flag on(observed) } }',
    '// app.add_systems(FakeSchedule, run);',
  ].join('\n'));
  const registry = {
    flag: { id: 'flag', kind: 'Component', name: 'Flag', feature: 'example', source: { path: 'src/example/mod.rs', line: 5 }, description: 'full description', fields: ['unchanged'] },
    run: { id: 'run', kind: 'system', name: 'run', feature: 'example', source: { path: 'src/example/mod.rs', line: 2 } },
    other: { id: 'other', kind: 'system', name: 'other', feature: 'example', source: { path: 'src/example/mod.rs', line: 3 } },
    observed: { id: 'observed', kind: 'observer', name: 'observed', feature: 'example', source: { path: 'src/example/mod.rs', line: 4 } },
  };
  applyArchitectureSourcePolicies(registry, { repository: fixture });
  assert.deepEqual(registry.flag.sourceEntries.map(source => [source.role, source.line]), [['definition', 1]]);
  assert.equal(registry.flag.description, 'full description');
  assert.deepEqual(registry.flag.fields, ['unchanged']);
  assert.deepEqual(registry.run.sourceEntries.filter(source => source.role === 'registration').map(source => source.line), [6, 7]);
  assert.deepEqual(registry.other.sourceEntries.filter(source => source.role === 'registration').map(source => source.line), [8], 'A before(other) reference does not register other');
  assert.deepEqual(registry.observed.sourceEntries.filter(source => source.role === 'registration').map(source => source.line), [9, 11], 'Global and declarative observers both remain traceable');
});

test('SystemSet cards retain actual declarations and configuration without claiming to be functions', t => {
  const fixture = sourceFixture(t, [
    '#[derive(SystemSet)]', 'pub struct Phase;', 'fn run() {}', 'fn install(app: &mut App) {',
    ' app.configure_sets(Update, Phase.before(Other));', ' app.add_systems(Update, run.in_set(Phase));', '}',
  ].join('\n'));
  const registry = { phase: { id: 'phase', kind: 'SystemSet', name: 'Phase', source: { path: 'src/example/mod.rs', line: 2 } } };
  applyArchitectureSourcePolicies(registry, { repository: fixture });
  assert.deepEqual(registry.phase.sourceEntries.map(source => [source.role, source.line]), [['definition', 2], ['configure', 5]]);
  assert.deepEqual(registry.phase.sourceGaps, []);
});

test('system groups trace actual member definitions and registrations without a fabricated group type', t => {
  const fixture = sourceFixture(t, [
    'fn first() {}', 'fn second() {}', 'fn install(app: &mut App) {',
    ' app.add_systems(Update, (first, second));', '}',
  ].join('\n'));
  const registry = {
    group: { id: 'group', kind: 'System group', name: '匿名系统元组' },
    first: { id: 'first', kind: 'System', name: 'first', source: { path: 'src/example/mod.rs', line: 1 } },
    second: { id: 'second', kind: 'System', name: 'second', source: { path: 'src/example/mod.rs', line: 2 } },
  };
  applyArchitectureSourcePolicies(registry, { repository: fixture, model: { system_links: ['first', 'second'].map(to => ({ kind: 'registration', from: 'group', to })) } });
  assert.deepEqual(registry.group.sourceEntries.map(source => [source.role, source.line]), [['configure', 4], ['implementation', 1], ['implementation', 2]]);
  assert.deepEqual(registry.group.sourceGaps, []);
});

test('Observer groups keep member functions and their registrations inside the actual installation scope', t => {
  const fixture = sourceFixture(t, [
    'pub struct WidgetPlugin;', 'fn on_a(event: On<Press>) {}', 'fn on_b(event: On<Drag>) {}',
    'impl Plugin for WidgetPlugin {', ' fn build(&self, app: &mut App) {',
    '  app.add_observer(on_a);', '  app.add_observer(on_b);', ' }', '}',
    'fn unrelated(event: On<Click>) {}', 'fn other_install(app: &mut App) { app.add_observer(unrelated); }',
  ].join('\n'));
  const registry = { group: { id: 'group', kind: 'Observer group', name: '控件 Observer 分组', definition_source: { path: 'src/example/mod.rs', line: 4 } } };
  applyArchitectureSourcePolicies(registry, { repository: fixture });
  assert.deepEqual(registry.group.sourceEntries.filter(source => source.role === 'implementation').map(source => source.line), [2, 3]);
  assert.deepEqual(registry.group.sourceEntries.filter(source => source.role === 'configure').map(source => source.line), [4, 6, 7]);
  assert(!registry.group.sourceEntries.some(source => ['definition', 'registration'].includes(source.role)));
  assert.deepEqual(registry.group.sourceGaps, []);
});

test('flow aggregates preserve incidental declaration provenance as implementation and report missing configuration', t => {
  const fixture = sourceFixture(t, 'pub struct Queue;\nfn drain_queue() {}');
  const registry = { flow: { id: 'flow', kind: 'Engine flow', name: '队列处理流程', definition_source: { path: 'src/example/mod.rs', line: 1 } } };
  applyArchitectureSourcePolicies(registry, { repository: fixture });
  assert.deepEqual(registry.flow.sourceEntries.map(source => [source.role, source.line]), [['implementation', 1]]);
  assert(registry.flow.sourceGaps.some(gap => /配置/.test(gap)));
});

test('registration helper cards require a real function definition and never invent a Schedule registration', t => {
  const fixture = sourceFixture(t, 'pub struct Data;\nfn install_feature(app: &mut App) {}');
  const registry = {
    helper: { id: 'helper', kind: 'Registration helper', name: '安装辅助函数', source: { path: 'src/example/mod.rs', line: 2 } },
    missing: { id: 'missing', kind: 'Registration helper', name: '缺少函数证据', source: { path: 'src/example/mod.rs', line: 1 } },
  };
  applyArchitectureSourcePolicies(registry, { repository: fixture });
  assert.deepEqual(registry.helper.sourceEntries.map(source => source.role), ['definition']);
  assert(!registry.helper.sourceEntries.some(source => source.role === 'registration'));
  assert.deepEqual(registry.missing.sourceEntries, []);
  assert(registry.missing.sourceGaps.some(gap => /真实定义/.test(gap)));
});

test('resource lifecycle uses actual typed operations and never invents missing definitions', t => {
  const fixture = sourceFixture(t, [
    'pub struct Data;',
    'fn install(app: &mut App) {',
    ' app.init_resource::<Data>();',
    ' app.insert_resource(Data);',
    ' app.world_mut().remove_resource::<Data>();',
    '}',
    'fn not_a_component() {}',
  ].join('\n'));
  const registry = {
    data: { id: 'data', kind: 'Resource', name: 'Data', source: { path: 'src/example/mod.rs', line: 1 } },
    missing: { id: 'missing', kind: 'Component', name: 'Missing', source: { path: 'src/example/mod.rs', line: 7 } },
  };
  applyArchitectureSourcePolicies(registry, { repository: fixture });
  assert.deepEqual(registry.data.sourceEntries.map(source => source.role), ['definition', 'initialize', 'insert', 'remove']);
  assert.deepEqual(registry.missing.sourceEntries, []);
  assert(registry.missing.sourceGaps.every(gap => gap.startsWith('待核实：')));
});

test('precise edge sources and evidence gaps survive policy application', t => {
  const fixture = sourceFixture(t, 'fn helper() {}');
  const links = [{ id: 'edge', from: 'a', to: 'b', kind: 'write', sourceEntries: [entry('call', { label: '辅助函数调用处' }), entry('related', { label: '仅清单声明' })], sourceGaps: ['待核实：字段修改尚未确认'] }];
  applyArchitectureEdgeSourcePolicies(links, { repository: fixture });
  assert.deepEqual(links[0].sourceEntries.map(source => source.role), ['related', 'operation']);
  assert(links[0].sourceEntries.some(source => source.role === 'operation' && source.label === '辅助函数调用处'));
  assert.deepEqual(links[0].sourceGaps, ['待核实：字段修改尚未确认']);
});

test('Observer 投影分别评估两段原链，单段证据不掩盖另一段动态缺口', t => {
  const fixture = sourceFixture(t, 'fn emit() {}\nfn receive() {}');
  const operation = { role: 'operation', path: 'src/example/mod.rs', line: 1, label: '发出操作' };
  const parameter = { role: 'parameter', path: 'src/example/mod.rs', line: 2, label: '订阅参数' };
  for (const missing of ['emission', 'subscription']) {
    const originals = [
      { id: 'emission', kind: 'trigger', from: 'system', to: 'event', sourceEntries: missing === 'emission' ? [] : [operation] },
      { id: 'subscription', kind: 'trigger', from: 'event', to: 'observer', sourceEntries: missing === 'subscription' ? [] : [parameter] },
    ];
    const before = structuredClone(originals);
    const projection = { id: 'projection', kind: 'trigger', projection: 'observer-trigger', from: 'system', to: 'observer',
      eventId: 'event', originalLinkIds: ['emission', 'subscription'], sourceEntries: [missing === 'emission' ? parameter : operation] };
    applyArchitectureEdgeSourcePolicies([projection], { repository: fixture, model: { system_links: originals } });
    assert.equal(projection.sourceEntries.length, 1);
    assert(projection.sourceGaps.some(gap => /具体操作位置尚未完成源码核实/.test(gap)), missing);
    assert.deepEqual(originals, before, `${missing}: 不污染清单中的原始对象关系`);
  }
});

test('Observer 投影复用原链普通来源回退，缺失原链或循环标记不会递归求值', t => {
  const fixture = sourceFixture(t, 'fn emit() {}\nfn receive() {}');
  const originals = [
    { id: 'emission', kind: 'trigger', from: 'system', to: 'event', source: { path: 'src/example/mod.rs', line: 1 } },
    { id: 'subscription', kind: 'trigger', from: 'event', to: 'observer', projection: 'observer-trigger', originalLinkIds: ['subscription'],
      sourceEntries: [{ role: 'parameter', path: 'src/example/mod.rs', line: 2 }] },
  ];
  const before = structuredClone(originals);
  const projection = { id: 'projection', kind: 'trigger', projection: 'observer-trigger', from: 'system', to: 'observer',
    eventId: 'event', originalLinkIds: ['emission', 'subscription'] };
  applyArchitectureEdgeSourcePolicies([projection], { repository: fixture, model: { system_links: originals } });
  assert.deepEqual(projection.sourceEntries.map(source => source.role), ['parameter', 'operation']);
  assert.deepEqual(projection.sourceGaps || [], []);
  assert.deepEqual(originals, before);
  const incomplete = { ...projection, id: 'incomplete', originalLinkIds: ['emission', 'absent'] };
  applyArchitectureEdgeSourcePolicies([incomplete], { repository: fixture, model: { system_links: originals } });
  assert(incomplete.sourceGaps.some(gap => /缺少完整的发出与订阅原关系/.test(gap)));
});

test('生产声明与注册覆盖审计排除测试项，保留普通声明和缺失注册', t => {
  const directory = sourceFixture(t, [
    '#[cfg(test)] use crate::testing::TestOnly;',
    '#[derive(Component)]',
    'struct Visible;',
    '#[cfg(test)]',
    '#[derive(Resource)] struct TestOnly;',
    '#[derive(QueryData)] struct Body { value: Read<Visible> }',
    'fn run(query: Query<&Visible>) {}',
    'fn setup(app: &mut App) { app.add_systems(Update, run); }',
    '#[cfg(test)] fn test_setup(app: &mut App) { app.add_systems(FixedUpdate, run); }',
  ].join('\n'));
  const registry = {
    visible: { id: 'visible', kind: 'Component', name: 'Visible', feature: 'example', source: { path: 'src/example/mod.rs', line: 3 } },
  };
  const audit = applyArchitectureSourcePolicies(registry, { repository: directory });
  const coverage = auditProductionEcsCoverage(registry, { context: audit.context });
  assert.deepEqual(coverage.declarations.map(declaration => declaration.name), ['Visible', 'Body']);
  assert.equal(coverage.registrations.length, 1);
  assert.equal(coverage.gaps.length, 2);
  assert.ok(coverage.gaps.some(gap => gap.includes('Body')));
  assert.ok(coverage.gaps.some(gap => gap.includes('add_systems')));
});

test('已审阅实体目标定位实际赋值及装配操作，未审阅关系不借字段声明伪造操作', () => {
  const model = JSON.parse(fs.readFileSync(path.join(repository, 'docs/diagrams/catalog/ecs-data.json'), 'utf8'));
  const expected = {
    controls_character: 'ControlsCharacter { character }', controls_camera: 'ControlsCamera { camera }', camera_target: 'FirstPersonCamera::new(character)',
    held_by: 'HeldBy { holder: character }', held_attachment_proxy: 'collider,', held_proxy_item: 'HeldCollider { item }', held_proxy_body: 'ColliderOf { body: holder }',
    animation_character: 'character,', grounding_character: 'character,', grounding_player: 'animation_player: first_player.expect',
    grounding_soles: 'sole_markers: sole_markers', settings_scrollbar_target: 'Scrollbar::new(',
  };
  const namedTargetFields = { controls_character: 'character', controls_camera: 'camera', held_by: 'holder', held_proxy_item: 'item' };
  for (const relation of model.relationships) {
    const sources = relation.component_target_sources || [];
    if (!expected[relation.id]) { assert.equal(sources.length, 0); continue; }
    assert.ok(relation.from_component);
    if (namedTargetFields[relation.id]) assert.equal(relation.component_field, namedTargetFields[relation.id]);
    assert.ok(relation.component_target_notes.some(note => note.includes('Commands') && note.includes('helper')));
    const lines = sources.map(source => {
      assert.equal(source.role, 'operation');
      assert.equal(source.column, 1);
      assert.ok(source.label);
      return fs.readFileSync(path.join(repository, source.path), 'utf8').split(/\r?\n/)[source.line - 1];
    });
    assert.ok(lines.every(line => typeof line === 'string' && line.trim() && !/^\s*(?:pub[^;]*\s+)?(?:struct|enum)\b/.test(line)));
    assert.ok(lines.some(line => line.includes(expected[relation.id])), relation.id);
  }
  assert.equal(model.relationships.filter(relation => relation.component_target_sources?.length).length, Object.keys(expected).length);
});

test('current registry and merged function cards have verified source scope across all real types', () => {
  const model = JSON.parse(fs.readFileSync(path.join(repository, 'docs/diagrams/catalog/ecs-data.json'), 'utf8'));
  const { registry } = buildArchitectureModel(model);
  const metadata = readCargoMetadata(repository), resolver = createDependencySourceResolver(metadata);
  attachDependencySources(registry, resolver, DEPENDENCY_SOURCE_DEFINITIONS);
  const components = buildComponentCatalog(model, registry);
  const inspectorBody = structuredClone({ description: registry.inspector_pass.description, notes: registry.inspector_pass.notes, registrations: registry.inspector_pass.registrations });
  const audit = applyArchitectureSourcePolicies(registry, { repository, model, components, dependencyContext: { metadata, resolver } });
  const coverage = auditProductionEcsCoverage(registry, { context: audit.context });
  assert.deepEqual(coverage.gaps, []);
  assert.equal(coverage.declarations.length, 90);
  assert.equal(coverage.registrations.length, 80);
  assert(!coverage.declarations.some(declaration => declaration.name === 'ReleasePointerAction'));
  for (const id of ['filter_egui_input', 'observe_release_pointer', 'event-observe_release_pointer', 'action.Action<ReleasePointerAction>']) {
    assert.equal(registry[id], undefined, `${id}: 已删除声明不能留在当前对象目录`);
  }
  assert.deepEqual(registry.mouse_capture.registrations, [{
    schedule: 'PreUpdate', scope: 'runtime', after: ['InputSystems', 'EguiPreUpdateSet::InitContexts'],
    before: ['EguiPreUpdateSet::ProcessInput', 'EnhancedInputSystems::Prepare'],
  }]);
  assert(registry.mouse_capture.writes.includes('camera.EguiContextSettings'));
  assert(registry.mouse_capture.writes.includes('camera.EguiInput'));
  assert(!registry.mouse_capture.reads.includes('resource.MouseButtonInputMessages'));
  assert.ok(coverage.declarations.some(declaration => declaration.name === 'RecoverableBody'));
  assert.ok(!coverage.declarations.some(declaration => declaration.name === 'WaterRecoveryOrder'));
  const sourceLine = source => source.dependency ? resolver.read(source).lines[source.line - 1]
    : fs.readFileSync(path.join(repository, source.path), 'utf8').split(/\r?\n/)[source.line - 1];
  const hasSource = (id, role, sourcePath, pattern, packageName) => registry[id].sourceEntries.some(source =>
    source.role === role && source.path === sourcePath && source.dependency?.name === packageName && pattern.test(sourceLine(source)));
  assert(hasSource('resource.ArtAssets', 'initialize', 'src/scene_assembly/assets.rs', /^impl FromWorld for ArtAssets/));
  const assetLogging = model.system_links.find(link => link.id === 'write-plugin-SceneAssemblyPlugin-log-producer');
  applyArchitectureEdgeSourcePolicies([assetLogging], { repository, model, components, dependencyContext: { metadata, resolver }, context: audit.context });
  assert.deepEqual(assetLogging.sourceGaps || [], []);
  for (const [role, sourcePath, pattern] of [
    ['configure', 'src/scene_assembly/mod.rs', /init_resource::<ArtAssets>/],
    ['operation', 'src/scene_assembly/assets.rs', /\.load\(path\);/],
    ['operation', 'src/scene_assembly/assets.rs', /info!\(target: "demo::art_assets", path, state = "loading"/],
  ]) assert(assetLogging.sourceEntries.some(source => source.role === role && source.path === sourcePath && pattern.test(sourceLine(source))));
  assert(hasSource('app-main', 'run', 'src/main.rs', /LaunchMode::Game => app\.run\(\)/));
  assert(hasSource('app-main', 'run', 'src/main.rs', /inspector::dump_schedules\(&mut app, &directory\)/));
  assert(audit.entries > 1000);
  for (const record of Object.values(registry)) {
    assert(record.sourceEntries.length || record.sourceGaps.length, `${record.id}: source entry or explicit missing evidence`);
    const policy = sourcePolicyFor(sourcePolicyKindFor(record));
    for (const source of record.sourceEntries) {
      assert(policy.roles.includes(source.role), `${record.id}: allowed source role`);
      const lines = source.dependency ? resolver.read(source).lines : fs.readFileSync(path.join(repository, source.path), 'utf8').split(/\r?\n/);
      assert(source.line > 0 && source.line <= lines.length, `${record.id}: source location exists`);
    }
    if (sourcePolicyFor(sourcePolicyKindFor(record)).kind === 'component') {
      assert(record.sourceEntries.length, `${record.id}: actual component declaration exists`);
      assert(record.sourceEntries.some(source => source.role === 'definition'), `${record.id}: component definition remains present`);
      for (const role of ['create', 'destroy']) assert(record.sourceEntries.some(source => source.role === role)
        || record.sourceGaps.some(gap => gap.includes(role === 'create' ? '创建、装配或插入' : '移除或所属实体销毁')), `${record.id}: ${role} evidence or explicit gap`);
    }
  }
  const createsAt = (id, filename, line) => registry[id].sourceEntries.some(source => source.role === 'create' && source.path === filename && source.line === line);
  assert(createsAt('character.Character', 'src/scene_assembly/actors.rs', 20));
  assert(createsAt('parcel.SpawnPoint', 'src/scene_assembly/actors.rs', 50));
  assert(!createsAt('parcel.SpawnPoint', 'src/scene_assembly/actors.rs', 23));
  assert(createsAt('character.SpawnPoint', 'src/scene_assembly/actors.rs', 23));
  assert(!createsAt('character.SpawnPoint', 'src/scene_assembly/actors.rs', 50));
  assert.deepEqual(registry['camera.Transform'].sourceEntries.filter(source => source.role === 'create').map(source => [source.path, source.line]), [['src/scene_assembly/loading.rs', 24]], 'Directional-light Transform must not be attributed to the camera');
  assert(createsAt('visual.Name', 'src/scene_assembly/actors.rs', 53));
  assert(!createsAt('visual.Name', 'src/scene_assembly/actors.rs', 45), 'A nested visual recipe must not inherit the parcel-root name');
  assert(createsAt('settings_scrollbar_thumb.BackgroundColor', 'src/ui/scroll.rs', 101));
  assert(!createsAt('settings_scrollbar_thumb.BackgroundColor', 'src/ui/widgets.rs', 264), 'An old usage locator does not establish thumb assembly');
  assert(createsAt('parcel.HeldBy', 'src/item_interaction/interaction.rs', 110));
  assert(createsAt('held_proxy.HeldCollider', 'src/item_interaction/attachment.rs', 90));
  assert(hasSource('character.CarryBaseMass', 'create', 'src/item_interaction/attachment.rs', /insert\(CarryBaseMass \{/));
  for (const [filename, lines] of [['src/ui/widgets.rs', [256, 276]], ['src/ui/volume.rs', [113, 118, 165]]]) {
    for (const line of lines) assert(createsAt('menu_button.SettingDescription', filename, line));
  }
  assert(createsAt('held_proxy.ColliderDisabled', 'src/item_interaction/attachment.rs', 103));
  assert(registry['parcel.RigidBody'].sourceEntries.some(source => source.role === 'destroy' && source.path === 'src/item_interaction/attachment.rs' && source.line === 31));
  for (const id of ['held_fixed', 'held_update', 'facing_fixed', 'facing_update']) {
    assert.equal(registry[id].sourceEntries.filter(source => source.role === 'definition').length, 1);
    assert.equal(registry[id].sourceEntries.filter(source => source.role === 'registration').length, 1);
  }
  for (const family of [['flow_suspend', 'flow_suspend_paused'], ['character_clear_intents', 'character_clear_intents_paused']]) for (const id of family) {
    assert.deepEqual(registry[id].registrationFamilyIds, family);
    const entries = registry[id].sourceEntries.filter(source => source.role === 'registration');
    assert.equal(entries.length, 1);
    assert.ok(entries[0].label.includes(registry[id].schedule));
  }
  for (const id of ['resource.SessionWriter', 'resource.ConsoleWriter']) {
    assert.deepEqual(registry[id].sourceGaps, []);
    for (const role of ['definition', 'initialize', 'insert', 'remove']) assert.ok(registry[id].sourceEntries.some(source => source.role === role), `${id}: ${role}`);
  }
  assert.ok(registry['param-recoverable-body'].sourceEntries.some(source => source.role === 'parameter'));
  assert.equal(registry['param-carry-rotation'].sourceEntries.filter(source => source.role === 'parameter').length, 2);
  assert.deepEqual(model.system_links.filter(link => link.from === 'param-carry-rotation').map(link => link.to), ['facing_fixed', 'facing_update', 'carry_align']);
  for (const relation of model.relationships.filter(relation => relation.from_component)) {
    assert.ok(model.entities.find(entity => entity.id === relation.from)?.components.some(component => component.id === relation.from_component), `${relation.id}: explicit component belongs to source entity`);
    const component = registry[relation.from_component], definition = component.sourceEntries.find(source => source.role === 'definition');
    const contents = definition.dependency ? resolver.read(definition).text : fs.readFileSync(path.join(repository, definition.path), 'utf8');
    assert.match(contents, relation.component_field === '0' ? new RegExp(`struct\\s+${component.name.split('<')[0]}(?:<[^>]*>)?\\s*\\(`) : new RegExp(`\\b${relation.component_field}\\s*:`));
  }
  const pbrGltf = resolver.read({ ...registry['model_node.MeshMaterial3d'].definition_source, path: 'src/gltf.rs' }).text;
  assert.match(pbrGltf, /let handle = load_context\.get_label_handle::<StandardMaterial>\(std_label\);\s*entity\.insert\(MeshMaterial3d\(handle\)\);/);
  assert.equal(registry['model_node.MeshMaterial3d'].rust_type, 'bevy::pbr::MeshMaterial3d<bevy::pbr::StandardMaterial>');
  assert.ok(audit.context.projectFiles.every(file => !/\bGltfExtensionHandler\b/.test(file.code)));
  assert(hasSource('entity-parcel', 'create', 'src/scene_assembly/actors.rs', /commands\.spawn_scene\(carryable_scene/));
  assert(hasSource('entity-parcel', 'destroy', 'src/scene_assembly/actors.rs', /entity\.insert\(\(parcel_body\(&config\), DespawnOnExit/));
  assert(hasSource('entity-parcel', 'destroy', 'src/ui/requests.rs', /app_state\.set\(AppState::MainMenu\)/));
  assert(hasSource('entity-parcel', 'destroy', 'src/state_scoped.rs', /commands\.despawn_all_where::<&DespawnOnExit<S>/, 'bevy_state'));
  assert(registry['resource.UiRequestMessages'].sourceEntries.some(source => source.role === 'message_definition'));
  assert.deepEqual(registry['resource.UiRequestMessages'].fields, ['UiRequest.action: UiAction']);
  const generated = pathsForRepository(repository).generatedDirectory;
  const artifactManifest = JSON.parse(fs.readFileSync(path.join(generated, 'data/manifest.json'), 'utf8'));
  const artifactRuntime = JSON.parse(fs.readFileSync(path.join(generated, artifactManifest.runtime.path), 'utf8'));
  assert.deepEqual(artifactRuntime.registry['resource.UiRequestMessages'].fields, ['UiRequest.action: UiAction']);
  assert(artifactRuntime.registry['resource.UiRequestMessages'].sourceEntries.some(source => source.role === 'message_definition'));
  for (const [id, field] of Object.entries({ 'controller.ControlsCharacter': 'character', 'controller.ControlsCamera': 'camera', 'parcel.HeldBy': 'holder', 'held_proxy.HeldCollider': 'item' })) {
    assert(artifactRuntime.registry[id].fields.some(value => value.startsWith(`${field}:`)), `${id}: formal named-field metadata`);
  }
  assert(!registry['resource.UiRequestMessages'].sourceEntries.some(source => source.role === 'remove'), 'Generic deregistration capability is not an observed removal of this resource');
  assert.deepEqual(registry['resource.UiTrack'].sourceEntries.map(source => source.role), ['definition']);
  assert.equal(registry['resource.EnableMultipassForPrimaryContext'], undefined, 'Egui 0.43 no longer installs a multipass marker Resource');
  assert.equal(registry['camera.EguiMultipassSchedule'].name, 'EguiSchedule', 'The stable projection points at the current component');
  assert(hasSource('camera.EguiMultipassSchedule', 'definition', 'src/lib.rs', /^pub struct EguiSchedule\(/, 'bevy_egui'));
  assert(hasSource('resource.EguiGlobalSettings', 'initialize', 'src/lib.rs', /init_resource::<EguiGlobalSettings>/, 'bevy_egui'));

  for (const [id, variant] of [['input_apply', 'Apply'], ['input_trigger', 'Trigger']]) {
    assert(hasSource(id, 'definition', 'src/lib.rs', new RegExp(`^\\s*${variant},`), 'bevy_enhanced_input'));
  }
  assert.notEqual(registry.input_apply.definition_source.line, registry.input_trigger.definition_source.line);
  assert.deepEqual(registry.input_apply.writes, model.object_aliases['action.Action']);
  assert.deepEqual(registry.input_apply.events, []);
  assert(registry.input_trigger.events.some(event => /Fire<MoveAction>/.test(event)));
  for (const id of ['time_update', 'input_update', 'input_trigger', 'animation_engine', 'native-ui-layout', 'kira-play-typed']) {
    assert.equal(registry[id].sourcePolicyKind, 'system_set', id);
    assert(registry[id].sourceEntries.every(source => ['definition', 'configure'].includes(source.role)), id);
  }
  for (const [id, packageName, sourcePath, pattern] of [
    ['time_update', 'bevy_time', 'src/lib.rs', /\.in_set\(TimeSystems\)/],
    ['input_update', 'bevy_input', 'src/lib.rs', /\.in_set\(InputSystems\)/],
    ['transform_propagate', 'bevy_transform', 'src/plugins.rs', /\.in_set\(TransformSystems::Propagate\)/],
    ['animation_engine', 'bevy_animation', 'src/lib.rs', /\.in_set\(AnimationSystems\)/],
    ['kira-play-typed', 'bevy_kira_audio', 'src/audio.rs', /\.in_set\(AudioSystemSet::PlayTypedChannels\)/],
    ['native-visibility', 'bevy_camera', 'src/visibility/mod.rs', /\(UpdateFrusta, VisibilityPropagate\)/],
  ]) {
    assert(hasSource(id, 'configure', sourcePath, pattern, packageName), `${id}: actual configuration survives imported names and defining-package boundaries`);
    assert.deepEqual(registry[id].sourceGaps, [], id);
  }
  for (const id of ['easing_reset', 'easing_start', 'easing_end']) {
    assert(!registry[id].sourceEntries.some(source => source.path === 'src/game_flow/mod.rs'), `${id}: constraints on Ease do not configure this variant`);
  }
  assert(!registry['native-ui-layout'].sourceEntries.some(source => !source.dependency && source.path === 'src/ui/mod.rs'), 'Project UiSystems and Bevy UiSystems are different declarations');
  for (const id of ['world_spawn', 'render', 'audio-output', 'kira-output']) {
    assert.equal(registry[id].sourcePolicyKind, 'engine_flow', id);
    assert(registry[id].sourceEntries.some(source => source.role === 'configure'), id);
    assert(registry[id].sourceEntries.some(source => source.role === 'implementation'), id);
    assert(!registry[id].sourceEntries.some(source => ['definition', 'registration'].includes(source.role)), `${id}: aggregate does not impersonate a single System`);
  }
  assert.equal(registry['plugin-DefaultPlugins'].sourcePolicyKind, 'plugin_group');
  assert.equal(registry['plugin-physics-0'].sourcePolicyKind, 'plugin_group');
  assert.deepEqual(registry['plugin-sound-events'].sourceEntries.map(source => source.role), ['definition', 'configure']);
  assert.equal(registry['native-scrollbar-events'].sourcePolicyKind, 'observer_group');
  assert.equal(registry['native-scrollbar-events'].sourceEntries.filter(source => source.role === 'implementation').length, 5);
  assert.equal(registry['audio-producers'].memberIds.length, 9);
  assert.equal(registry['audio-producers'].sourceEntries.filter(source => source.role === 'implementation').length, 8, 'Two facing registrations share a single actual function definition');
  assert(registry['audio-producers'].sourceEntries.some(source => source.role === 'configure' && /Observer/.test(source.label)), 'Observer producers use Observer registrations rather than fabricated Schedules');
  assert.deepEqual(registry['audio-producers'].sourceGaps, []);
  assert(hasSource('ui-next-state', 'related', 'src/ui/requests.rs', /app_state\.set\(AppState::InGame\)/));
  assert(hasSource('ui-next-state', 'related', 'src/ui/requests.rs', /play_state\.set\(PlayState::Paused\)/));

  assert.equal(registry.wake_apply.sourcePolicyKind, 'sync');
  assert(hasSource('wake_apply', 'definition', 'src/schedule/executor/mod.rs', /^pub struct ApplyDeferred;/, 'bevy_ecs'));
  assert(hasSource('wake_apply', 'configure', 'src/physics/mod.rs', /before\(PhysicsSystems::Prepare\)/));
  assert(hasSource('event_apply', 'definition', 'src/schedule/executor/mod.rs', /^pub struct ApplyDeferred;/, 'bevy_ecs'));
  assert(hasSource('event_apply', 'configure', 'src/ui/requests.rs', /after\(EnhancedInputSystems::Trigger\)/));
  assert(hasSource('resource.LastPhysicsTick', 'initialize', 'src/schedule/mod.rs', /init_resource::<LastPhysicsTick>/, 'avian3d'));
  assert.equal(registry.wake_changed_bodies.sourceEntries.filter(source => source.role === 'definition').length, 1);
  assert.equal(registry.wake_changed_bodies.sourceEntries.filter(source => source.role === 'registration').length, 1);

  for (const name of ['down', 'up', 'click', 'drag_end', 'cancel', 'key']) {
    const record = registry[`native_button_${name}`];
    assert.equal(record.sourcePolicyKind, 'observer');
    assert.equal(record.sourceEntries.filter(source => source.role === 'definition').length, 1);
    assert.equal(record.sourceEntries.filter(source => source.role === 'registration').length, 1);
    assert(record.sourceEntries.every(source => source.dependency?.name === 'bevy_ui_widgets' && source.path === 'src/button.rs'));
  }
  for (const id of ['native_pointer_events', 'native_update_hovered']) {
    assert.equal(registry[id].sourcePolicyKind, 'system');
    assert.equal(registry[id].sourceEntries.filter(source => source.role === 'definition').length, 1);
    assert.equal(registry[id].sourceEntries.filter(source => source.role === 'registration').length, 1);
    assert(registry[id].sourceEntries.every(source => source.dependency?.name === 'bevy_picking'));
  }
  for (const [id, symbol, sourcePath, packageName] of [
    ['event-native_button_up', 'PointerRelease', 'src/events.rs', 'bevy_picking'],
    ['event-native_button_click', 'PointerClick', 'src/events.rs', 'bevy_picking'],
    ['event-native_button_drag_end', 'PointerDragEnd', 'src/events.rs', 'bevy_picking'],
    ['event-native_button_cancel', 'PointerCancel', 'src/events.rs', 'bevy_picking'],
    ['native-focused-keyboard-event', 'FocusedInput', 'src/lib.rs', 'bevy_input_focus'],
    ['native-button-activate-event', 'Activate', 'src/lib.rs', 'bevy_ui_widgets'],
    ['event-observe_menu_primary_clear', 'RemoveEvent', 'src/lifecycle.rs', 'bevy_ecs'],
  ]) {
    assert(hasSource(id, 'definition', sourcePath, new RegExp(`^pub struct ${symbol}\\b`), packageName), `${id}: actual event declaration`);
    assert.deepEqual(registry[id].sourceGaps, [], id);
  }
  assert.equal(registry['event-observe_menu_primary_clear'].name, 'RemoveEvent');
  assert.equal(model.observers.find(observer => observer.system === 'observe_menu_primary_clear').event, 'RemoveEvent');
  assert(registry.observe_menu_primary_clear.filters.some(filter => filter.includes('On<Remove<Pressed>>')));
  for (const [symbol, sourcePath, qualified] of [
    ['HoverMap', 'src/hover.rs', 'hover::HoverMap'],
    ['PreviousHoverMap', 'src/hover.rs', 'hover::PreviousHoverMap'],
    ['PointerState', 'src/events.rs', 'PointerState'],
    ['PointerMap', 'src/pointer.rs', 'pointer::PointerMap'],
    ['PickingSettings', 'src/lib.rs', 'PickingSettings'],
  ]) {
    const id = `resource.${symbol}`;
    assert(hasSource(id, 'definition', sourcePath, new RegExp(`^pub struct ${symbol}\\b`), 'bevy_picking'), `${id}: actual resource declaration`);
    assert(hasSource(id, 'initialize', 'src/lib.rs', new RegExp(`init_resource::<${qualified}>`), 'bevy_picking'), `${id}: actual framework initialization`);
    assert.deepEqual(registry[id].sourceGaps, [], id);
  }
  for (const [symbol, sourcePath, qualified] of [
    ['PointerPress', 'src/events.rs', 'PointerPress'],
    ['PointerInput', 'src/pointer.rs', 'pointer::PointerInput'],
  ]) {
    const id = `resource.${symbol}Messages`;
    assert(hasSource(id, 'message_definition', sourcePath, new RegExp(`^pub struct ${symbol}\\b`), 'bevy_picking'), `${id}: actual message declaration`);
    assert(hasSource(id, 'registration', 'src/lib.rs', new RegExp(`add_message::<${qualified}>`), 'bevy_picking'), `${id}: actual framework message registration`);
  }
  assert.equal(registry['native-scrollbar-layout'].sourceEntries.filter(source => source.role === 'registration').length, 1, 'Popover ordering constraints do not register the scrollbar function');
  assert.equal(registry.inspector_pass.sourcePolicyKind, 'system');
  assert.deepEqual(registry.inspector_pass.sourceEntries.map(source => [source.role, source.path, source.line]), [['definition', 'src/quick.rs', 92], ['registration', 'src/quick.rs', 88]], 'The real inspector function shows only its definition and true Schedule registration');
  assert.deepEqual({ description: registry.inspector_pass.description, notes: registry.inspector_pass.notes, registrations: registry.inspector_pass.registrations }, inspectorBody, 'Exclusive World access and run conditions remain intact');
});

test('native framework plugins retain exact parent-group installation evidence', () => {
  const metadata = readCargoMetadata(repository), resolver = createDependencySourceResolver(metadata);
  const installations = [
    ['UiWidgetsPlugins', 'PluginGroup', 'bevy_internal', 'src/default_plugins.rs', /bevy_ui_widgets:::UiWidgetsPlugins,/],
    ['DefaultPickingPlugins', 'PluginGroup', 'bevy_internal', 'src/default_plugins.rs', /bevy_picking:::DefaultPickingPlugins,/],
    ['ButtonPlugin', 'Plugin', 'bevy_ui_widgets', 'src/lib.rs', /\.add\(ButtonPlugin\)/],
    ['PickingPlugin', 'Plugin', 'bevy_picking', 'src/lib.rs', /\.add\(PickingPlugin\)/],
    ['InteractionPlugin', 'Plugin', 'bevy_picking', 'src/lib.rs', /\.add\(InteractionPlugin\)/],
  ];
  const registry = Object.fromEntries(installations.map(([name, kind]) => [`plugin-${name}`, { id: `plugin-${name}`, name, kind, feature: 'infrastructure' }]));
  attachDependencySources(registry, resolver, DEPENDENCY_SOURCE_DEFINITIONS);
  applyArchitectureSourcePolicies(registry, { repository, dependencyContext: { metadata, resolver } });
  for (const [name, , packageName, sourcePath, pattern] of installations) {
    const record = registry[`plugin-${name}`];
    assert.deepEqual(record.sourceEntries.map(source => source.role), ['definition', 'build', 'install']);
    const install = record.sourceEntries.find(source => source.role === 'install');
    assert.equal(install.dependency.name, packageName);
    assert.equal(install.path, sourcePath);
    assert.match(resolver.read(install).lines[install.line - 1], pattern);
    assert.deepEqual(record.sourceGaps, []);
  }
});

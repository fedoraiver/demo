import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSourceEntry, sourceEntriesFor, sourcePolicyFor, sourcePolicyKindFor, applyArchitectureSourcePolicies, applyArchitectureEdgeSourcePolicies } from './architecture-source-policy.mjs';
import { buildArchitectureModel } from './architecture-model.mjs';
import { readCargoMetadata, createDependencySourceResolver, attachDependencySources } from './dependency-sources.mjs';
import { DEPENDENCY_SOURCE_DEFINITIONS } from './architecture-source-definitions.mjs';
import { buildComponentCatalog } from './architecture-components.mjs';

const entry = (role, overrides = {}) => ({ role, label: role, path: 'src/example.rs', line: 12, ...overrides });
const dependency = { name: 'bevy_ecs', version: '0.17.3', root: 'C:/cargo/registry/bevy_ecs-0.17.3' };

test('every semantic card kind has its approved source role scope', () => {
  const cases = {
    Component: ['definition'], Entity: ['create', 'destroy'], System: ['definition', 'registration'],
    Observer: ['definition', 'registration'], Resource: ['definition', 'initialize', 'insert', 'remove'],
    'Local<T>': ['parameter', 'definition', 'initialize'],
    'NonSend<T>': ['definition', 'initialize', 'insert', 'remove', 'cleanup'], Message: ['definition'],
    'Messages<T>': ['definition', 'message_definition', 'registration', 'initialize', 'remove'],
    EntityEvent: ['definition', 'action_definition'], Plugin: ['definition', 'build', 'install'],
    PluginGroup: ['definition', 'build', 'install'], App: ['create', 'assembly', 'run'],
    SystemSet: ['definition', 'configure'], 'Engine SystemSet': ['definition', 'configure'],
    Contract: ['definition', 'configure', 'parameter'], SystemParam: ['definition', 'configure', 'parameter'],
    QueryData: ['definition', 'configure', 'parameter'], Relationship: ['definition', 'configure', 'parameter'],
    sync: ['definition', 'implementation', 'registration', 'configure'],
    'External I/O': ['definition', 'create', 'install', 'implementation', 'close'], 'Lifecycle note': ['related'],
  };
  for (const [kind, roles] of Object.entries(cases)) {
    assert.deepEqual(sourcePolicyFor(kind).roles, roles, kind);
    assert.deepEqual(sourceEntriesFor({}, { kind, reviewedEntries: roles.map(role => entry(role)) }).map(source => source.role), roles);
  }
});

test('unknown kinds and aggregate engine visual kinds cannot masquerade as systems', () => {
  for (const kind of [undefined, 'engine', 'rounded', 'Plugin / App', 'random']) {
    assert.deepEqual(sourceEntriesFor({ kind, sources: [entry('definition')] }), []);
  }
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

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function sourceFixture(t, text) {
  const temporaryRoot = path.join(repository, 'tmp');
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(temporaryRoot, 'architecture-source-policy-'));
  fs.mkdirSync(path.join(fixture, 'src/example'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'src/example/mod.rs'), text);
  t.after(() => {
    const relative = path.relative(temporaryRoot, fixture);
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    fs.rmSync(fixture, { recursive: true });
  });
  return fixture;
}

test('semantic kinds distinguish real storage types from visual aggregates', () => {
  assert.equal(sourcePolicyKindFor({ kind: 'engine', name: 'InputSystems' }), 'sync');
  assert.equal(sourcePolicyKindFor({ id: 'inspector_pass', kind: 'engine', name: 'world_inspector_ui' }), 'system');
  assert.equal(sourcePolicyKindFor({ id: 'capture-state', kind: 'Component' }), 'Note');
  assert.equal(sourcePolicyKindFor({ kind: 'Resource', name: 'Messages<SoundRequest>' }), 'Messages<T>');
  assert.equal(sourcePolicyKindFor({ kind: 'Plugin', name: 'PhysicsPlugins + TransformInterpolation' }), 'PluginGroup');
  assert.equal(sourcePolicyKindFor({ kind: 'Native platform bridge' }), 'External I/O');
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

test('current registry and merged function cards have verified source scope across all real types', () => {
  const model = JSON.parse(fs.readFileSync(path.join(repository, 'docs/diagrams/ecs-data.json'), 'utf8'));
  const { registry } = buildArchitectureModel(model);
  const metadata = readCargoMetadata(repository), resolver = createDependencySourceResolver(metadata);
  attachDependencySources(registry, resolver, DEPENDENCY_SOURCE_DEFINITIONS);
  buildComponentCatalog(model, registry);
  const inspectorBody = structuredClone({ description: registry.inspector_pass.description, notes: registry.inspector_pass.notes, registrations: registry.inspector_pass.registrations });
  const audit = applyArchitectureSourcePolicies(registry, { repository, model, dependencyContext: { metadata, resolver } });
  const sourceLine = source => source.dependency ? resolver.read(source).lines[source.line - 1]
    : fs.readFileSync(path.join(repository, source.path), 'utf8').split(/\r?\n/)[source.line - 1];
  const hasSource = (id, role, sourcePath, pattern, packageName) => registry[id].sourceEntries.some(source =>
    source.role === role && source.path === sourcePath && source.dependency?.name === packageName && pattern.test(sourceLine(source)));
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
      assert(record.sourceEntries.every(source => source.role === 'definition'), `${record.id}: component definitions only`);
    }
  }
  for (const id of ['held_fixed', 'held_update', 'facing_fixed', 'facing_update']) {
    assert.equal(registry[id].sourceEntries.filter(source => source.role === 'definition').length, 1);
    assert.equal(registry[id].sourceEntries.filter(source => source.role === 'registration').length, 2);
  }
  assert(hasSource('entity-parcel', 'create', 'src/scene_assembly/actors.rs', /commands\.spawn_scene\(carryable_scene/));
  assert(hasSource('entity-parcel', 'destroy', 'src/scene_assembly/actors.rs', /entity\.insert\(\(parcel_body\(&config\), DespawnOnExit/));
  assert(hasSource('entity-parcel', 'destroy', 'src/ui/requests.rs', /app_state\.set\(AppState::MainMenu\)/));
  assert(hasSource('entity-parcel', 'destroy', 'src/state_scoped.rs', /commands\.despawn_all_where::<&DespawnOnExit<S>/, 'bevy_state'));
  assert(registry['resource.UiRequestMessages'].sourceEntries.some(source => source.role === 'message_definition'));
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
  assert.deepEqual(registry.input_apply.writes, ['action.Action']);
  assert.deepEqual(registry.input_apply.events, []);
  assert(registry.input_trigger.events.some(event => /Fire<MoveAction>/.test(event)));

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

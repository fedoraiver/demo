import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createDependencySourceResolver, dependencySourceKey, dependencyDefinitionTargets, attachDependencySources, checkDependencySources, readCargoMetadata } from './dependency-sources.mjs';
import { buildArchitectureModel } from './architecture-model.mjs';
import { DEPENDENCY_SOURCE_DEFINITIONS } from './architecture-source-definitions.mjs';
import { vscodeUri } from './source-editor.mjs';
import { fileURLToPath } from 'node:url';

const temporaryRoot = new URL('../../tmp/ecs-architecture/dependency-source-tests/', import.meta.url);
function fixture(text = '\r\n#[derive(Component)]\r\npub(crate) struct Friction(pub f32);\r\n') {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.mkdtempSync(new URL('case-', temporaryRoot));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname="example"\nversion="1.2.3"\n');
  fs.writeFileSync(path.join(root, 'src/material.rs'), text);
  const metadata = { packages: [{ name: 'example', version: '1.2.3', manifest_path: path.join(root, 'Cargo.toml'), source: 'registry+https://example.invalid/index' }] };
  const definition = { package: 'example', path: 'src/material.rs', kind: 'struct', symbol: 'Friction' };
  return { root, metadata, definition, resolver: createDependencySourceResolver(metadata) };
}

test('dependency declarations use locked package roots and exact one-based lines without consuming preceding whitespace', () => {
  const { root, definition, resolver } = fixture();
  const source = resolver.resolve(definition);
  assert.deepEqual(source, { path: 'src/material.rs', line: 3, dependency: { name: 'example', version: '1.2.3', root: root.replaceAll('\\', '/') } });
  assert.equal(dependencySourceKey(source), 'cargo/example-1.2.3/src/material.rs');
  assert.equal(resolver.read(source).lines[source.line - 1], 'pub(crate) struct Friction(pub f32);');
});

test('missing, ambiguous and wrong-version declarations fail instead of silently opening a usage site', () => {
  const data = fixture('pub struct Friction;\npub struct Friction;\n');
  assert.throws(() => data.resolver.resolve(data.definition), /found 2/);
  assert.throws(() => data.resolver.resolve({ ...data.definition, symbol: 'Missing' }), /found 0/);
  assert.throws(() => data.resolver.resolve({ ...data.definition, version: '9.0.0' }), /Expected one locked registry package/);
  data.metadata.packages.push({ ...data.metadata.packages[0], version: '2.0.0' });
  assert.throws(() => data.resolver.resolve(data.definition), /Expected one locked registry package/);
  assert.throws(() => data.resolver.resolve({ ...data.definition, version: '1.2.3' }), /found 2/);
});

test('explicit contextual patterns distinguish cfg declarations while retaining the declaration line', () => {
  const { definition, resolver } = fixture('pub struct Inertia {\n  inverse: f32,\n}\n\npub struct Inertia {\n  inverse: Matrix,\n}\n');
  const source = resolver.resolve({ ...definition, pattern: '^pub struct Inertia \\{(?=[^}]*inverse: Matrix)' });
  assert.equal(source.line, 5);
});

test('a scheduling member is located inside its actual enum even when another enum has the same variant', () => {
  const { definition, resolver } = fixture('pub enum Other {\n    PlayTypedChannels,\n}\npub enum AudioSystemSet {\n    Prepare,\n    PlayTypedChannels,\n}\n');
  const source = resolver.resolve({ ...definition, pattern: DEPENDENCY_SOURCE_DEFINITIONS['kira-play-typed'].pattern });
  assert.equal(source.line, 6);
});

test('dependency sources cannot leave their package, substitute another root or use malformed identities', () => {
  const { definition, resolver } = fixture();
  const source = resolver.resolve(definition);
  for (const candidate of ['../outside.rs', '/outside.rs', 'src/../outside.rs', 'C:/outside.rs', 'src\\material.rs', 'src//material.rs', 'src/material.rs?x']) {
    assert.throws(() => resolver.read({ ...source, path: candidate }), /Unsafe dependency source path/);
  }
  assert.throws(() => resolver.read({ ...source, dependency: { ...source.dependency, root: source.dependency.root + '/other' } }), /root mismatch/);
  assert.throws(() => resolver.read({ ...source, dependency: { ...source.dependency, version: '9.0.0' } }), /Expected one locked registry package/);
  for (const dependency of [{}, { name: '../example', version: '1.2.3' }, { name: 'example', version: '1.2.3/escape' }]) {
    assert.throws(() => dependencySourceKey({ ...source, dependency }), /identity/);
  }
});

test('local and nonregistry packages are not accepted as Cargo registry definitions', () => {
  const { metadata, definition } = fixture();
  metadata.packages[0].source = null;
  assert.throws(() => createDependencySourceResolver(metadata).resolve(definition), /Expected one locked registry package/);
});

test('definition attachment preserves project usage, identity, ownership and unrelated project types', () => {
  const { definition, resolver } = fixture();
  const source = { path: 'src/project.rs', line: 10 };
  const registry = {
    friction: { id: 'friction', kind: 'Component', feature: 'avian', defined_in: 'avian', source },
    plugin: { id: 'plugin', kind: 'Plugin', feature: 'infrastructure' },
    payload: { id: 'payload', kind: 'Component', feature: 'avian', defined_in: 'physics', source },
    system: { id: 'system', kind: 'system', feature: 'physics', source },
  };
  assert.deepEqual(dependencyDefinitionTargets(registry), ['friction', 'plugin']);
  assert.throws(() => attachDependencySources(registry, resolver, { friction: definition }), /Missing dependency definition: plugin/);
  const definitions = { friction: definition, plugin: definition };
  attachDependencySources(registry, resolver, definitions);
  assert.equal(registry.friction.source, source);
  assert.equal(registry.payload.definition_source, undefined);
  assert.equal(registry.system.definition_source, undefined);
  checkDependencySources(registry, resolver, definitions);
  for (const corrupt of [value => value.line++, value => value.path = 'src/other.rs', value => value.dependency.root += '/elsewhere']) {
    const changed = structuredClone(registry); corrupt(changed.friction.definition_source);
    assert.throws(() => checkDependencySources(changed, resolver, definitions), /Dependency definition source mismatch: friction/);
  }
  const missing = structuredClone(registry); delete missing.plugin.definition_source;
  assert.throws(() => checkDependencySources(missing, resolver, definitions), /Dependency definition source mismatch: plugin/);
});

test('all maintained dependency types and execution nodes resolve real declarations while original usages remain intact', () => {
  const repository = fileURLToPath(new URL('../..', import.meta.url));
  const model = JSON.parse(fs.readFileSync(new URL('./ecs-data.json', import.meta.url), 'utf8'));
  const { registry } = buildArchitectureModel(model);
  const usages = structuredClone(Object.fromEntries(Object.entries(registry).map(([id, node]) => [id, node.source])));
  const targets = dependencyDefinitionTargets(registry);
  assert.deepEqual(new Set(targets), new Set(Object.keys(DEPENDENCY_SOURCE_DEFINITIONS)));
  const resolver = createDependencySourceResolver(readCargoMetadata(repository));
  attachDependencySources(registry, resolver, DEPENDENCY_SOURCE_DEFINITIONS);
  checkDependencySources(registry, resolver, DEPENDENCY_SOURCE_DEFINITIONS);
  assert.deepEqual(Object.fromEntries(Object.entries(registry).map(([id, node]) => [id, node.source])), usages);
  for (const id of targets) assert.ok(resolver.read(registry[id].definition_source).lines[registry[id].definition_source.line - 1].trim(), id);
  for (const id of ['character.Friction', 'parcel.Friction', 'held_proxy.Friction']) {
    const source = registry[id].definition_source;
    assert.equal(source.dependency.name, 'avian3d');
    assert.equal(source.dependency.version, '0.8.0');
    assert.equal(source.path, 'src/dynamics/rigid_body/physics_material.rs');
    assert.match(resolver.read(source).lines[source.line - 1], /^pub struct Friction/);
    assert.ok(vscodeUri('Z:/another-worktree', source).endsWith(`/avian3d-0.8.0/${source.path}:${source.line}:1`));
  }
  assert.equal(registry['menu_button.Button'].definition_source.dependency.name, 'bevy_ui_widgets');
  const worldRoots = targets.filter(id => DEPENDENCY_SOURCE_DEFINITIONS[id].symbol === 'WorldAssetRoot');
  assert.ok(worldRoots.length);
  for (const id of worldRoots) assert.equal(registry[id].definition_source.dependency.name, 'bevy_world_serialization');
  const kira = registry['kira-play-typed'];
  assert.equal(kira.source, undefined);
  assert.equal(kira.definition_source.dependency.name, 'bevy_kira_audio');
  assert.equal(kira.definition_source.path, 'src/lib.rs');
  assert.match(resolver.read(kira.definition_source).lines[kira.definition_source.line - 1], /^\s*PlayTypedChannels,/);
  const synchronization = ['held_apply', 'capture_apply', 'orphan_apply', 'wake_apply', 'event_apply'];
  for (const id of synchronization) {
    const source = registry[id].definition_source;
    assert.equal(source.dependency.name, 'bevy_ecs');
    assert.equal(source.path, 'src/schedule/executor/mod.rs');
    assert.match(resolver.read(source).lines[source.line - 1], /^pub struct ApplyDeferred;/);
    assert.deepEqual(registry[id].source, usages[id]);
    assert.deepEqual(source, registry.capture_apply.definition_source);
    assert.equal(vscodeUri('Z:/another-worktree', source).includes('/src/first_person/mod.rs'), false);
  }
});

test('the 0.20 dependency catalog distinguishes native UI states, 3d physics and input execution stages', () => {
  const repository = fileURLToPath(new URL('../..', import.meta.url));
  const resolver = createDependencySourceResolver(readCargoMetadata(repository));
  const sourceFor = id => resolver.resolve(DEPENDENCY_SOURCE_DEFINITIONS[id]);
  const declarationFor = id => {
    const source = sourceFor(id);
    return resolver.read(source).lines[source.line - 1];
  };
  assert.match(declarationFor('menu_button.Button'), /^pub struct Button;/);
  assert.equal(sourceFor('menu_button.Button').dependency.name, 'bevy_ui_widgets');
  assert.equal(sourceFor('menu_button.Button').dependency.version, '0.20.0');
  assert.equal(sourceFor('menu_button.Pressed').path, 'src/interaction_states.rs');
  assert.equal(sourceFor('menu_button.Hovered').dependency.name, 'bevy_picking');
  assert.match(declarationFor('menu_button.Pressed'), /^pub struct Pressed;/);
  assert.match(declarationFor('menu_button.Hovered'), /^pub struct Hovered/);

  assert.match(declarationFor('character.Rotation'), /^pub struct Rotation\(pub Quat\);/);
  const inertia = sourceFor('character.ComputedAngularInertia');
  assert.equal(resolver.read(inertia).lines[inertia.line], '    inverse: SymmetricTensor,');
  for (const id of ['character.SpeculativeCcd', 'parcel.SpeculativeCcd']) {
    assert.equal(sourceFor(id).dependency.version, '0.8.0');
    assert.match(declarationFor(id), /^pub struct SpeculativeCcd/);
  }
  for (const [type, sourcePath] of [
    ['BodySizeMetrics', 'src/dynamics/rigid_body/body_size_metrics.rs'],
    ['SolverBodyIndex', 'src/dynamics/solver/solver_body/mod.rs'],
    ['Sleeping', 'src/dynamics/rigid_body/sleeping.rs'],
  ]) {
    const sources = ['character', 'parcel'].map(owner => sourceFor(`${owner}.${type}`));
    assert.deepEqual(sources[0], sources[1]);
    assert.equal(sources[0].dependency.name, 'avian3d');
    assert.equal(sources[0].dependency.version, '0.8.0');
    assert.equal(sources[0].path, sourcePath);
    assert.match(declarationFor(`character.${type}`), new RegExp(`^pub struct ${type}\\b`));
  }
  assert.deepEqual(sourceFor('wake_apply'), sourceFor('capture_apply'));

  assert.equal(sourceFor('input_apply').dependency.version, '0.27.0');
  assert.match(declarationFor('input_apply'), /^\s*Apply,/);
  assert.match(declarationFor('input_trigger'), /^\s*Trigger,/);
  assert.notEqual(sourceFor('input_apply').line, sourceFor('input_trigger').line);
  const egui = sourceFor('camera.EguiMultipassSchedule');
  assert.equal(egui.dependency.version, '0.43.1');
  assert.match(declarationFor('camera.EguiMultipassSchedule'), /^pub struct EguiSchedule\(/);
  assert.equal(sourceFor('kira-play-typed').dependency.version, '0.27.1');

  for (const id of ['plugin-UiWidgetsPlugins', 'plugin-ButtonPlugin']) {
    assert.equal(sourceFor(id).dependency.name, 'bevy_ui_widgets');
    assert.match(declarationFor(id), /^pub struct (?:UiWidgetsPlugins|ButtonPlugin);/);
  }
  for (const plugin of ['DefaultPickingPlugins', 'InteractionPlugin', 'PickingPlugin']) {
    const id = `plugin-${plugin}`;
    assert.equal(sourceFor(id).dependency.name, 'bevy_picking');
    assert.match(declarationFor(id), new RegExp(`^pub struct ${plugin};`));
  }
  const callbacks = ['down', 'up', 'click', 'drag_end', 'cancel', 'key'].map(name => sourceFor(`native_button_${name}`));
  assert.equal(new Set(callbacks.map(source => source.line)).size, 6);
  for (const source of callbacks) {
    assert.equal(source.dependency.name, 'bevy_ui_widgets');
    assert.match(resolver.read(source).lines[source.line - 1], /^fn button_on_/);
  }
  assert.match(declarationFor('native_pointer_events'), /^pub fn pointer_events\(/);
  assert.match(declarationFor('native_update_hovered'), /^pub fn update_is_hovered\(/);
  for (const [id, variant] of [['picking_hover', 'Hover'], ['picking_post_hover', 'PostHover'], ['picking_last', 'Last']]) {
    assert.equal(sourceFor(id).dependency.name, 'bevy_picking');
    assert.equal(declarationFor(id).trim(), `${variant},`);
  }
});

test('execution definitions include engine sets and synchronization while preserving project implementations and output contracts', () => {
  const { definition, resolver } = fixture();
  const kinds = ['System', 'Observer', 'Synchronization', 'SystemSet', 'Observer group', 'PluginGroup'];
  const registry = Object.fromEntries(kinds.map((kind, index) => ['execution-' + index, { id: 'execution-' + index, kind, feature: 'infrastructure' }]));
  registry.project = { id: 'project', kind: 'SystemSet', feature: 'physics', source: { path: 'src/physics.rs', line: 1 } };
  registry.project_observer = { id: 'project_observer', kind: 'observer', feature: 'ui', source: { path: 'src/ui/pointer.rs', line: 1 } };
  registry.output = { id: 'output', kind: 'Engine flow', feature: 'kira' };
  registry.entity = { id: 'entity', kind: 'Entity', feature: 'infrastructure' };
  assert.deepEqual(dependencyDefinitionTargets(registry), kinds.map((_, index) => 'execution-' + index));
  const definitions = Object.fromEntries(kinds.map((_, index) => ['execution-' + index, definition]));
  attachDependencySources(registry, resolver, definitions);
  checkDependencySources(registry, resolver, definitions);
  const missing = structuredClone(registry); delete missing['execution-0'].definition_source;
  assert.throws(() => checkDependencySources(missing, resolver, definitions), /Dependency definition source mismatch: execution-0/);
  assert.equal(registry.project.definition_source, undefined);
  assert.equal(registry.project_observer.definition_source, undefined);
  assert.equal(registry.output.definition_source, undefined);
  assert.equal(registry.entity.definition_source, undefined);
});

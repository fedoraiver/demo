import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildComponentCatalog, maskRustSource } from './architecture-components.mjs';
import { buildArchitectureModel } from './architecture-model.mjs';
import { DEPENDENCY_SOURCE_DEFINITIONS } from './architecture-source-definitions.mjs';

function fixture({ components, systems = [], files = {}, links = [] }) {
  const model = { entities: components.map((component, index) => ({ id: `owner${index}`, name: `Owner ${index}`, components: [component] })), systems, system_links: links };
  const registry = Object.fromEntries(model.entities.flatMap(entity => [
    [`entity-${entity.id}`, { ...entity, id: `entity-${entity.id}`, kind: 'Entity', feature: 'example' }],
    ...entity.components.map(component => [component.id, { ...component, kind: 'Component', feature: 'example', defined_in: 'example' }]),
  ]));
  for (const system of systems) registry[system.id] = { kind: 'system', feature: 'example', ...system };
  return { model, registry, catalog: buildComponentCatalog(model, registry, { readSource: filename => files[filename] }) };
}
const component = (id, name = 'Flag', source = { path: 'src/types.rs', line: 1 }) => ({ id, name, source });
const system = (id, source, reads = [], writes = [], extra = {}) => ({ id, kind: 'system', name: 'run', source, reads, writes,
  registrations: [{ schedule: 'Update', scope: 'runtime' }], ...extra });
const definition = (path, line, name = 'bevy_test', root = 'C:/cargo/test') => ({ path, line, dependency: { name, version: '1.0.0', root } });

test('同一真实声明聚合多个实体投影，原 ID 和全部 owner 保留', () => {
  const result = fixture({ components: [component('a.Flag'), component('b.Flag')] });
  const [type] = result.catalog.types;
  assert.equal(result.catalog.types.length, 1);
  assert.deepEqual(type.projectionIds, ['a.Flag', 'b.Flag']);
  assert.deepEqual(type.ownerEntityIds, ['entity-owner0', 'entity-owner1']);
  assert.equal(type.componentNodeId, 'a.Flag');
  assert.equal(result.registry['b.Flag'].id, 'b.Flag');
  const graph = result.catalog.graphFor('b.Flag');
  assert.equal(graph.nodes.filter(node => node.id === 'a.Flag').length, 1);
  assert.ok(!graph.nodes.some(node => node.id === 'b.Flag'));
  assert.equal(graph.links.filter(link => link.operation === 'contains').length, 2);
});

test('同名不同声明、不同泛型实参以及无定义证据的投影不会误合并', () => {
  const components = [component('a.Pickable', 'Pickable', { path: 'src/a.rs', line: 1 }), component('b.Pickable', 'Pickable', { path: 'src/b.rs', line: 1 }),
    { ...component('a.Generic', 'Generic<A>'), definition_source: definition('src/generic.rs', 5) },
    { ...component('b.Generic', 'Generic<B>'), definition_source: definition('src/generic.rs', 5) }];
  const result = fixture({ components });
  assert.equal(result.catalog.types.length, 4);
  const missing = fixture({ components: [{ id: 'a.Missing', name: 'Missing' }, { id: 'b.Missing', name: 'Missing' }] });
  assert.equal(missing.catalog.types.length, 2);
  assert.ok(missing.catalog.types.every(type => !type.identityVerified && type.sourceGaps.length));
});

test('依赖安装根目录不影响类型 ID；明确 Rust 类型可作为归并证据', () => {
  const first = fixture({ components: [{ id: 'a.F', name: 'Flag', definition_source: definition('src/type.rs', 9) }] });
  const second = fixture({ components: [{ id: 'a.F', name: 'Flag', definition_source: definition('src/type.rs', 9, 'bevy_test', 'D:/other/cache') }] });
  assert.equal(first.catalog.types[0].id, second.catalog.types[0].id);
  const explicit = fixture({ components: [{ id: 'a.F', name: 'Flag', rust_type: 'crate::a::Flag' }, { id: 'b.F', name: 'Flag', rust_type: 'crate::a::Flag' }] });
  assert.equal(explicit.catalog.types.length, 1);
});

test('重复构建同一 registry 不改变类型身份，也不把展示类型文字当新的归并依据', () => {
  const { model, registry, catalog } = fixture({ components: [component('a.Flag'), component('b.Flag')] });
  const again = buildComponentCatalog(model, registry, { readSource: () => '' });
  assert.deepEqual(again.types.map(type => type.id), catalog.types.map(type => type.id));
  assert.deepEqual(again.typeByProjectionId, catalog.typeByProjectionId);
  assert.deepEqual(again.types.map(type => type.details), catalog.types.map(type => type.details));
});

test('类型详情保留各实体投影的完整正文和字段，完整泛型名称不覆盖原投影', () => {
  const { catalog, registry } = fixture({ components: [
    { ...component('a.Flag', 'Flag<State>'), description: '用于状态 A', fields: ['A'], notes: ['共同约束', 'A 约束'], display_summary: '管理退出清理。', owner: '实体 A' },
    { ...component('b.Flag', 'Flag<State>'), description: '用于状态 B', fields: ['B', 'A'], notes: ['共同约束', 'B 约束'], owner: '实体 B' },
  ] });
  const details = catalog.types[0].details;
  assert.equal(details.name, 'Flag<State>');
  assert.equal(details.rust_type, 'crate::types::Flag<State>');
  assert.equal(details.qualified_type, 'crate::types::Flag<State>');
  assert.equal(details.description, '实体 A：用于状态 A\n实体 B：用于状态 B');
  assert.deepEqual(details.fields, ['A', 'B']);
  assert.deepEqual(details.notes, ['共同约束', 'A 约束', 'B 约束']);
  assert.equal(details.display_summary, '管理退出清理。');
  assert.equal(registry['a.Flag'].description, '用于状态 A');
  assert.deepEqual(registry['b.Flag'].fields, ['B', 'A']);
});

test('同函数只显示一次，原注册 ID、完整参数与注册专属说明分别保留', () => {
  const source = { path: 'src/run.rs', line: 1 };
  const records = [system('fixed', source, [], ['a.Flag'], { notes: ['共享', '固定步说明'], registrations: [{ schedule: 'FixedUpdate', scope: 'runtime', sets: ['FixedSet'], run_if: ['running'] }] }),
    system('frame', source, [], ['a.Flag'], { notes: ['共享', '逐帧说明'], registrations: [{ schedule: 'Update', scope: 'runtime', before: ['Camera'] }] })];
  const { catalog, registry } = fixture({ components: [component('a.Flag')], systems: records, files: { 'src/run.rs': 'fn run(mut query: Query<&mut Flag>) {}' } });
  const id = catalog.functionIdBySystemId.fixed;
  assert.equal(catalog.functionIdBySystemId.frame, id);
  assert.deepEqual(registry[id].registrationIds, ['fixed', 'frame']);
  assert.deepEqual(registry[id].notes, ['共享']);
  assert.deepEqual(registry[id].registrations.map(registration => registration.notes), [['固定步说明'], ['逐帧说明']]);
  assert.deepEqual(registry[id].registrations[0].run_if, ['running']);
  assert.equal(registry[id].targetNodeId, 'fixed');
  assert.equal(catalog.graphFor('a.Flag').nodes.filter(node => node.id === id).length, 1);
});

test('归并函数只在公共正文保留通用说明，各注册专属正文进入自己的 notes', () => {
  const source = { path: 'src/run.rs', line: 1 };
  const { catalog, registry } = fixture({ components: [component('a.Flag')], systems: [
    system('fixed', source, [], ['a.Flag'], { description: '同步当前数据。' }),
    system('post', source, [], ['a.Flag'], { description: '引擎回写后再次同步。', registrations: [{ schedule: 'PostUpdate', scope: 'runtime' }] }),
  ], files: { 'src/run.rs': 'fn run(mut query: Query<&mut Flag>) {}' } });
  const merged = registry[catalog.functionIdBySystemId.fixed];
  assert.equal(merged.description, '同步当前数据。');
  assert.deepEqual(merged.registrations[0].notes, []);
  assert.deepEqual(merged.registrations[1].notes, ['引擎回写后再次同步。']);
  assert.deepEqual(merged.registrationDescriptions.map(entry => entry.description), ['同步当前数据。', '引擎回写后再次同步。']);
});

test('同名函数的不同定义不合并，Observer 保留真实节点类别', () => {
  const { catalog } = fixture({ components: [component('a.Flag')], systems: [
    system('one', { path: 'src/one.rs', line: 1 }, ['a.Flag']),
    system('two', { path: 'src/two.rs', line: 1 }, ['a.Flag'], [], { kind: 'observer', registrations: [] }),
  ] });
  assert.notEqual(catalog.functionIdBySystemId.one, catalog.functionIdBySystemId.two);
  assert.equal(catalog.systemByFunctionId.two.kind, 'observer');
});

test('明确 insert/remove、可变 Query 与实际字段赋值保留不同访问操作和行号', () => {
  const body = `fn run(mut commands: Commands, mut query: Query<&mut Flag>) {
    commands.entity(entity).insert(Flag { value: 1 });
    for mut flag in &mut query {
        flag.value = 2;
    }
    commands.entity(entity).remove::<Flag>();
}`;
  const { catalog } = fixture({ components: [component('a.Flag')], systems: [system('run', { path: 'src/run.rs', line: 1 }, [], ['a.Flag'])], files: { 'src/run.rs': body } });
  const links = catalog.graphFor('a.Flag').links;
  for (const operation of ['insert', 'remove', 'write']) assert.ok(links.some(link => link.operation === operation));
  assert.ok(links.find(link => link.operation === 'insert').sourceEntries.some(source => source.line === 2));
  assert.ok(links.find(link => link.operation === 'write').sourceEntries.some(source => source.line === 4));
  assert.equal(links.find(link => link.operation === 'write').label, '字段赋值');
  assert.ok(links.find(link => link.operation === 'remove').sourceEntries.some(source => source.line === 6));
});

test('get_mut 和 single_mut 解构绑定追踪实际字段赋值，可变参数本身不表示赋值', () => {
  const { catalog } = fixture({ components: [component('a.Flag')], systems: [
    system('mutating', { path: 'src/run.rs', line: 1 }, [], ['a.Flag']),
    system('borrowing', { path: 'src/run.rs', line: 7 }, [], ['a.Flag']),
  ], files: { 'src/run.rs': `fn mutating(mut query: Query<(Entity, &mut Flag)>) {
    let Ok((entity, mut flag)) = query.get_mut(entity) else { return; };
    flag.value = 2;
    if let Ok((_, mut other)) = query.single_mut() { other.value += 1; }
}

fn borrowing(mut query: Query<&mut Flag>) {
    let Ok(mut local) = query.single_mut() else { return; };
    let local = local;
}` } });
  const links = catalog.graphFor('a.Flag').links;
  const write = links.find(link => link.from === 'mutating');
  assert.deepEqual(write.accesses.filter(access => access.accessMode === 'field-write').map(access => access.sourceEntries.at(-1).line), [3, 4]);
  assert.equal(write.label, '字段赋值');
  assert.equal(write.sourceGaps.length, 0);
  const borrowed = links.find(link => link.from === 'borrowing');
  assert.equal(borrowed.label, '可变访问');
  assert.ok(borrowed.sourceGaps.some(gap => gap.includes('可变借用本身不保证发生修改')));
});

test('QueryData 字段与可选 Write 解构定位真实赋值，ParamSet 绑定不串到其它查询', () => {
  const { catalog } = fixture({ components: [component('a.Flag'), component('a.Other', 'Other')],
    systems: [system('run', { path: 'src/run.rs', line: 6 }, [], ['a.Flag', 'a.Other'])], files: { 'src/run.rs': `#[derive(QueryData)]
struct Body {
    flag: Write<Flag>,
    optional: Option<Write<Other>>,
}
fn run(mut bodies: ParamSet<(Query<Body>, Query<&mut Flag>)>) {
    for mut body in &mut bodies.p0() {
        body.flag.value = 1;
        if let Some(mut value) = body.optional { value.0 = 2; }
    }
    for mut unrelated in &mut bodies.p1() { unrelated.0 = 3; }
}` } });
  const flag = catalog.graphFor('a.Flag').links.find(link => link.operation === 'write');
  const other = catalog.graphFor('a.Other').links.find(link => link.operation === 'write');
  assert.deepEqual(flag.accesses.filter(access => access.accessMode === 'field-write').map(access => access.sourceEntries.at(-1).line), [8, 11]);
  assert.deepEqual(other.accesses.filter(access => access.accessMode === 'field-write').map(access => access.sourceEntries.at(-1).line), [9]);
});

test('项目显式注册与 ReflectComponent 定义共同确认 Inspector，别名及同名类型按真实声明区分', () => {
  const types = `#[derive(Component, Reflect)]
#[reflect(Component)]
pub struct Flag(pub u64);
#[derive(Reflect)]
pub struct Plain;
#[derive(Component, Reflect)]
#[reflect(Component)]
pub struct Unregistered;`;
  const { catalog, registry } = fixture({ components: [component('a.Flag', 'Flag', { path: 'src/types.rs', line: 3 }),
    component('b.Flag', 'Flag', { path: 'src/other.rs', line: 3 }), component('a.Plain', 'Plain', { path: 'src/types.rs', line: 5 }),
    component('a.Unregistered', 'Unregistered', { path: 'src/types.rs', line: 8 })], systems: [
    system('setup', { path: 'src/plugin/mod.rs', line: 2 }),
    system('inspector_pass', { path: 'src/inspect.rs', line: 1 }, [], [], { definition_source: definition('src/quick.rs', 92, 'bevy-inspector-egui') }),
  ], files: { 'src/types.rs': types, 'src/other.rs': types,
    'src/plugin/mod.rs': `use crate::types::{Flag as LocalFlag, Plain};
fn setup(app: &mut App) {
    app.register_type::<LocalFlag>().register_type::<Plain>();
}` } });
  const reflected = catalog.graphFor('a.Flag').links.filter(link => link.operation.startsWith('reflect_'));
  assert.deepEqual(reflected.map(link => link.operation), ['reflect_read', 'reflect_write']);
  assert.ok(reflected.every(link => link.sourceEntries.some(source => source.path === 'src/plugin/mod.rs' && source.line === 3)));
  assert.ok(reflected.every(link => link.sourceEntries.some(source => source.dependency?.name === 'bevy-inspector-egui')));
  for (const id of ['b.Flag', 'a.Plain', 'a.Unregistered']) assert.ok(!catalog.graphFor(id).links.some(link => link.operation.startsWith('reflect_')));
  assert.ok(registry.inspector_pass.reads.includes('a.Flag'));
  assert.ok(registry.inspector_pass.writes.includes('a.Flag'));
  assert.ok(!registry.inspector_pass.reads.includes('b.Flag'));
  assert.ok(registry.inspector_pass.notes.some(note => note.includes('并不穷尽')));
});

test('辅助函数的结构操作归属于调用系统，保存调用处和实际操作处', () => {
  const body = `fn run(mut commands: Commands) {
    release(&mut commands);
}
fn release(commands: &mut Commands) {
    commands.queue(move |world: &mut World| {
        world.entity_mut(entity).remove::<Flag>();
    });
}`;
  const { catalog } = fixture({ components: [component('a.Flag')], systems: [system('run', { path: 'src/run.rs', line: 1 }, [], ['a.Flag'])], files: { 'src/run.rs': body } });
  const graph = catalog.graphFor('a.Flag'), removal = graph.links.find(link => link.operation === 'remove');
  assert.ok(removal);
  assert.ok(removal.sourceEntries.some(source => source.role === 'call' && source.line === 2));
  assert.ok(removal.sourceEntries.some(source => source.role === 'operation' && source.line === 6));
  assert.ok(!graph.nodes.some(node => node.id === 'release'));
});

test('QueryData 的 Write/Read/Has 归属使用它的系统，BSN 裸标记计为添加', () => {
  const body = `#[derive(QueryData)]
struct Body {
    flag: Write<Flag>,
}
fn run(mut bodies: Query<Body>, mut commands: Commands) {
    commands.spawn_scene(bsn! { Flag });
}`;
  const { catalog } = fixture({ components: [component('a.Flag')], systems: [system('run', { path: 'src/run.rs', line: 5 }, [], ['a.Flag'])], files: { 'src/run.rs': body } });
  const links = catalog.graphFor('a.Flag').links;
  assert.ok(links.some(link => link.operation === 'write' && link.sourceEntries.some(source => source.line === 3)));
  assert.ok(links.some(link => link.operation === 'insert' && link.sourceEntries.some(source => source.line === 6)));
});

test('裸标记 insert 保留结构语义，remove 泛型参数不是被移除的组件', () => {
  const { catalog } = fixture({ components: [component('a.Flag'), component('a.Wrapper', 'Wrapper<Flag>')],
    systems: [system('run', { path: 'src/run.rs', line: 1 }, [], ['a.Flag', 'a.Wrapper'])],
    files: { 'src/run.rs': `fn run(mut commands: Commands) {
    commands.entity(entity).insert(Flag);
    commands.entity(entity).remove::<Wrapper<Flag>>();
}` } });
  assert.ok(catalog.graphFor('a.Flag').links.some(link => link.operation === 'insert'));
  assert.ok(!catalog.graphFor('a.Flag').links.some(link => link.operation === 'remove'));
  assert.ok(catalog.graphFor('a.Wrapper').links.some(link => link.operation === 'remove'));
});

test('insert 与 BSN 只把实体层值视为组件，嵌套字段和 helper 比较不是独立挂载', () => {
  const body = `fn run(mut commands: Commands) {
    commands.entity(entity).insert(Envelope { nested: Flag { value: 1 } });
    commands.spawn_scene(bsn! {
        Envelope { nested: Flag { value: 2 } }
        Children [(Child)]
        template_value(bundle())
    });
}
fn bundle() -> impl Bundle {
    let value = if Flag::DEFAULT { 1 } else { 2 };
    (Envelope { nested: Child }, Flag)
}`;
  const { catalog } = fixture({ components: [component('a.Flag'), component('a.Envelope', 'Envelope'), component('a.Child', 'Child')],
    systems: [system('run', { path: 'src/run.rs', line: 1 }, [], ['a.Flag', 'a.Envelope', 'a.Child'])], files: { 'src/run.rs': body } });
  const flag = catalog.graphFor('a.Flag').links.find(link => link.operation === 'insert');
  assert.deepEqual(flag.sourceEntries.filter(source => source.role === 'operation').map(source => source.line), [11]);
  const child = catalog.graphFor('a.Child').links.find(link => link.operation === 'insert');
  assert.deepEqual(child.sourceEntries.filter(source => source.role === 'operation').map(source => source.line), [5]);
  assert.ok(catalog.graphFor('a.Envelope').links.some(link => link.operation === 'insert'));
});

test('明确 bevy::picking::Pickable 导入将 BSN Type::CONST 精确指向 UI 类型', () => {
  const { catalog } = fixture({ components: [component('business.Pickable', 'Pickable'),
    { ...component('ui.Pickable', 'Pickable'), definition_source: definition('src/lib.rs', 198, 'bevy_picking') }],
    systems: [system('run', { path: 'src/run.rs', line: 2 })], files: { 'src/run.rs': `use bevy::picking::Pickable;
fn run(mut commands: Commands) { commands.spawn_scene(bsn! { Pickable::IGNORE }); }` } });
  assert.ok(catalog.graphFor('ui.Pickable').links.some(link => link.operation === 'insert'));
  assert.ok(!catalog.graphFor('business.Pickable').links.some(link => link.operation === 'insert'));
});

test('源码注释、普通和 raw 字符串、字符字面量不生成虚假操作', () => {
  const body = `fn run(mut query: Query<&mut Flag>) {
    // commands.entity(entity).remove::<Flag>();
    let text = "commands.entity(entity).insert(Flag {})";
    let raw = r#"commands.entity(entity).remove::<Flag>();"#;
    let bracket = '}';
}`;
  const masked = maskRustSource(body);
  assert.equal(masked.length, body.length);
  assert.equal(masked.split('\n').length, body.split('\n').length);
  const { catalog } = fixture({ components: [component('a.Flag')], systems: [system('run', { path: 'src/run.rs', line: 1 }, [], ['a.Flag'])], files: { 'src/run.rs': body } });
  assert.ok(!catalog.graphFor('a.Flag').links.some(link => ['insert', 'remove'].includes(link.operation)));
});

test('类型歧义时不猜 insert/remove，未细分的声明写访问明确标为待核实', () => {
  const { catalog } = fixture({ components: [component('a.Flag', 'Flag', { path: 'src/a.rs', line: 1 }), component('b.Flag', 'Flag', { path: 'src/b.rs', line: 1 })],
    systems: [system('run', { path: 'src/run.rs', line: 1 }, [], ['a.Flag', 'b.Flag'])], files: { 'src/run.rs': 'fn run(mut commands: Commands) { commands.entity(entity).insert(Flag); }' } });
  for (const type of catalog.types) {
    const write = catalog.graphFor(type.id).links.find(link => link.operation === 'write');
    assert.ok(write.sourceGaps.length);
    assert.ok(!catalog.graphFor(type.id).links.some(link => link.operation === 'insert'));
  }
});

test('投影后的组件边使用新 ID 并保留原关系身份', () => {
  const { catalog } = fixture({ components: [component('a.Flag')], systems: [system('run', { path: 'src/run.rs', line: 1 }, ['a.Flag'])],
    links: [{ id: 'old-read', from: 'a.Flag', to: 'run', kind: 'read', label: '检查状态' }] });
  const read = catalog.graphFor('a.Flag').links.find(link => link.operation === 'read');
  assert.notEqual(read.id, 'old-read');
  assert.deepEqual(read.originalLinkIds, ['old-read']);
});

test('当前清单全部真实组件有专属图，HeldTarget 保持批准样稿的函数及操作覆盖', () => {
  const model = JSON.parse(fs.readFileSync(new URL('./ecs-data.json', import.meta.url), 'utf8'));
  const { registry } = buildArchitectureModel(model);
  // 定义描述符提供类型身份；本测试不依赖个人 Cargo 安装目录或已生成 HTML。
  const descriptors = new Map();
  for (const [id, descriptor] of Object.entries(DEPENDENCY_SOURCE_DEFINITIONS)) {
    if (registry[id]?.kind !== 'Component') continue;
    const key = JSON.stringify(descriptor);
    if (!descriptors.has(key)) descriptors.set(key, descriptors.size + 1);
    registry[id].definition_source = { path: descriptor.path, line: descriptors.get(key), dependency: { name: descriptor.package, version: '0.0.0', root: '/locked-dependency' } };
  }
  registry.inspector_pass.definition_source = definition('src/quick.rs', 92, 'bevy-inspector-egui');
  const catalog = buildComponentCatalog(model, registry), projections = model.entities.flatMap(entity => entity.components.map(component => component.id));
  assert.deepEqual(new Set(Object.keys(catalog.typeByProjectionId)), new Set(projections));
  assert.equal(catalog.types.length, 158);
  const declaredCount = model.systems.reduce((count, system) => count + [...system.reads, ...system.writes].filter(id => projections.includes(id)).length, 0);
  assert.equal(catalog.declarations.length, declaredCount);
  assert.ok(catalog.deferredAccesses.every(access => registry[access.system].kind === 'sync'));
  for (const type of catalog.types) {
    const graph = catalog.graphFor(type.id), ids = new Set(graph.nodes.map(node => node.id));
    assert.equal(ids.size, graph.nodes.length);
    assert.ok(graph.links.every(link => ids.has(link.from) && ids.has(link.to)));
    assert.equal(graph.nodes.filter(node => projections.includes(node.id)).length, 1);
  }
  const held = catalog.graphFor('parcel.HeldTarget');
  assert.equal(held.nodes.length, 9);
  assert.equal(held.links.length, 11);
  assert.equal(held.links.filter(link => link.operation === 'remove').length, 5);
  assert.equal(held.links.filter(link => link.operation === 'write').length, 1);
  assert.equal(held.links.find(link => link.operation === 'write').label, '&mut HeldTarget');
  assert.equal(held.links.find(link => link.operation === 'filter').kind, 'reference');
  assert.equal(held.links.find(link => link.operation === 'filter').label, 'With<HeldTarget>');
  assert.ok(!held.nodes.some(node => ['held_apply', 'orphan_apply'].includes(node.id)));
  assert.ok(!catalog.typeByProjectionId['capture-state']);
  assert.notEqual(catalog.typeByProjectionId['parcel.Pickable'], catalog.typeByProjectionId['settings_scrollbar.Pickable']);
  assert.notEqual(catalog.typeByProjectionId['menu_model.CourierAnimation'], catalog.typeByProjectionId['animation_player.CourierAnimation']);
  const reflected = catalog.types.filter(type => catalog.graphFor(type.id).links.some(link => link.operation === 'reflect_read'));
  assert.deepEqual(reflected.map(type => type.rustType).sort(), [
    'crate::first_person::PlayerId', 'crate::first_person::ControlsCharacter', 'crate::first_person::ControlsCamera',
    'crate::first_person::FirstPersonCamera', 'crate::first_person::CharacterVisual', 'crate::bounds_recovery::SpawnPoint',
    'crate::character::components::Character', 'crate::character::components::CharacterIntent', 'crate::character::components::CharacterMotion',
    'crate::item_interaction::components::Parcel', 'crate::item_interaction::components::Pickable',
    'crate::item_interaction::components::CarryGrip', 'crate::item_interaction::components::HeldTarget', 'crate::scene_assembly::assets::ItemModel',
  ].sort());
  assert.ok(!catalog.graphFor('settings_scrollbar.Pickable').links.some(link => link.operation.startsWith('reflect_')));
  for (const name of ['Character', 'Parcel', 'Pickable', 'CharacterVisual']) {
    const type = reflected.find(type => type.name === name);
    assert.ok(type);
    const reflection = catalog.graphFor(type.id).links.filter(link => link.operation.startsWith('reflect_'));
    assert.deepEqual(reflection.map(link => link.operation), ['reflect_read']);
    assert.ok(reflection[0].notes.some(note => note.includes('无字段标记')));
    assert.ok(type.projectionIds.every(id => registry.inspector_pass.reads.includes(id) && !registry.inspector_pass.writes.includes(id)));
    assert.ok(!catalog.graphFor(type.id).links.some(link => link.from === 'inspector_pass' && link.operation === 'write'));
  }
  assert.equal(catalog.disprovedDeclarations.length, 4);
  assert.ok(catalog.disprovedDeclarations.every(access => catalog.declarations.some(original => original.system === access.system && original.component === access.component && original.operation === access.operation)));
  assert.ok(catalog.graphFor('parcel.Pickable').links.some(link => link.operation === 'insert'));
  const transformInsert = catalog.graphFor('parcel.Transform').links.filter(link => link.operation === 'insert');
  assert.ok(transformInsert.every(link => !link.sourceEntries.some(source => source.path === 'src/item_interaction/attachment.rs' && source.line === 34)));
  const modelInsert = catalog.graphFor('parcel.ItemModel').links.find(link => link.operation === 'insert');
  assert.ok(modelInsert.sourceEntries.some(source => source.path === 'src/scene_assembly/actors.rs' && source.line === 49));
  assert.ok(!modelInsert.sourceEntries.some(source => source.path === 'src/scene_assembly/actors.rs' && source.line === 38));
  for (const id of ['controller.PlayerId', 'camera.FirstPersonCamera', 'character.CollisionEventsEnabled', 'character.TranslationInterpolation', 'parcel.TransformInterpolation']) {
    assert.ok(catalog.graphFor(id).links.some(link => link.operation === 'insert' && link.from === 'actors_spawn'));
  }
  for (const id of ['action.Action', 'model_node.MeshMaterial3d']) {
    const type = catalog.typeById[catalog.typeByProjectionId[id]];
    assert.equal(type.identityVerified, false);
    assert.equal(type.aggregateProjection, true);
    assert.ok(type.knownRustTypes.length);
    assert.ok(type.sourceGaps.length);
    assert.deepEqual(type.details.sourceGaps, type.sourceGaps);
    assert.ok(type.definition_source);
  }
  const uiPickable = catalog.graphFor('settings_scrollbar.Pickable').links.find(link => link.operation === 'insert' && link.from === 'menu_rebuild');
  assert.ok(uiPickable);
  assert.ok([86, 98].every(line => uiPickable.sourceEntries.some(source => source.path === 'src/ui/scroll.rs' && source.line === line)));
  for (const id of ['grounded_fixed', 'carry_physics_fixed', 'audio_voice_volumes']) {
    const merged = registry[catalog.functionIdBySystemId[id]];
    assert.ok(!merged.description.includes('\n'));
    for (const original of merged.registrationDescriptions.filter(entry => entry.description !== merged.description)) {
      assert.ok(merged.registrations.filter(registration => registration.registrationId === original.registrationId && registration.scope === 'runtime').every(registration => registration.notes.includes(original.description)));
    }
  }
});

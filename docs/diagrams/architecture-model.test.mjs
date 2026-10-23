import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildArchitectureModel, isMainPluginRegistration, scheduleGroupLabel, SCHEDULE_GROUP_DISPLAY_LABELS } from './architecture-model.mjs';
import { INFRASTRUCTURE_FEATURES, architectureViewId } from './architecture-infrastructure.mjs';

const model = JSON.parse(fs.readFileSync(new URL('./ecs-data.json', import.meta.url), 'utf8'));
const architecture = buildArchitectureModel(model);
const featureIds = [...model.features, ...INFRASTRUCTURE_FEATURES].map(feature => feature.id);
const allGraphs = () => featureIds.flatMap(feature => ['systems', 'data', 'events'].map(aspect => architecture.graphFor(feature, aspect)));
const entityComponentIds = entityId => model.entities.find(entity => `entity-${entity.id}` === entityId).components.map(component => component.id);

test('Bevy 与四个第三方入口分别浏览，具体泛型契约和类型定义归属独立保留', () => {
  assert.equal(architecture.features.length, 14);
  assert.deepEqual(INFRASTRUCTURE_FEATURES.map(feature => [feature.id, feature.label]), [['infrastructure', 'Bevy 引擎'], ['avian', 'Avian'], ['enhanced_input', 'Enhanced Input'], ['kira', 'Kira'], ['egui', 'Egui / Inspector']]);
  for (const [feature, prefix] of [['avian', 'avian'], ['enhanced_input', 'enhanced-input'], ['kira', 'kira'], ['egui', 'egui']]) {
    assert.equal(architectureViewId(feature, 'events'), `third-party-${prefix}-events`);
  }
  assert.equal(architectureViewId('infrastructure', 'data'), 'infrastructure-data');
  for (const [feature, ids] of [
    ['avian', ['physics_step', 'easing_start', 'character.Position', 'parcel.TransformInterpolation', 'plugin-physics-0']],
    ['enhanced_input', ['enhanced_prepare', 'action.ActionOf', 'plugin-EnhancedInputPlugin']],
    ['kira', ['kira-output', 'plugin-kira']],
    ['egui', ['egui_input', 'inspector_pass', 'camera.PrimaryEguiContext', 'plugin-inspector-0', 'plugin-inspector-1']],
  ]) for (const id of ids) assert.equal(architecture.ownerOf(id), feature, id);
  for (const id of ['time_update', 'held_apply', 'world_spawn', 'animation_engine', 'character.Transform', 'action.Name', 'settings_scrollbar.Pickable']) assert.equal(architecture.ownerOf(id), 'infrastructure', id);
  for (const id of ['resource.CollisionStartMessages', 'resource.CollisionEndMessages', 'resource.TimePhysics', 'resource.AudioSources', 'resource.AudioInstances', 'resource.AudioLoadFailures']) {
    assert.equal(architecture.ownerOf(id), id.startsWith('resource.Audio') ? 'kira' : 'avian', id);
    assert.equal(architecture.registry[id].defined_in, 'infrastructure', id);
  }
  assert.equal(architecture.registry['resource.Gravity'].defined_in, 'avian');
  assert.equal(architecture.registry['resource.LastEasingTick'].defined_in, 'avian');
  assert.equal(architecture.registry['resource.ContextInstances'].defined_in, 'enhanced_input');
  assert.equal(architecture.registry['resource.EguiGlobalSettings'].defined_in, 'egui');
  assert.equal(architecture.registry.held_apply.registered_by, 'game_flow');
  assert.equal(architecture.ownerOf('native-window-events'), 'window_policy');
  assert.equal(architecture.graphFor('infrastructure', 'systems').nodes.find(node => node.id === 'egui_input').role, 'external');
  assert.equal(architecture.graphFor('egui', 'systems').nodes.find(node => node.id === 'egui_input').role, 'internal');
  assert.equal(architecture.graphFor('egui', 'systems').nodes.find(node => node.id === 'input_update').role, 'external');
  assert.equal(architecture.graphFor('infrastructure', 'systems').nodes.find(node => node.id === 'input_update').role, 'internal');
});

test('149 个第三方业务节点各有唯一入口，移除混合目录而不展开跨入口内部实现', () => {
  const counts = { avian: 95, enhanced_input: 34, kira: 6, egui: 14 };
  for (const [feature, expected] of Object.entries(counts)) {
    const owned = Object.values(architecture.registry).filter(node => node.feature === feature);
    assert.equal(owned.length, expected, feature);
    assert.equal(Object.values(model.node_features).filter(owner => owner === feature).length, expected, feature);
    const visibleInternal = new Set();
    for (const aspect of ['systems', 'data', 'events']) {
      const graph = architecture.graphFor(feature, aspect);
      for (const node of graph.nodes) {
        assert.equal(node.role === 'internal', architecture.ownerOf(node.id) === feature, `${feature}/${aspect}/${node.id}`);
        if (node.role === 'internal') visibleInternal.add(node.id);
        else assert.ok(node.group.startsWith('外部契约 · '), node.id);
      }
      assert.ok(graph.links.every(link => architecture.ownerOf(link.from) === feature || architecture.ownerOf(link.to) === feature), `${feature}/${aspect}`);
    }
    assert.deepEqual(visibleInternal, new Set(owned.map(node => node.id)), feature);
  }
  assert.ok(!architecture.registry['third-party-plugins']);
  assert.ok(!Object.hasOwn(model.node_features, 'third-party-plugins'));
  assert.ok(!Object.values(architecture.registry).some(node => node.feature === 'third_party'));
  assert.throws(() => architecture.graphFor('third_party', 'systems'), /功能不存在/);
  const egui = architecture.graphFor('egui', 'systems');
  assert.ok(!egui.nodes.some(node => node.id === 'enhanced_evaluate'));
  const enhancedInput = architecture.graphFor('enhanced_input', 'systems');
  assert.ok(!enhancedInput.nodes.some(node => node.id === 'egui_begin'));
});

test('14 个项目插件有独立功能，并保持定义归属与实体装配归属的区别', () => {
  assert.equal(architecture.features.length, 14);
  assert.equal(new Set(architecture.features.map(feature => feature.plugin)).size, 14);
  assert.equal(architecture.ownerOf('character.CharacterIntent'), 'character');
  assert.equal(architecture.ownerOf('resource.PrototypeConfig'), 'settings');
  assert.equal(architecture.ownerOf('character.Transform'), 'infrastructure');
  assert.equal(architecture.registry['entity-character'].assembled_by[0], 'scene_assembly');
  assert.equal(architecture.registry['character.CharacterIntent'].owner, '角色业务根实体');
  assert.equal(architecture.registry['character.CharacterIntent'].defined_in, 'character');
  assert.equal(architecture.registry.movement.registered_by, 'character');
  assert.equal(architecture.ownerOf('held_apply'), 'infrastructure');
  assert.equal(architecture.registry.held_apply.registered_by, 'game_flow');
  assert.equal(architecture.registry.capture_apply.registered_by, 'first_person');
  assert.equal(architecture.registry.orphan_apply.registered_by, 'item_interaction');
});

test('同名类型与同一函数的多次注册保留各自 canonical ID', () => {
  assert.notEqual(architecture.registry.held_fixed.id, architecture.registry.held_update.id);
  assert.equal(architecture.registry.held_fixed.name, architecture.registry.held_update.name);
  assert.notEqual(architecture.registry['character.Transform'].id, architecture.registry['parcel.Transform'].id);
  assert.equal(architecture.ownerOf('parcel.Pickable'), 'item_interaction');
  assert.equal(architecture.ownerOf('settings_scrollbar.Pickable'), 'infrastructure');
  assert.equal(architecture.ownerOf('animation_player.CourierAnimation'), 'character_animation');
  assert.equal(architecture.ownerOf('menu_model.CourierAnimation'), 'ui');
});

test('功能系统图保留本功能边界，Observer 留在事件图，跨功能依赖显示外部端点', () => {
  const graph = architecture.graphFor('character', 'systems');
  assert.ok(graph.nodes.some(node => node.id === 'movement' && node.role === 'internal'));
  assert.ok(graph.nodes.some(node => node.id === 'facing_fixed' && node.role === 'external'));
  assert.ok(!graph.nodes.some(node => node.id === 'menu_rebuild'));
  assert.ok(!architecture.graphFor('first_person', 'systems').nodes.some(node => node.id === 'observe_move'));
  assert.ok(architecture.graphFor('first_person', 'events').nodes.some(node => node.id === 'observe_move' && node.role === 'internal'));
  assert.ok(graph.nodes.every(node => /[\u4e00-\u9fff]/.test(node.group)));
});

test('跨功能实体复用同一身份，完整组件与本功能定义归属分别保留', () => {
  const characterGraph = architecture.graphFor('character', 'data'), interactionGraph = architecture.graphFor('item_interaction', 'data');
  const character = characterGraph.nodes.find(node => node.id === 'entity-character');
  const interaction = interactionGraph.nodes.find(node => node.id === 'entity-character');
  assert.equal(character.id, interaction.id);
  assert.equal(architecture.registry[character.id].identity, 'entity-character');
  assert.ok(character.projection_components.includes('character.CharacterIntent'));
  assert.ok(!character.projection_components.includes('character.HoldingItems'));
  assert.ok(interaction.projection_components.includes('character.HoldingItems'));
  assert.ok(!interaction.projection_components.includes('character.CharacterIntent'));
  for (const [feature, graph] of [['character', characterGraph], ['item_interaction', interactionGraph]]) {
    assert.deepEqual(graph.entityGroups.find(group => group.entity === character.id).components, entityComponentIds(character.id));
    for (const id of ['character.CharacterIntent', 'character.HoldingItems']) {
      assert.equal(graph.nodes.find(node => node.id === id).role, architecture.ownerOf(id) === feature ? 'internal' : 'external');
    }
  }
});

test('数据页实体组包含规范全组件并保留清单顺序，每个视图内节点和组件只出现一次', () => {
  const groupedComponents = [];
  for (const feature of featureIds) {
    const graph = architecture.graphFor(feature, 'data');
    const visible = new Set(graph.nodes.map(node => node.id));
    const members = graph.entityGroups.flatMap(group => group.components);
    assert.equal(visible.size, graph.nodes.length, feature);
    assert.equal(new Set(members).size, members.length, feature);
    assert.equal(new Set(graph.entityGroups.map(group => group.id)).size, graph.entityGroups.length, feature);
    for (const group of graph.entityGroups) {
      const entity = model.entities.find(entity => `entity-${entity.id}` === group.entity);
      assert.ok(entity, group.entity);
      assert.equal(group.id, `entity-group-${entity.id}`);
      assert.ok(!architecture.registry[group.id], group.id);
      assert.ok(visible.has(group.entity), group.entity);
      assert.ok(group.components.length > 0, group.entity);
      assert.deepEqual(group.components, entity.components.map(component => component.id));
      for (const id of group.components) {
        assert.equal(architecture.registry[id].kind, 'Component', id);
        assert.ok(visible.has(id), `${feature}/${id}`);
      }
      groupedComponents.push(...group.components);
    }
  }
  assert.ok(new Set(groupedComponents).size < groupedComponents.length);
  assert.deepEqual(new Set(groupedComponents), new Set(model.entities.flatMap(entity => entity.components.map(component => component.id))));
});

test('菜单背景、角色及可搬物在功能页与提供方页均展开完整规范组件', () => {
  const expected = [['entity-menu_backdrop', 5, ['ui', 'infrastructure']], ['entity-character', 38, ['character', 'avian', 'infrastructure']], ['entity-parcel', 50, ['item_interaction', 'avian', 'infrastructure']]];
  for (const [entity, count, features] of expected) for (const feature of features) {
    const group = architecture.graphFor(feature, 'data').entityGroups.find(group => group.entity === entity);
    assert.equal(group.components.length, count, `${feature}/${entity}`);
    assert.deepEqual(group.components, entityComponentIds(entity));
  }
  assert.deepEqual(entityComponentIds('entity-menu_backdrop'), ['menu_backdrop.MenuBackdrop', 'menu_backdrop.DespawnOnExit', 'menu_backdrop.Children', 'menu_backdrop.Transform', 'menu_backdrop.Visibility']);
});

test('不同实体的同名组件保留各自分组，不按名称合并或复制', () => {
  const graph = architecture.graphFor('bounds_recovery', 'data');
  assert.deepEqual(graph.entityGroups, [
    { id: 'entity-group-character', entity: 'entity-character', components: entityComponentIds('entity-character') },
    { id: 'entity-group-parcel', entity: 'entity-parcel', components: entityComponentIds('entity-parcel') },
  ]);
  for (const name of ['SpawnPoint', 'ResumeInterpolation']) {
    const matches = graph.nodes.filter(node => architecture.registry[node.id].name === name);
    assert.equal(matches.length, 2, name);
    assert.notEqual(matches[0].id, matches[1].id);
  }
});

test('提供方数据页补齐已有外部实体上下文的完整组件，身份、源码与真实归属不变', () => {
  let contexts = 0;
  for (const [feature, count] of [['infrastructure', 21], ['avian', 4], ['enhanced_input', 4], ['egui', 2]]) {
    const graph = architecture.graphFor(feature, 'data');
    const externalEntities = graph.nodes.filter(node => architecture.registry[node.id].kind === 'Entity' && node.role === 'external');
    assert.equal(externalEntities.length, count, feature);
    contexts += externalEntities.length;
    for (const context of externalEntities) {
      const entity = model.entities.find(entity => `entity-${entity.id}` === context.id), record = architecture.registry[context.id];
      assert.ok(entity, context.id);
      assert.equal(record.identity, context.id);
      assert.notEqual(record.feature, feature);
      assert.deepEqual(record.source, entity.source);
      assert.deepEqual(record.assembled_by, entity.assembled_by);
      assert.deepEqual(record.features, entity.features);
      assert.ok(!Object.hasOwn(context, 'projection_components'));
      assert.ok(context.group.startsWith('外部契约 · '));
      assert.equal(graph.nodes.filter(node => node.id === context.id).length, 1);
      assert.equal(graph.entityGroups.filter(group => group.entity === context.id).length, 1);
      assert.deepEqual(graph.entityGroups.find(group => group.entity === context.id).components, entityComponentIds(context.id));
    }
  }
  assert.equal(contexts, 31);
  const avian = architecture.graphFor('avian', 'data');
  assert.equal(avian.entityGroups.find(group => group.entity === 'entity-character').components.length, 38);
  for (const id of ['character.CharacterIntent', 'character.Transform']) {
    assert.equal(avian.nodes.find(node => node.id === id).role, 'external', id);
    assert.notEqual(architecture.ownerOf(id), 'avian');
    assert.equal(architecture.registry[id].defined_in, architecture.ownerOf(id));
  }
  assert.ok(!avian.nodes.some(node => node.id === 'entity-camera'));
});

test('组成员只读取规范组件清单，外部组件仍可归组且上下文不扩展关系', () => {
  const fixture = {
    features: [{ id: 'project', label: '项目' }],
    entities: [
      { id: 'one', name: '同名实体', feature: 'project', source: { path: 'src/project.rs', line: 1 }, components: [
        { id: 'one.Transform', name: 'Transform', feature: 'avian' },
        { id: 'one.Hidden', name: 'Hidden', feature: 'enhanced_input' },
      ] },
      { id: 'two', name: '同名实体', feature: 'project', source: { path: 'src/project.rs', line: 2 }, components: [
        { id: 'two.Transform', name: 'Transform', feature: 'avian' },
        { id: 'two.External', name: 'External', feature: 'enhanced_input' },
      ] },
      { id: 'unrelated', name: '补齐成员所引用的其他实体', feature: 'project', components: [
        { id: 'unrelated.Component', name: 'Component', feature: 'enhanced_input' },
      ] },
    ],
    systems: [{ id: 'external-system', name: 'ExternalSystem', feature: 'project', kind: 'system' }],
    resources: [{ id: 'project-resource', name: 'ProjectResource', feature: 'project' }],
    nodes: [{ id: 'aggregate', name: '聚合说明', kind: 'Component', feature: 'avian', owner: '同名实体', aspects: ['data', 'events'] }],
    system_links: [
      { id: 'component-reference', from: 'one.Transform', to: 'two.External', kind: 'reference', label: '真实引用' },
      { id: 'context-read', from: 'entity-one', to: 'project-resource', kind: 'read' },
      { id: 'hidden-reference', from: 'one.Hidden', to: 'unrelated.Component', kind: 'reference' },
      { id: 'hidden-write', from: 'external-system', to: 'one.Hidden', kind: 'write' },
    ],
  };
  const before = structuredClone(fixture), local = buildArchitectureModel(fixture), graph = local.graphFor('avian', 'data');
  assert.deepEqual(graph.entityGroups, [
    { id: 'entity-group-one', entity: 'entity-one', components: ['one.Transform', 'one.Hidden'] },
    { id: 'entity-group-two', entity: 'entity-two', components: ['two.Transform', 'two.External'] },
  ]);
  for (const id of ['entity-one', 'entity-two', 'one.Hidden', 'two.External']) assert.equal(graph.nodes.find(node => node.id === id).role, 'external', id);
  assert.ok(graph.nodes.some(node => node.id === 'aggregate'));
  assert.ok(!graph.entityGroups.some(group => group.components.includes('aggregate')));
  assert.ok(!graph.nodes.some(node => ['project-resource', 'external-system', 'entity-unrelated', 'unrelated.Component'].includes(node.id)));
  assert.deepEqual(graph.links, [fixture.system_links[0]]);
  assert.deepEqual(fixture, before);
});

test('聚合组件不从显示归属补充成员，规范实体即使原来没有组件投影也补齐完整清单', () => {
  const graph = architecture.graphFor('first_person', 'data');
  assert.ok(graph.nodes.some(node => node.id === 'capture-state'));
  assert.ok(graph.nodes.some(node => node.id === 'entity-action'));
  assert.ok(graph.nodes.some(node => node.id === 'entity-binding'));
  assert.ok(!graph.entityGroups.some(group => group.components.includes('capture-state')));
  for (const id of ['entity-action', 'entity-binding']) assert.deepEqual(graph.entityGroups.find(group => group.entity === id).components, entityComponentIds(id));
  for (const id of ['shared-carry-pose', 'first-person-fields', 'first-person-visual-state']) assert.ok(!allGraphs().some(graph => graph.nodes.some(node => node.id === id)), id);
});

test('直接可见的外部实体补齐自身组件，零组件实体独立保留而不生成空组', () => {
  const fixture = {
    features: [{ id: 'project', label: '项目' }],
    entities: [
      { id: 'owned', name: '本地实体', feature: 'project', components: [{ id: 'owned.External', name: 'External', feature: 'avian' }] },
      { id: 'external', name: '外部实体', feature: 'avian', components: [{ id: 'external.Component', name: 'Component', feature: 'enhanced_input' }] },
      { id: 'empty', name: '空实体', feature: 'project', components: [] },
    ],
    resources: [{ id: 'resource.Local', name: 'Local', feature: 'project' }],
    system_links: [{ id: 'external-reference', from: 'resource.Local', to: 'entity-external', kind: 'reference' }],
  };
  const local = buildArchitectureModel(fixture), graph = local.graphFor('project', 'data');
  assert.deepEqual(graph.entityGroups, [
    { id: 'entity-group-owned', entity: 'entity-owned', components: ['owned.External'] },
    { id: 'entity-group-external', entity: 'entity-external', components: ['external.Component'] },
  ]);
  assert.equal(graph.nodes.find(node => node.id === 'entity-owned').role, 'internal');
  for (const id of ['owned.External', 'entity-external', 'external.Component']) assert.equal(graph.nodes.find(node => node.id === id).role, 'external', id);
  assert.equal(graph.nodes.find(node => node.id === 'entity-empty').role, 'internal');
  assert.ok(!graph.entityGroups.some(group => group.entity === 'entity-empty'));
  assert.deepEqual(graph.links, fixture.system_links.map(link => ({ ...link, label: undefined })));
});

test('数据实体组不影响系统和事件视图、注册表及原始关系', () => {
  const local = buildArchitectureModel(model), beforeModel = structuredClone(model), beforeRegistry = structuredClone(local.registry);
  const before = featureIds.flatMap(feature => ['systems', 'events'].map(aspect => local.graphFor(feature, aspect)));
  const data = featureIds.map(feature => local.graphFor(feature, 'data'));
  assert.deepEqual(featureIds.flatMap(feature => ['systems', 'events'].map(aspect => local.graphFor(feature, aspect))), before);
  for (const graph of before) assert.ok(!Object.hasOwn(graph, 'entityGroups'));
  assert.equal(data.reduce((count, graph) => count + graph.links.length, 0), 89);
  for (const graph of data) for (const link of graph.links) {
    const original = model.system_links.find(original => original.id === link.id);
    assert.ok(original, link.id);
    const { id, from, to, kind, label } = original;
    assert.deepEqual(link, { id, from: local.resolveNode(from), to: local.resolveNode(to), kind, label });
  }
  assert.deepEqual(local.registry, beforeRegistry);
  assert.deepEqual(model, beforeModel);
});

test('共享实体的关系只在定义功能展开，使用功能仅保留必要外部实体', () => {
  const firstPerson = architecture.graphFor('first_person', 'data');
  for (const id of ['held_by', 'grounding_player', 'npc_collider_parent']) assert.ok(!firstPerson.links.some(link => link.id === id), id);
  assert.ok(firstPerson.links.some(link => link.id === 'controls_character'));
  assert.equal(firstPerson.nodes.find(node => node.id === 'entity-character').role, 'external');
  assert.ok(!firstPerson.nodes.some(node => node.id === 'entity-npc'));
  assert.ok(architecture.graphFor('item_interaction', 'data').links.some(link => link.id === 'held_by'));
  assert.ok(architecture.graphFor('character_animation', 'data').links.some(link => link.id === 'grounding_player'));
  assert.ok(architecture.graphFor('scene_assembly', 'data').links.some(link => link.id === 'npc_collider_parent'));
  for (const feature of featureIds) {
    for (const link of architecture.graphFor(feature, 'data').links) {
      if (model.relationships.some(relation => relation.id === link.id)) assert.equal(architecture.ownerOf(link.id), feature, link.id);
    }
  }
});

test('PlayState 暂停是状态转换，只出现在数据视图，不伪装为 ECS 事件', () => {
  const id = 'transition-resource.PlayState-state-paused';
  const transition = architecture.graphFor('game_flow', 'data').links.find(link => link.id === id);
  assert.equal(transition?.kind, 'transition');
  assert.equal(transition.from, 'resource.PlayState');
  assert.equal(transition.to, 'state-paused');
  assert.ok(!architecture.graphFor('game_flow', 'events').links.some(link => link.id === id));
  assert.ok(!model.system_links.some(link => link.id === 'trigger-resource.PlayState-state-paused'));
});

test('所有系统、Observer、关键节点和实体关系均保留在可浏览图中', () => {
  const graphs = allGraphs();
  const nodeIds = new Set(graphs.flatMap(graph => graph.nodes.map(node => node.id)));
  const links = new Map(graphs.flatMap(graph => graph.links.map(link => [link.id, link])));
  for (const system of model.systems) assert.ok(nodeIds.has(system.id), system.id);
  for (const id of model.required_nodes) assert.ok(nodeIds.has(id), id);
  for (const observer of model.observers) assert.equal(links.get(`observer-${observer.system}`)?.to, observer.system);
  for (const relation of model.relationships) {
    assert.equal(links.get(relation.id)?.from, `entity-${relation.from}`);
    assert.equal(links.get(relation.id)?.to, `entity-${relation.to}`);
    assert.equal(links.get(relation.id)?.kind, relation.kind);
  }
  for (const link of model.system_links) {
    if (isMainPluginRegistration(link, architecture.registry)) assert.ok(!links.has(link.id), link.id);
    else assert.ok(links.has(link.id), link.id);
  }
});

test('主入口到全部插件的注册只隐藏展示，保留清单、插件身份及其他装配和退出关系', () => {
  const before = JSON.stringify(model);
  const registrations = model.system_links.filter(link => isMainPluginRegistration(link, architecture.registry));
  assert.equal(registrations.length, 16);
  assert.deepEqual(registrations.map(link => architecture.registry[link.to].name).sort(), [...model.features.map(feature => feature.plugin), 'DefaultPlugins', 'EnhancedInputPlugin'].sort());
  const graphs = allGraphs();
  for (const graph of graphs) {
    assert.ok(graph.links.every(link => !registrations.some(registration => registration.id === link.id)));
    for (const node of graph.nodes.filter(node => node.id === 'app-main' && node.role === 'external')) {
      assert.ok(graph.links.some(link => link.from === node.id || link.to === node.id));
    }
  }
  for (const feature of model.features) {
    assert.ok(architecture.graphFor(feature.id, 'events').nodes.some(node => node.id === `plugin-${feature.plugin}` && node.role === 'internal'));
  }
  assert.ok(!architecture.graphFor('settings', 'events').nodes.some(node => node.id === 'app-main'));
  const infrastructure = architecture.graphFor('infrastructure', 'events');
  assert.ok(infrastructure.nodes.some(node => node.id === 'plugin-DefaultPlugins'));
  assert.ok(architecture.graphFor('enhanced_input', 'events').nodes.some(node => node.id === 'plugin-EnhancedInputPlugin'));
  assert.ok(architecture.graphFor('session_log', 'events').links.some(link => link.from === 'app-main' && link.to === 'log-file-worker'));
  assert.ok(architecture.graphFor('physics', 'events').links.some(link => link.from === 'plugin-GamePhysicsPlugin' && link.to === 'plugin-physics-0'));
  const registration = registrations.find(link => link.to === 'plugin-ItemInteractionPlugin');
  assert.equal(isMainPluginRegistration({ ...registration, to: 'plugin-carry' }, architecture.registry), true);
  for (const changed of [{ kind: 'reference' }, { kind: 'dependency' }, { from: registration.to, to: 'app-main' }, { from: 'plugin-SessionLogPlugin' }, { to: 'log-file-worker' }]) {
    assert.equal(isMainPluginRegistration({ ...registration, ...changed }, architecture.registry), false);
  }
  assert.equal(JSON.stringify(model), before);
});

test('图中关系端点均可解析，局部图不引入 dangling ID', () => {
  for (const [id, feature] of Object.entries(model.node_features)) {
    assert.ok(architecture.registry[id], id);
    assert.equal(architecture.ownerOf(id), feature, id);
  }
  for (const relation of model.relationships) {
    assert.equal(architecture.registry[relation.id].relationship_kind, relation.kind);
    assert.equal(architecture.registry[relation.id].source.path, relation.source.path);
  }
  for (const graph of allGraphs()) {
    const nodeIds = new Set(graph.nodes.map(node => node.id));
    assert.equal(nodeIds.size, graph.nodes.length);
    assert.equal(new Set(graph.links.map(link => link.id)).size, graph.links.length);
    for (const link of graph.links) {
      assert.ok(nodeIds.has(link.from), link.id);
      assert.ok(nodeIds.has(link.to), link.id);
      assert.ok(architecture.registry[link.from]);
      assert.ok(architecture.registry[link.to]);
    }
  }
});

test('并行分支不增加虚构全序，Despawn Observer 正确表达停用代理', () => {
  const order = model.system_links.filter(link => link.kind === 'order');
  const hasOrder = (from, to) => order.some(link => link.from === from && link.to === to);
  assert.ok(!hasOrder('audio_land', 'collision_log'));
  assert.ok(!hasOrder('collision_log', 'audio_land'));
  assert.ok(!hasOrder('menu_volume_pointer', 'menu_volume_visuals'));
  assert.ok(!hasOrder('menu_volume_visuals', 'menu_volume_pointer'));
  assert.ok(!hasOrder('menu_style', 'menu_description'));
  assert.ok(!order.some(link => link.from.startsWith('schedule-') || link.from.startsWith('phase-') || link.to === 'render'));
  const observerWrites = model.system_links.filter(link => link.from === 'carry_holder_despawn' && link.kind === 'write');
  assert.ok(observerWrites.some(link => link.to === 'held_proxy.ColliderDisabled'));
  assert.ok(!observerWrites.some(link => link.to === 'held_proxy.HeldCollider'));
  assert.equal(model.relationships.find(relation => relation.id === 'held_by').linked_spawn, false);
});

test('会话日志的启动、双后台线程与退出刷新仍可追踪', () => {
  const graph = architecture.graphFor('session_log', 'events');
  for (const id of ['plugin-SessionLogPlugin', 'log-producer', 'log-file-worker', 'log-console-worker', 'app-main']) assert.ok(graph.nodes.some(node => node.id === id), id);
  assert.ok(graph.links.some(link => link.from === 'log-producer' && link.to === 'log-file-worker'));
  assert.ok(graph.links.some(link => link.from === 'log-producer' && link.to === 'log-console-worker'));
  assert.ok(graph.links.some(link => link.from === 'app-main' && link.to === 'log-file-worker'));
  assert.equal(architecture.graphFor('session_log', 'data').empty, true);
});

test('碰撞日志只进入 tracing，由两个后台输出分支处理，文件只有文件线程一个写入源', () => {
  const writes = model.system_links.filter(link => link.kind === 'write');
  assert.deepEqual(writes.filter(link => link.from === 'collision_log').map(link => link.to), ['log-producer']);
  assert.deepEqual(new Set(writes.filter(link => link.from === 'log-producer').map(link => link.to)), new Set(['log-file-worker', 'log-console-worker']));
  const fileWrites = writes.filter(link => link.to === 'physics-file-log');
  assert.equal(fileWrites.length, 1);
  assert.deepEqual(fileWrites[0], { id: 'write-log-file-worker-physics-file-log', from: 'log-file-worker', to: 'physics-file-log', kind: 'write', label: 'write_all / flush' });
  assert.ok(!model.system_links.some(link => link.id === 'write-collision_log-physics-file-log'));
  const graph = architecture.graphFor('session_log', 'events');
  for (const [from, to] of [['collision_log', 'log-producer'], ['log-producer', 'log-file-worker'], ['log-producer', 'log-console-worker'], ['log-file-worker', 'physics-file-log']]) {
    assert.equal(graph.links.filter(link => link.kind === 'write' && link.from === from && link.to === to).length, 1, `${from} → ${to}`);
  }
  for (const id of ['collision_log', 'log-producer', 'log-file-worker', 'log-console-worker', 'physics-file-log']) assert.equal(graph.nodes.filter(node => node.id === id).length, 1, id);
});

test('物理插件只引用 tracing 入口，不展开日志插件内部的文件与工作线程', () => {
  const graph = architecture.graphFor('physics', 'events');
  assert.equal(graph.nodes.find(node => node.id === 'collision_log').role, 'internal');
  assert.equal(graph.nodes.find(node => node.id === 'log-producer').role, 'external');
  assert.deepEqual(graph.links.filter(link => link.from === 'collision_log' && link.kind === 'write').map(link => link.to), ['log-producer']);
  assert.ok(graph.links.some(link => link.kind === 'read' && link.from === 'physics-messages' && link.to === 'collision_log'));
  for (const id of ['physics-file-log', 'log-file-worker', 'log-console-worker']) assert.ok(!graph.nodes.some(node => node.id === id), id);
});

test('会话日志文件保留稳定身份，源码入口指向真实文件创建而非碰撞调用者', () => {
  const node = architecture.registry['physics-file-log'];
  assert.equal(model.nodes.filter(item => item.id === node.id).length, 1);
  assert.equal(node.name, '会话日志文件');
  assert.equal(node.feature, 'session_log');
  assert.equal(node.kind, 'External I/O');
  assert.equal(node.source.path, 'src/session_log/lifecycle.rs');
  const lines = fs.readFileSync(new URL('../../' + node.source.path, import.meta.url), 'utf8').split(/\r?\n/);
  assert.match(lines[node.source.line - 1], /^pub\(super\) fn create_session_file\(/);
  const graph = architecture.graphFor('session_log', 'events');
  assert.equal(graph.nodes.find(item => item.id === node.id).role, 'internal');
});

test('构造和读取局部图不修改输入，未知功能或视图明确失败', () => {
  const before = JSON.stringify(model);
  const local = buildArchitectureModel(model);
  for (const feature of INFRASTRUCTURE_FEATURES) for (const aspect of ['systems', 'data', 'events']) local.graphFor(feature.id, aspect);
  assert.equal(JSON.stringify(model), before);
  assert.throws(() => local.graphFor('missing', 'systems'), /功能不存在/);
  assert.throws(() => local.graphFor('character', 'missing'), /架构视图不存在/);
});

test('非系统节点缺少明确归属时失败，不静默归入基础设施', () => {
  const missingOwner = structuredClone(model);
  const resource = missingOwner.resources.find(resource => resource.id === 'resource.GameSettings');
  delete resource.feature;
  delete missingOwner.node_features[resource.id];
  assert.throws(() => buildArchitectureModel(missingOwner), /resource.GameSettings.*缺少明确的功能归属/);
});

test('121 个条目分别记录实际 Schedule，Observer 不冒充固定调度', () => {
  const scheduleNames = new Set(['Startup', 'First', 'PreUpdate', 'FixedFirst', 'FixedUpdate', 'FixedPostUpdate', 'FixedLast', 'RunFixedMainLoop', 'Update', 'SpawnScene', 'PostUpdate', 'EguiPrimaryContextPass', 'Render', 'OnEnter(AppState::MainMenu)', 'OnEnter(AppState::InGame)', 'OnEnter(PlayState::Paused)', 'OnEnter(PlayState::Running)']);
  assert.equal(model.systems.length, 121);
  for (const system of model.systems) {
    assert.ok(Object.hasOwn(system, 'schedule'), system.id);
    if (system.kind === 'observer') {
      assert.equal(system.schedule, null, system.id);
      assert.deepEqual(system.registrations, [], system.id);
    } else {
      assert.ok(scheduleNames.has(system.schedule), `${system.id}: ${system.schedule}`);
      assert.ok(system.registrations.some(registration => registration.schedule === system.schedule), system.id);
    }
  }
  assert.equal(architecture.registry.window_install.schedule, 'PreUpdate');
  assert.deepEqual(architecture.registry.menu_sync_scrollbars.registrations[0].after, ['bevy::ui::UiSystems::Layout']);
  assert.deepEqual(architecture.registry.movement.registrations[0].run_if, ['gameplay_running']);
});

test('Schedule 横向分组按引擎真实顺序，每个 canonical 节点只出现一次', () => {
  for (const feature of featureIds) {
    const graph = architecture.graphFor(feature, 'systems');
    const before = JSON.stringify(graph);
    const groups = architecture.scheduleGroups(graph);
    const ids = groups.flatMap(group => group.nodes.map(node => node.id));
    assert.equal(new Set(ids).size, ids.length, feature);
    assert.deepEqual(new Set(ids), new Set(graph.nodes.map(node => node.id)), feature);
    assert.deepEqual(groups.map(group => group.order), groups.map(group => group.order).sort((a, b) => a - b));
    assert.equal(JSON.stringify(graph), before);
  }
  for (const [feature, expected] of [
    ['infrastructure', ['First', 'PreUpdate', 'FixedUpdate', 'SpawnScene', 'PostUpdate']],
    ['avian', ['FixedFirst', 'FixedPostUpdate', 'FixedLast', 'RunFixedMainLoop.AfterFixedMainLoop']],
    ['enhanced_input', ['PreUpdate']],
    ['kira', ['PostUpdate']],
    ['egui', ['PreUpdate', 'EguiPrimaryContextPass']],
  ]) {
    const order = architecture.scheduleGroups(architecture.graphFor(feature, 'systems')).map(group => group.id);
    for (const group of expected) assert.ok(order.includes(group), `${feature}: ${group}`);
    for (let index = 1; index < expected.length; index++) assert.ok(order.indexOf(expected[index - 1]) < order.indexOf(expected[index]), `${feature}: ${expected[index - 1]} → ${expected[index]}`);
  }
});

test('固定循环之后仍属于 RunFixedMainLoop，条件状态入口与 Startup 分开说明', () => {
  const groups = new Map(model.schedule_groups.map(group => [group.id, group]));
  const afterLoop = architecture.registry.facing_update;
  assert.equal(afterLoop.schedule, 'RunFixedMainLoop');
  assert.equal(afterLoop.schedule_group, 'RunFixedMainLoop.AfterFixedMainLoop');
  assert.equal(afterLoop.registrations[0].driver_set, 'RunFixedMainLoopSystems::AfterFixedMainLoop');
  assert.equal(groups.get('FixedFirst').track, 'fixed');
  assert.equal(groups.get('Startup').track, 'startup');
  assert.equal(groups.get('StateTransition').track, 'conditional');
  assert.ok(groups.get('StateTransition').notes.some(note => note.includes('PreStartup')));
  assert.deepEqual(architecture.registry.character_clear_intents.registrations.map(registration => registration.schedule), ['OnEnter(AppState::MainMenu)', 'OnEnter(PlayState::Paused)']);
  assert.equal(architecture.registry.startup_spawn.schedule, 'OnEnter(AppState::InGame)');
  assert.ok(architecture.registry.startup_spawn.registrations.some(registration => registration.schedule === 'Startup' && registration.scope === 'headless-test'));
  assert.equal(groups.get('EguiPrimaryContextPass').parent, 'PostUpdate');
  assert.equal(groups.get('RenderApp').track, 'external');
  assert.equal(architecture.registry.render.schedule, 'Render');
  assert.ok(architecture.registry.render.registrations.some(registration => registration.schedule === 'ExtractSchedule' && registration.sub_app === 'RenderApp'));
});

test('状态分组标题只显示类型，完整运行时注册、身份与生命周期说明继续保留', () => {
  const targets = new Map([
    ['game_flow', ['OnEnter(AppState::MainMenu)', 'OnEnter(PlayState::Paused)', 'OnEnter(PlayState::Running)']],
    ['first_person', ['OnEnter(AppState::MainMenu)', 'OnEnter(PlayState::Paused)', 'OnEnter(PlayState::Running)']],
    ['character', ['OnEnter(AppState::MainMenu)', 'OnEnter(PlayState::Paused)']],
    ['scene_assembly', ['OnEnter(AppState::InGame)']],
    ['ui', ['OnEnter(AppState::MainMenu)', 'OnEnter(PlayState::Paused)', 'OnEnter(PlayState::Running)']],
  ]);
  const definitions = new Map(model.schedule_groups.map(group => [group.id, group]));
  for (const feature of featureIds) {
    const groups = architecture.scheduleGroups(architecture.graphFor(feature, 'systems'));
    const state = groups.find(group => group.id === 'StateTransition');
    assert.equal(state?.label, targets.has(feature) ? 'OnEnter' : undefined, feature);
    const schedules = state && [...new Set(state.nodes.flatMap(node => architecture.registry[node.id].registrations.filter(registration => registration.scope === 'runtime').map(registration => registration.schedule)))];
    assert.deepEqual(schedules?.toSorted(), targets.get(feature)?.toSorted(), feature);
    for (const group of groups) {
      const { label, nodes, ...contract } = group;
      const { label: originalLabel, ...definition } = definitions.get(group.id);
      assert.deepEqual(contract, definition, `${feature}/${group.id}`);
      if (group.id === 'Startup') assert.equal(label, 'Startup');
      assert.ok(!label.includes('仅初始化一次'));
      if (group.id === 'StateTransition') assert.doesNotMatch(label, /StateTransition|条件|Startup/);
      else assert.equal(label, SCHEDULE_GROUP_DISPLAY_LABELS[group.id] ?? originalLabel);
      assert.equal(new Set(nodes.map(node => node.id)).size, nodes.length);
    }
  }
  assert.ok(definitions.get('Startup').notes.some(note => note.includes('执行一次')));
  assert.deepEqual(architecture.registry.flow_suspend.registrations.map(registration => registration.schedule), ['OnEnter(AppState::MainMenu)', 'OnEnter(PlayState::Paused)']);
});

test('指定调度标题只显示名称，原始说明、阶段身份和其他标题不被改写', () => {
  const expected = {
    FixedLast: 'FixedLast',
    FixedPostUpdate: 'FixedPostUpdate',
    EguiPrimaryContextPass: 'EguiPrimaryContextPass',
    RenderApp: 'RenderApp',
    NativePlatformEvents: '原生平台回调',
    EventTriggered: 'Observer',
    Explanatory: '约束与说明',
  };
  assert.deepEqual(SCHEDULE_GROUP_DISPLAY_LABELS, expected);
  const before = JSON.stringify(model);
  for (const [id, label] of Object.entries(expected)) {
    const definition = model.schedule_groups.find(group => group.id === id);
    assert.notEqual(definition.label, label, id);
    assert.equal(scheduleGroupLabel(definition, architecture.registry), label, id);
  }
  const afterLoop = model.schedule_groups.find(group => group.id === 'RunFixedMainLoop.AfterFixedMainLoop');
  assert.equal(scheduleGroupLabel(afterLoop, architecture.registry), 'RunFixedMainLoop · AfterFixedMainLoop');
  const lifecycle = model.schedule_groups.find(group => group.id === 'ApplicationLifecycle');
  assert.equal(scheduleGroupLabel(lifecycle, architecture.registry), 'App 构建与退出');
  for (const feature of featureIds) architecture.scheduleGroups(architecture.graphFor(feature, 'systems'));
  assert.equal(JSON.stringify(model), before);
});

test('状态标题按首次出现列出不同 Schedule 类型，参数和每条注册条件不被合并', () => {
  const registry = {
    a: { registrations: [
      { schedule: 'OnExit(AppState::InGame)', scope: 'runtime' },
      { schedule: 'OnEnter(AppState::MainMenu)', scope: 'runtime', run_if: ['ready', 'enabled'], after: ['prepare'] },
      { schedule: 'Startup', scope: 'headless-test' },
    ] },
    b: { registrations: [
      { schedule: 'OnExit(AppState::InGame)', scope: 'runtime' },
      { schedule: 'OnEnter(PlayState::Paused)', scope: 'runtime' },
      { schedule: 'OnTransition { exited: PlayState::Running, entered: PlayState::Paused }', scope: 'runtime' },
      { schedule: 'OnExit(TestState::Ready)', scope: 'headless-test' },
    ] },
  };
  const group = { id: 'StateTransition', label: 'StateTransition', nodes: [{ id: 'a' }, { id: 'b' }] };
  const expected = 'OnExit\nOnEnter\nOnTransition';
  const before = JSON.stringify({ group, registry });
  assert.equal(scheduleGroupLabel(group, registry), expected);
  assert.equal(scheduleGroupLabel({ ...group, nodes: ['a', 'b'] }, registry), expected);
  assert.equal(JSON.stringify({ group, registry }), before);
  assert.equal(scheduleGroupLabel({ id: 'Update', label: 'Update', nodes: [] }, registry), 'Update');
  for (const registrations of [[], [{ schedule: 'Startup', scope: 'headless-test' }], [{ schedule: '', scope: 'runtime' }]]) {
    assert.throws(() => scheduleGroupLabel({ ...group, nodes: ['missing-runtime'] }, { 'missing-runtime': { registrations } }), /缺少有效的运行时 Schedule 注册/);
  }
  assert.throws(() => scheduleGroupLabel({ ...group, nodes: ['invalid'] }, { invalid: { registrations: [{ schedule: 'OnEnter???', scope: 'runtime' }] } }), /无法识别 Schedule 类型/);
});

test('初始化与逐帧传播共用 canonical 方框，列内排序不添加执行依赖', () => {
  const graph = architecture.graphFor('infrastructure', 'systems');
  const before = JSON.stringify(model.system_links);
  const groups = architecture.scheduleGroups(graph);
  assert.equal(groups.flatMap(group => group.nodes).filter(node => node.id === 'transform_propagate').length, 1);
  assert.deepEqual(architecture.registry.transform_propagate.registrations.map(registration => registration.schedule), ['PostUpdate', 'PostStartup']);
  assert.equal(JSON.stringify(model.system_links), before);
  const character = architecture.scheduleGroups(architecture.graphFor('character', 'systems'));
  const fixed = character.find(group => group.id === 'FixedUpdate').nodes.map(node => node.id);
  assert.ok(fixed.indexOf('grounded_fixed') < fixed.indexOf('movement'));
  assert.ok(fixed.indexOf('movement') < fixed.indexOf('gravity'));
});

test('缺少规范化 Schedule 或使用未知泳道时失败，不从 phase 文本猜测', () => {
  const missing = structuredClone(model);
  const movement = missing.systems.find(system => system.id === 'movement');
  delete movement.schedule;
  const incomplete = buildArchitectureModel(missing);
  assert.throws(() => incomplete.scheduleGroups(incomplete.graphFor('character', 'systems')), /movement.*缺少明确的 Schedule 注册/);
  movement.schedule = 'FixedUpdate';
  movement.schedule_group = 'UnknownSchedule';
  const unknown = buildArchitectureModel(missing);
  assert.throws(() => unknown.scheduleGroups(unknown.graphFor('character', 'systems')), /movement.*调度分组不存在/);
});

test('主调度边界与条件、嵌套阶段不转成跨 Schedule 的系统执行边', () => {
  const groups = new Map(model.schedule_groups.map(group => [group.id, group]));
  for (const [left, right] of [['PreUpdate', 'StateTransition'], ['StateTransition', 'FixedFirst'], ['RunFixedMainLoop.AfterFixedMainLoop', 'Update'], ['Update', 'SpawnScene'], ['SpawnScene', 'PostUpdate']]) {
    assert.ok(groups.get(left).order < groups.get(right).order, `${left} → ${right}`);
  }
  for (const link of model.system_links.filter(link => link.kind === 'order')) {
    const from = architecture.registry[link.from];
    const to = architecture.registry[link.to];
    assert.ok(from.schedule && to.schedule, link.id);
    assert.equal(from.schedule, to.schedule, `${link.id} 不能把主调度边界误画成系统注册依赖`);
  }
  assert.equal(groups.get('EguiPrimaryContextPass').track, 'nested');
  assert.equal(architecture.registry.inspector_pass.registrations[0].driver_schedule, 'PostUpdate');
  assert.equal(architecture.registry.inspector_pass.registrations[0].driver_set, 'EguiPostUpdateSet::EndPass');
  assert.equal(architecture.registry.physics_step.registrations[0].nested_schedule, 'PhysicsSchedule');
});

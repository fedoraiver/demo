import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildArchitectureModel, buildObserverPlacement, isMainPluginRegistration, isUnscheduledTriggerNode, projectObserverTriggers, scheduleGroupLabel, SCHEDULE_GROUP_DISPLAY_LABELS } from './architecture-model.mjs';
import { INFRASTRUCTURE_FEATURES, architectureViewId } from './architecture-infrastructure.mjs';
import { dependencyDefinitionTargets } from './dependency-sources.mjs';
import { DEPENDENCY_SOURCE_DEFINITIONS } from './architecture-source-definitions.mjs';
import { buildObjectCatalog } from './architecture-objects.mjs';

const model = JSON.parse(fs.readFileSync(new URL('./ecs-data.json', import.meta.url), 'utf8'));
const architecture = buildArchitectureModel(model);
const objects = buildObjectCatalog(model, architecture.registry);
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

test('第三方业务节点各有唯一入口，拆分旧聚合身份而不展开跨入口内部实现', () => {
  const counts = { avian: 104, enhanced_input: 39, kira: 6, egui: 13 };
  // 已核实入口保持稳定；移除新版已不存在的 Egui 标记及已停用的调试动作。
  const originalNodes = {
    avian: [
      'physics_prepare', 'physics_step', 'physics_writeback', 'easing_reset',
      'easing_end', 'easing_apply', 'easing_tick', 'easing_start',
      'resource.Gravity', 'resource.ColliderTrees', 'resource.CollisionStartMessages', 'resource.CollisionEndMessages',
      'resource.LastEasingTick', 'resource.TimePhysics', 'resource.ContactGraph', 'character.RigidBody',
      'character.Collider', 'character.Position', 'character.Rotation', 'character.LinearVelocity',
      'character.AngularVelocity', 'character.Mass', 'character.ComputedMass', 'character.ComputedAngularInertia',
      'character.ComputedCenterOfMass', 'character.CollisionLayers', 'character.CollisionEventsEnabled', 'character.SweptCcd',
      'character.Friction', 'character.Restitution', 'character.VelocityIntegrationData', 'character.AccumulatedLocalAcceleration',
      'character.SleepTimer', 'character.TranslationInterpolation', 'character.TranslationEasingState', 'character.LockedAxes',
      'character.ColliderAabb', 'character.NoTranslationEasing', 'character.NoRotationEasing', 'character.RigidBodyColliders',
      'parcel.RigidBody', 'parcel.Collider', 'parcel.Position', 'parcel.Rotation',
      'parcel.LinearVelocity', 'parcel.AngularVelocity', 'parcel.Mass', 'parcel.ComputedMass',
      'parcel.ComputedAngularInertia', 'parcel.ComputedCenterOfMass', 'parcel.CollisionLayers', 'parcel.CollisionEventsEnabled',
      'parcel.SweptCcd', 'parcel.Friction', 'parcel.Restitution', 'parcel.VelocityIntegrationData',
      'parcel.AccumulatedLocalAcceleration', 'parcel.SleepTimer', 'parcel.TranslationInterpolation', 'parcel.TranslationEasingState',
      'parcel.LockedAxes', 'parcel.AngularDamping', 'parcel.TransformInterpolation', 'parcel.RotationInterpolation',
      'parcel.ScaleInterpolation', 'parcel.RotationEasingState', 'parcel.ScaleEasingState', 'parcel.Sensor',
      'parcel.ColliderAabb', 'parcel.NoTranslationEasing', 'parcel.NoRotationEasing', 'parcel.ColliderDisabled',
      'parcel.ColliderOf', 'parcel.Sleeping', 'world.RigidBody', 'world.Collider',
      'world.CollisionLayers', 'world.Position', 'world.Rotation', 'world.ColliderAabb',
      'world.Sensor', 'world.ColliderOf', 'world.ColliderDisabled', 'held_proxy.ColliderOf',
      'held_proxy.ColliderTransform', 'held_proxy.Collider', 'held_proxy.CollisionLayers', 'held_proxy.Position',
      'held_proxy.Rotation', 'held_proxy.Friction', 'held_proxy.Restitution', 'held_proxy.CollisionEventsEnabled',
      'held_proxy.ColliderDisabled', 'plugin-physics-0', 'physics-messages',
    ],
    enhanced_input: [
      'enhanced_prepare', 'enhanced_evaluate', 'input_apply', 'resource.ContextInstances',
      'resource.ActionSources', 'resource.ConsumedInputs', 'resource.PendingBindings', 'controller.GamepadDevice',
      'controller.Actions', 'controller.ContextPriority', 'controller.ContextActivity', 'action.Action',
      'action.ActionSettings', 'action.ActionOf', 'action.Bindings', 'action.Press',
      'action.ActionValue', 'action.TriggerState', 'action.ActionEvents', 'action.ActionTime',
      'action.ActionMock', 'action.ActionFns', 'action.ConditionFns', 'binding.Binding',
      'binding.BindingOf', 'binding.FirstActivation', 'binding.Negate', 'binding.SwizzleAxis',
      'binding.ModifierFns', 'menu_controller.ContextPriority', 'menu_controller.ContextActivity', 'menu_controller.GamepadDevice',
      'menu_controller.Actions', 'plugin-EnhancedInputPlugin',
    ],
    kira: [
      'resource.AudioSources', 'resource.AudioLoadFailures', 'resource.AudioInstances', 'plugin-kira',
      'kira-play-typed', 'kira-output',
    ],
    egui: [
      'egui_input', 'egui_begin', 'inspector_pass', 'resource.EguiGlobalSettings',
      'resource.EnableMultipassForPrimaryContext', 'camera.EguiContext', 'camera.PrimaryEguiContext', 'camera.EguiContextSettings',
      'camera.EguiInput', 'camera.EguiMultipassSchedule', 'camera.EguiFullOutput', 'menu_camera.PrimaryEguiContext',
      'plugin-inspector-0', 'plugin-inspector-1',
    ],
  };
  const addedNodes = {
    avian: [
      'resource.LastPhysicsTick', 'character.SpeculativeCcd', 'character.BodySizeMetrics', 'character.SolverBodyIndex',
      'character.Sleeping', 'parcel.SpeculativeCcd', 'parcel.BodySizeMetrics', 'parcel.SolverBodyIndex',
    ],
    enhanced_input: [
      'input_trigger', 'enhanced-reset-gameplay-action',
    ],
    kira: [],
    egui: [],
  };
  for (const [feature, expected] of Object.entries(counts)) {
    const owned = Object.values(architecture.registry).filter(node => node.feature === feature);
    assert.equal(owned.length, expected, feature);
    const retained = originalNodes[feature].filter(id => id !== 'resource.EnableMultipassForPrimaryContext').flatMap(id => model.object_aliases[id] || [id]);
    assert.deepEqual(new Set(owned.map(node => node.id)), new Set([...retained, ...addedNodes[feature]]), `${feature}: retained and added stable IDs`);
    assert.equal(Object.values(model.node_features).filter(owner => owner === feature).length, expected, feature);
    const visibleInternal = new Set();
    for (const aspect of ['systems', 'data', 'events']) {
      const graph = architecture.graphFor(feature, aspect);
      for (const node of graph.nodes) {
        assert.equal(node.role === 'internal', architecture.ownerOf(node.id) === feature, `${feature}/${aspect}/${node.id}`);
        if (node.role === 'internal' && architecture.registry[node.id].kind !== 'Component') visibleInternal.add(node.id);
        else assert.ok(node.group.startsWith('外部契约 · '), node.id);
      }
      assert.ok(graph.links.every(link => architecture.ownerOf(link.from) === feature || architecture.ownerOf(link.to) === feature), `${feature}/${aspect}`);
    }
    for (const object of objects.objects.filter(object => object.feature === feature && object.kind !== 'Component')) visibleInternal.add(object.id);
    assert.deepEqual(visibleInternal, new Set(owned.filter(node => node.kind !== 'Component').map(node => node.id)), feature);
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

test('功能系统图保留本功能边界，Observer 根据来源连接而不进入 Schedule 容器', () => {
  const graph = architecture.graphFor('character', 'systems');
  assert.ok(graph.nodes.some(node => node.id === 'movement' && node.role === 'internal'));
  assert.ok(graph.nodes.some(node => node.id === 'facing_fixed' && node.role === 'external'));
  assert.ok(!graph.nodes.some(node => node.id === 'menu_rebuild'));
  const firstPerson = architecture.graphFor('first_person', 'systems');
  assert.ok(firstPerson.nodes.some(node => node.id === 'observe_move' && node.role === 'internal'));
  assert.ok(!architecture.scheduleGroups(firstPerson).some(group => group.id === 'EventTriggered'));
  assert.ok(architecture.scheduleGroups(firstPerson).flatMap(group => group.nodes).every(node => !isUnscheduledTriggerNode(architecture.registry[node.id])));
  assert.ok(graph.nodes.every(node => /[\u4e00-\u9fff]/.test(node.group)));
});

test('Observer 来源投影按精确事件身份连接，保留多来源、条件、源码和稳定 ID', () => {
  const registry = {
    emitter: { kind: 'System' }, cleanup: { kind: 'Observer' }, receiver: { kind: 'Observer' },
    a: { kind: 'EntityEvent', name: 'RemoveEvent' }, b: { kind: 'EntityEvent', name: 'RemoveEvent' },
  };
  const source = { path: 'src/example.rs', line: 9, role: 'operation' };
  const links = [
    { id: 'emit-a', from: 'emitter', to: 'a', kind: 'trigger', label: 'Commands::trigger', notes: ['命令应用后生效'], sourceEntries: [source] },
    { id: 'reset-a', from: 'cleanup', to: 'a', kind: 'trigger', notes: ['旧状态 Fired 时'] },
    { id: 'emit-b', from: 'emitter', to: 'b', kind: 'trigger' },
    { id: 'subscribe-a', from: 'a', to: 'receiver', kind: 'trigger', label: 'Remove<Pressed>', sourceEntries: [source], sourceGaps: ['待核实：边界条件'] },
  ];
  const before = structuredClone(links), projected = projectObserverTriggers(links, registry);
  assert.equal(projected.length, 2, '同名事件不能互相匹配');
  assert.deepEqual(projected.map(link => [link.from, link.to, link.eventId, link.label]), [
    ['emitter', 'receiver', 'a', 'Remove<Pressed>'], ['cleanup', 'receiver', 'a', 'Remove<Pressed>'],
  ]);
  assert.deepEqual(projected[0].originalLinkIds, ['emit-a', 'subscribe-a']);
  assert.deepEqual(projected[0].sourceEntries, [source]);
  assert.deepEqual(projected[0].sourceGaps, ['待核实：边界条件']);
  assert.deepEqual(projected[0].notes, ['Commands::trigger', '命令应用后生效']);
  assert.deepEqual(projected[1].notes, ['旧状态 Fired 时']);
  assert.deepEqual(projectObserverTriggers([...links].reverse(), registry).map(link => link.id).sort(), projected.map(link => link.id).sort());
  assert.equal(new Set(projected.map(link => link.id)).size, projected.length);
  assert.deepEqual(links, before, '显示投影不修改原关系或对象图输入');
});

test('Observer 只作为发出来源旁的视觉附属，保留真实调度成员和独立生命周期分支', () => {
  for (const feature of ['first_person', 'ui', 'infrastructure', 'enhanced_input']) {
    const graph = architecture.graphFor(feature, 'systems'), before = JSON.stringify(graph);
    const groups = architecture.scheduleGroups(graph), placement = buildObserverPlacement(graph, architecture.registry, groups);
    const pre = placement.groups.find(group => group.id === 'PreUpdate');
    const callbacks = graph.nodes.filter(node => architecture.registry[node.id].kind === 'Observer');
    assert.ok(pre.visualAttachments.length, feature);
    assert.ok(callbacks.some(node => pre.visualAttachments.includes(node.id)), feature);
    const scheduled = placement.groups.flatMap(group => group.nodes.map(node => typeof node === 'string' ? node : node.id));
    const attachments = placement.groups.flatMap(group => group.visualAttachments || []);
    const branches = placement.branches.flatMap(branch => branch.nodes);
    assert.equal(new Set([...scheduled, ...attachments, ...branches]).size, graph.nodes.length);
    assert.deepEqual(new Set([...scheduled, ...attachments, ...branches]), new Set(graph.nodes.map(node => node.id)));
    assert.ok(attachments.every(id => !scheduled.includes(id) && architecture.registry[id].schedule === null));
    assert.equal(JSON.stringify(graph), before, '布局不回写关系或注册');
  }
  const item = architecture.graphFor('item_interaction', 'systems');
  const itemPlacement = buildObserverPlacement(item, architecture.registry, architecture.scheduleGroups(item));
  assert.ok(itemPlacement.branches.some(branch => branch.nodes.includes('ecs-component-lifecycle') && branch.nodes.includes('carry_holder_despawn')));
  const scene = architecture.scheduleGroups(architecture.graphFor('scene_assembly', 'systems'));
  assert.ok(scene.find(group => group.id === 'SpawnScene').visualAttachments.includes('island_ready_observer'));
});

test('提前唤醒同步在物理页完整显示，浏览归属不覆盖引擎定义来源', () => {
  const graph = architecture.graphFor('physics', 'systems');
  const chain = ['wake_changed_bodies', 'wake_apply', 'physics_prepare'];
  for (const [id, role] of [['wake_changed_bodies', 'internal'], ['wake_apply', 'internal'], ['physics_prepare', 'external']]) {
    assert.equal(graph.nodes.find(node => node.id === id)?.role, role, id);
    assert.equal(architecture.registry[id].schedule, 'FixedPostUpdate', id);
  }
  for (let index = 1; index < chain.length; index++) {
    assert.equal(graph.links.filter(link => link.kind === 'order' && link.from === chain[index - 1] && link.to === chain[index]).length, 1);
  }
  const group = architecture.scheduleGroups(graph).find(group => group.id === 'FixedPostUpdate');
  const positions = chain.map(id => group.nodes.findIndex(node => node.id === id));
  assert.ok(positions.every(index => index >= 0));
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2]);
  assert.equal(architecture.ownerOf('wake_apply'), 'physics');
  assert.equal(architecture.registry.wake_apply.defined_in, 'infrastructure');
  assert.equal(architecture.registry.wake_apply.registered_by, 'physics');
  assert.equal(architecture.registry.wake_apply.registrations[0].implicit, true);
  assert.ok(dependencyDefinitionTargets(architecture.registry).includes('wake_apply'));
  assert.deepEqual(DEPENDENCY_SOURCE_DEFINITIONS.wake_apply, {
    package: 'bevy_ecs', path: 'src/schedule/executor/mod.rs', symbol: 'ApplyDeferred', kind: 'struct',
  });
});

test('菜单请求等待 Trigger 事件命令应用，UI 页保留完整消费链', () => {
  const graph = architecture.graphFor('ui', 'systems');
  const chain = ['input_trigger', 'event_apply', 'menu_handle_requests'];
  for (const [id, role] of [['input_trigger', 'external'], ['event_apply', 'internal'], ['menu_handle_requests', 'internal']]) {
    assert.equal(graph.nodes.find(node => node.id === id)?.role, role, id);
    assert.equal(architecture.registry[id].schedule, 'PreUpdate', id);
  }
  for (let index = 1; index < chain.length; index++) {
    assert.equal(graph.links.filter(link => link.kind === 'order' && link.from === chain[index - 1] && link.to === chain[index]).length, 1);
  }
  assert.equal(architecture.registry.input_apply.events.length, 0);
  assert.ok(!graph.links.some(link => link.kind === 'order' && link.from === 'input_apply' && link.to === 'menu_handle_requests'));
  assert.equal(architecture.ownerOf('event_apply'), 'ui');
  assert.equal(architecture.registry.event_apply.registrations[0].implicit, true);
  assert.equal(architecture.registry.event_apply.defined_in, 'infrastructure');
  assert.deepEqual(DEPENDENCY_SOURCE_DEFINITIONS.event_apply, DEPENDENCY_SOURCE_DEFINITIONS.wake_apply);
});

test('数据页使用普通Entity卡片，组件清单和真实访问端点完整保留', () => {
  const owner = new Map(model.entities.flatMap(entity => entity.components.map(component => [component.id, `entity-${entity.id}`])));
  for (const feature of featureIds) {
    const graph = architecture.graphFor(feature, 'data'), visible = new Set(graph.nodes.map(node => node.id));
    assert.ok(!graph.entityGroups);
    assert.ok(graph.nodes.every(node => !owner.has(node.id)));
    for (const link of graph.links) {
      assert.equal(link.displayFrom, owner.get(link.from) || link.from);
      assert.equal(link.displayTo, owner.get(link.to) || link.to);
      assert.ok(visible.has(link.displayFrom) && visible.has(link.displayTo));
    }
  }
  assert.deepEqual(architecture.registry['entity-parcel'].components.map(component => component.id), entityComponentIds('entity-parcel'));
  assert.ok(architecture.registry['parcel.HeldTarget']);
  assert.ok(architecture.registry['character.Transform'] && architecture.registry['parcel.Transform']);
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
  const graphs = [...allGraphs(), ...objects.objects.map(object => objects.graphFor(object.id))];
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
    assert.ok(links.has(link.id), link.id);
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
      assert.ok(nodeIds.has(link.displayFrom || link.from), link.id);
      assert.ok(nodeIds.has(link.displayTo || link.to), link.id);
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
  const data = architecture.graphFor('session_log', 'data');
  assert.equal(data.empty, false);
  for (const id of ['resource.SessionWriter', 'resource.ConsoleWriter']) assert.ok(data.nodes.some(node => node.id === id), id);
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
  for (const id of model.object_aliases['physics-messages']) assert.ok(graph.links.some(link => link.kind === 'read' && link.from === id && link.to === 'collision_log'), id);
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

test('系统清单分别记录实际 Schedule，Observer 不冒充固定调度', () => {
  const scheduleNames = new Set(['Startup', 'First', 'PreUpdate', 'FixedFirst', 'FixedUpdate', 'FixedPostUpdate', 'FixedLast', 'RunFixedMainLoop', 'Update', 'SpawnScene', 'PostUpdate', 'EguiPrimaryContextPass', 'Render', 'OnEnter(AppState::MainMenu)', 'OnEnter(AppState::InGame)', 'OnEnter(PlayState::Paused)', 'OnEnter(PlayState::Running)']);
  const originalIds = [
    'startup_spawn', 'startup_config', 'startup_timestep', 'startup_pose',
    'frame_limit', 'time_update', 'input_update', 'mouse_capture',
    'enhanced_prepare', 'enhanced_evaluate', 'input_apply', 'observe_move',
    'observe_complete', 'observe_cancel', 'observe_jump', 'observe_interact',
    'observe_look', 'facing_fixed', 'movement', 'gravity',
    'interaction', 'held_apply', 'held_fixed', 'facing_update',
    'held_update', 'camera_follow', 'transform_propagate', 'render',
    'visibility_update', 'startup_inspector', 'egui_input', 'egui_begin',
    'capture_apply', 'inspector_pass', 'grounded_fixed',
    'grounded_after', 'gravity_sync', 'orphan_cleanup', 'orphan_apply',
    'velocity_log', 'collision_log', 'physics_prepare', 'physics_step',
    'physics_writeback', 'easing_reset', 'easing_end', 'easing_apply',
    'easing_tick', 'startup_assets', 'asset_poll', 'island_begin',
    'island_ready_observer', 'island_prepare', 'actors_spawn', 'courier_ready_observer',
    'animation_initialize', 'animation_sync', 'water_recover', 'interpolation_resume',
    'world_spawn', 'animation_grounding', 'animation_engine', 'easing_start',
    'flow_enter_menu', 'flow_pause', 'flow_suspend', 'flow_resume',
    'menu_spawn_controller', 'menu_sync_context', 'menu_handle_requests', 'menu_pointer',
    'menu_rebuild', 'menu_style', 'menu_description', 'menu_scroll_focus',
    'menu_backdrop_spawn', 'menu_asset_failures', 'observe_menu_previous',
    'observe_menu_next', 'observe_menu_left', 'observe_menu_right', 'observe_menu_confirm',
    'observe_menu_back', 'observe_menu_scroll', 'observe_courier_ready', 'menu_animation_play',
    'audio_preload', 'audio_load_failures', 'audio_play', 'audio_stop',
    'audio_strain', 'audio_land', 'menu_volume_pointer', 'menu_volume_visuals',
    'audio_mix', 'audio_voice_volumes', 'audio_voice_volumes_post', 'window_log',
    'window_install', 'menu_settings_text', 'menu_bind_scrollbars', 'menu_sync_scrollbars',
    'observe_scrollbar_scroll', 'observe_scrollbar_press', 'carry_proxy_cleanup', 'carry_mass_restore',
    'carry_attach', 'carry_align', 'carry_physics_fixed', 'carry_physics_post',
    'carry_physics_frame', 'carry_resume', 'carry_holder_despawn', 'flow_clock_menu',
    'flow_clock_pause', 'flow_clock_resume', 'flow_resume_capture', 'menu_audio_preview',
    'character_clear_intents',
  ];
  const addedIds = [
    'input_trigger', 'wake_changed_bodies', 'wake_apply', 'observe_menu_primary_press',
    'observe_menu_primary_clear', 'menu_clear_cancelled_primary', 'native_pointer_events', 'native_update_hovered',
    'native_button_down', 'native_button_up', 'native_button_click', 'native_button_drag_end',
    'native_button_cancel', 'native_button_key',
    'flow_suspend_paused', 'character_clear_intents_paused',
    'enhanced-reset-gameplay-action', 'native-focused-keyboard-dispatch',
  ];
  assert.deepEqual(new Set(model.systems.map(system => system.id)), new Set([...originalIds, ...addedIds]), 'Original registrations retain their stable IDs');
  for (const id of ['filter_egui_input', 'observe_release_pointer']) assert.equal(architecture.registry[id], undefined, `${id}: 已删除系统不保留为生产对象`);
  assert.deepEqual(architecture.registry.mouse_capture.registrations, [{
    schedule: 'PreUpdate', scope: 'runtime', after: ['InputSystems', 'EguiPreUpdateSet::InitContexts'],
    before: ['EguiPreUpdateSet::ProcessInput', 'EnhancedInputSystems::Prepare'],
  }]);
  for (const system of model.systems) {
    assert.ok(Object.hasOwn(system, 'schedule'), system.id);
    if (system.kind === 'Observer') {
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
    const triggers = graph.nodes.filter(node => isUnscheduledTriggerNode(architecture.registry[node.id])).map(node => node.id);
    assert.deepEqual(new Set([...ids, ...triggers]), new Set(graph.nodes.map(node => node.id)), feature);
    assert.ok(triggers.every(id => !ids.includes(id)), '触发节点不冒充 Schedule 成员');
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
  assert.deepEqual(architecture.registry.character_clear_intents.registrations.map(registration => registration.schedule), ['OnEnter(AppState::MainMenu)']);
  assert.deepEqual(architecture.registry.character_clear_intents_paused.registrations.map(registration => registration.schedule), ['OnEnter(PlayState::Paused)']);
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
      const { label, nodes, visualAttachments, ...contract } = group;
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
  assert.deepEqual(architecture.registry.flow_suspend.registrations.map(registration => registration.schedule), ['OnEnter(AppState::MainMenu)']);
  assert.deepEqual(architecture.registry.flow_suspend_paused.registrations.map(registration => registration.schedule), ['OnEnter(PlayState::Paused)']);
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

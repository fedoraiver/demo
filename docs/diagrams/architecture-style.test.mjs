import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildArchitectureModel } from './architecture-model.mjs';
import { NODE_KINDS, nodeKindOf } from './architecture-kinds.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, EXTERNAL_REFERENCE_STYLE, selectedFillColor, visualTypeOf, edgeSemanticOf, displayLabelOf, scheduleLinksFor, mermaidStyleDefinitions } from './architecture-style.mjs';

const model = JSON.parse(fs.readFileSync(new URL('./ecs-data.json', import.meta.url), 'utf8'));
const architecture = buildArchitectureModel(model);
const registry = architecture.registry;
const features = [...architecture.features, ...architecture.infrastructureFeatures].map(feature => feature.id);

// 按审核后的外观契约核对；目录新增项须同步提供明确规范，不能静默回退为泛称。
const approvedStyles = {
  system: ['System', 'rounded', '#3567A6'], observer: ['Observer', 'hex', '#7B4DB2'],
  entity: ['Entity', 'rounded', '#A6533B'], component: ['Component', 'rounded', '#4B8060'],
  resource: ['Resource', 'cyl', '#A5792C'], local: ['Local<T>', 'notch-rect', '#AA8752'],
  non_send: ['NonSend<T>', 'tag-rect', '#A5633A'], message: ['Message', 'lean-r', '#247B91'],
  message_buffer: ['Messages<T>', 'cyl', '#247B91'], event: ['EntityEvent', 'stadium', '#B66B2D'],
  system_set: ['SystemSet', 'lin-rect', '#6A778C'], system_param: ['SystemParam', 'notch-rect', '#3B8790'],
  query_data: ['QueryData', 'notch-rect', '#567A51'], scheduling_constraint: ['Scheduling constraint', 'lin-rect', '#7C6AA6'],
  shared_data_contract: ['Shared data contract', 'tag-rect', '#4A8580'], sync: ['Synchronization', 'rounded', '#8B6A42'],
  system_group: ['System group', 'fr-rect', '#607C96'], observer_group: ['Observer group', 'hex', '#9A648D'],
  engine_flow: ['Engine flow', 'stadium', '#557C78'], plugin: ['Plugin', 'fr-rect', '#4A6389'],
  plugin_group: ['PluginGroup', 'fr-rect', '#735C93'], app: ['App', 'fr-rect', '#3A7B87'],
  registration_helper: ['Registration helper', 'tag-rect', '#8A7548'], external_io: ['External I/O', 'lean-l', '#526A78'],
  platform_api: ['Platform API', 'lean-l', '#8A6555'], platform_event: ['Platform event', 'lean-r', '#916B45'],
  note: ['Note', 'doc', '#9A9B88'], lifecycle_note: ['Lifecycle note', 'doc', '#8E766D'],
  bsn_layout: ['BSN layout', 'doc', '#6C8D9D'], operation_result: ['Operation result', 'doc', '#7D8963'],
};

test('every drawable semantic category has its approved independent shape, color and exact legend', () => {
  assert.deepEqual(Object.keys(NODE_STYLES), Object.keys(approvedStyles));
  const drawn = Object.values(NODE_KINDS).flatMap(kind => kind.visualType ? [kind.visualType] : []);
  assert.deepEqual(new Set(drawn), new Set(Object.keys(NODE_STYLES)));
  const signatures = new Set();
  for (const [type, style] of Object.entries(NODE_STYLES)) {
    assert.deepEqual([style.legendLabel, style.shape, style.stroke], approvedStyles[type], type);
    assert.match(style.label, /\S/); assert.match(style.shape, /^[a-z-]+$/);
    assert.match(style.fill, /^#[\dA-F]{6}$/); assert.match(style.stroke, /^#[\dA-F]{6}$/);
    assert.ok(style.width > 0);
    signatures.add([style.shape, style.fill, style.stroke].join('|'));
  }
  assert.equal(signatures.size, Object.keys(NODE_STYLES).length);
  assert.equal(new Set(Object.values(NODE_STYLES).map(style => style.legendLabel)).size, Object.keys(NODE_STYLES).length);
  for (const label of ['Contract', 'Plugin / App', 'External I/O / Platform API']) {
    assert.ok(!Object.values(NODE_STYLES).some(style => style.legendLabel === label));
  }
});

test('the existing ECS category labels and rounded Entity/Component styles remain intact', () => {
  assert.deepEqual(Object.values(NODE_STYLES).slice(0, 10).map(style => style.label), [
    '系统', 'Observer', '实体', '组件', '共享资源', '系统私有状态', '主线程状态',
    '消息契约', '消息缓冲', '触发事件',
  ]);
  assert.equal(NODE_STYLES.entity.width, 2.2);
  assert.equal(NODE_STYLES.component.shape, NODE_STYLES.system.shape);
  assert.equal(NODE_STYLES.entity.shape, NODE_STYLES.system.shape);
});

test('edge legends use the exact English vocabulary while existing Chinese labels stay intact', () => {
  assert.deepEqual(Object.values(EDGE_STYLES).map(style => style.legendLabel), [
    'Schedule order', 'Explicit ordering', 'Nested schedule execution', 'Read access', 'Write / Output',
    'Message write', 'Message read', 'Event trigger', 'Observer invocation', 'State transition',
    'Reference', 'Relationship', 'SystemSet membership', 'System group membership', 'Ordering contract participation', 'Registration', 'Dependency',
  ]);
  assert.deepEqual(Object.values(EDGE_STYLES).map(style => style.label), [
    'Schedule 先后', '显式执行依赖', '内部调度', '读取：数据 → 系统', '修改：系统 → 数据',
    '发布：生产者 → 消息缓冲', '消费：消息缓冲 → 消费者', '发出：发起者 → 事件', '触发：事件 → Observer', '状态转换',
    '普通引用：持有者 → 目标', 'Bevy 关系：关系源 → 目标', '系统集合 → 成员系统', '系统分组 → 成员系统', '调度契约 → 参与集合', '装配方 → 注册对象', '契约使用方 → 提供方',
  ]);
});

test('every node fill blends eight percent of its semantic stroke into ninety two percent white', () => {
  for (const [type, style] of Object.entries(NODE_STYLES)) {
    for (const offset of [1, 3, 5]) {
      const stroke = Number.parseInt(style.stroke.slice(offset, offset + 2), 16);
      const fill = Number.parseInt(style.fill.slice(offset, offset + 2), 16);
      assert.equal(fill, Math.round(stroke * .08 + 255 * .92), type + '/' + offset);
    }
  }
  assert.equal(NODE_STYLES.system.fill, '#EFF3F8');
  assert.equal(NODE_STYLES.entity.fill, '#F8F1EF');
  assert.equal(NODE_STYLES.entity.stroke, '#A6533B');
  assert.equal(selectedFillColor(NODE_STYLES.entity.stroke), '#EBD9D4');
  assert.equal(NODE_STYLES.system.shape, 'rounded');
  assert.equal(NODE_STYLES.entity.shape, NODE_STYLES.system.shape);
  assert.equal(NODE_STYLES.component.shape, NODE_STYLES.system.shape);
  assert.equal(NODE_STYLES.message.fill, NODE_STYLES.message_buffer.fill);
});

test('business graphs and guide samples receive the same pale native shape and semantic edge definitions', () => {
  const definitions = mermaidStyleDefinitions(Object.keys(NODE_STYLES), Object.keys(EDGE_STYLES));
  for (const [type, style] of Object.entries(NODE_STYLES)) {
    assert.ok(definitions.includes(`classDef node_${type} fill:${style.fill},stroke:${style.stroke},stroke-width:${style.width}px,color:#1F3340`));
  }
  for (const [semantic, style] of Object.entries(EDGE_STYLES)) {
    assert.ok(definitions.includes(`classDef edge_${semantic} stroke:${style.stroke},stroke-width:${style.width}px${style.dash ? `,stroke-dasharray:${style.dash}` : ''}`));
  }
  assert.ok(definitions.includes(`classDef external_node stroke-dasharray:${EXTERNAL_REFERENCE_STYLE.dash}`));
});

test('selection and external reference conventions share one catalog without changing normal semantic fills', () => {
  assert.deepEqual(SELECTION_STYLE, { fillStrokeRatio: .22, strokeExtraPx: 2, ringWidthPx: 2, ringGapPx: 1, ringColor: '#2563EB', ringOpacity: .85, filterPaddingPx: 2 });
  assert.deepEqual(EXTERNAL_REFERENCE_STYLE, { dash: '6 4', description: '节点虚线边框表示外部引用', legendLabel: 'Dashed node outlines indicate external references.' });
  for (const [type, style] of Object.entries(NODE_STYLES)) {
    const selected = selectedFillColor(style.stroke);
    for (const offset of [1, 3, 5]) assert.equal(Number.parseInt(selected.slice(offset, offset + 2), 16), Math.round(Number.parseInt(style.stroke.slice(offset, offset + 2), 16) * .22 + 255 * .78), type);
    assert.notEqual(selected, style.fill, type);
  }
  assert.equal(selectedFillColor('#3567A6'), '#D3DEEB');
  assert.equal(selectedFillColor('rgb(53, 103, 166)'), '#D3DEEB');
  assert.equal(selectedFillColor('rgb(53 103 166 / 1)'), '#D3DEEB');
  assert.equal(selectedFillColor('#333'), selectedFillColor('#333333'));
  assert.equal(selectedFillColor('none'), null);
});

test('all edge meanings have distinct color, weight and dash signatures', () => {
  const signatures = new Set();
  for (const style of Object.values(EDGE_STYLES)) {
    assert.match(style.label, /\S/);
    assert.match(style.stroke, /^#[\dA-F]{6}$/);
    assert.ok(style.width > 0);
    assert.ok(style.dash === null || /^(?:\d+\s+)+\d+$/.test(style.dash));
    signatures.add([style.stroke, style.width, style.dash].join('|'));
  }
  assert.equal(signatures.size, Object.keys(EDGE_STYLES).length);
});

test('every drawn node is classified while relationship records cannot become extra business cards', () => {
  const before = JSON.stringify(model), registryBefore = JSON.stringify(registry);
  const relationIds = new Set();
  for (const node of Object.values(registry)) {
    if (NODE_KINDS[nodeKindOf(node)].visualType) assert.ok(NODE_STYLES[visualTypeOf(node)], node.id);
    else {
      relationIds.add(node.id);
      assert.ok(['Relationship', 'Entity reference'].includes(node.kind), node.id);
      assert.throws(() => visualTypeOf(node), /relationship record is not a drawable node/);
    }
  }
  assert.equal(relationIds.size, model.relationships.length);
  for (const feature of features) for (const aspect of ['systems', 'data', 'events']) {
    for (const node of architecture.graphFor(feature, aspect).nodes) {
      assert.ok(!relationIds.has(node.id), node.id);
      assert.ok(NODE_STYLES[visualTypeOf(registry[node.id])], node.id);
    }
  }
  assert.equal(JSON.stringify(model), before); assert.equal(JSON.stringify(registry), registryBefore);
  for (const kind of ['Unclassified kind', 'engine', 'Contract', undefined]) {
    assert.throws(() => visualTypeOf({ id: 'new-kind', kind }), /Unknown architecture node kind/);
  }
});

test('verified functions, sets, groups, synchronization, flow and platform cards retain distinct roles', () => {
  const cases = {
    system: ['movement', 'startup_timestep', 'inspector_pass', 'native-scrollbar-layout'],
    system_set: ['fixed-gameplay-set', 'presentation-set', 'audio-system-sets', 'time_update', 'input_update',
      'enhanced_prepare', 'enhanced_evaluate', 'input_apply', 'input_trigger', 'transform_propagate',
      'physics_prepare', 'physics_step', 'physics_writeback', 'animation_engine', 'ui-style-set',
      'egui_input', 'egui_begin', 'easing_start', 'easing_reset', 'easing_end', 'easing_apply', 'easing_tick',
      'native-ui-layout', 'native-visibility', 'kira-play-typed'],
    system_param: ['param-carry-rotation'], system_group: ['ui-volume-set', 'audio-producers'],
    observer_group: ['native-scrollbar-events'], engine_flow: ['world_spawn', 'render', 'audio-output', 'kira-output'],
    sync: ['held_apply', 'capture_apply', 'orphan_apply', 'wake_apply', 'event_apply', 'resume_apply'],
    platform_api: ['window-native-policy'], platform_event: ['native-window-events'],
    external_io: ['physics-file-log', 'log-producer', 'log-file-worker', 'log-console-worker'],
    non_send: ['non_send.NativePolicies'], local: ['local.FramePacing'], event: ['world-ready-event'],
    note: ['capture-state', 'volume-request-source'], lifecycle_note: ['first-person-lifecycle', 'state-paused'], bsn_layout: ['settings-fixed-regions'],
    operation_result: ['result-observe_move', 'result-observe_menu_previous'],
    shared_data_contract: ['physics-collision-layers'], scheduling_constraint: ['flow-audio-order'],
    app: ['app-main'], registration_helper: ['plugin-sound-events'],
  };
  for (const [expected, ids] of Object.entries(cases)) {
    for (const id of ids) assert.equal(visualTypeOf(registry[id]), expected, id);
  }
});

test('PluginGroups retain independent visuals while native callbacks keep their actual API category', () => {
  for (const id of ['plugin-UiWidgetsPlugins', 'plugin-DefaultPickingPlugins', 'plugin-DefaultPlugins', 'plugin-physics-0']) {
    const node = registry[id], before = JSON.stringify(node);
    assert.equal(node.kind, 'PluginGroup'); assert.equal(visualTypeOf(node), 'plugin_group');
    assert.equal(JSON.stringify(node), before);
  }
  for (const id of ['native_pointer_events', 'native_update_hovered']) assert.equal(visualTypeOf(registry[id]), 'system', id);
  for (const suffix of ['down', 'up', 'click', 'drag_end', 'cancel', 'key']) assert.equal(visualTypeOf(registry[`native_button_${suffix}`]), 'observer', suffix);
  for (const id of ['picking_hover', 'picking_post_hover', 'picking_last']) assert.equal(visualTypeOf(registry[id]), 'system_set', id);
  assert.equal(edgeSemanticOf({ from: 'plugin-UiWidgetsPlugins', to: 'plugin-ButtonPlugin', kind: 'registration' }, registry), 'registration');
});

test('Messages resources are buffer shapes and their communication differs from ordinary data access', () => {
  assert.equal(visualTypeOf(registry['resource.SoundRequestMessages']), 'message_buffer');
  assert.equal(visualTypeOf(registry['resource.AppTransitionMessages']), 'message_buffer');
  assert.equal(visualTypeOf(registry['resource.SoundBank']), 'resource');
  assert.equal(visualTypeOf(registry['window-messages']), 'message');
  const cases = [
    ['write-audio_strain-resource.SoundRequestMessages', 'publish'],
    ['read-resource.SoundRequestMessages-audio_play', 'consume'],
    ['read-window-messages-mouse_capture', 'consume'],
    ['write-audio_play-resource.SoundBank', 'write'],
    ['read-resource.SoundBank-audio_play', 'read'],
    ['write-log-producer-log-file-worker', 'write'],
  ];
  for (const [id, expected] of cases) assert.equal(edgeSemanticOf(model.system_links.find(link => link.id === id), registry), expected, id);
});

test('all 296 detailed links and 27 feature links are classified without changing raw contracts', () => {
  const before = JSON.stringify(model);
  assert.equal(model.system_links.length, 296);
  assert.equal(model.feature_links.length, 27);
  const counts = {};
  for (const link of [...model.system_links, ...model.feature_links]) {
    const semantic = edgeSemanticOf(link, registry);
    assert.ok(EDGE_STYLES[semantic], link.id || `${link.from} → ${link.to}`);
    assert.equal(typeof displayLabelOf(link, semantic, registry), 'string');
    counts[semantic] = (counts[semantic] || 0) + 1;
  }
  assert.equal(counts.set_membership, 18);
  assert.equal(counts.group_membership, 2);
  assert.equal(counts.constraint, 2);
  assert.equal(counts.registration, 38);
  assert.equal(counts.emit, 14);
  assert.equal(counts.observe, 28);
  assert.equal(counts.dependency, 27);
  assert.equal(counts.order, 74);
  assert.equal(counts.relationship, 18);
  assert.equal(counts.reference, 14);
  assert.equal(JSON.stringify(model), before);
});

test('trigger emission, observer dispatch, registration, set membership and scheduling constraints stay distinct', () => {
  const cases = [
    ['trigger-world_spawn-world-ready-event', 'emit'],
    ['observer-observe_move', 'observe'],
    ['registration-ui-volume-set-menu_volume_pointer', 'group_membership'],
    ['registration-fixed-gameplay-set-movement', 'set_membership'],
    ['registration-flow-audio-order-ui-style-set', 'constraint'],
    ['registration-plugin-GameAudioPlugin-plugin-kira', 'registration'],
    ['registration-plugin-sound-events-audio_strain', 'registration'],
  ];
  for (const [id, expected] of cases) assert.equal(edgeSemanticOf(model.system_links.find(link => link.id === id), registry), expected, id);
});

test('unclassified kinds, triggers and registration roles fail instead of falling back to a gray edge', () => {
  const base = { id: 'invalid', from: 'movement', to: 'gravity' };
  assert.throws(() => edgeSemanticOf({ ...base, kind: 'new-edge' }, registry), /Unknown architecture edge kind/);
  assert.throws(() => edgeSemanticOf({ ...base, kind: 'trigger' }, registry), /no event\/Observer contract/);
  assert.throws(() => edgeSemanticOf({ ...base, kind: 'registration' }, registry), /registration source is not classified/);
  assert.throws(() => edgeSemanticOf({ ...base, from: 'missing', kind: 'read' }, registry), /endpoint missing/);
  assert.throws(() => displayLabelOf(base, 'new-edge', registry), /Unknown architecture edge semantic/);
});

test('edge labels contain contract names and domain conditions rather than repeated relation categories', () => {
  const cases = [
    ['R 设置', 'read', '设置'], ['R / W 守卫', 'write', '守卫'], ['W MenuHover', 'publish', 'MenuHover'],
    ['读取', 'consume', ''], ['W', 'write', ''], ['触发', 'emit', ''], ['chain', 'order', ''], ['after', 'order', ''],
    ['chain / Commands', 'order', 'Commands'], ['after(Writeback)', 'order', 'Writeback'], ['after StepSimulation', 'order', 'StepSimulation'],
    ['Build →', 'order', 'Build'], ['Pointer → Style', 'order', 'Pointer → Style'],
    ['读取 PrototypeConfig', 'dependency', 'PrototypeConfig'], ['使用 Avian 身体与碰撞层', 'dependency', 'Avian 身体与碰撞层'],
    ['写入 / 结构变更（待核实）', 'write', '结构变更（待核实）'],
    ['发布 SoundRequest', 'dependency', 'SoundRequest'], ['消费交互请求', 'read', '交互请求'],
    ['先安装 Egui', 'registration', 'Egui'], ['显式安装', 'registration', ''],
    ['禁用默认 LogPlugin / AudioPlugin', 'registration', '禁用默认 LogPlugin / AudioPlugin'],
    ['ChildOf 层级', 'relationship', 'ChildOf 层级'], ['HeldBy', 'relationship', 'HeldBy'],
    ['落水时解除持握', 'read', '落水时解除持握'], ['保存成功后应用', 'write', '保存成功后应用'],
    ['Fire<MoveAction>', 'observe', 'Fire<MoveAction>'], ['进入 PlayState::Paused', 'transition', '进入 PlayState::Paused'],
  ];
  for (const [label, semantic, expected] of cases) assert.equal(displayLabelOf({ label }, semantic, registry), expected, label);
});

test('relationships keep their source direction, cardinality and lifecycle details out of visual inference', () => {
  const heldBy = model.system_links.find(link => link.id === 'held_by');
  assert.equal(edgeSemanticOf(heldBy, registry), 'relationship');
  assert.equal(heldBy.from, 'entity-parcel');
  assert.equal(heldBy.to, 'entity-character');
  assert.equal(displayLabelOf(heldBy, 'relationship', registry), 'HeldBy');
  assert.equal(registry.held_by.linked_spawn, false);
  assert.match(registry.held_by.cardinality, /0\.\.N/);
  assert.equal(registry.character_visual_child.linked_spawn, true);
  assert.equal(displayLabelOf(model.system_links.find(link => link.id === 'menu_page_hierarchy'), 'relationship', registry), 'ChildOf 层级');
});

test('Schedule arrows connect visible main phases in order and only nest Egui within PostUpdate', () => {
  const original = JSON.stringify(model.schedule_groups);
  const links = scheduleLinksFor([...model.schedule_groups].reverse());
  const main = links.filter(link => link.edgeSemantic === 'schedule');
  const chain = [main[0].from, ...main.map(link => link.to)];
  assert.deepEqual(chain, ['Startup', 'First', 'PreUpdate', 'StateTransition', 'FixedFirst', 'FixedUpdate', 'FixedPostUpdate', 'FixedLast', 'RunFixedMainLoop.AfterFixedMainLoop', 'Update', 'SpawnScene', 'PostUpdate']);
  assert.deepEqual(links.filter(link => link.edgeSemantic === 'nested'), [{ id: 'nested-PostUpdate-EguiPrimaryContextPass', from: 'PostUpdate', to: 'EguiPrimaryContextPass', edgeSemantic: 'nested', displayLabel: '' }]);
  assert.ok(links.every(link => link.displayLabel === '' && !link.mermaidId));
  assert.equal(JSON.stringify(model.schedule_groups), original);
  for (const excluded of ['ApplicationLifecycle', 'RenderApp', 'NativePlatformEvents', 'EventTriggered', 'Explanatory']) assert.ok(links.every(link => link.from !== excluded && link.to !== excluded), excluded);
});

test('Schedule navigation skips absent groups and never adds hidden containers or loop labels', () => {
  const select = (...ids) => model.schedule_groups.filter(group => ids.includes(group.id));
  assert.deepEqual(scheduleLinksFor([]), []);
  assert.deepEqual(scheduleLinksFor(select('EguiPrimaryContextPass')), []);
  assert.deepEqual(scheduleLinksFor(select('Startup')), []);
  assert.deepEqual(scheduleLinksFor(select('FixedUpdate', 'Update')), [{ id: 'schedule-FixedUpdate-Update', from: 'FixedUpdate', to: 'Update', edgeSemantic: 'schedule', displayLabel: '' }]);
  assert.throws(() => scheduleLinksFor([model.schedule_groups[1], model.schedule_groups[1]]), /Duplicate Schedule group/);
  for (const feature of features) {
    const graph = architecture.graphFor(feature, 'systems');
    const groups = architecture.scheduleGroups(graph);
    const ids = new Set(groups.map(group => group.id));
    assert.ok(scheduleLinksFor(groups).every(link => ids.has(link.from) && ids.has(link.to) && link.displayLabel === ''));
  }
});

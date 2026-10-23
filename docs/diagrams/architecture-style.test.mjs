import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildArchitectureModel } from './architecture-model.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, ENTITY_TOGGLE_STYLE, entityToggleBounds, EXTERNAL_REFERENCE_STYLE, selectedFillColor, visualTypeOf, edgeSemanticOf, displayLabelOf, scheduleLinksFor, mermaidStyleDefinitions } from './architecture-style.mjs';

const model = JSON.parse(fs.readFileSync(new URL('./ecs-data.json', import.meta.url), 'utf8'));
const architecture = buildArchitectureModel(model);
const registry = architecture.registry;
const features = [...architecture.features, ...architecture.infrastructureFeatures].map(feature => feature.id);

test('Entity corner controls use the shared twenty four unit square with eight unit insets', () => {
  assert.deepEqual(ENTITY_TOGGLE_STYLE, { size: 24, inset: 8 });
  assert.deepEqual(entityToggleBounds({ x: -50, y: 20, width: 200, height: 160 }), { x: 118, y: 28, width: 24, height: 24 });
});

test('the fourteen node types use a distinct shape and color combination', () => {
  assert.equal(Object.keys(NODE_STYLES).length, 14);
  const signatures = new Set();
  for (const style of Object.values(NODE_STYLES)) {
    assert.match(style.label, /\S/);
    assert.match(style.shape, /^[a-z-]+$/);
    assert.match(style.fill, /^#[\dA-F]{6}$/);
    assert.match(style.stroke, /^#[\dA-F]{6}$/);
    assert.ok(style.width > 0);
    signatures.add([style.shape, style.fill, style.stroke].join('|'));
  }
  assert.equal(signatures.size, 14);
});

test('node legends use the exact English vocabulary while existing Chinese labels stay intact', () => {
  assert.deepEqual(Object.values(NODE_STYLES).map(style => style.legendLabel), [
    'System', 'Observer', 'Entity', 'Component', 'Resource', 'Local<T>', 'NonSend<T>',
    'Message', 'Messages<T>', 'EntityEvent', 'Plugin / App', 'Contract', 'External I/O / Platform API', 'Note',
  ]);
  assert.deepEqual(Object.values(NODE_STYLES).map(style => style.label), [
    '系统', 'Observer', '实体', '组件', '共享资源', '系统私有状态', '主线程状态',
    '消息契约', '消息缓冲', '触发事件', '插件与装配', '集合与公开契约', '外部 I/O', '说明与结果摘要',
  ]);
});

test('edge legends use the exact English vocabulary while existing Chinese labels stay intact', () => {
  assert.deepEqual(Object.values(EDGE_STYLES).map(style => style.legendLabel), [
    'Schedule order', 'Explicit ordering', 'Nested schedule execution', 'Read access', 'Write / Output',
    'Message write', 'Message read', 'Event trigger', 'Observer invocation', 'State transition',
    'Reference', 'Relationship', 'SystemSet / group membership', 'Ordering contract participation', 'Registration', 'Dependency',
  ]);
  assert.deepEqual(Object.values(EDGE_STYLES).map(style => style.label), [
    'Schedule 先后', '显式执行依赖', '内部调度', '读取：数据 → 系统', '修改：系统 → 数据',
    '发布：生产者 → 消息缓冲', '消费：消息缓冲 → 消费者', '发出：发起者 → 事件', '触发：事件 → Observer', '状态转换',
    '普通引用：持有者 → 目标', 'Bevy 关系：关系源 → 目标', '集合 → 成员系统', '调度契约 → 参与集合', '装配方 → 注册对象', '契约使用方 → 提供方',
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
  assert.equal(NODE_STYLES.entity.shape, 'rect', 'Standalone Entity, folded Entity, expanded container and legend share the native rectangle');
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

test('all sixteen edge meanings have distinct color, weight and dash signatures', () => {
  assert.equal(Object.keys(EDGE_STYLES).length, 16);
  const signatures = new Set();
  for (const style of Object.values(EDGE_STYLES)) {
    assert.match(style.label, /\S/);
    assert.match(style.stroke, /^#[\dA-F]{6}$/);
    assert.ok(style.width > 0);
    assert.ok(style.dash === null || /^(?:\d+\s+)+\d+$/.test(style.dash));
    signatures.add([style.stroke, style.width, style.dash].join('|'));
  }
  assert.equal(signatures.size, 16);
});

test('every registered and rendered node has an explicit visual type without changing its identity', () => {
  const before = JSON.stringify(model);
  for (const node of Object.values(registry)) assert.ok(NODE_STYLES[visualTypeOf(node)], node.id);
  for (const feature of features) for (const aspect of ['systems', 'data', 'events']) {
    for (const node of architecture.graphFor(feature, aspect).nodes) assert.ok(NODE_STYLES[visualTypeOf(registry[node.id])], node.id);
  }
  assert.equal(JSON.stringify(model), before);
  assert.throws(() => visualTypeOf({ id: 'new-kind', kind: 'Unclassified kind' }), /Unknown architecture node kind/);
  assert.throws(() => visualTypeOf({ id: 'new-kind' }), /Unknown architecture node kind/);
});

test('systems, scheduling contracts, event observers and external callbacks retain different roles', () => {
  for (const id of ['movement', 'startup_timestep', 'world_spawn', 'inspector_pass']) assert.equal(visualTypeOf(registry[id]), 'system', id);
  for (const id of ['time_update', 'input_update', 'physics_step', 'animation_engine', 'held_apply', 'ui-style-set', 'param-carry-rotation']) assert.equal(visualTypeOf(registry[id]), 'contract', id);
  assert.equal(visualTypeOf(registry['native-scrollbar-events']), 'observer');
  for (const id of ['native-window-events', 'window-native-policy', 'log-file-worker', 'kira-output']) assert.equal(visualTypeOf(registry[id]), 'external_io', id);
  assert.equal(visualTypeOf(registry['non_send.NativePolicies']), 'non_send');
  assert.equal(visualTypeOf(registry['local.FramePacing']), 'local');
  assert.equal(visualTypeOf(registry['world-ready-event']), 'event');
  assert.equal(visualTypeOf(registry['state-paused']), 'note');
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

test('all 233 detailed links and 27 feature links are classified without changing raw contracts', () => {
  const before = JSON.stringify(model);
  assert.equal(model.system_links.length, 233);
  assert.equal(model.feature_links.length, 27);
  const counts = {};
  for (const link of [...model.system_links, ...model.feature_links]) {
    const semantic = edgeSemanticOf(link, registry);
    assert.ok(EDGE_STYLES[semantic], link.id || `${link.from} → ${link.to}`);
    assert.equal(typeof displayLabelOf(link, semantic, registry), 'string');
    counts[semantic] = (counts[semantic] || 0) + 1;
  }
  assert.equal(counts.membership, 18);
  assert.equal(counts.constraint, 2);
  assert.equal(counts.registration, 25);
  assert.equal(counts.emit, 1);
  assert.equal(counts.observe, 20);
  assert.equal(counts.dependency, 27);
  assert.equal(counts.order, 66);
  assert.equal(counts.relationship, 18);
  assert.equal(counts.reference, 14);
  assert.equal(JSON.stringify(model), before);
});

test('trigger emission, observer dispatch, registration, set membership and scheduling constraints stay distinct', () => {
  const cases = [
    ['trigger-world_spawn-world-ready-event', 'emit'],
    ['observer-observe_move', 'observe'],
    ['registration-ui-volume-set-menu_volume_pointer', 'membership'],
    ['registration-fixed-gameplay-set-movement', 'membership'],
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

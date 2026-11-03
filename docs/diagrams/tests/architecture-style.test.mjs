import assert from 'node:assert/strict';
import test from 'node:test';
import { NODE_KINDS, nodeKindOf } from '../src/architecture-kinds.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, EXTERNAL_REFERENCE_STYLE, selectedFillColor, visualTypeOf, edgeSemanticOf, displayLabelOf, scheduleLinksFor, mermaidStyleDefinitions } from '../src/architecture-style.mjs';

const registry = { movement: { kind: 'System' }, gravity: { kind: 'Resource' } };

const approvedStyles = {
  system: ['System', 'rounded', '#3567A6'], observer: ['Observer', 'hex', '#7B4DB2'],
  entity: ['Entity', 'rounded', '#A6533B'], component: ['Component', 'rounded', '#4B8060'],
  resource: ['Resource', 'cyl', '#A5792C'], local: ['Local<T>', 'notch-rect', '#AA8752'],
  non_send: ['NonSend<T>', 'tag-rect', '#A5633A'], message: ['Message', 'lean-r', '#247B91'],
  message_buffer: ['Messages<T>', 'cyl', '#247B91'], event: ['Event / EntityEvent', 'stadium', '#B66B2D'],
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
    '发布：生产者 → 消息缓冲', '消费：消息缓冲 → 消费者', '发出：发起者 → 事件', '触发：来源 → Observer', '状态转换',
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

test('unclassified kinds, triggers and registration roles fail instead of falling back to a gray edge', () => {
  const base = { id: 'invalid', from: 'movement', to: 'gravity' };
  assert.throws(() => edgeSemanticOf({ ...base, kind: 'new-edge' }, registry), /Unknown architecture edge kind/);
  assert.throws(() => edgeSemanticOf({ ...base, kind: 'trigger' }, registry), /no event\/Observer contract/);
  assert.throws(() => edgeSemanticOf({ ...base, kind: 'registration' }, registry), /registration source is not classified/);
  assert.throws(() => edgeSemanticOf({ ...base, from: 'missing', kind: 'read' }, registry), /endpoint missing/);
  assert.throws(() => displayLabelOf(base, 'new-edge', registry), /Unknown architecture edge semantic/);
});

test('only source-backed Schedule contexts classify Engine flow registration edges', () => {
  const records = { schedule: { kind: 'Engine flow', scheduleEvidence: { kind: 'schedule' } }, system: { kind: 'System' } };
  const link = { id: 'schedule-registration', from: 'schedule', to: 'system', kind: 'registration', scheduleEvidence: { relations: [{ relation: 'registration' }] } };
  assert.equal(edgeSemanticOf(link, records), 'registration');
  assert.throws(() => edgeSemanticOf({ ...link, scheduleEvidence: null }, records), /registration source is not classified/);
  assert.throws(() => edgeSemanticOf(link, { ...records, schedule: { kind: 'Engine flow' } }), /registration source is not classified/);
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

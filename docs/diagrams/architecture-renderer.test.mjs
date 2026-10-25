import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildArchitectureModel, isMainPluginRegistration } from './architecture-model.mjs';
import { renderGraphView, renderOverview, mermaidConfiguration, entityComponentColumns, dataLayoutColumns, dataObserverLayoutPairs } from './architecture-renderer.mjs';
import { NODE_STYLES, EDGE_STYLES, EXTERNAL_REFERENCE_STYLE } from './architecture-style.mjs';
import { INFRASTRUCTURE_FEATURES } from './architecture-infrastructure.mjs';

const model = JSON.parse(fs.readFileSync(new URL('./ecs-data.json', import.meta.url), 'utf8'));
const architecture = buildArchitectureModel(model);
const featureIds = [...architecture.features, ...INFRASTRUCTURE_FEATURES].map(feature => feature.id);

test('Component views rank every native relation System to Component to Entity without changing business direction', () => {
  const registry = {
    entity: { kind: 'Entity', name: 'Entity', description: 'owner', feature: 'test' },
    component: { kind: 'Component', name: 'Component', description: 'data', feature: 'test' },
    system: { kind: 'system', name: 'System', description: 'behavior', feature: 'test' },
  };
  const graph = { componentNodeId: 'component', nodes: Object.keys(registry).map(id => ({ id, role: 'internal' })), links: [
    { id: 'owner', from: 'component', to: 'entity', kind: 'reference' },
    { id: 'read', from: 'component', to: 'system', kind: 'read' },
    { id: 'write', from: 'system', to: 'component', kind: 'write' },
  ] };
  const before = JSON.stringify(graph), view = renderGraphView({ id: 'component-test', aspect: 'component', label: 'Component', summary: 'relations' }, graph, registry, []);
  assert.equal(JSON.stringify(graph), before);
  assert.deepEqual(view.links.map(({ from, to, nativeReverse }) => [from, to, nativeReverse]), [['component', 'entity', undefined], ['component', 'system', true], ['system', 'component', undefined]]);
  assert.match(view.mermaid, /n2 e1@--- n1/); assert.match(view.mermaid, /n2 e2@--> n1/); assert.match(view.mermaid, /n1 e0@--> n0/);
  const config = JSON.parse(/^---\n([\s\S]*?)\n---/.exec(view.mermaid)[1]).config;
  assert.match(config.themeCSS, /#component-test-e1\{marker-start:url\(#component-test_flowchart-v2-pointStart\)!important\}/);
  assert.match(config.themeCSS, /fill:context-stroke!important;stroke:context-stroke!important/);
  const enriched = renderGraphView({ id: 'component-details', aspect: 'component', componentNodeId: 'component', componentDetails: { name: 'Component<f32>', description: 'all owners', display_summary: '完整类型用途' }, label: 'Component', summary: 'relations' }, graph, registry, []);
  assert.equal(enriched.nodes.find(node => node.id === 'component').nameLabel, 'Component<f32>');
  assert.equal(enriched.nodes.find(node => node.id === 'component').contextLabel[0], '完整类型用途');
  assert.equal(enriched.nodes.find(node => node.id === 'system').nameLabel, 'System');
  assert.equal(registry.component.name, 'Component');
});
function viewFor(feature, aspect) {
  const graph = architecture.graphFor(feature, aspect);
  return renderGraphView({ id: `${feature}-${aspect}`, feature, aspect, label: '测试', summary: '测试' }, graph, architecture.registry, architecture.features, aspect === 'systems' ? architecture.scheduleGroups(graph) : []);
}

function isolatedView(record, { role = 'internal', aspect = 'data' } = {}) {
  const graph = { nodes: [{ id: record.id, role }], links: [] };
  const groups = aspect === 'systems' ? [{ id: 'Update', label: 'Update', order: 90, track: 'frame', nodes: graph.nodes }] : [];
  return renderGraphView({ id: 'isolated-test', feature: 'first_person', aspect, label: '测试', summary: '测试' }, graph, { [record.id]: record }, architecture.features, groups);
}

test('all relationships share one Mermaid declaration per canonical node without dropping any edge', () => {
  for (const feature of featureIds) for (const aspect of ['systems', 'data', 'events']) {
    const graph = architecture.graphFor(feature, aspect), view = viewFor(feature, aspect);
    assert.deepEqual(view.nodes.map(node => node.id), graph.nodes.map(node => node.id));
    assert.deepEqual(view.links.map(link => link.id), graph.links.map(link => link.id));
    assert.equal(new Set(view.nodes.map(node => node.id)).size, view.nodes.length);
    assert.equal((view.mermaid?.match(/^  (?:n\d+@\{|subgraph n\d+\[)/gm) || []).length, graph.nodes.length);
    assert.equal((view.mermaid?.match(/^  n\d+ e\d+@/gm) || []).length, graph.links.length);
  }
});

test('logging Mermaid shows one asynchronous file pipeline and keeps the physical plugin at its tracing boundary', () => {
  const session = viewFor('session_log', 'events');
  const ids = ['collision_log', 'log-producer', 'log-file-worker', 'log-console-worker', 'physics-file-log'];
  for (const id of ids) {
    const nodes = session.nodes.filter(node => node.id === id);
    assert.equal(nodes.length, 1, id);
    assert.equal((session.mermaid.match(new RegExp(`^  ${nodes[0].mermaidId}@\\{`, 'gm')) || []).length, 1, id);
  }
  const file = session.nodes.find(node => node.id === 'physics-file-log');
  assert.equal(file.nameLabel, '会话日志文件');
  assert.equal(file.visualType, 'external_io');
  assert.equal(file.role, 'internal');
  for (const [from, to] of [['collision_log', 'log-producer'], ['log-producer', 'log-file-worker'], ['log-producer', 'log-console-worker'], ['log-file-worker', 'physics-file-log']]) {
    const link = session.links.find(link => link.kind === 'write' && link.from === from && link.to === to);
    assert.ok(link, `${from} → ${to}`);
    assert.equal(link.edgeSemantic, 'write');
    const source = session.nodes.find(node => node.id === from), target = session.nodes.find(node => node.id === to);
    assert.ok(session.mermaid.includes(`  ${source.mermaidId} ${link.mermaidId}@-->|"${link.displayLabel}"| ${target.mermaidId}\n`), `${from} → ${to}`);
  }
  assert.ok(!session.links.some(link => link.id === 'write-collision_log-physics-file-log'));
  assert.deepEqual(session.links.filter(link => link.kind === 'write' && link.to === file.id).map(link => link.from), ['log-file-worker']);
  const physics = viewFor('physics', 'events');
  const producer = physics.nodes.find(node => node.id === 'log-producer');
  assert.equal(producer.role, 'external');
  assert.ok(physics.mermaid.includes(`class ${producer.mermaidId} external_node`));
  assert.deepEqual(physics.links.filter(link => link.kind === 'write' && link.from === 'collision_log').map(link => link.to), ['log-producer']);
  for (const id of ['physics-file-log', 'log-file-worker', 'log-console-worker']) assert.ok(!physics.nodes.some(node => node.id === id), id);
  assert.doesNotMatch(physics.mermaid, /\*\*(?:会话日志文件|File worker|Console worker)\*\*/);
});

test('systems retain true dependencies and keep layout links outside the semantic relation list', () => {
  const graph = architecture.graphFor('character', 'systems'), view = viewFor('character', 'systems');
  assert.match(view.mermaid, /subgraph diagram_main\[" "\]\n  direction LR/);
  assert.deepEqual(view.links.map(({ mermaidId, edgeSemantic, displayLabel, ...link }) => link), graph.links);
  assert.ok(view.layoutLinks.length);
  assert.ok(view.layoutLinks.every(link => link.mermaidId.startsWith('layout_')));
  assert.ok(view.nodes.some(node => node.id === 'grounded_fixed'));
  assert.ok(view.nodes.some(node => node.id === 'grounded_after'));
});

test('log_policy begins with its full name and purpose without a type header or repeated Startup', () => {
  const view = viewFor('window_policy', 'systems');
  const node = view.nodes.find(node => architecture.registry[node.id].name === 'log_policy');
  assert.ok(node);
  const record = architecture.registry[node.id];
  assert.equal(node.displayLabel, 'log_policy\n' + (record.display_summary ?? record.description));
  assert.equal(node.contextLabel.length, 1);
  assert.equal(node.shape, 'rounded');
  assert.equal(node.visualType, 'system');
  assert.match(view.mermaid, new RegExp(node.mermaidId + '@\\{ shape: rounded, label: "\\*\\*log_policy\\*\\*<br/>'));
});

test('cards show a full name and one purpose while all technical detail stays unchanged in the registry', () => {
  const record = {
    id: 'long-system', kind: 'system', feature: 'first_person',
    name: 'very_long_system_' + 'character_facing_'.repeat(12),
    display_summary: '同步角色朝向与观察方向。',
    description: '完整说明保留内部实现、所有数据访问和生命周期约束，不用卡片摘要覆盖。',
    reads: ['hidden-read'], writes: ['hidden-write'], schedule: 'Update',
    registrations: [{ schedule: 'Update', run_if: ['hidden_condition'] }, { schedule: 'Startup' }],
    fields: ['hidden-field'], notes: ['hidden-note'], source: { path: 'src/first_person/facing.rs', line: 1 },
  };
  const original = structuredClone(record), view = isolatedView(record, { aspect: 'systems' }), node = view.nodes[0];
  assert.equal(node.nameLabel, record.name);
  assert.deepEqual(node.contextLabel, [record.display_summary]);
  assert.equal(node.displayLabel, `${record.name}\n${record.display_summary}`);
  const declaration = view.mermaid.split('\n').find(line => line.startsWith('  n0@{'));
  assert.ok(declaration.replace(/\*\*|<br\/>/g, '').includes(record.name));
  assert.doesNotMatch(declaration, /…|hidden-|hidden_condition|另有注册|R \d|W \d/);
  assert.deepEqual(record, original);
});

test('purpose fallback stays complete and external components retain only their provider context', () => {
  const description = '保存角色在画面中呈现的姿态，供相机跟随、动画和显示同步共同使用，并保持角色业务身份与物理状态的边界。';
  const record = { id: 'character.Transform', kind: 'Component', feature: 'infrastructure', name: 'Transform', owner: '角色业务根实体', description };
  const view = isolatedView(record, { role: 'external' }), node = view.nodes[0];
  assert.deepEqual(node.contextLabel, [`来自Bevy 引擎 ↗：${description}`]);
  assert.equal(node.displayLabel, `Transform\n${node.contextLabel[0]}`);
  assert.doesNotMatch(node.displayLabel, /…|所属实体 ·/);
  assert.ok(view.mermaid.includes('class n0 external_node'));
  assert.throws(() => isolatedView({ id: 'missing-purpose', kind: 'system', feature: 'first_person', name: 'empty' }), /缺少用途简介/);
});

test('defined display summaries must be nonempty strings rather than silently coercing invalid values', () => {
  const record = { id: 'summary-contract', kind: 'system', feature: 'first_person', name: 'sample', description: '提供完整的用途说明。' };
  for (const display_summary of [null, 0, 42, false, {}, [], '', ' \t\n ']) {
    assert.throws(() => isolatedView({ ...record, display_summary }), /用途简介必须是非空文本/);
  }
  assert.deepEqual(isolatedView(record).nodes[0].contextLabel, [record.description]);
  assert.deepEqual(isolatedView({ ...record, display_summary: '简洁用途。' }).nodes[0].contextLabel, ['简洁用途。']);
});

test('every rendered card has only its complete name and a single purpose paragraph', () => {
  const original = JSON.stringify(architecture.registry);
  for (const feature of featureIds) for (const aspect of ['systems', 'data', 'events']) {
    const view = viewFor(feature, aspect);
    for (const node of view.nodes) {
      assert.equal(node.nameLabel, architecture.registry[node.id].name);
      assert.equal(node.contextLabel.length, 1, view.id + '/' + node.id);
      assert.equal(node.displayLabel, node.nameLabel + '\n' + node.contextLabel[0]);
      assert.ok(node.contextLabel[0].includes(architecture.registry[node.id].display_summary ?? architecture.registry[node.id].description));
    }
  }
  assert.equal(JSON.stringify(architecture.registry), original);
});

test('数据图没有Entity开合与嵌套组件，但真实关系和普通Entity身份完整保留', () => {
  for (const feature of featureIds) {
    const view = viewFor(feature, 'data'), graph = architecture.graphFor(feature, 'data');
    assert.ok(!Object.hasOwn(view, 'entityViews'));
    assert.deepEqual(view.entityGroups, []);
    assert.ok(view.nodes.every(node => !node.entityToggle && !node.presentation));
    assert.doesNotMatch(view.mermaid || '', /subgraph n\d+\[|eh\d+@/);
    assert.deepEqual(view.links.map(link => [link.id, link.from, link.to, link.displayFrom, link.displayTo]), graph.links.map(link => [link.id, link.from, link.to, link.displayFrom, link.displayTo]));
    for (const node of view.nodes.filter(node => ['entity', 'component'].includes(node.visualType))) assert.equal(node.shape, NODE_STYLES.system.shape);
  }
});

test('dense component columns are balanced, ordered and bounded to four columns', () => {
  for (const size of [0, 1, 6, 7, 12, 13, 24, 25, 34, 50]) {
    const ids = Array.from({ length: size }, (_, index) => `component-${index}`), columns = entityComponentColumns(ids);
    assert.equal(columns.length, Math.min(4, Math.ceil(size / 6)));
    assert.deepEqual(columns.flat(), ids);
    if (size) assert.ok(Math.max(...columns.map(column => column.length)) - Math.min(...columns.map(column => column.length)) <= 1);
  }
});

test('catalog columns balance whole Entity groups by their displayed rows rather than splitting their cards', () => {
  const units = [...Array.from({ length: 20 }, (_, index) => ({ id: `resource-${index}` })),
    ...Array.from({ length: 12 }, (_, index) => ({ id: `entity-${index}`, components: Array.from({ length: 6 }, (_, c) => `${index}-${c}`) }))];
  const columns = dataLayoutColumns(units);
  assert.equal(columns.length, 3);
  assert.equal(new Set(columns.flat()).size, units.length);
  assert.deepEqual(columns.flat().map(unit => unit.id).sort(), units.map(unit => unit.id).sort());
  assert.ok(columns.every(column => column.filter(unit => unit.components).length === 4));
});

test('Observer fan-in layout preserves source order, leaves independent targets alone and adds no dependency cycles', () => {
  const nodes = ['a', 'b', 'c', 'independent'].map(id => ({ id, visualType: 'observer' }));
  const links = [
    { from: 'a', to: 'resource-first' }, { from: 'b', to: 'resource-first' },
    { from: 'b', to: 'resource-second' }, { from: 'c', to: 'resource-second' },
    { from: 'independent', to: 'resource-third' },
  ];
  const original = structuredClone({ nodes, links });
  assert.deepEqual(dataObserverLayoutPairs(nodes, links), [['a', 'b'], ['b', 'c']]);
  assert.deepEqual({ nodes, links }, original);
  assert.deepEqual(dataObserverLayoutPairs(nodes, [...links, { from: 'b', to: 'a' }]), [['b', 'c']], 'Existing semantic reachability already positions those peers');
  assert.deepEqual(dataObserverLayoutPairs(nodes, [...links, { from: 'c', to: 'a' }]), [['a', 'b']], 'A later invisible pair cannot close a cycle through an earlier pair');
});

test('组件完整用途保留在注册表，事件页组件不增加实体容器', () => {
  assert.equal(architecture.registry['model_node.AnimatedBy'].display_summary, '关联负责采样当前节点动画的播放器。');
  for (const feature of featureIds) for (const node of viewFor(feature, 'events').nodes.filter(node => node.visualType === 'component')) assert.ok(!node.contextLabel[0].includes(architecture.registry[node.id].owner + '：'));
});

test('App overview cards preserve complete system names and responsibilities', () => {
  const id = 'frame_limit', description = '等待本帧剩余时间并更新本地计时状态。'.repeat(8);
  const registry = { ...architecture.registry, [id]: { ...architecture.registry[id], description, display_summary: undefined } };
  const view = renderOverview(model, registry, architecture.features);
  const node = view.nodes.find(item => item.id === id);
  assert.equal(node.nameLabel, registry[id].name);
  assert.deepEqual(node.contextLabel, [description]);
  assert.equal(node.displayLabel, node.nameLabel + '\n' + description);
  assert.doesNotMatch(node.displayLabel, /…/);
});

test('App overview reuses canonical system summaries without rewriting full descriptions', () => {
  const id = 'frame_limit';
  const registry = { ...architecture.registry, [id]: { ...architecture.registry[id], display_summary: '等待本帧剩余时间。' } };
  const description = registry[id].description;
  const view = renderOverview(model, registry, architecture.features), node = view.nodes.find(item => item.id === id);
  assert.equal(node.nameLabel, registry[id].name);
  assert.deepEqual(node.contextLabel, [registry[id].display_summary]);
  assert.equal(registry[id].description, description);
});

test('standalone Mermaid carries the same typography, spacing, light containers and semantic styles', () => {
  for (const aspect of ['systems', 'data', 'events']) {
    const view = viewFor('first_person', aspect);
    const config = JSON.parse(/^---\n([\s\S]*?)\n---/.exec(view.mermaid)[1]).config;
    assert.deepEqual(config, mermaidConfiguration(aspect));
    assert.equal(config.htmlLabels, false);
    assert.equal(config.themeVariables.fontSize, '14px');
    assert.equal(config.themeVariables.clusterBkg, '#F8FAFC');
    assert.equal(config.themeVariables.clusterBorder, '#DDE4ED');
    assert.equal(config.themeVariables.edgeLabelBackground, '#FFFFFF');
    assert.deepEqual([config.flowchart.nodeSpacing, config.flowchart.rankSpacing, config.flowchart.padding, config.flowchart.wrappingWidth, config.flowchart.minNodeWidth], [32, aspect === 'data' ? 8 : 56, 16, 280, 180]);
    assert.equal(config.layout, 'dagre');
    assert.match(view.mermaid, /label: "\*\*[^\n]+?\*\*<br\/>/);
    for (const node of view.nodes) {
      const style = NODE_STYLES[node.visualType];
      assert.ok(view.mermaid.includes(`classDef node_${node.visualType} fill:${style.fill},stroke:${style.stroke},stroke-width:${style.width}px,color:#1F3340`));
    }
  }
});

test('data uses compact native top-level groups while overview and events use Dagre LR', () => {
  const data = viewFor('avian', 'data');
  for (const view of [data]) {
    assert.match(view.mermaid, /^flowchart TB$/m);
    assert.doesNotMatch(view.mermaid, /diagram_main/);
    for (const group of ['catalog', 'relations', 'column_0', 'relation_0']) assert.match(view.mermaid, new RegExp(`subgraph ${group}\\[`));
  }
  for (const view of [viewFor('ui', 'events'), renderOverview(model, architecture.registry, architecture.features)]) {
    assert.match(view.mermaid, /^flowchart LR$/m);
    assert.equal(JSON.parse(/^---\n([\s\S]*?)\n---/.exec(view.mermaid)[1]).config.layout, 'dagre');
    assert.match(view.mermaid, /subgraph diagram_main\[" "\]\n  direction LR/);
  }
});

test('all native node shapes and visible edge styles come from the shared semantic catalog', () => {
  for (const aspect of ['systems', 'data', 'events']) {
    const view = viewFor('first_person', aspect);
    for (const node of view.nodes) {
      assert.equal(node.shape, node.presentation === 'entity-container' ? 'rect' : NODE_STYLES[node.visualType].shape);
      assert.equal(node.displayLabel.split('\n')[0], architecture.registry[node.id].name);
      if (node.visualType === 'component' && architecture.registry[node.id].owner) assert.ok(!node.contextLabel[0].startsWith(architecture.registry[node.id].owner + '：'));
      if (node.role === 'external') assert.ok(node.displayLabel.includes('来自'));
    }
    for (const link of [...view.links, ...view.scheduleLinks]) assert.ok(EDGE_STYLES[link.edgeSemantic]);
  }
});

test('Schedule arrows connect container identities and keep fixed-step counts off their titles', () => {
  const view = viewFor('infrastructure', 'systems');
  assert.ok(view.scheduleLinks.length);
  for (const link of view.scheduleLinks) {
    assert.ok(view.scheduleGroups.some(group => group.id === link.from));
    assert.ok(view.scheduleGroups.some(group => group.id === link.to));
    assert.equal(link.displayLabel, '');
    assert.ok(!view.links.some(edge => edge.id === link.id));
  }
  assert.equal(view.scheduleGroups.find(group => group.id === 'FixedUpdate').label, 'FixedUpdate');
  const egui = viewFor('egui', 'systems');
  assert.equal(egui.scheduleGroups.find(group => group.id === 'EguiPrimaryContextPass').parent, 'PostUpdate');
  assert.ok(!egui.scheduleGroups.some(group => group.id === 'PostUpdate'));
  assert.ok(!egui.scheduleLinks.some(link => link.edgeSemantic === 'nested'));
  assert.ok(!view.scheduleLinks.some(link => ['ApplicationLifecycle', 'RenderApp', 'NativePlatformEvents', 'Explanatory'].includes(link.from) || ['RenderApp', 'NativePlatformEvents', 'Explanatory'].includes(link.to)));
});

test('Schedule titles show unique state Schedule types without changing registrations or stage identities', () => {
  const baseline = viewFor('character', 'systems');
  const state = baseline.scheduleGroups.find(group => group.id === 'StateTransition');
  assert.equal(state.label, 'OnEnter');
  assert.ok(baseline.mermaid.includes(`subgraph ${state.mermaidId}["OnEnter"]`));
  const startup = viewFor('window_policy', 'systems').scheduleGroups.find(group => group.id === 'Startup');
  assert.equal(startup.label, 'Startup');

  const updated = structuredClone(model);
  const system = updated.systems.find(system => system.id === 'character_clear_intents');
  system.schedule = 'OnExit(AppState::InGame)';
  system.registrations = [
    { schedule: 'OnExit(AppState::InGame)', scope: 'runtime' },
    { schedule: 'OnExit(PlayState::Paused)', scope: 'runtime' },
    { schedule: 'OnTransition { exited: PlayState::Running, entered: PlayState::Paused }', scope: 'runtime' },
    { schedule: 'OnExit(AppState::InGame)', scope: 'runtime' },
    { schedule: 'OnEnter(TestState::Ready)', scope: 'headless-test' },
  ];
  const local = buildArchitectureModel(updated), graph = local.graphFor('character', 'systems');
  const view = renderGraphView({ id: 'character-systems', feature: 'character', aspect: 'systems', label: '测试', summary: '测试' }, graph, local.registry, local.features, local.scheduleGroups(graph));
  const changedState = view.scheduleGroups.find(group => group.id === 'StateTransition');
  assert.equal(changedState.label, 'OnExit\nOnTransition');
  assert.ok(view.mermaid.includes(`subgraph ${changedState.mermaidId}["OnExit<br/>OnTransition"]`));
  assert.doesNotMatch(view.mermaid, /TestState|StateTransition ·|条件 OnEnter|仅初始化一次/);
  assert.deepEqual(view.nodes.map(node => node.id), baseline.nodes.map(node => node.id));
  assert.deepEqual(view.scheduleGroups.map(({ label, ...group }) => group), baseline.scheduleGroups.map(({ label, ...group }) => group));
  assert.deepEqual(view.scheduleLinks, baseline.scheduleLinks);
  assert.deepEqual(view.layoutLinks, baseline.layoutLinks);
  assert.deepEqual(view.links, baseline.links);
  assert.deepEqual(local.registry.character_clear_intents.registrations, system.registrations);
});

test('Schedule containers use concise titles while preserving their identities, membership and stage edges', () => {
  const expected = new Map([
    ['FixedLast', 'FixedLast'],
    ['FixedPostUpdate', 'FixedPostUpdate'],
    ['EguiPrimaryContextPass', 'EguiPrimaryContextPass'],
    ['RenderApp', 'RenderApp'],
    ['NativePlatformEvents', '原生平台回调'],
    ['Explanatory', '约束与说明'],
  ]);
  const seen = new Set();
  for (const feature of featureIds) {
    const graph = architecture.graphFor(feature, 'systems'), view = viewFor(feature, 'systems');
    for (const group of view.scheduleGroups) {
      if (!expected.has(group.id)) continue;
      const label = expected.get(group.id);
      assert.equal(group.label, label, `${feature}/${group.id}`);
      assert.ok(view.mermaid.includes(`subgraph ${group.mermaidId}["${label}"]`), `${feature}/${group.id}`);
      seen.add(group.id);
    }
    assert.deepEqual(view.nodes.map(node => node.id), graph.nodes.map(node => node.id));
    assert.deepEqual(view.links.map(({ mermaidId, edgeSemantic, displayLabel, ...link }) => link), graph.links);
  }
  assert.deepEqual([...seen].sort(), [...expected.keys()].sort());
  const avian = viewFor('avian', 'systems'), egui = viewFor('egui', 'systems');
  assert.equal(avian.scheduleGroups.find(group => group.id === 'RunFixedMainLoop.AfterFixedMainLoop').label, 'RunFixedMainLoop · AfterFixedMainLoop');
  assert.equal(egui.scheduleGroups.find(group => group.id === 'EguiPrimaryContextPass').parent, 'PostUpdate');
  assert.equal(architecture.registry.inspector_pass.registrations[0].driver_schedule, 'PostUpdate');
  for (const view of [avian, egui]) assert.ok(!view.scheduleLinks.some(link => ['RenderApp', 'NativePlatformEvents', 'Explanatory'].includes(link.from) || ['RenderApp', 'NativePlatformEvents', 'Explanatory'].includes(link.to)));
});

test('business Mermaid definitions exclude guides and retain only real nodes, edges and layout', () => {
  for (const feature of featureIds) for (const aspect of ['systems', 'data', 'events']) {
    const view = viewFor(feature, aspect);
    assert.equal(Object.hasOwn(view, 'legend'), false);
    assert.doesNotMatch(view.mermaid || '', /legend_|subgraph legend|layout_hidden/);
    assert.ok(view.layoutLinks.every(link => !link.directed));
    assert.deepEqual(view.nodes.map(node => node.id), architecture.graphFor(feature, aspect).nodes.map(node => node.id));
  }
});

test('data group captions describe their contents while retaining stable group and graph identities', () => {
  let catalogs = 0, relations = 0;
  for (const feature of featureIds) {
    const graph = architecture.graphFor(feature, 'data'), view = viewFor(feature, 'data');
    if (view.mermaid?.includes('subgraph catalog[')) {
      assert.ok(view.mermaid.includes('subgraph catalog["数据与实体"]'), feature);
      catalogs++;
    }
    if (view.mermaid?.includes('subgraph relations[')) {
      assert.ok(view.mermaid.includes('subgraph relations["数据流与关系"]'), feature);
      relations++;
    }
    assert.doesNotMatch(view.mermaid || '', /subgraph (?:catalog|relations)\["(?:数据契约|关系与约束)"\]/, feature);
    assert.deepEqual(view.nodes.map(node => node.id), graph.nodes.map(node => node.id), feature);
    const endpoints = link => [link.id, link.from, link.to];
    assert.deepEqual(view.links.map(endpoints), graph.links.map(endpoints), feature);
  }
  assert.ok(catalogs > 0 && relations > 0);
});

test('overview displays the App schedule while plugin entrances remain in their own views', () => {
  const view = renderOverview(model, architecture.registry, architecture.features);
  assert.equal(view.layout, 'app-schedule');
  assert.equal(new Set(view.nodes.map(node => node.id)).size, view.nodes.length);
  for (const system of model.systems) assert.ok(view.nodes.some(node => node.id === system.id), system.id);
  for (const entry of INFRASTRUCTURE_FEATURES) assert.ok(architecture.graphFor(entry.id, 'events').nodes.some(node => node.id === entry.overviewNode), entry.id);
  assert.ok(!view.nodes.some(node => node.id === 'third-party-plugins'));
  assert.ok(view.links.every(link => ['order', 'registration'].includes(link.kind)));
  assert.ok(view.nodes.every(node => node.role === 'internal'));
});

test('empty tabs have neither Mermaid source nor an export filename', () => {
  const view = viewFor('session_log', 'systems');
  assert.equal(view.mermaid, null);
  assert.equal(view.mermaidFilename, null);
  assert.equal(view.filename, null);
});

test('legacy carry plugin identity redirects to the same declaration and retains its relations', () => {
  const view = viewFor('item_interaction', 'events');
  assert.equal(architecture.resolveNode('plugin-carry'), 'plugin-ItemInteractionPlugin');
  assert.equal(architecture.registry['plugin-carry'].alias_of, 'plugin-ItemInteractionPlugin');
  assert.equal(view.nodes.filter(node => architecture.registry[node.id].name === 'ItemInteractionPlugin').length, 1);
  const previous = model.system_links.filter(link => (link.from === 'plugin-ItemInteractionPlugin' || link.to === 'plugin-ItemInteractionPlugin') && !isMainPluginRegistration(link, architecture.registry));
  assert.ok(previous.length);
  for (const link of previous) {
    const rendered = view.links.find(item => item.id === link.id);
    assert.ok(rendered);
    assert.equal(rendered.from, architecture.resolveNode(link.from));
    assert.equal(rendered.to, architecture.resolveNode(link.to));
  }
  const legacyModel = structuredClone(model);
  const legacyLink = legacyModel.system_links.find(link => link.id === previous[0].id);
  for (const endpoint of ['from', 'to']) if (legacyLink[endpoint] === 'plugin-ItemInteractionPlugin') legacyLink[endpoint] = 'plugin-carry';
  const legacyArchitecture = buildArchitectureModel(legacyModel);
  const redirected = legacyArchitecture.graphFor('item_interaction', 'events').links.find(link => link.id === legacyLink.id);
  assert.equal(redirected.from, previous[0].from);
  assert.equal(redirected.to, previous[0].to);
});

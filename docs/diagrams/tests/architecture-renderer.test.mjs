import assert from 'node:assert/strict';
import test from 'node:test';
import { renderGraphView, mermaidConfiguration, entityComponentColumns, dataLayoutColumns, dataObserverLayoutPairs, observerBranchLayoutPairs } from '../src/architecture-renderer.mjs';
import { NODE_STYLES, EDGE_STYLES, EXTERNAL_REFERENCE_STYLE } from '../src/architecture-style.mjs';
import { INFRASTRUCTURE_FEATURES } from '../src/architecture-infrastructure.mjs';
import { mermaidRenderIdentity } from '../src/mermaid-cache.mjs';

function isolatedView(record, { role = 'internal', aspect = 'data' } = {}) {
  const graph = { centerNodeId: record.id, nodes: [{ id: record.id, role }], links: [] };
  const groups = aspect === 'systems' ? [{ id: 'Update', label: 'Update', order: 90, track: 'frame', nodes: graph.nodes }] : [];
  return renderGraphView({ id: 'isolated-test', feature: 'first_person', aspect, label: '测试', summary: '测试' }, graph, { [record.id]: record }, [{ id: 'example', label: '示例' }], groups);
}

test('Component views rank every native relation System to Component to Entity without changing business direction', () => {
  const registry = {
    entity: { kind: 'Entity', name: 'Entity', description: 'owner', feature: 'test' },
    component: { kind: 'Component', name: 'Component', description: 'data', feature: 'test' },
    system: { kind: 'system', name: 'System', description: 'behavior', feature: 'test' },
  };
  const graph = { componentNodeId: 'component', nodes: Object.keys(registry).map(id => ({ id, role: 'internal' })), links: [
    { id: 'owner', from: 'component', to: 'entity', kind: 'reference', label: '所属实体' },
    { id: 'read', from: 'component', to: 'system', kind: 'read' },
    { id: 'write', from: 'system', to: 'component', kind: 'write' },
  ] };
  const before = JSON.stringify(graph), view = renderGraphView({ id: 'component-test', aspect: 'component', label: 'Component', summary: 'relations' }, graph, registry, []);
  assert.equal(JSON.stringify(graph), before);
  assert.deepEqual(view.links, graph.links);
  assert.deepEqual(view.visualEdgeGroups.map(({ from, to, nativeReverse }) => [from, to, nativeReverse]), [['component', 'entity', undefined], ['component', 'system', true], ['system', 'component', undefined]]);
  assert.deepEqual(view.visualEdgeGroups.map(group => group.displayLabel), ['引用 · 所属实体', '读访问', '写访问']);
  assert.match(view.mermaid, /n2 e1@--- n1/);
  assert.match(view.mermaid, /n2 e2@--> n1/);
  assert.match(view.mermaid, /n1 e0@--> n0/);
  assert.doesNotMatch(view.mermaid, /e\d+@[^\n]*\|/);
  const config = JSON.parse(/^---\n([\s\S]*?)\n---/.exec(view.mermaid)[1]).config;
  assert.match(config.themeCSS, /#component-test-e1\{marker-start:url\(#component-test_flowchart-v2-pointStart\)!important\}/);
  assert.match(config.themeCSS, /fill:context-stroke!important;stroke:context-stroke!important/);
  assert.ok(!config.themeCSS.includes('.edgeLabel rect'));
  const enriched = renderGraphView({ id: 'component-details', aspect: 'component', componentNodeId: 'component', componentDetails: { name: 'Component<f32>', description: 'all owners', display_summary: '完整类型用途' }, label: 'Component', summary: 'relations' }, graph, registry, []);
  assert.equal(enriched.nodes.find(node => node.id === 'component').nameLabel, 'Component<f32>');
  assert.deepEqual(enriched.nodes.find(node => node.id === 'component').contextLabel, []);
  assert.equal(enriched.nodes.find(node => node.id === 'system').nameLabel, 'System');
  assert.equal(registry.component.name, 'Component');
});

test('unlabeled views do not add label background styling', () => {
  const view = isolatedView({ id: 'single', kind: 'Component', name: 'Single', description: '用途', feature: 'first_person' }, { aspect: 'object' });
  const config = JSON.parse(/^---\n([\s\S]*?)\n---/.exec(view.mermaid)[1]).config;
  assert.equal(config.themeCSS, undefined);
});

test('source-local Observer fanout layout never chains unrelated emitters or closes semantic cycles', () => {
  const nodes = ['source-a', 'source-b', 'a', 'b', 'c', 'd'].map(id => ({ id }));
  const links = [['source-a', 'a'], ['source-a', 'b'], ['source-b', 'c'], ['source-b', 'd']].map(([from, to]) => ({ from, to, projection: 'observer-trigger' }));
  const groups = [{ nodes: ['source-a', 'source-b'], visualAttachments: ['a', 'b', 'c', 'd'] }];
  const before = structuredClone({ nodes, links, groups });
  assert.deepEqual(observerBranchLayoutPairs(nodes, links, groups), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(observerBranchLayoutPairs(nodes, [...links, { from: 'b', to: 'a' }], groups), [['c', 'd']]);
  assert.deepEqual({ nodes, links, groups }, before);
});

test('cards show complete short titles without inferred purposes or hidden implementation detail', () => {
  const shortName = 'very_long_system_' + 'character_facing_'.repeat(12);
  const record = {
    id: 'long-system', kind: 'system', feature: 'first_person',
    name: `demo::first_person::${shortName}<dep::State>`,
    reads: ['hidden-read'], writes: ['hidden-write'], schedule: 'Update',
    registrations: [{ schedule: 'Update', run_if: ['hidden_condition'] }, { schedule: 'Startup' }],
    fields: ['hidden-field'], notes: ['hidden-note'], source: { path: 'src/first_person/facing.rs', line: 1 },
  };
  const original = structuredClone(record), view = isolatedView(record, { aspect: 'systems' }), node = view.nodes[0];
  assert.equal(node.nameLabel, shortName);
  assert.deepEqual(node.contextLabel, []);
  assert.equal(node.displayLabel, shortName);
  const declaration = view.mermaid.split('\n').find(line => line.startsWith('  n0@{'));
  assert.ok(declaration.replace(/\*\*|<br\/>|[\u200B\uFEFF]/g, '').includes(shortName));
  assert.doesNotMatch(declaration, /demo::|dep::/);
  assert.doesNotMatch(declaration, /…|hidden-|hidden_condition|另有注册|R \d|W \d/);
  assert.deepEqual(record, original);
});

test('short titles preserve distinct generic identities, links and escaped type structure', () => {
  const registry = {
    one: { kind: 'System', name: 'demo::run<dep::First>', description: 'first', feature: 'fixture' },
    two: { kind: 'System', name: 'demo::run<dep::Second>', description: 'second', feature: 'fixture' },
    type: { kind: 'Resource', name: 'dep::Assets<dep::Wrapper<dep::T>>', description: 'data', feature: 'fixture' },
  };
  const graph = { centerNodeId: 'one', nodes: Object.keys(registry).map(id => ({ id, role: 'internal' })), links: [
    { id: 'read', from: 'type', to: 'one', kind: 'read' }, { id: 'write', from: 'two', to: 'type', kind: 'write' },
  ] };
  const before = structuredClone({ registry, graph });
  const view = renderGraphView({ id: 'short-titles', aspect: 'object', label: 'types', summary: 'purposes' }, graph, registry, []);
  assert.deepEqual(view.nodes.map(node => [node.id, node.nameLabel]), [['one', 'run'], ['two', 'run'], ['type', 'Assets<Wrapper<T>>']]);
  assert.match(view.mermaid, /Assets#lt;Wrapper#lt;T#gt;#gt;/);
  assert.deepEqual(view.links.map(({ id, from, to }) => ({ id, from, to })), graph.links.map(({ id, from, to }) => ({ id, from, to })));
  assert.deepEqual({ registry, graph }, before);
});

test('colliding short titles use actual full declarations or package versions as visible context', () => {
  const registry = {
    left: { id: 'left', kind: 'System', name: 'demo::left::run', declarationId: 'decl-left' },
    right: { id: 'right', kind: 'System', name: 'demo::right::run', declarationId: 'decl-right' },
    old: { id: 'old', kind: 'Resource', name: 'shared::State', typeIdentity: { package: { name: 'shared', version: '1.0.0' } } },
    current: { id: 'current', kind: 'Resource', name: 'shared::State', typeIdentity: { package: { name: 'shared', version: '2.0.0' } } },
  };
  const graph = { centerNodeId: 'left', nodes: Object.keys(registry).map(id => ({ id, role: 'internal' })), links: [] };
  const before = structuredClone(registry);
  const view = renderGraphView({ id: 'colliding-titles', aspect: 'object', centerNodeId: 'left', label: 'Declarations' }, graph, registry, []);
  assert.deepEqual(view.nodes.map(node => node.nameLabel), ['run', 'run', 'State', 'State']);
  assert.deepEqual(view.nodes.map(node => node.contextLabel), [['demo::left::run'], ['demo::right::run'], ['shared 1.0.0'], ['shared 2.0.0']]);
  assert.equal(new Set(view.nodes.map(node => node.displayLabel)).size, 4);
  assert.deepEqual(registry, before);
});

test('Entity Name titles retain source text and changing a name invalidates rendered geometry', () => {
  const names = ['HUD::状态 "active"_label', 'format!("Block {}", index)', 'Name ∈ {Floor | Wall}', 'Entity @ src/scene.rs:12'];
  const registry = Object.fromEntries(names.map((name, index) => ['entity-' + index,
    { kind: 'Entity', name, description: '保存该创建模板的实体身份。', display_summary: '场景中的实体。', feature: 'fixture' }]));
  registry['entity-copy'] = { ...registry['entity-0'] };
  const graph = { centerNodeId: 'entity-0', nodes: Object.keys(registry).map(id => ({ id, role: 'internal' })), links: [
    { id: 'child', from: 'entity-0', to: 'entity-copy', kind: 'relationship' },
  ] };
  const definition = { id: 'entity-names', aspect: 'object', label: 'Entity', summary: '实体模板' };
  const view = renderGraphView(definition, graph, registry, []);
  assert.deepEqual(view.nodes.map(node => [node.id, node.nameLabel]), [...names.map((name, index) => ['entity-' + index, name]), ['entity-copy', names[0]]]);
  assert.match(view.mermaid.replace(/[\u200B\uFEFF]/g, ''), /HUD::状态 \\u0022active\\u0022_label/);
  assert.match(view.mermaid, /format!\(\\u0022Block \{\}\\u0022, index\)/);
  assert.deepEqual(view.links.map(({ id, from, to }) => ({ id, from, to })), graph.links.map(({ id, from, to }) => ({ id, from, to })));
  const before = mermaidRenderIdentity(view, registry, '{}');
  const oldEncoding = { ...view, mermaid: view.mermaid.replaceAll('\\u0022', '#quot;') };
  assert.notEqual(mermaidRenderIdentity(oldEncoding, registry, '{}').fingerprint, before.fingerprint, 'Native text encoding remains part of the render cache input');
  const renamed = { ...registry, 'entity-0': { ...registry['entity-0'], name: 'HUD::新名称' } };
  const updated = renderGraphView(definition, graph, renamed, []);
  assert.notEqual(mermaidRenderIdentity(updated, renamed, '{}').fingerprint, before.fingerprint);
  assert.deepEqual(updated.nodes.map(node => node.id), view.nodes.map(node => node.id));
});

test('external components retain their provider context without requiring purpose text', () => {
  const record = { id: 'character.Transform', kind: 'Component', feature: 'infrastructure', name: 'Transform', owner: '角色业务根实体' };
  const view = isolatedView(record, { role: 'external' }), node = view.nodes[0];
  assert.deepEqual(node.contextLabel, ['来自Bevy 引擎 ↗']);
  assert.equal(node.displayLabel, `Transform\n${node.contextLabel[0]}`);
  assert.doesNotMatch(node.displayLabel, /…|所属实体 ·/);
  assert.ok(view.mermaid.includes('class n0 external_node'));
  assert.equal(isolatedView({ id: 'fact-only', kind: 'system', feature: 'first_person', name: 'empty' }).nodes[0].displayLabel, 'empty');
});

test('obsolete purpose fields never affect generated labels', () => {
  const record = { id: 'name-contract', kind: 'system', feature: 'first_person', name: 'sample' };
  for (const display_summary of [null, 0, 42, false, {}, [], '', ' \t\n ']) {
    assert.equal(isolatedView({ ...record, display_summary, description: '旧用途。' }).nodes[0].displayLabel, 'sample');
  }
  assert.deepEqual(isolatedView(record).nodes[0].contextLabel, []);
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

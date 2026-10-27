import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArchitectureModel } from './architecture-model.mjs';
import { buildObjectCatalog } from './architecture-objects.mjs';
import { renderGraphView } from './architecture-renderer.mjs';

function fixture() {
  const system = (id, schedule) => ({ id, name: 'sync', kind: 'System', feature: 'sample', module: 'sample', registered_by: 'sample',
    reads: ['a.Flag', 'state'], writes: ['a.Flag'], registrations: [{ scope: 'runtime', schedule, sets: ['SampleSet::Sync'] }], description: '同步' });
  const model = { features: [{ id: 'sample', plugin: 'SamplePlugin' }], systems: [system('fixed', 'FixedUpdate'), system('frame', 'Update')],
    resources: [{ id: 'state', name: 'State', feature: 'sample', description: '状态' }], entities: ['a', 'b'].map(id => ({ id, name: id, feature: 'sample', description: '实体身份',
      components: [{ id: `${id}.Flag`, name: 'Flag', feature: 'sample', description: '标记' }] })),
    nodes: [{ id: 'plugin-SamplePlugin', name: 'SamplePlugin', feature: 'sample', kind: 'Plugin', description: '插件' },
      { id: 'set', name: 'SampleSet', feature: 'sample', kind: 'SystemSet', description: '集合' },
      { id: 'note', name: '说明', feature: 'sample', kind: 'Note', description: '上下文' },
      { id: 'isolated', name: 'Isolated', feature: 'sample', kind: 'QueryData', description: '无关联对象' }],
    system_links: [{ id: 'fixed-frame', from: 'fixed', to: 'frame', kind: 'order' }, { id: 'frame-note', from: 'frame', to: 'note', kind: 'reference' }] };
  const { registry } = buildArchitectureModel(model);
  for (const record of Object.values(registry)) record.sourceEntries = [];
  const components = { accesses: [
    { system: 'fixed', component: 'a.Flag', operation: 'filter', evidence: 'source' },
    { system: 'fixed', component: 'a.Flag', operation: 'read', evidence: 'declaration' },
    { system: 'fixed', component: 'a.Flag', operation: 'remove', evidence: 'source' },
    { system: 'fixed', component: 'a.Flag', operation: 'write', evidence: 'declaration' },
    { system: 'frame', component: 'a.Flag', operation: 'write', evidence: 'source' },
  ] };
  return { model, registry, components, catalog: buildObjectCatalog(model, registry, { components }) };
}

test('对象目录保留同名投影与同函数多注册，说明只保留为关联上下文', () => {
  const { registry, catalog } = fixture();
  for (const id of ['a.Flag', 'b.Flag', 'fixed', 'frame']) assert.ok(catalog.objectById[id], id);
  assert.notEqual(catalog.objectById['a.Flag'].viewId, catalog.objectById['b.Flag'].viewId);
  assert.notEqual(catalog.objectById.fixed.viewId, catalog.objectById.frame.viewId);
  assert.equal(catalog.objectById.note, undefined);
  assert.ok(catalog.graphFor('frame').nodes.some(node => node.id === 'note'));
  assert.deepEqual(catalog.objects, buildObjectCatalog(fixture().model, registry).objects);
});

test('每图严格包含中心的全部入出边，不扩展邻居关系或同类型的其他实体', () => {
  const { catalog } = fixture(), graph = catalog.graphFor('a.Flag');
  const expected = catalog.links.filter(link => link.from === 'a.Flag' || link.to === 'a.Flag');
  assert.deepEqual(graph.links, expected);
  assert.deepEqual(new Set(graph.nodes.map(node => node.id)), new Set(['a.Flag', ...expected.flatMap(link => [link.from, link.to])]));
  assert.ok(!graph.links.some(link => link.id === 'fixed-frame'));
  assert.ok(!graph.nodes.some(node => node.id === 'b.Flag'));
  assert.ok(graph.links.some(link => link.operation === 'contains' && link.to === 'entity-a'));
});

test('统一关系目录补齐资源访问、插件注册与具名集合成员，精确过滤和移除不冒充字段访问', () => {
  const { catalog } = fixture();
  assert.ok(catalog.graphFor('state').links.some(link => link.from === 'state' && link.to === 'fixed' && link.kind === 'read'));
  assert.ok(catalog.graphFor('fixed').links.some(link => link.from === 'plugin-SamplePlugin' && link.to === 'fixed' && link.kind === 'registration'));
  assert.ok(catalog.graphFor('set').links.some(link => link.to === 'fixed' && link.label === 'SampleSet::Sync'));
  const componentEdges = catalog.graphFor('a.Flag').links.filter(link => link.from === 'fixed' || link.to === 'fixed');
  assert.deepEqual(componentEdges.map(link => link.operation).sort(), ['filter', 'remove']);
});

test('实体图隐藏包含及字段目标的组件端点，保留实体关系、装配归属与其他直接关联', () => {
  const { model, registry, components } = fixture();
  model.entities[0].assembled_by = ['sample'];
  model.system_links.push(
    { id: 'entity-peer', from: 'entity-a', to: 'entity-b', kind: 'relationship' },
    { id: 'component-target', from: 'b.Flag', to: 'entity-a', kind: 'reference', operation: 'entity_target' },
    { id: 'entity-system', from: 'fixed', to: 'entity-a', kind: 'reference' },
  );
  const catalog = buildObjectCatalog(model, registry, { components });
  const graph = catalog.graphFor('entity-a');
  assert.deepEqual(new Set(graph.nodes.map(node => node.id)), new Set(['entity-a', 'entity-b', 'fixed', 'plugin-SamplePlugin']));
  assert.ok(graph.nodes.every(node => registry[node.id].kind !== 'Component'));
  assert.ok(graph.links.every(link => graph.nodes.some(node => node.id === link.from) && graph.nodes.some(node => node.id === link.to)));
  assert.deepEqual(graph.links, catalog.links.filter(link => [link.from, link.to].includes('entity-a') && ![link.from, link.to].some(id => registry[id].kind === 'Component')));
  assert.ok(catalog.links.some(link => link.id === 'component-target'));
  assert.ok(catalog.graphFor('b.Flag').links.some(link => link.id === 'component-target'));
  assert.ok(catalog.graphFor('a.Flag').links.some(link => link.operation === 'contains' && link.to === 'entity-a'));
  assert.deepEqual(registry['entity-a'].components, model.entities[0].components);
  for (const id of ['fixed', 'a.Flag']) {
    assert.deepEqual(catalog.graphFor(id).links, catalog.links.filter(link => link.from === id || link.to === id));
  }
});

test('插件与插件组专属图为单卡，其他对象仍保留真实装配与注册关系', () => {
  const { model, registry, components } = fixture();
  registry['plugin-group'] = { id: 'plugin-group', name: 'SamplePlugins', kind: 'PluginGroup', feature: 'sample', sourceEntries: [] };
  model.nodes.push(registry['plugin-group']);
  model.system_links.push({ id: 'group-plugin', from: 'plugin-group', to: 'plugin-SamplePlugin', kind: 'registration' });
  const catalog = buildObjectCatalog(model, registry, { components });
  for (const id of ['plugin-SamplePlugin', 'plugin-group']) {
    const graph = catalog.graphFor(id);
    assert.deepEqual(graph.nodes.map(node => node.id), [id]);
    assert.deepEqual(graph.links, []);
    assert.equal(graph.empty, false);
    assert.ok(catalog.links.some(link => link.from === id || link.to === id));
  }
  assert.ok(catalog.graphFor('fixed').links.some(link => link.from === 'plugin-SamplePlugin' && link.to === 'fixed'));
});

test('仅有组件关系的实体过滤后生成正常单卡图，组件目录及自身包含关系完整保留', () => {
  const { registry, catalog } = fixture(), graph = catalog.graphFor('entity-a');
  assert.deepEqual(graph.nodes.map(node => node.id), ['entity-a']);
  assert.deepEqual(graph.links, []);
  assert.equal(graph.empty, false);
  const view = renderGraphView({ id: catalog.objectById['entity-a'].viewId, aspect: 'object', objectId: 'entity-a', centerNodeId: 'entity-a', label: '实体', summary: '实体关系' }, graph, registry, []);
  assert.ok(view.mermaid);
  assert.ok(view.filename.endsWith('.svg'));
  assert.equal(view.nodes.length, 1);
  assert.ok(catalog.objectById['a.Flag']);
  assert.ok(catalog.graphFor('a.Flag').links.some(link => link.operation === 'contains' && link.to === 'entity-a'));
});

test('无关系对象有且仅有一张单卡图，未知对象不能静默进入其他图', () => {
  const { catalog } = fixture();
  assert.deepEqual(catalog.graphFor('isolated').nodes.map(node => node.id), ['isolated']);
  assert.equal(catalog.graphFor('isolated').empty, false);
  assert.deepEqual(catalog.graphFor('isolated').links, []);
  assert.throws(() => catalog.graphFor('missing'), /未知 ECS 对象/);
});

test('类型级与多实体候选操作不能落到首投影或广播，已审阅反射访问保持全部目标', () => {
  const { model, registry, components } = fixture();
  components.accesses.push(
    { system: 'fixed', component: 'a.Flag', projectionIds: [], targetScope: 'type-only', operation: 'insert', evidence: 'source' },
    { system: 'frame', component: 'a.Flag', projectionIds: ['a.Flag', 'b.Flag'], targetScope: 'declared-candidates', operation: 'remove', evidence: 'source' },
    { system: 'frame', component: 'a.Flag', projectionIds: ['a.Flag', 'b.Flag'], operation: 'reflect_read', evidence: 'reviewed' },
  );
  const catalog = buildObjectCatalog(model, registry, { components });
  assert.equal(catalog.unresolvedAccesses.length, 2);
  assert.ok(!catalog.links.some(link => ['insert', 'remove'].includes(link.operation) && link.from === 'frame'));
  assert.ok(!catalog.links.some(link => link.operation === 'insert'));
  for (const component of ['a.Flag', 'b.Flag']) assert.ok(catalog.links.some(link => link.from === component && link.to === 'frame' && link.operation === 'reflect_read'));
});

test('真实实体引用与装配归属补进对象的一跳关系，不从相同组件名猜测目标', () => {
  const { model, registry } = fixture();
  model.entities[0].assembled_by = ['sample'];
  model.relationships = [{ id: 'target', from: 'a', to: 'b', kind: 'reference', name: 'Flag.target', from_component: 'a.Flag', component_field: 'target', description: '普通字段引用' }];
  model.system_links.push({ id: 'target', from: 'entity-a', to: 'entity-b', kind: 'reference' });
  registry.target = { id: 'target', kind: 'Entity reference', feature: 'sample', sourceEntries: [] };
  const catalog = buildObjectCatalog(model, registry);
  assert.ok(catalog.graphFor('a.Flag').links.some(link => link.operation === 'entity_target' && link.to === 'entity-b'));
  assert.ok(!catalog.graphFor('b.Flag').links.some(link => link.operation === 'entity_target'));
  assert.ok(catalog.links.some(link => link.from === 'plugin-SamplePlugin' && link.operation === 'assembly' && link.to === 'entity-a'));
  assert.ok(catalog.graphFor('entity-a').links.some(link => link.from === 'plugin-SamplePlugin' && link.operation === 'assembly'));
});

test('对象原生布局保留双向读写的端点和箭头，只以渲染方向消除布局环', () => {
  const registry = { center: { id: 'center', name: 'Center', kind: 'Resource', feature: 'sample', description: '资源' },
    system: { id: 'system', name: 'System', kind: 'System', feature: 'sample', description: '行为' } };
  const graph = { centerNodeId: 'center', nodes: Object.keys(registry).map(id => ({ id, role: 'internal' })), links: [
    { id: 'read', from: 'center', to: 'system', kind: 'read' }, { id: 'write', from: 'system', to: 'center', kind: 'write' },
  ] };
  const view = renderGraphView({ id: 'object-test', aspect: 'object', objectId: 'center', centerNodeId: 'center', label: '对象', summary: '关系' }, graph, registry, []);
  assert.deepEqual(view.links.map(link => [link.from, link.to]), graph.links.map(link => [link.from, link.to]));
  assert.equal(view.links[0].nativeReverse, true);
  assert.equal(view.links[1].nativeReverse, undefined);
  assert.equal(view.layoutLinks.length, 0);
  assert.match(view.mermaid, /marker-start/);
});

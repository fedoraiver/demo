import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { buildArchitectureModel, isUnscheduledTriggerNode } from '../src/architecture-model.mjs';
import { buildComponentCatalog } from '../src/architecture-components.mjs';
import { renderGraphView } from '../src/architecture-renderer.mjs';
import { inspectViewRoutes, nativeMarkerProperty } from '../src/architecture-routing.mjs';
import { checkMermaidGeometry } from '../src/diagram-geometry.mjs';
import { compileGuideSamples, compileNativeView } from '../src/mermaid-compiler.mjs';
import { compileRoutedView } from '../src/mermaid-core.mjs';
import { svgElements } from '../src/svg-shape-geometry.mjs';
import { readCargoMetadata, createDependencySourceResolver, attachDependencySources } from '../src/dependency-sources.mjs';
import { DEPENDENCY_SOURCE_DEFINITIONS } from '../catalog/architecture-source-definitions.mjs';
import { checkGuideSamples, checkMermaidSource, checkMermaidStyles } from '../src/check-ecs.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, EXTERNAL_REFERENCE_STYLE } from '../src/architecture-style.mjs';

const chromium = process.env.MERMAID_CHROMIUM_PATH || [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
  .filter(Boolean).flatMap(base => [path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe')])
  .find(candidate => fs.existsSync(candidate));
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const model = JSON.parse(fs.readFileSync(new URL('../catalog/ecs-data.json', import.meta.url), 'utf8'));
const architecture = buildArchitectureModel(model);
const temporary = fileURLToPath(new URL('../../../tmp/ecs-architecture/native-layout-tests/', import.meta.url));
let components;

test('native guide samples retain identical bytes and shared styles across repeated compilation', { skip: !chromium, timeout: 180000 }, async () => {
  fs.mkdirSync(temporary, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: fs.mkdtempSync(path.join(temporary, 'guide-repeat-')) });
  try {
    const first = await compileGuideSamples(browser), second = await compileGuideSamples(browser);
    assert.deepEqual(second, first, 'Complex classic shapes must not receive random Rough.js control points');
    checkGuideSamples(first, { nodes: NODE_STYLES, edges: EDGE_STYLES, selection: SELECTION_STYLE, externalReference: EXTERNAL_REFERENCE_STYLE });
  } finally {
    await browser.close();
  }
});

function componentCatalog() {
  if (!components) {
    const metadata = readCargoMetadata(repository);
    attachDependencySources(architecture.registry, createDependencySourceResolver(metadata), DEPENDENCY_SOURCE_DEFINITIONS);
    components = buildComponentCatalog(model, architecture.registry);
  }
  return components;
}

async function compileFixture(view, graph, name, registry = architecture.registry) {
  const input = JSON.stringify(view), graphInput = JSON.stringify(graph), registryInput = JSON.stringify(registry);
  fs.mkdirSync(temporary, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: fs.mkdtempSync(path.join(temporary, `${name}-`)) });
  try {
    const result = await compileRoutedView(view, registry, (candidate, records) => compileNativeView(browser, candidate, records));
    assert.equal(JSON.stringify(view), input, 'Native layout retries do not mutate the input view');
    assert.equal(JSON.stringify(graph), graphInput, 'Native layout retries do not mutate the semantic graph');
    assert.equal(JSON.stringify(registry), registryInput, 'Native compilation does not mutate the canonical registry');
    assert.deepEqual(result.nodes.map(node => node.id), view.nodes.map(node => node.id));
    assert.deepEqual(result.links, view.links, 'All semantic relations and source evidence survive compilation');
    assert.deepEqual(result.links.map((link, index) => Object.fromEntries(Object.keys(graph.links[index]).map(key => [key, link[key]]))), graph.links,
      'Original relation IDs, endpoints, operations and metadata remain canonical');
    assert.equal(result.entityViews, undefined, 'No Entity expansion variants are generated');
    assert.deepEqual(result.entityGroups || [], [], 'Entities remain standalone cards');
    assert.equal(result.routing.rule, 'axis-or-curve');
    checkMermaidGeometry(result.svg, result);
    checkMermaidStyles(result, registry);
    const inspection = inspectViewRoutes(result);
    assert.deepEqual(inspection.collisions, []);
    assert(inspection.edges.every(edge => !edge.arrowIssues.length && (edge.axis ? !edge.curved : edge.curved)),
      'Every native path, label and marker meets the strict shared geometry rules');
    fs.writeFileSync(path.join(temporary, `${name}.svg`), result.svg);
    return result;
  } finally {
    await browser.close();
  }
}

test('object fan-in uses one invisible native input column when an otherwise valid edge is near-flat', { skip: !chromium, timeout: 180000 }, async () => {
  const registry = { cache: { id: 'cache', kind: 'Resource', name: 'PipelineCache', description: '承载调度系统参数或查询访问的数据。', feature: 'infrastructure' } };
  const nodes = [{ id: 'cache', role: 'internal', group: '当前对象' }], links = [];
  const writers = new Map([
    [3, { name: 'extract_shaders', description: '消费主世界 Shader 资产变更，合并全局 shader 定义并更新或移除管线缓存中的着色器；全量重载时重新提交全部 Shader 并清空已覆盖的事件。' }],
    [8, { name: 'prepare_view_upscaling_pipelines', description: '准备视图 upscaling 管线。按当前配置计算专用管线键，通过管线缓存复用或排队创建对应变体；资源参数包含 PipelineCache、SpecializedRenderPipelines<BlitPipeline>、BlitPipeline，只读与可变声明分别在 Read／Write 中列出。' }],
    [14, { name: 'process_pipeline_queue_system', description: '处理管线 queue。资源参数包含 Self，只读与可变声明分别在 Read／Write 中列出。' }],
  ]);
  for (let index = 0; index < 17; index++) {
    const id = `system-${index}`, incoming = writers.has(index);
    registry[id] = { id, kind: 'System', name: `pipeline_system_${index}`, description: '准备此阶段的专用渲染管线及纹理绑定，供后续视图使用。',
      feature: 'infrastructure', ...writers.get(index) };
    nodes.push({ id, role: 'internal', group: '直接关联对象' });
    links.push({ id: `link-${index}`, from: incoming ? id : 'cache', to: incoming ? 'cache' : id, kind: incoming ? 'write' : 'read' });
  }
  const graph = { nodes, links };
  const view = renderGraphView({ id: 'object-input-native-fixture', aspect: 'object', feature: 'infrastructure', objectId: 'cache', centerNodeId: 'cache',
    label: '管线缓存', summary: '测试原生输入列布局。' }, graph, registry, []);
  const result = await compileFixture(view, graph, 'object-input-column', registry);
  assert.deepEqual(result.layoutLinks, [
    { mermaidId: 'layout_input_0', from: 'n4', to: 'n9' },
    { mermaidId: 'layout_input_1', from: 'n9', to: 'n15' },
  ]);
  assert.equal(view.layoutLinks.length, 0, 'The original graph has no added layout context');
  assert.equal(result.links.length, 17, 'The input column neither adds nor removes semantic relations');
  assert.equal((result.svg.match(/data-layout-link=/g) || []).length, 2);
  assert.match(result.mermaid, /n4 layout_input_0@~~~ n9/);
});

test('long nested generic labels retain every character using one bounded native wrapping fallback', { skip: !chromium, timeout: 180000 }, async () => {
  const names = ['Messages<AssetEvent<AnimationGraph>>', 'RemovedComponents<MeshMaterial2d<ColorMaterial>>',
    'RemovedComponents<MeshMaterial2d<SpriteMeshMaterial>>', 'RemovedComponents<MeshMaterial2d<TilemapChunkMaterial>>',
    'RemovedComponents<MeshMaterial3d<StandardMaterial>>', 'RemovedComponents<MeshMaterial3d<ExtendedMaterial<StandardMaterial, ForwardDecalMaterialExt>>>'];
  for (const [index, name] of names.entries()) {
    const registry = { type: { id: 'type', kind: index ? 'SystemParam' : 'Messages<T>', name,
      description: '声明调度系统参数访问的数据。', display_summary: '承载调度系统参数或查询访问的数据。', feature: 'infrastructure' } };
    const graph = { nodes: [{ id: 'type', role: 'internal', group: '当前对象' }], links: [] };
    const view = renderGraphView({ id: `object-generic-label-${index}`, aspect: 'object', feature: 'infrastructure', objectId: 'type', centerNodeId: 'type',
      label: name, summary: '完整泛型标签。' }, graph, registry, []);
    const result = await compileFixture(view, graph, `generic-label-${index}`, registry);
    assert.equal(JSON.parse(/^---\n([\s\S]*?)\n---/.exec(result.mermaid)[1]).config.flowchart.wrappingWidth, 1000);
    assert.equal(JSON.parse(/^---\n([\s\S]*?)\n---/.exec(view.mermaid)[1]).config.flowchart.wrappingWidth, 280);
    assert.equal(result.nodes[0].displayLabel, view.nodes[0].displayLabel);
    checkMermaidSource(result, registry, new Map());
  }
});

for (const feature of ['item_interaction', 'ui', 'first_person']) test(`${feature} data cards preserve canonical native relationships`, { skip: !chromium, timeout: 180000 }, async () => {
  const graph = architecture.graphFor(feature, 'data');
  const view = renderGraphView({ id: `plugin-${feature}-data`, feature, aspect: 'data', label: '数据与实体', summary: '原生实体卡片关系回归。' },
    graph, architecture.registry, architecture.features);
  assert.equal(view.entityViews, undefined);
  assert.deepEqual(view.entityGroups || [], []);
  await compileFixture(view, graph, feature);
});

test('Observer sources route natively in local branches without assigning callbacks a Schedule', { skip: !chromium, timeout: 180000 }, async () => {
  const graph = architecture.graphFor('first_person', 'systems');
  const view = renderGraphView({ id: 'plugin-first_person-systems', feature: 'first_person', aspect: 'systems', label: '系统与调度', summary: '发出系统直接连接其事件 Observer。' },
    graph, architecture.registry, architecture.features, architecture.scheduleGroups(graph));
  assert(view.links.some(link => link.kind === 'trigger' && link.projection === 'observer-trigger'));
  const result = await compileFixture(view, graph, 'observer-sources');
  const independent = result.nodes.filter(node => isUnscheduledTriggerNode(architecture.registry[node.id]));
  assert(independent.some(node => node.visualType === 'observer'));
  for (const node of independent) {
    assert(!result.scheduleGroups.some(group => group.nodes.includes(node.id)), node.id);
    assert(result.scheduleGroups.some(group => group.id === 'PreUpdate' && group.visualAttachments?.includes(node.id)), node.id);
  }
  assert.equal(JSON.parse(/^---\n([\s\S]*?)\n---/.exec(result.mermaid)[1]).config.layout, 'dagre');
});

test('unscheduled lifecycle Observer remains beside its real source in an independent native branch', { skip: !chromium, timeout: 180000 }, async () => {
  const graph = architecture.graphFor('item_interaction', 'systems');
  const view = renderGraphView({ id: 'plugin-item_interaction-systems', feature: 'item_interaction', aspect: 'systems', label: '系统与调度', summary: '持物调度保持真实来源与原生走线。' },
    graph, architecture.registry, architecture.features, architecture.scheduleGroups(graph));
  const result = await compileFixture(view, graph, 'carry-observer-sources');
  assert(result.observerBranches.some(branch => branch.nodes.includes('carry_holder_despawn') && branch.nodes.includes('ecs-component-lifecycle')));
  assert(result.scheduleGroups.every(group => !group.nodes.includes('carry_holder_despawn') && !group.visualAttachments?.includes('carry_holder_despawn')));
  assert.equal(JSON.parse(/^---\n([\s\S]*?)\n---/.exec(result.mermaid)[1]).config.layout, 'dagre');
});

for (const name of ['Name', 'Transform', 'HeldTarget']) test(`${name} component graph keeps all owners left, systems right and native reversed arrows`, { skip: !chromium, timeout: 240000 }, async () => {
  const catalog = componentCatalog();
  const type = catalog.types.find(candidate => candidate.name === name);
  assert(type, `The real source-derived ${name} type must be available`);
  assert(type.ownerEntityIds.length, 'The component graph contains its actual owner categories');
  const graph = catalog.graphFor(type.id);
  const graphInput = JSON.stringify(graph);
  const view = renderGraphView({ id: type.viewId, feature: type.feature, aspect: 'component', label: `${name} · 组件关系`,
    summary: '左侧为包含组件的实体，中间为真实组件类型，右侧为去重后的系统函数。', componentTypeId: type.id,
    componentNodeId: type.componentNodeId, projectionIds: type.projectionIds, ownerEntityIds: type.ownerEntityIds, componentDetails: type.details,
  }, graph, architecture.registry, architecture.features);
  assert.equal(JSON.stringify(graph), graphInput, 'Rendering does not change the source-derived semantic graph');
  assert.equal(view.entityViews, undefined);
  assert.deepEqual(view.entityGroups || [], []);
  const result = await compileFixture(view, graph, `component-${name}`);
  const center = result.nodes.find(node => node.id === type.componentNodeId).position;
  const owners = new Set(type.ownerEntityIds);
  for (const node of result.nodes) {
    if (node.id === type.componentNodeId) continue;
    if (owners.has(node.id)) assert(node.position.x + node.position.width < center.x, `${node.id}: owner Entity stays left of ${name}`);
    else assert(node.position.x > center.x + center.width, `${node.id}: related System or Observer stays right of ${name}`);
  }
  assert.deepEqual(result.nodes.filter(node => node.visualType === 'entity').map(node => node.id).sort(), [...owners].sort());
  const elements = svgElements(result.svg);
  const reversed = result.links.filter(link => link.nativeReverse);
  assert(reversed.length, 'This real component graph exercises reversed native arrowheads');
  for (const link of reversed) {
    const edge = elements.find(element => element.tag === 'path' && element.attrs['data-link-id'] === link.id);
    assert(edge, `${link.id}: the original native edge path remains available`);
    const marker = nativeMarkerProperty(edge, 'marker-start');
    assert(marker?.includes('pointStart'), `${link.id}: semantic arrow uses Mermaid native pointStart`);
    assert(!nativeMarkerProperty(edge, 'marker-end') || nativeMarkerProperty(edge, 'marker-end') === 'none', `${link.id}: no opposing end arrowhead`);
    const markerId = /^url\(#([^)]*)\)$/.exec(marker)?.[1];
    assert(elements.some(element => element.tag === 'marker' && element.attrs.id === markerId), `${link.id}: the referenced native start marker exists`);
    assert.equal(edge.attrs['data-native-reverse'], 'true');
  }
});

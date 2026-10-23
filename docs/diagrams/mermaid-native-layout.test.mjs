import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { buildArchitectureModel } from './architecture-model.mjs';
import { buildComponentCatalog } from './architecture-components.mjs';
import { renderGraphView } from './architecture-renderer.mjs';
import { inspectViewRoutes, nativeMarkerProperty } from './architecture-routing.mjs';
import { checkMermaidGeometry } from './diagram-geometry.mjs';
import { compileNativeView } from './mermaid-compiler.mjs';
import { compileRoutedView } from './mermaid-core.mjs';
import { svgElements } from './svg-shape-geometry.mjs';
import { readCargoMetadata, createDependencySourceResolver, attachDependencySources } from './dependency-sources.mjs';
import { DEPENDENCY_SOURCE_DEFINITIONS } from './architecture-source-definitions.mjs';

const chromium = process.env.MERMAID_CHROMIUM_PATH || [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
  .filter(Boolean).flatMap(base => [path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe')])
  .find(candidate => fs.existsSync(candidate));
const repository = fileURLToPath(new URL('../../', import.meta.url));
const model = JSON.parse(fs.readFileSync(new URL('./ecs-data.json', import.meta.url), 'utf8'));
const architecture = buildArchitectureModel(model);
const temporary = fileURLToPath(new URL('../../tmp/ecs-architecture/native-layout-tests/', import.meta.url));
let components;

function componentCatalog() {
  if (!components) {
    const metadata = readCargoMetadata(repository);
    attachDependencySources(architecture.registry, createDependencySourceResolver(metadata), DEPENDENCY_SOURCE_DEFINITIONS);
    components = buildComponentCatalog(model, architecture.registry);
  }
  return components;
}

async function compileFixture(view, graph, name) {
  const input = JSON.stringify(view), graphInput = JSON.stringify(graph), registryInput = JSON.stringify(architecture.registry);
  fs.mkdirSync(temporary, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: fs.mkdtempSync(path.join(temporary, `${name}-`)) });
  try {
    const result = await compileRoutedView(view, architecture.registry, (candidate, registry) => compileNativeView(browser, candidate, registry));
    assert.equal(JSON.stringify(view), input, 'Native layout retries do not mutate the input view');
    assert.equal(JSON.stringify(graph), graphInput, 'Native layout retries do not mutate the semantic graph');
    assert.equal(JSON.stringify(architecture.registry), registryInput, 'Native compilation does not mutate the canonical registry');
    assert.deepEqual(result.nodes.map(node => node.id), view.nodes.map(node => node.id));
    assert.deepEqual(result.links, view.links, 'All semantic relations and source evidence survive compilation');
    assert.deepEqual(result.links.map((link, index) => Object.fromEntries(Object.keys(graph.links[index]).map(key => [key, link[key]]))), graph.links,
      'Original relation IDs, endpoints, operations and metadata remain canonical');
    assert.equal(result.entityViews, undefined, 'No Entity expansion variants are generated');
    assert.deepEqual(result.entityGroups || [], [], 'Entities remain standalone cards');
    assert.equal(result.routing.rule, 'axis-or-curve');
    checkMermaidGeometry(result.svg, result);
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

for (const feature of ['item_interaction', 'ui', 'first_person']) test(`${feature} data cards preserve canonical native relationships`, { skip: !chromium, timeout: 180000 }, async () => {
  const graph = architecture.graphFor(feature, 'data');
  const view = renderGraphView({ id: `plugin-${feature}-data`, feature, aspect: 'data', label: '数据与实体', summary: '原生实体卡片关系回归。' },
    graph, architecture.registry, architecture.features);
  assert.equal(view.entityViews, undefined);
  assert.deepEqual(view.entityGroups || [], []);
  await compileFixture(view, graph, feature);
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

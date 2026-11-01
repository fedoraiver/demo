import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { renderGraphView } from '../src/architecture-renderer.mjs';
import { inspectViewRoutes, nativeMarkerProperty } from '../src/architecture-routing.mjs';
import { checkMermaidGeometry } from '../src/diagram-geometry.mjs';
import { compileGuideSamples, compileNativeView } from '../src/mermaid-compiler.mjs';
import { compileRoutedView } from '../src/mermaid-core.mjs';
import { svgElements } from '../src/svg-shape-geometry.mjs';
import { checkGuideSamples, checkMermaidSource, checkMermaidStyles } from '../src/check-ecs.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, EXTERNAL_REFERENCE_STYLE } from '../src/architecture-style.mjs';

const chromium = process.env.MERMAID_CHROMIUM_PATH || [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
  .filter(Boolean).flatMap(base => [path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe')])
  .find(candidate => fs.existsSync(candidate));
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = path.join(repository, 'tmp/native-mermaid-tests');
async function compileFixture(view, graph, name, registry = {}) {
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

test('one-hop Component fan-in uses real native routes while retaining every source relation', { skip: !chromium, timeout: 180000 }, async () => {
  const registry = { component: { id: 'component', kind: 'Component', feature: 'fixture', name: 'SharedComponent', description: '供多个系统读取的数据。' } };
  for (let index = 0; index < 17; index++) registry['system-' + index] = { id: 'system-' + index, kind: 'System', feature: 'fixture', name: 'read_' + index, description: '读取组件并计算该步骤。' };
  const graph = { centerNodeId: 'component', nodes: Object.keys(registry).map(id => ({ id, role: 'internal' })),
    links: Object.keys(registry).slice(1).map((id, index) => ({ id: 'read-' + index, from: 'component', to: id, kind: 'read', sourceEntries: [{ path: 'src/main.rs', line: index + 1 }] })) };
  const view = renderGraphView({ id: 'native-fan-in', aspect: 'object', objectId: 'component', feature: 'fixture', label: '共享组件', summary: '完整一跳关系。' }, graph, registry, [{ id: 'fixture', label: '示例' }]);
  const compiled = await compileFixture(view, graph, 'fan-in', registry);
  assert.equal(compiled.links.length, 17);
});

test('complete nested generic names fit native cards without truncating compiler identities', { skip: !chromium, timeout: 180000 }, async () => {
  const names = ['Messages<Request<Options<(AssetId<Image>, Entity), Result<Handle<Scene>, Error>>>>',
    'Query<(&mut Transform, Option<&InheritedVisibility>), (With<Root>, Without<Camera>)>',
    'SystemState<(Res<Configuration>, Local<PreviousFrame<SelectionState>>)>' ];
  const registry = Object.fromEntries(names.map((name, index) => ['type-' + index, { id: 'type-' + index, kind: 'Component', feature: 'fixture', name, description: '完整泛型参数对应的编译器类型。' }]));
  const graph = { centerNodeId: 'type-0', nodes: Object.keys(registry).map(id => ({ id, role: 'internal' })), links: [
    { id: 'ref-1', from: 'type-0', to: 'type-1', kind: 'reference' }, { id: 'ref-2', from: 'type-2', to: 'type-0', kind: 'reference' }] };
  const view = renderGraphView({ id: 'native-generic', aspect: 'object', objectId: 'type-0', feature: 'fixture', label: '完整类型', summary: '编译器类型身份。' }, graph, registry, [{ id: 'fixture', label: '示例' }]);
  const compiled = await compileFixture(view, graph, 'generic', registry);
  assert.deepEqual(compiled.nodes.map(node => node.nameLabel), names);
});

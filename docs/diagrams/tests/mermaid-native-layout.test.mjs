import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { renderGraphView } from '../src/architecture-renderer.mjs';
import { inspectViewRoutes, nativeMarkerProperty } from '../src/architecture-routing.mjs';
import { checkMermaidGeometry } from '../src/diagram-geometry.mjs';
import { compileGuideSamples, compileNativeView, compileMermaidViews, compileArchitectureArtifacts, withMermaidContext } from '../src/mermaid-compiler.mjs';
import { browserRendererProof } from './fixtures/browser-renderer-proof.mjs';
import { compileRoutedView, nativeLabelMismatches } from '../src/mermaid-core.mjs';
import { svgElements } from '../src/svg-shape-geometry.mjs';
import { checkGuideSamples, checkMermaidSource, checkMermaidStyles } from '../src/check-ecs.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, EXTERNAL_REFERENCE_STYLE } from '../src/architecture-style.mjs';
import { VIEWER_BACKGROUND } from '../src/viewer-theme.mjs';

const chromium = process.env.MERMAID_CHROMIUM_PATH || [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
  .filter(Boolean).flatMap(base => [path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe')])
  .find(candidate => fs.existsSync(candidate));
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = path.join(repository, 'tmp/native-mermaid-tests');

for (const id of ['object-7dbecb473f3bff18', 'object-1c0bc2f73463f19b']) {
  test(`native edge labels have opaque viewer-colored backgrounds: ${id}`, { skip: !chromium, timeout: 180000 }, async () => {
    const { view, registry, features } = JSON.parse(fs.readFileSync(new URL(`./fixtures/${id}-native.json`, import.meta.url), 'utf8'));
    const graph = { centerNodeId: view.centerNodeId, nodes: view.nodes.map(({ id: nodeId, role }) => ({ id: nodeId, role })), links: view.links };
    const generated = renderGraphView(view, graph, registry, features);
    const themeCSS = JSON.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(generated.mermaid)[1]).config.themeCSS;
    const mermaid = view.mermaid.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_, json) => {
      const front = JSON.parse(json); front.config.themeCSS = themeCSS;
      return `---\n${JSON.stringify(front, null, 2)}\n---`;
    });
    const browser = await puppeteer.launch({ executablePath: chromium, headless: true });
    try {
      const result = await compileNativeView(browser, { ...view, mermaid }, registry);
      assert.deepEqual(result.nodes.map(node => node.id), view.nodes.map(node => node.id));
      assert.deepEqual(result.links, view.links);
      assert.deepEqual(nativeLabelMismatches(result), []);
      const elements = svgElements(result.svg), compact = text => text.replace(/[\s\u200B\uFEFF]/g, '');
      for (const link of result.links.filter(link => link.displayLabel)) {
        const label = elements.find(element => element.attrs['data-mermaid-native-id'] === link.mermaidId && (element.attrs.class || '').split(/\s+/).includes('label'));
        assert.ok(label, `Missing edge label ${link.mermaidId}`);
        assert.equal(compact(label.text), compact(link.displayLabel));
      }
      checkMermaidGeometry(result.svg, result);
      const routes = inspectViewRoutes(result);
      assert.equal(routes.edges.length, view.links.length);
      assert.deepEqual(routes.collisions, []);
      assert.ok(routes.edges.every(edge => !edge.arrowIssues.length && (edge.axis ? !edge.curved : edge.curved)));
      const page = await browser.newPage();
      await page.setContent(result.svg);
      const backgrounds = await page.$$eval('.edgeLabel .label rect.background', rects => rects.map(rect => {
        let opacity = 1;
        for (let element = rect; element; element = element.parentElement) opacity *= Number(getComputedStyle(element).opacity);
        const style = getComputedStyle(rect);
        return { opacity: opacity * Number(style.fillOpacity), fill: style.fill };
      }));
      assert.equal(backgrounds.length, result.links.filter(link => link.displayLabel).length);
      const color = VIEWER_BACKGROUND.match(/\w\w/g).map(value => parseInt(value, 16));
      for (const background of backgrounds) assert.deepEqual(background, { opacity: 1, fill: `rgb(${color.join(', ')})` });
      await page.close();
    } finally { await browser.close(); }
  });
}
async function compileFixture(view, graph, name, registry = {}, options = {}) {
  const input = JSON.stringify(view), graphInput = JSON.stringify(graph), registryInput = JSON.stringify(registry);
  fs.mkdirSync(temporary, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: fs.mkdtempSync(path.join(temporary, `${name}-`)) });
  try {
    const result = await compileRoutedView(view, registry, (candidate, records) => compileNativeView(browser, candidate, records), options);
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

test('captured InputFocus output fanout retains every read under strict native routing', { skip: !chromium, timeout: 180000 }, async () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/native-input-focus.json', import.meta.url), 'utf8'));
  const { graph, registry, features, targetEdgeId } = fixture, before = structuredClone(fixture);
  const view = renderGraphView(fixture.view, graph, registry, features);
  const result = await compileFixture(view, graph, 'input-focus', registry);
  assert.equal(result.nodes.length, 38); assert.equal(result.links.length, 65);
  assert.deepEqual(view.layoutLinks, []);
  const edge = inspectViewRoutes(result).edges.find(item => item.id === targetEdgeId);
  assert.deepEqual(edge.arrowIssues, []);
  assert.deepEqual(nativeLabelMismatches(result), []);
  assert.equal(result.nodes.find(node => node.id === graph.links.find(link => link.id === targetEdgeId).to).nameLabel, 'update_accessibility_nodes');
  assert.deepEqual(fixture, before);
});

test('captured SSAO parallel input operations retain exact removal evidence with fact-only cards', { skip: !chromium, timeout: 300000 }, async () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/native-ssao-input.json', import.meta.url), 'utf8'));
  const { graph, registry, features, targetEdgeId } = fixture, before = structuredClone(fixture);
  const view = renderGraphView(fixture.view, graph, registry, features);
  const result = await compileFixture(view, graph, 'ssao-input', registry);
  assert.equal(result.nodes.length, 5); assert.equal(result.links.length, 6);
  assert.deepEqual(view.layoutLinks, []);
  const removal = result.links.find(link => link.id === targetEdgeId);
  assert.equal(removal.operation, 'remove'); assert.equal(removal.displayLabel, '移除');
  assert.equal(result.links[0].nativeReverse, true);
  assert.equal(inspectViewRoutes(result).edges.find(edge => edge.id === targetEdgeId).arrowIssues.length, 0);
  assert.deepEqual(nativeLabelMismatches(result), []);
  assert.deepEqual(fixture, before);
});

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

test('bounded parallel Mermaid compilation isolates real renderer contexts and preserves view order', { skip: !chromium, timeout: 180000 }, async t => {
  fs.mkdirSync(temporary, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: fs.mkdtempSync(path.join(temporary, 'parallel-pages-')) });
  const pages = new Set(), contexts = new Set(), closedContexts = new Set(), completedPages = [];
  let active = 0, peak = 0, firstWaveReady, firstWaveFailed, rendererProof;
  const firstWave = new Promise((resolve, reject) => { firstWaveReady = resolve; firstWaveFailed = reject; });
  const isolatedBrowser = { createBrowserContext: async () => {
    const context = await browser.createBrowserContext(); contexts.add(context.id);
    return { newPage: async () => {
      const page = await context.newPage(), close = page.close.bind(page);
      pages.add(page); active++; peak = Math.max(peak, active);
      page.close = async () => {
        if (completedPages.length < 2) {
          completedPages.push(page);
          if (completedPages.length === 2) void browserRendererProof(browser, completedPages).then(proof => {
            rendererProof = proof; firstWaveReady();
          }, firstWaveFailed);
          await firstWave;
        }
        try { await close(); } finally { active--; }
      };
      return page;
    }, close: async () => { await context.close(); closedContexts.add(context.id); } };
  } };
  try {
    const registry = Object.fromEntries(Array.from({ length: 4 }, (_, index) => ['parallel-' + index,
      { id: 'parallel-' + index, kind: 'Resource', feature: 'fixture', name: 'PageContent_' + index, description: '保存此编译页的独立内容。' }]));
    const views = Object.keys(registry).map(id => renderGraphView({ id: 'view-' + id, aspect: 'object', objectId: id, centerNodeId: id,
      feature: 'fixture', label: id, summary: '独立页面编译。' }, { centerNodeId: id, nodes: [{ id, role: 'internal' }], links: [] }, registry, [{ id: 'fixture', label: '示例' }]));
    const before = JSON.stringify(views);
    const compiled = await compileMermaidViews(views, view => withMermaidContext(isolatedBrowser, scoped => compileRoutedView(view, registry,
      (candidate, records) => compileNativeView(scoped, candidate, records))), { jobs: 2 });
    assert.equal(peak, 2); assert.equal(active, 0); assert.equal(pages.size, views.length);
    assert.equal(contexts.size, views.length); assert.deepEqual(closedContexts, contexts);
    assert.equal(new Set(rendererProof.contexts).size, 2); assert.ok(rendererProof.activeRenderers.length >= 2);
    t.diagnostic('Mermaid renderer process proof: ' + JSON.stringify(rendererProof));
    assert.deepEqual(compiled.map(view => view.id), views.map(view => view.id));
    for (const [index, result] of compiled.entries()) {
      checkMermaidGeometry(result.svg, result); checkMermaidStyles(result, registry);
      assert.match(result.svg, new RegExp('PageContent_' + index));
      for (let other = 0; other < views.length; other++) if (other !== index) assert.doesNotMatch(result.svg, new RegExp('PageContent_' + other));
    }
    assert.equal(JSON.stringify(views), before);
  } finally { await browser.close(); }
});

test('native Mermaid initialization accepts more than 500 recorded edges including candidate layout constraints', { skip: !chromium, timeout: 180000 }, async () => {
  fs.mkdirSync(temporary, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: fs.mkdtempSync(path.join(temporary, 'edge-limit-')) });
  try {
    const registry = Object.fromEntries(Array.from({ length: 501 }, (_, index) => ['limit-' + index,
      { id: 'limit-' + index, kind: 'System', feature: 'fixture', name: 'Step_' + index, description: '执行当前夹具步骤。' }]));
    const ids = Object.keys(registry), graph = { nodes: ids.map(id => ({ id, role: 'internal' })),
      links: ids.slice(1).map((to, index) => ({ id: 'order-' + index, from: ids[index], to, kind: 'order' })) };
    const view = renderGraphView({ id: 'native-edge-limit', aspect: 'object', objectId: ids[0], centerNodeId: ids[0], feature: 'fixture',
      label: '完整边数', summary: '保留业务边和候选排版约束。' }, graph, registry, [{ id: 'fixture', label: '示例' }]);
    const candidate = { ...view, layoutLinks: [{ mermaidId: 'layout_limit', from: 'n0', to: 'n2' }],
      mermaid: view.mermaid + '  n0 layout_limit@~~~ n2\n' };
    const before = JSON.stringify(candidate), result = await compileNativeView(browser, candidate, registry);
    assert.equal(result.links.length, 500); assert.equal(result.layoutLinks.length, 1);
    assert.deepEqual(result.links, candidate.links); assert.deepEqual(result.layoutLinks, candidate.layoutLinks);
    assert.equal(svgElements(result.svg).filter(element => element.tag === 'path' && element.attrs['data-link-id']).length, 500);
    assert.equal(svgElements(result.svg).filter(element => element.attrs['data-layout-link'] === 'layout_limit').length, 1);
    checkMermaidGeometry(result.svg, result); checkMermaidStyles(result, registry);
    assert.equal(JSON.stringify(candidate), before);
  } finally { await browser.close(); }
});

test('native Mermaid accepts a valid source above 200000 characters while retaining its complete source and visible text', { skip: !chromium, timeout: 180000 }, async () => {
  fs.mkdirSync(temporary, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: fs.mkdtempSync(path.join(temporary, 'text-limit-')) });
  try {
    const name = '完整源码文本<System<资源, 状态>>', registry = {
      long: { id: 'long', kind: 'Resource', feature: 'fixture', name, description: '保留超过默认长度的有效源码和完整节点文字。' },
    };
    const view = renderGraphView({ id: 'native-text-limit', aspect: 'object', objectId: 'long', centerNodeId: 'long', feature: 'fixture',
      label: '完整源码', summary: '长源码夹具。' }, { nodes: [{ id: 'long', role: 'internal' }], links: [] }, registry, [{ id: 'fixture', label: '示例' }]);
    const candidate = { ...view, mermaid: view.mermaid + '  %% Valid source padding 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ\n'.repeat(4000) };
    assert.ok(candidate.mermaid.length > 200000);
    const result = await compileNativeView(browser, candidate, registry);
    assert.equal(result.mermaid, candidate.mermaid);
    assert.equal(result.nodes[0].nameLabel, name);
    assert.deepEqual(nativeLabelMismatches(result), []);
    checkMermaidGeometry(result.svg, result); checkMermaidStyles(result, registry);
  } finally { await browser.close(); }
});

test('the captured complete GPU batching object passes native artifact compilation and cached reuse opens no context', { skip: !chromium, timeout: 180000 }, async t => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/native-system-resource-fanout.json', import.meta.url), 'utf8'));
  const { graph, registry, features } = fixture, before = JSON.stringify(fixture);
  const view = renderGraphView(fixture.view, graph, registry, features), viewBefore = JSON.stringify(view);
  const launch = puppeteer.launch.bind(puppeteer);
  let contextsCreated = 0;
  t.mock.method(puppeteer, 'launch', async options => {
    const browser = await launch(options), create = browser.createBrowserContext.bind(browser);
    browser.createBrowserContext = async (...args) => { contextsCreated++; return create(...args); };
    return browser;
  });
  const compiled = await compileArchitectureArtifacts([view], registry), result = compiled.views[0];
  assert.equal(result.nodes.length, 14); assert.equal(result.links.length, 14);
  assert.deepEqual(result.links, view.links); assert.deepEqual(result.layoutLinks, []);
  assert.equal(result.routing.rule, 'axis-or-curve');
  assert.deepEqual(nativeLabelMismatches(result), []);
  checkMermaidGeometry(result.svg, result); checkMermaidStyles(result, registry);
  const inspection = inspectViewRoutes(result), edge = inspection.edges.find(edge => edge.id === 'relation-c21fb7aaa58930b597d6f0e2');
  assert.deepEqual(inspection.collisions, []);
  assert.ok(inspection.edges.every(edge => !edge.arrowIssues.length && (edge.axis ? !edge.curved : edge.curved)));
  assert.ok(edge.axis ? !edge.curved : edge.curved);
  checkGuideSamples(compiled.guideSamples, { nodes: NODE_STYLES, edges: EDGE_STYLES, selection: SELECTION_STYLE, externalReference: EXTERNAL_REFERENCE_STYLE });
  const beforeReuse = contextsCreated, reused = await compileArchitectureArtifacts([view], registry);
  assert.equal(contextsCreated, beforeReuse, 'Validated cached geometry must bypass context creation');
  assert.equal(reused.views[0].svg, result.svg); assert.equal(reused.views[0].mermaid, result.mermaid);
  assert.equal(JSON.stringify(fixture), before); assert.equal(JSON.stringify(view), viewBefore);
});

for (const [filename, nodes, links] of [['native-volumetric-fog.json', 5, 6], ['native-hovered-fanout.json', 62, 62]]) {
  test(`captured ${filename} preserves every fact with strict native routes and labels`, { skip: !chromium, timeout: 180000 }, async () => {
    const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/' + filename, import.meta.url), 'utf8'));
    const { graph, registry, features } = fixture, before = JSON.stringify(fixture);
    const view = renderGraphView(fixture.view, graph, registry, features);
    const result = await compileFixture(view, graph, filename.replace('.json', ''), registry);
    assert.equal(result.nodes.length, nodes); assert.equal(result.links.length, links);
    assert.deepEqual(nativeLabelMismatches(result), []);
    assert.deepEqual(result.links.find(link => link.id === fixture.targetEdgeId).bodyOperations,
      view.links.find(link => link.id === fixture.targetEdgeId).bodyOperations);
    assert.equal(JSON.stringify(fixture), before);
  });
}

test('one-hop Component fan-in uses real native routes while retaining every source relation', { skip: !chromium, timeout: 180000 }, async () => {
  const registry = { component: { id: 'component', kind: 'Component', feature: 'fixture', name: 'SharedComponent', description: '供多个系统读取的数据。' } };
  for (let index = 0; index < 17; index++) registry['system-' + index] = { id: 'system-' + index, kind: 'System', feature: 'fixture', name: 'read_' + index, description: '读取组件并计算该步骤。' };
  const graph = { centerNodeId: 'component', nodes: Object.keys(registry).map(id => ({ id, role: 'internal' })),
    links: Object.keys(registry).slice(1).map((id, index) => ({ id: 'read-' + index, from: 'component', to: id, kind: 'read', sourceEntries: [{ path: 'src/main.rs', line: index + 1 }] })) };
  const view = renderGraphView({ id: 'native-fan-in', aspect: 'object', objectId: 'component', feature: 'fixture', label: '共享组件', summary: '完整一跳关系。' }, graph, registry, [{ id: 'fixture', label: '示例' }]);
  const compiled = await compileFixture(view, graph, 'fan-in', registry);
  assert.equal(compiled.links.length, 17);
});

test('Rust lifetime, underscore and pointer symbols remain literal through native Markdown labels', { skip: !chromium, timeout: 180000 }, async () => {
  const name = "(bevy_ecs::system::Local<'_, alloc::vec::Vec<input_binding_>>, Query<'_, '_, (&action_state_, *const raw_value_, *mut *const Other_)>)";
  const registry = { literal: { id: 'literal', kind: 'System', feature: 'fixture', name,
    description: '按上下文求值输入并更新动作状态。', display_summary: '求值输入并更新动作状态。' } };
  const graph = { centerNodeId: 'literal', nodes: [{ id: 'literal', role: 'internal', group: '当前对象' }], links: [] };
  const view = renderGraphView({ id: 'native-lifetime-literals', aspect: 'object', objectId: 'literal',
    feature: 'fixture', label: name, summary: '完整系统名称。' }, graph, registry, [{ id: 'fixture', label: '示例' }]);
  const compiled = await compileFixture(view, graph, 'lifetime-literals', registry);
  assert.equal(compiled.nodes[0].displayLabel, view.nodes[0].displayLabel);
});

test('captured entity Name expressions preserve quotes and literal escapes in native SVG labels', { skip: !chromium, timeout: 180000 }, async () => {
  const records = [
    ['entity-688c484938d1bc3da575b848', 'format!("Menu button: {title}")'],
    ['entity-0097372e0c50008e9e475029', 'format!("Volume row: {title}")'],
    ['entity-02cc770652a42b7fa22de70a', 'Menu button icon container'],
    ['quoted-underscore', 'HUD::状态 "active"_label'],
    ['quoted-generic', `format!("&mut Vec<T> for 'a")`],
    ['quoted-braces', '"quote" and {outer}'],
    ['quoted-escape', String.raw`Name("first \" second")`],
    ['literal-escape', String.raw`literal \n \u0022`],
  ];
  const registry = Object.fromEntries(records.map(([id, name]) => [id, { id, kind: 'Entity', name, feature: 'ui' }]));
  const graph = { centerNodeId: records[2][0], nodes: records.map(([id]) => ({ id, role: 'internal' })), links: [
    { id: 'relation-2f94ad76abbcc3cfd0e5674d', from: records[0][0], to: records[2][0], kind: 'relationship' },
  ] };
  const view = renderGraphView({ id: 'native-entity-name-expressions', aspect: 'object', objectId: graph.centerNodeId,
    feature: 'ui', label: 'Entity Name expressions', summary: '实体创建名称与直接关系。' }, graph, registry, [{ id: 'ui', label: 'ui' }]);
  const before = structuredClone({ registry, graph, view });
  fs.mkdirSync(temporary, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true });
  try {
    const captured = renderGraphView({ ...view, id: 'native-captured-name-expressions' }, { ...graph, nodes: graph.nodes.slice(0, 3) }, registry, [{ id: 'ui', label: 'ui' }]);
    const native = await compileNativeView(browser, captured, registry);
    assert.deepEqual(nativeLabelMismatches(native), [], 'Native SVG must contain the original quotes, braces and backslashes');
    const compiled = await compileRoutedView(view, registry, (candidate, entries) => compileNativeView(browser, candidate, entries));
    assert.deepEqual(compiled.nodes.map(node => node.displayLabel), records.map(([, name]) => name));
    assert.deepEqual(compiled.links, view.links);
    checkMermaidGeometry(compiled.svg, compiled); checkMermaidStyles(compiled, registry);
    assert.deepEqual(nativeLabelMismatches(compiled), []);
    assert.deepEqual({ registry, graph, view }, before);
    fs.writeFileSync(path.join(temporary, 'entity-name-expressions.svg'), compiled.svg);
  } finally { await browser.close(); }
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

test('short SVG titles retain full provenance, distinct callable identities and escaped type structure', { skip: !chromium, timeout: 180000 }, async () => {
  const cases = [
    ['System', 'demo::settings::frame_pacing::log_simulation_timestep', 'log_simulation_timestep'],
    ['System', 'bevy_asset::Assets<dep::First>::asset_events_condition', 'asset_events_condition'],
    ['System', 'bevy_asset::Assets<dep::Second>::asset_events_condition', 'asset_events_condition'],
    ['Observer', 'demo::register<dep::T>::{{closure}}', 'register::{{closure}}'],
    ['Resource', 'bevy_asset::Assets<dep::Wrapper<dep::T>>', 'Assets<Wrapper<T>>'],
    ['Component', "&'a mut dep::Type<(dep::T, [dep::U; 4])>", "&'a mut Type<(T, [U; 4])>"],
    ['SystemSet', 'ExitSchedules(PhantomData<demo::game_flow::AppState>)', 'ExitSchedules(PhantomData<AppState>)'],
    ['Entity', '角色业务根实体', '角色业务根实体'],
    ['Local', '方向更新 Local 私有状态', '方向更新 Local 私有状态'],
  ];
  const registry = Object.fromEntries(cases.map(([kind, name], index) => ['sample-' + index, { kind, name, description: '保留完整类型与原始注册身份。', feature: 'fixture' }]));
  const graph = { centerNodeId: 'sample-0', nodes: Object.keys(registry).map(id => ({ id, role: 'internal' })), links: [] };
  const view = renderGraphView({ id: 'native-short-titles', aspect: 'object', objectId: 'sample-0', label: '短显示名', summary: '完整身份不变。' }, graph, registry, []);
  const before = structuredClone({ graph, registry, view });
  const directory = fileURLToPath(new URL('../../../tmp/ecs-architecture/card-display-fix/names/', import.meta.url));
  fs.mkdirSync(directory, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: fs.mkdtempSync(path.join(directory, 'profile-')) });
  try {
    const result = await compileRoutedView(view, registry, (candidate, records) => compileNativeView(browser, candidate, records));
    assert.deepEqual(result.nodes.map(node => node.nameLabel), cases.map(([, , short]) => short));
    assert.deepEqual(result.nodes.map(node => node.id), graph.nodes.map(node => node.id));
    assert.deepEqual(nativeLabelMismatches(result), []);
    checkMermaidGeometry(result.svg, result); checkMermaidStyles(result, registry);
    const elements = svgElements(result.svg);
    for (const node of result.nodes) {
      const element = elements.find(item => item.attrs['data-id'] === node.id);
      assert.equal(element.attrs['aria-label'].split(' · ')[0], registry[node.id].name);
      assert.equal(element.children.find(item => item.tag === 'title').text, registry[node.id].name);
    }
    assert.deepEqual({ graph, registry, view }, before);
    fs.writeFileSync(path.join(directory, 'short-titles.svg'), result.svg);
  } finally { await browser.close(); }
});

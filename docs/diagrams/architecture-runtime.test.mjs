import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { buildArchitectureRuntimeAssets } from './architecture-runtime-assets.mjs';
import { renderGraphView } from './architecture-renderer.mjs';
import { inspectViewRoutes } from './architecture-routing.mjs';
import { checkMermaidGeometry } from './diagram-geometry.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const chromium = process.env.MERMAID_CHROMIUM_PATH || [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
  .filter(Boolean).flatMap(base => [path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe')])
  .find(candidate => fs.existsSync(candidate));

test('offline browser runtime compiles arbitrary Entity sets with native routing and no network', { skip: !chromium, timeout: 120000 }, async () => {
  const features = [{ id: 'runtime', label: '运行时测试' }], registry = {}, nodes = [], entityGroups = [];
  for (const id of ['alpha', 'beta', 'gamma']) {
    registry[id] = { id, kind: 'Entity', feature: 'runtime', name: id, description: '保存测试实体身份。' };
    registry[`${id}.Value`] = { id: `${id}.Value`, kind: 'Component', feature: 'runtime', name: `${id} Value`, description: '保存可读写的值。' };
    nodes.push({ id, role: 'internal' }, { id: `${id}.Value`, role: 'internal' });
    entityGroups.push({ id: `group-${id}`, entity: id, components: [`${id}.Value`] });
  }
  const base = renderGraphView({ id: 'runtime-offline-fixture', aspect: 'data', feature: 'runtime', label: '运行时测试', summary: '检查多个实体独立展开。' }, {
    nodes, entityGroups, links: [{ id: 'value-reference', from: 'alpha.Value', to: 'beta.Value', kind: 'reference' }],
  }, registry, features);
  const source = await buildArchitectureRuntimeAssets();
  assert.doesNotMatch(source, /<\/(?:script|body|head|html)(?=[\s>])/i, 'The inline bundle must not terminate its script or attract development-server injection');
  assert.ok(source.includes('architectureEntityRuntime'));
  const directory = path.join(root, 'tmp/ecs-architecture/multi-entity-runtime');
  fs.mkdirSync(directory, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: fs.mkdtempSync(path.join(directory, 'profile-')) });
  try {
    const page = await browser.newPage(), requests = [], errors = [];
    await page.setRequestInterception(true);
    page.on('request', request => { requests.push(request.url()); request.abort(); });
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"></head><body></body></html>');
    await page.addScriptTag({ content: source });
    const result = await page.evaluate(async ({ base, registry, features }) => {
      const expanded = await architectureEntityRuntime.compile(base, ['alpha', 'beta'], registry, features);
      const partial = await architectureEntityRuntime.compile(base, ['beta', 'gamma'], registry, features);
      return { expanded, partial, leftoverMeasurementHosts: document.querySelectorAll('[data-architecture-measurement]').length };
    }, { base, registry, features });
    assert.deepEqual(result.expanded.entityGroups.filter(group => group.expanded).map(group => group.entity), ['alpha', 'beta']);
    assert.deepEqual(result.partial.entityGroups.filter(group => group.expanded).map(group => group.entity), ['beta', 'gamma']);
    assert.equal(result.expanded.links[0].displayFrom, 'alpha.Value');
    assert.equal(result.partial.links[0].displayFrom, 'alpha');
    assert.equal(result.partial.links[0].displayTo, 'beta.Value');
    for (const view of [result.expanded, result.partial]) {
      assert.equal(view.routing.rule, 'axis-or-curve');
      assert.equal(inspectViewRoutes(view).collisions.length, 0);
      assert.ok(view.entityGroups.filter(group => group.expanded).every(group => group.headerBounds?.width));
      assert.doesNotMatch(view.svg, /data-entity-toggle-label|展开组件|收起组件/);
    }
    assert.equal(result.leftoverMeasurementHosts, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, [], 'All Mermaid code, renderers and geometry dependencies must already be embedded');
  } finally {
    await browser.close();
  }
});

test('offline native runtime handles multiple expanded groups across dense generated Bevy and UI views', { skip: !chromium, timeout: 360000 }, async t => {
  const html = fs.readFileSync(new URL('./ecs-architecture.html', import.meta.url), 'utf8');
  const data = JSON.parse(/<script id="architecture-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  const scenarios = [
    { name: 'Bevy related groups from scene assembly, window policy and UI', feature: 'infrastructure', ids: ['entity-visual', 'entity-window', 'entity-menu_scroll'] },
    { name: 'Bevy five dense groups preserve canonical component order and unrelated groups remain collapsed', feature: 'infrastructure', ids: ['entity-character', 'entity-model_node', 'entity-menu_button', 'entity-menu_scroll', 'entity-settings_scrollbar_thumb'] },
    { name: 'UI navigation groups preserve their component relationship endpoints', feature: 'ui', ids: ['entity-menu_root', 'entity-menu_button', 'entity-menu_scroll'] },
    { name: 'UI five settings and text groups route through the complete existing relation network', feature: 'ui', ids: ['entity-menu_root', 'entity-menu_text', 'entity-settings_panel', 'entity-settings_scrollbar', 'entity-settings_scrollbar_thumb'] },
    { name: 'parcel and character expand independently while their proxy remains collapsed', feature: 'item_interaction', ids: ['entity-character', 'entity-parcel'] },
    { name: 'parcel and attachment proxy expand independently while character remains collapsed', feature: 'item_interaction', ids: ['entity-parcel', 'entity-held_proxy'] },
    { name: 'complete Bevy components compile offline beyond the former fifty thousand character limit', feature: 'infrastructure', complete: true,
      ids: data.views.find(view => view.feature === 'infrastructure' && view.aspect === 'data').entityGroups.map(group => group.entity) },
  ];
  const directory = path.join(root, 'tmp/ecs-architecture/multi-entity-runtime');
  fs.mkdirSync(directory, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: fs.mkdtempSync(path.join(directory, 'dense-profile-')), protocolTimeout: 180000 });
  try {
    const page = await browser.newPage(), requests = [], errors = [];
    await page.setOfflineMode(true);
    await page.setRequestInterception(true);
    page.on('request', request => { requests.push(request.url()); request.abort(); });
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"></head><body></body></html>');
    await page.addScriptTag({ content: await buildArchitectureRuntimeAssets() });
    for (const scenario of scenarios) await t.test(scenario.name, { timeout: 120000 }, async () => {
      const { entityViews, ...base } = data.views.find(view => view.feature === scenario.feature && view.aspect === 'data');
      assert.ok(scenario.complete ? base.entityGroups.length === scenario.ids.length : base.entityGroups.length > scenario.ids.length);
      assert.ok(scenario.ids.every(id => base.entityGroups.some(group => group.entity === id)));
      const result = await page.evaluate(async ({ base, ids, registry, features }) => architectureEntityRuntime.compile(base, ids, registry, features), {
        base, ids: scenario.ids, registry: data.registry, features: data.model.features,
      });
      assert.deepEqual(result.entityGroups.filter(group => group.expanded).map(group => group.entity), base.entityGroups.filter(group => scenario.ids.includes(group.entity)).map(group => group.entity));
      const hidden = new Map(base.entityGroups.filter(group => !scenario.ids.includes(group.entity)).flatMap(group => group.components.map(id => [id, group.entity])));
      assert.deepEqual(result.nodes.map(node => node.id), base.nodes.filter(node => !hidden.has(node.id)).map(node => node.id));
      assert.deepEqual(result.links.map(link => [link.id, link.from, link.to]), base.links.map(link => [link.id, link.from, link.to]));
      for (const link of result.links) {
        assert.equal(link.displayFrom, hidden.get(link.from) || link.from);
        assert.equal(link.displayTo, hidden.get(link.to) || link.to);
      }
      assert.equal(result.routing.rule, 'axis-or-curve');
      if (scenario.complete) assert.ok(result.mermaid.length > 50000);
      assert.deepEqual(inspectViewRoutes(result).collisions, []);
      assert.doesNotThrow(() => checkMermaidGeometry(result.svg, result));
      assert.ok(result.entityGroups.filter(group => group.expanded).every(group => group.headerBounds?.width > 0 && group.headerBounds?.height > 0));
      assert.equal(await page.$$eval('[data-architecture-measurement]', nodes => nodes.length), 0);
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, [], 'Dense native graph compilation must stay entirely offline');
  } finally {
    await browser.close();
  }
});

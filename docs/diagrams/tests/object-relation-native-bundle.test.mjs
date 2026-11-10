import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { DOMParser } from '@xmldom/xmldom';
import { objectRelationRuntimeAssets } from '../src/object-relation-runtime-assets.mjs';
import { checkMermaidGeometry } from '../src/diagram-geometry.mjs';
import { nativeLabelMismatches } from '../src/mermaid-core.mjs';
import { inspectViewRoutes } from '../src/architecture-routing.mjs';
import { validateArchitectureSvg } from '../src/architecture-asset-loader.mjs';

const chromium = process.env.MERMAID_CHROMIUM_PATH || [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
  .filter(Boolean).flatMap(base => [path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe')])
  .find(candidate => fs.existsSync(candidate));
const repository = fileURLToPath(new URL('../../../', import.meta.url));

// 静态夹具来自真实对象目录；此测试只编译空白文档中的 SVG，不访问正式查看器或 generated。
test('the shipped object relation bundle compiles described, reverse and long-generic relations without visible labels offline', { skip: !chromium, timeout: 180000 }, async t => {
  const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/object-relations-native.json', import.meta.url), 'utf8'));
  const generic = JSON.parse(fs.readFileSync(new URL('./fixtures/object-relations.json', import.meta.url), 'utf8'));
  assert.equal(captured.provenance.buildId, generic.provenance.buildId);
  const cases = [...captured.cases, { key: 'long-generic', view: generic.view, relationId: generic.view.links[0].id }];
  const registry = { ...generic.registry, ...captured.registry };
  assert.ok(cases[0].view.nodes.some(node => registry[node.id].name === 'bevy_ecs::name::Name'));
  assert.ok(cases[0].view.links[0].displayLabel);
  assert.equal(cases[1].view.links[0].nativeReverse, true);
  assert.ok(captured.cases.every(entry => entry.view.links[0].sourceEntries.length > 0));
  assert.ok(registry[generic.view.centerNodeId].name.length > 200);
  const { module: moduleSource } = await objectRelationRuntimeAssets();
  const temporary = path.join(repository, 'tmp/native-object-relation-tests');
  fs.mkdirSync(temporary, { recursive: true });
  const runDirectory = fs.mkdtempSync(path.join(temporary, 'bundle-'));
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: path.join(runDirectory, 'profile') });
  const requests = [];
  let rendered;
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => { requests.push(request.url()); void request.abort().catch(() => {}); });
    await page.setContent('<!doctype html><html><body></body></html>');
    rendered = await page.evaluate(async ({ moduleSource, cases, registry, features, buildId }) => {
      const url = URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' }));
      const before = JSON.stringify({ cases, registry });
      let renderer;
      try {
        const runtime = await import(url);
        renderer = runtime.createObjectRelationRenderer({ registry, features, buildId, document });
        const results = [];
        for (const entry of cases) {
          // 与业务 view.id 相同的旧 SVG 能捕获错误的全局选择器和 DOM 编译身份复用。
          const sentinel = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          sentinel.setAttribute('id', entry.view.id);
          sentinel.setAttribute('viewBox', '0 0 13 17');
          sentinel.innerHTML = '<g class="node"><rect width="13" height="17"/><text>Unrelated old SVG</text></g>';
          document.body.appendChild(sentinel);
          const previous = sentinel.outerHTML;
          const compiled = await renderer.render(entry.view, entry.relationId);
          const cached = await renderer.render(entry.view, entry.relationId);
          const preview = document.createElement('div');
          preview.innerHTML = compiled.svg;
          document.body.appendChild(preview);
          const edgeLabels = [...preview.querySelectorAll('.edgeLabel text,.edge-label text')].map(text => text.textContent.trim()).filter(Boolean);
          results.push({ key: entry.key, compiled, cachedSame: cached === compiled, edgeLabels,
            compilerContainers: document.querySelectorAll('[data-object-relation-compiler]').length,
            sentinelUnchanged: document.getElementById(entry.view.id) === sentinel && sentinel.outerHTML === previous });
          preview.remove(); sentinel.remove();
        }
        return { results, factsUnchanged: JSON.stringify({ cases, registry }) === before };
      } finally {
        renderer?.dispose(); URL.revokeObjectURL(url);
      }
    }, { moduleSource, cases, registry, features: generic.features, buildId: captured.provenance.buildId });
    assert.equal(await page.$$eval('[data-object-relation-compiler]', elements => elements.length), 0);
    await page.close();
  } finally {
    await browser.close();
  }
  assert.deepEqual(requests, [], 'The complete shipped bundle must not request scripts, fonts or other external resources');
  assert.equal(rendered.factsUnchanged, true, 'Native compilation must not mutate the captured facts');
  const nativeIds = new Set();
  for (const [index, result] of rendered.results.entries()) await t.test(result.key, () => {
    const input = cases[index], original = input.view.links.find(link => link.id === input.relationId), view = result.compiled;
    const endpointIds = [...new Set([original.displayFrom ?? original.from, original.displayTo ?? original.to])];
    assert.equal(view.id, input.view.id);
    assert.equal(view.presentation, 'relation');
    assert.equal(view.relationId, original.id);
    assert.notEqual(view.nativeRenderId, view.id);
    assert.ok(!nativeIds.has(view.nativeRenderId)); nativeIds.add(view.nativeRenderId);
    assert.deepEqual(view.nodes.map(node => node.id).sort(), endpointIds.sort());
    assert.equal(view.links.length, 1);
    // Mermaid 的局部 e0 身份允许重排；原关系字段、方向、操作和全部证据逐项不变。
    const semanticFields = Object.keys(original).filter(field => field !== 'mermaidId');
    assert.deepEqual(Object.fromEntries(semanticFields.map(field => [field, view.links[0][field]])),
      Object.fromEntries(semanticFields.map(field => [field, original[field]])));
    assert.ok(original.evidence);
    assert.ok(Array.isArray(original.sourceEntries) || Array.isArray(original.sourceEvidence));
    assert.equal(result.cachedSame, true);
    assert.equal(result.compilerContainers, 0);
    assert.equal(result.sentinelUnchanged, true);
    validateArchitectureSvg(view.svg, { DOMParser });
    checkMermaidGeometry(view.svg, view);
    assert.deepEqual(nativeLabelMismatches(view), []);
    const inspection = inspectViewRoutes(view);
    assert.equal(inspection.edges.length, 1);
    assert.deepEqual(inspection.collisions, []);
    assert.ok(inspection.edges.every(edge => !edge.arrowIssues.length && !edge.clearanceIssues.length && (edge.axis ? !edge.curved : edge.curved)));
    assert.deepEqual(result.edgeLabels, []);
    fs.writeFileSync(path.join(runDirectory, result.key + '.svg'), view.svg);
  });
});

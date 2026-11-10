import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { architectureBrowserPath } from '../src/architecture-browser.mjs';
import { renderArchitectureViewer } from '../src/architecture-viewer.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, EXTERNAL_REFERENCE_STYLE } from '../src/architecture-style.mjs';

function viewerPage() {
  const nodes = ['first', 'second'].map((id, index) => ({ id, instance: 'native-' + id, visualType: 'system',
    position: { x: 20 + index * 380, y: 60, width: 180, height: 80 } }));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" id="hit-fixture" viewBox="0 0 620 200" width="620" height="200">'
    + '<defs><marker id="head" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto"><path d="M0 0L6 3L0 6Z" fill="#334155"/></marker></defs>'
    + '<g><path class="edge" data-link-id="order" data-connect="first|second" d="M200 100L400 100" fill="none" stroke="#334155" stroke-width="2" stroke-dasharray="6 4" marker-end="url(#head)" role="button" tabindex="0" aria-label="执行依赖"/></g>'
    + nodes.map(node => '<g class="node" data-id="' + node.id + '" data-instance="' + node.instance + '" data-visual-type="system" role="button" tabindex="0">'
      + '<rect data-shape-part="' + node.instance + '" x="' + node.position.x + '" y="60" width="180" height="80" fill="#EEF3F8" stroke="#3567A6"/>'
      + '<g class="label"><text x="' + (node.position.x + 25) + '" y="105">' + node.id + '</text></g></g>').join('') + '</svg>';
  const view = { id: 'object-first', aspect: 'object', engine: 'mermaid', objectId: 'first', centerNodeId: 'first', feature: 'demo',
    label: 'first', nodes, links: [{ id: 'order', from: 'first', to: 'second', kind: 'order', edgeSemantic: 'order', displayLabel: '执行依赖' }],
    scheduleLinks: [], scheduleGroups: [], sections: [], svg, width: 620, height: 200, bounds: { x: 0, y: 0, width: 620, height: 200 } };
  return renderArchitectureViewer({ model: { features: [], entities: [] }, features: [], views: [view],
    registry: Object.fromEntries(nodes.map(node => [node.id, { id: node.id, name: node.id, kind: 'System', feature: 'demo', sourceEntries: [] }])),
    objects: [{ id: 'first', viewId: view.id, kind: 'System', feature: 'demo' }], infrastructureFeatures: [],
    guideSamples: { nodes: { system: '<svg></svg>' }, edges: { order: '<svg></svg>' } },
    styles: { nodes: NODE_STYLES, edges: EDGE_STYLES, selection: SELECTION_STYLE, externalReference: EXTERNAL_REFERENCE_STYLE } });
}

test('unlabelled edge hit areas select on mouse release while native cards and one keyboard target retain priority', { timeout: 60000 }, async () => {
  const html = viewerPage();
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: architectureBrowserPath(), headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto('http://127.0.0.1:' + server.address().port + '/pages/ecs-architecture.html?object=first');
    await page.waitForSelector('[data-link-hit-id="order"]');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const probe = await page.evaluate(() => {
      const path = document.querySelector('path[data-link-id="order"]');
      const hit = document.querySelector('[data-link-hit-id="order"]');
      const point = path.getPointAtLength(path.getTotalLength() / 2);
      const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM());
      return { x: screen.x, y: screen.y, width: getComputedStyle(hit).strokeWidth, nativeCount: document.querySelectorAll('[data-link-id]').length,
        keyboardCount: document.querySelectorAll('path[data-link-id][tabindex="0"]').length,
        hitTabIndex: hit.getAttribute('tabindex'), labels: document.querySelectorAll('#diagram .edgeLabel').length,
        target: document.elementFromPoint(screen.x, screen.y + 4)?.outerHTML };
    });
    assert.equal(probe.width, '12px');
    assert.equal(probe.nativeCount, 1);
    assert.equal(probe.keyboardCount, 1);
    assert.equal(probe.hitTabIndex, null);
    assert.equal(probe.labels, 0);
    assert.ok(probe.target.includes('data-link-hit-id="order"'), JSON.stringify(probe));
    await page.mouse.click(probe.x, probe.y + 4);
    await page.waitForFunction(() => document.querySelector('#details .badge')?.textContent === '执行依赖');
    await page.$eval('[data-link-id="order"]', element => element.focus());
    await page.keyboard.press('Space');
    assert.equal(await page.$eval('#details .badge', element => element.textContent), '执行依赖');
    for (const [button, steps, expectedZoom] of [['zoom-out', 18, '8%'], ['zoom-in', 30, '240%'], ['fit', 1, '100%']]) {
      await page.evaluate(({ button, steps }) => {
        for (let index = 0; index < steps; index++) document.getElementById(button).click();
      }, { button, steps });
      assert.equal(await page.$eval('#zoom-label', element => element.textContent), expectedZoom);
      const point = await page.$eval('[data-link-id="order"]', path => {
        const center = path.getPointAtLength(path.getTotalLength() / 2);
        const screen = new DOMPoint(center.x, center.y).matrixTransform(path.getScreenCTM());
        return { x: screen.x, y: screen.y, target: document.elementFromPoint(screen.x, screen.y + 4)?.getAttribute('data-link-hit-id') };
      });
      assert.equal(point.target, 'order', expectedZoom);
      await page.mouse.click(point.x, point.y + 4);
      assert.equal(await page.$eval('#details .badge', element => element.textContent), '执行依赖');
    }
    const cardPoint = await page.$eval('[data-id="first"] rect', element => {
      const box = element.getBoundingClientRect();
      return { x: box.right - 2, y: box.top + box.height / 2 };
    });
    await page.mouse.click(cardPoint.x, cardPoint.y);
    await page.waitForFunction(() => document.querySelector('#details h2')?.textContent === 'first');
    assert.equal(await page.$('#details .badge'), null);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});

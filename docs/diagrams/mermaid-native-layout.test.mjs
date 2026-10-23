import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { buildArchitectureModel } from './architecture-model.mjs';
import { entityComponentColumns, renderGraphView } from './architecture-renderer.mjs';
import { inspectViewRoutes } from './architecture-routing.mjs';
import { checkMermaidGeometry } from './diagram-geometry.mjs';
import { compileNativeView } from './mermaid-compiler.mjs';
import { compileRoutedView } from './mermaid-core.mjs';

const chromium = process.env.MERMAID_CHROMIUM_PATH || [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
  .filter(Boolean).flatMap(base => [path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe')])
  .find(candidate => fs.existsSync(candidate));
const architecture = buildArchitectureModel(JSON.parse(fs.readFileSync(new URL('./ecs-data.json', import.meta.url), 'utf8')));
const temporary = fileURLToPath(new URL('../../tmp/ecs-architecture/native-layout-tests/', import.meta.url));

for (const { feature, expansion } of [{ feature: 'item_interaction' }, { feature: 'ui' }, { feature: 'item_interaction', expansion: 'entity-parcel' }, { feature: 'first_person', expansion: 'entity-camera' }]) test(`${expansion || 'complete'} ${feature} Entity relationships compile with native labels, arrowheads and canonical component order`, { skip: !chromium, timeout: 120000 }, async () => {
  const base = renderGraphView({ id: `plugin-${feature}-data`, feature, aspect: 'data', label: '数据与实体', summary: '原生实体关系回归。' },
    architecture.graphFor(feature, 'data'), architecture.registry, architecture.features);
  const view = expansion ? base.entityViews[expansion] : base;
  const original = JSON.stringify(view);
  fs.mkdirSync(temporary, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: fs.mkdtempSync(path.join(temporary, `${feature}-`)) });
  try {
    let failedAttempts = 0;
    const result = await compileRoutedView(view, architecture.registry, (candidate, registry) => compileNativeView(browser, candidate, registry), {
      onAttempt: () => {
        failedAttempts++;
        if (expansion === 'entity-camera') assert.ok(failedAttempts <= 8, 'The known native wide-context candidate must precede exhaustive layout retries');
      },
    });
    assert.equal(JSON.stringify(view), original, 'Rejected candidates must not change the canonical definition or its cached variants');
    assert.deepEqual(result.nodes.map(node => node.id), view.nodes.map(node => node.id));
    assert.deepEqual(result.links, view.links);
    assert.deepEqual(result.entityGroups.map(group => [group.id, group.entity, group.components]), view.entityGroups.map(group => [group.id, group.entity, group.components]));
    if (expansion) assert.deepEqual(result.entityGroups.filter(group => group.expanded).map(group => group.entity), [expansion]);
    if (expansion === 'entity-parcel') {
      assert.deepEqual(result.entityGroups.map(group => [group.entity, group.expanded]), [['entity-character', false], ['entity-parcel', true], ['entity-held_proxy', false]]);
      const visibleComponents = result.nodes.filter(node => node.visualType === 'component').map(node => node.id);
      assert.equal(visibleComponents.length, 50);
      assert.deepEqual(new Set(visibleComponents), new Set(result.entityGroups.find(group => group.entity === expansion).components));
      assert.ok(result.nodes.filter(node => node.visualType === 'entity' && node.id !== expansion).every(node => node.presentation === 'entity-collapsed'));
      const page = await browser.newPage();
      try {
        await page.setContent(result.svg);
        const sourceGap = await page.evaluate(() => {
          const svg = document.querySelector('svg'), path = svg.querySelector('[data-link-id="held_by"]');
          const source = svg.querySelector('[data-id="entity-parcel"]'), rect = [...source.children].find(child => child.hasAttribute('data-shape-part'));
          const transform = svg.getCTM().inverse(), point = path.getPointAtLength(0), box = rect.getBBox();
          const start = new DOMPoint(point.x, point.y).matrixTransform(transform.multiply(path.getCTM()));
          const corners = [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]]
            .map(([x, y]) => new DOMPoint(x, y).matrixTransform(transform.multiply(rect.getCTM())));
          return Math.min(...corners.map((first, index) => {
            const last = corners[(index + 1) % corners.length], dx = last.x - first.x, dy = last.y - first.y;
            const ratio = Math.max(0, Math.min(1, ((start.x - first.x) * dx + (start.y - first.y) * dy) / (dx * dx + dy * dy)));
            return Math.hypot(start.x - first.x - ratio * dx, start.y - first.y - ratio * dy);
          }));
        });
        assert.ok(sourceGap <= .5, `HeldBy must start at the real Parcel border, not its transparent wrapper (${sourceGap})`);
      } finally { await page.close(); }
    }
    assert.equal(result.routing.rule, 'axis-or-curve');
    assert.doesNotThrow(() => checkMermaidGeometry(result.svg, result));
    const inspection = inspectViewRoutes(result);
    assert.deepEqual(inspection.collisions, []);
    assert.ok(inspection.edges.every(edge => !edge.arrowIssues.length && (edge.axis ? !edge.curved : edge.curved)), 'Every actual native path and marker must meet the shared routing rule');
    for (const group of result.entityGroups.filter(group => group.expanded !== false)) {
      assert.ok(group.headerBounds.width > 0 && group.headerBounds.height > 0);
      const columns = entityComponentColumns(group.components).map(column => column.map(id => result.nodes.find(node => node.id === id).position));
      const lefts = columns.map(column => Math.min(...column.map(box => box.x)));
      assert.ok(lefts.every((left, index) => !index || left > lefts[index - 1] + .05));
      for (const column of columns) {
        assert.ok(column[0].y >= group.headerBounds.y + group.headerBounds.height - .05);
        assert.ok(column.every((box, index) => !index || box.y >= column[index - 1].y + column[index - 1].height - .05));
      }
    }
    fs.writeFileSync(path.join(temporary, `${feature}${expansion ? `-${expansion}` : ''}.svg`), result.svg);
  } finally {
    await browser.close();
  }
});

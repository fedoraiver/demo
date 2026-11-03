import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { instance } from '@viz-js/viz';
import { DOMParser } from '@xmldom/xmldom';
import { parseScheduleGraph, scheduleGraphInput, scheduleGraphFacts, scheduleNodeKind } from '../src/schedule-graph.mjs';
import { normalizeScheduleSvg } from '../src/debugdump.mjs';
import { SCHEDULE_THEME } from '../src/schedule-theme.mjs';
import { svgElements, flattenShape, shapeBounds } from '../src/svg-shape-geometry.mjs';
import { pathIntersectsOutline } from '../src/architecture-routing.mjs';
import { validateArchitectureSvg } from '../src/architecture-asset-loader.mjs';
import { repositoryRoot } from '../src/paths.mjs';

const temporary = path.join(repositoryRoot, 'tmp/ecs-architecture/continuation/graphviz-native-visual');
const chromium = process.env.MERMAID_CHROMIUM_PATH || [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
  .filter(Boolean).flatMap(base => [path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe')])
  .find(candidate => fs.existsSync(candidate));
const fixtures = [['postupdate', 'native-postupdate.dot'], ['render', 'native-render.dot']];

async function compileFixtures() {
  const viz = await instance();
  return fixtures.map(([name, filename]) => {
    const dot = fs.readFileSync(new URL('./fixtures/' + filename, import.meta.url), 'utf8'), model = parseScheduleGraph(viz, dot);
    const before = scheduleGraphFacts(model), input = scheduleGraphInput(model, SCHEDULE_THEME);
    const svg = normalizeScheduleSvg(viz.renderString(input, { engine: 'dot', format: 'svg' }), 'schedule-native-' + name).svg;
    assert.equal(scheduleGraphFacts(model), before, 'Native presentation cannot mutate the parsed DOT facts');
    validateArchitectureSvg(svg, { DOMParser });
    return { name, dot, model, input, svg };
  });
}

test('complete captured PostUpdate and Render graphs preserve every identity and avoid the target-card spline intrusion', async () => {
  for (const fixture of await compileFixtures()) {
    const document = new DOMParser().parseFromString(fixture.svg, 'image/svg+xml');
    const groups = [...document.getElementsByTagName('g')], titles = className => groups.filter(group => group.getAttribute('class') === className)
      .map(group => [...group.childNodes].find(child => child.localName === 'title')?.textContent).sort();
    assert.deepEqual(titles('node'), fixture.model.nodes.filter(node => scheduleNodeKind(node) !== 'marker').map(node => node.name).sort());
    assert.deepEqual(titles('edge'), fixture.model.edges.map(edge => edge.tail + '->' + edge.head).sort());
    assert.equal(fixture.input.graphAttributes.splines, 'polyline');
    if (fixture.name !== 'postupdate') continue;
    const elements = svgElements(fixture.svg), group = (kind, title) => elements.find(element => element.tag === 'g' && element.attrs.class === kind
      && element.children.some(child => child.tag === 'title' && child.text === title));
    const target = group('node', 'node_System(SystemKey(57v1))'), edge = group('edge', 'node_System(SystemKey(60v1))->node_System(SystemKey(57v1))');
    const ownedPath = owner => elements.find(element => element.tag === 'path' && element.parent?.parent?.parent === owner);
    const outline = ownedPath(target), path = ownedPath(edge);
    assert.ok(outline && path);
    assert.equal(pathIntersectsOutline(flattenShape(path), { bounds: shapeBounds(outline), parts: [{ contours: flattenShape(outline), strokeWidth: 1.6 }] }), false,
      'The actual incoming dependency must not enter the target card before its arrow');
  }
});

test('actual Chromium glyph bounds fit native cluster-title backgrounds on both complete captured graphs', { skip: !chromium, timeout: 120000 }, async () => {
  fs.mkdirSync(temporary, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: fs.mkdtempSync(path.join(temporary, 'chrome-')) });
  try {
    for (const fixture of await compileFixtures()) {
      const filename = path.join(temporary, fixture.name + '.svg'); fs.writeFileSync(filename, fixture.svg);
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: 1600, height: 1000 }); await page.goto(pathToFileURL(filename).href); await page.evaluate(() => document.fonts.ready);
        const proof = await page.evaluate(() => [...document.querySelectorAll('.schedule-cluster-title')].map(layer => {
          const polygon = layer.querySelector('polygon'), background = polygon.getBBox();
          return { id: layer.dataset.clusterName, background: { x: background.x, y: background.y, width: background.width, height: background.height },
            texts: [...layer.querySelectorAll('text')].map(text => { const box = text.getBBox(); return { text: text.textContent, x: box.x, y: box.y, width: box.width, height: box.height }; }) };
        }));
        fs.writeFileSync(path.join(temporary, fixture.name + '-glyphs.json'), JSON.stringify(proof, null, 2) + '\n');
        assert.ok(proof.length);
        for (const layer of proof) for (const text of layer.texts) {
          const box = layer.background;
          assert.ok(text.x >= box.x && text.y >= box.y && text.x + text.width <= box.x + box.width && text.y + text.height <= box.y + box.height,
            'Native title background must cover actual glyph bounds: ' + fixture.name + '/' + layer.id + '/' + JSON.stringify({ text, box }));
        }
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});

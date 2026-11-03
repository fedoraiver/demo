import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { DOMParser } from '@xmldom/xmldom';
import { normalizeMermaidSvg } from '../src/mermaid-core.mjs';
import { computeObjectFocus } from '../src/architecture-focus.mjs';
import { architectureInteractionAssets } from '../src/architecture-interaction.mjs';
import { NODE_STYLES } from '../src/architecture-style.mjs';
import { repositoryRoot } from '../src/paths.mjs';

const temporary = path.join(repositoryRoot, 'tmp/ecs-architecture/card-display-fix/focus');
const chromium = process.env.MERMAID_CHROMIUM_PATH || [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
  .filter(Boolean).flatMap(base => [path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe')])
  .find(candidate => fs.existsSync(candidate));

function starFixture() {
  const ids = ['s1', 's2', 's3', 'resource', 'condition'];
  const nodes = ids.map((id, index) => ({ id, instance: id, mermaidId: 'n' + index, visualType: index < 3 || index === 4 ? 'system' : 'resource', role: 'internal', shape: 'rect' }));
  const links = ids.slice(0, 3).map((id, index) => ({ id: id + '-resource', from: id, to: 'resource', mermaidId: 'e' + index, kind: 'read', edgeSemantic: 'read' }));
  links.push({ id: 'resource-condition', from: 'resource', to: 'condition', mermaidId: 'e3', kind: 'read', edgeSemantic: 'read' });
  const view = { id: 'focus-star', aspect: 'object', nodes, links, layoutLinks: [], scheduleLinks: [], scheduleGroups: [], entityGroups: [] };
  const positions = [[20, 30], [20, 110], [20, 190], [230, 110], [450, 110]];
  const routes = ['M100,50 L170,50 L170,120 L230,120', 'M100,130 L230,130', 'M100,210 L170,210 L170,140 L230,140', 'M310,130 L450,130'];
  const labels = [[125, 25], [125, 105], [125, 185], [360, 105]];
  const source = '<svg xmlns="http://www.w3.org/2000/svg" id="focus-star" viewBox="0 0 560 260">'
    + '<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="#111111"/></marker></defs>'
    + nodes.map((node, index) => `<g class="node" id="flowchart-${node.mermaidId}-0" transform="translate(${positions[index]})"><rect width="80" height="40" fill="#111111" stroke="#111111"/><g class="label"><text x="5" y="25" fill="white">${node.id}</text></g></g>`).join('')
    + links.map((link, index) => `<path data-id="${link.mermaidId}" d="${routes[index]}" fill="none" stroke="#111111" stroke-width="4" marker-end="url(#arrow)"/>`
      + `<g class="edgeLabel" transform="translate(${labels[index]})"><g class="label" data-id="${link.mermaidId}"><rect class="background" width="45" height="18" fill="#111111"/><text x="2" y="13" fill="white">read</text></g></g>`).join('') + '</svg>';
  const registry = Object.fromEntries(ids.map(id => [id, { name: id, feature: 'fixture', description: '聚焦测试。' }]));
  return normalizeMermaidSvg(view, source, registry);
}

async function installInteraction(page, view, svg = view.svg) {
  await page.setContent(svg);
  await page.addScriptTag({ content: architectureInteractionAssets().script + '\n' + computeObjectFocus.toString() });
  await page.evaluate(({ view, nodeStyles }) => {
    window.focusView = view;
    window.focusInteraction = createArchitectureInteraction({ diagram: document.querySelector('svg'), nodeStyles });
  }, { view, nodeStyles: NODE_STYLES });
}

async function paintAndMeasure(page, selection) {
  return page.evaluate(async selection => {
    focusInteraction.paint(computeObjectFocus(focusView, selection));
    const svg = document.querySelector('svg');
    const effectiveOpacity = element => {
      let value = 1;
      for (let current = element; current instanceof Element; current = current.parentElement) value *= Number(getComputedStyle(current).opacity);
      return value;
    };
    const edges = [...svg.querySelectorAll('.edge')].map(path => {
      const label = [...svg.querySelectorAll('.edge-label')].find(label => label.dataset.linkId === path.dataset.linkId);
      const markerId = /#([^)"]+)/.exec(path.getAttribute('marker-end'))[1], marker = svg.querySelector('#' + markerId + ' path');
      return { id: path.dataset.linkId, path: effectiveOpacity(path), arrow: effectiveOpacity(path) * effectiveOpacity(marker), label: label && effectiveOpacity(label.querySelector('text')), background: label && effectiveOpacity(label.querySelector('rect')) };
    });
    const source = new XMLSerializer().serializeToString(svg), blob = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
    const image = new Image(); image.src = blob; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 560; canvas.height = 260;
    const context = canvas.getContext('2d'); context.fillStyle = '#F6F8FB'; context.fillRect(0, 0, 560, 260); context.drawImage(image, 0, 0); URL.revokeObjectURL(blob);
    const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data];
    return {
      nodes: [...svg.querySelectorAll('[data-id]')].map(node => ({ id: node.dataset.id, opacity: effectiveOpacity(node.querySelector('[data-shape-part]')), textOpacity: effectiveOpacity(node.querySelector('text')) })),
      edges, rings: svg.querySelectorAll('[data-selection-filter]').length,
      pixels: { dimArrow: pixel(225, 120), dimPath: pixel(150, 130), dimBackground: pixel(126, 26), dimCard: pixel(25, 35), clearArrow: pixel(445, 130), clearPath: pixel(340, 130), clearBackground: pixel(361, 106) },
    };
  }, selection);
}

test('native blank SVG focus fades unrelated card bodies, text, paths, marker arrows and label backgrounds together', { skip: !chromium, timeout: 60000 }, async () => {
  fs.mkdirSync(temporary, { recursive: true });
  const fixture = starFixture(); fs.writeFileSync(path.join(temporary, 'star.svg'), fixture.svg);
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: fs.mkdtempSync(path.join(temporary, 'chrome-')) });
  try {
    const page = await browser.newPage(); await installInteraction(page, fixture);
    const baseline = await paintAndMeasure(page, { kind: 'none' });
    for (let repeat = 0; repeat < 2; repeat++) {
      const focused = await paintAndMeasure(page, { kind: 'node', id: 'condition' });
      assert.equal(focused.rings, 1, 'Only the selected condition receives a blue ring');
      for (const node of focused.nodes) {
        assert.equal(node.opacity, node.id.startsWith('s') ? .22 : 1, node.id);
        assert.equal(node.textOpacity, node.opacity, node.id + ' text');
      }
      for (const edge of focused.edges) {
        const opacity = edge.id === 'resource-condition' ? 1 : .16;
        for (const part of ['path', 'arrow', 'label', 'background']) assert.equal(edge[part], opacity, edge.id + '/' + part);
      }
      for (const key of ['dimArrow', 'dimPath', 'dimBackground', 'dimCard']) {
        const ratio = key === 'dimCard' ? .22 : .16;
        for (let channel = 0; channel < 3; channel++) {
          const background = [246, 248, 251][channel], wanted = background + (baseline.pixels[key][channel] - background) * ratio;
          assert.ok(Math.abs(focused.pixels[key][channel] - wanted) < 3, key + ' must be faded in the actual SVG raster');
        }
      }
      for (const key of ['clearArrow', 'clearPath', 'clearBackground']) assert.deepEqual(focused.pixels[key], baseline.pixels[key], key);
      const edgeFocus = await paintAndMeasure(page, { kind: 'edge', id: 's1-resource' });
      assert.equal(edgeFocus.rings, 2);
      for (const edge of edgeFocus.edges) assert.equal(edge.path, edge.id === 's1-resource' ? 1 : .16);
      const cleared = await paintAndMeasure(page, { kind: 'none' });
      assert.deepEqual(cleared, baseline);
    }
    await page.close();
  } finally { await browser.close(); }
});

test('native Entity containers fade their own outline, separate title and nested card exactly once, then restore', { skip: !chromium, timeout: 60000 }, async () => {
  fs.mkdirSync(temporary, { recursive: true });
  const fixture = starFixture(), style = [...new DOMParser().parseFromString(fixture.svg, 'image/svg+xml').getElementsByTagName('style')].at(-1).textContent;
  const source = '<svg xmlns="http://www.w3.org/2000/svg" id="entity-focus" viewBox="0 0 300 180"><style>' + style + '</style>'
    + '<g class="node entity-container" data-id="entity" data-presentation="entity-container"><rect data-shape-part="entity" width="180" height="160" fill="#111"/>'
    + '<g class="node" data-id="component"><rect data-shape-part="component" x="20" y="50" width="100" height="40" fill="#111"/><text x="25" y="75">component</text></g></g>'
    + '<g data-entity-header="entity" data-entity-owner="entity"><text x="20" y="30">Entity title</text></g></svg>';
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: fs.mkdtempSync(path.join(temporary, 'entity-chrome-')) });
  try {
    const page = await browser.newPage(); await installInteraction(page, fixture, source);
    const proof = await page.evaluate(() => {
      const effective = element => { let opacity = 1; for (; element instanceof Element; element = element.parentElement) opacity *= Number(getComputedStyle(element).opacity); return opacity; };
      const targets = ['[data-id="entity"]>[data-shape-part]', '[data-entity-header] text', '[data-id="component"]>[data-shape-part]', '[data-id="component"] text'];
      const measure = () => targets.map(selector => effective(document.querySelector(selector)));
      const before = measure(); focusInteraction.paint({ dimNodes: new Set(['entity', 'component']) }); const dim = measure();
      focusInteraction.paint({ nativeOnly: true }); const nativeOnly = measure(); focusInteraction.paint();
      return { before, dim, nativeOnly, cleared: measure() };
    });
    assert.deepEqual(proof.before, [1, 1, 1, 1]); assert.deepEqual(proof.dim, [.22, .22, .22, .22]);
    assert.deepEqual(proof.nativeOnly, proof.dim); assert.deepEqual(proof.cleared, proof.before);
    await page.close();
  } finally { await browser.close(); }
});

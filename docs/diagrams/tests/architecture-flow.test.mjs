import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { instance } from '@viz-js/viz';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { normalizeScheduleSvg } from '../src/debugdump.mjs';
import { architectureFlowAssets, architectureFlowDirections, createArchitectureFlow } from '../src/architecture-flow.mjs';
import { architectureBrowserPath } from '../src/architecture-browser.mjs';
import { repositoryRoot } from '../src/paths.mjs';
import { testDocument } from './test-dom.mjs';

function fixture(markup) {
  const document = testDocument('<div id="diagram">' + markup + '</div><button data-flow-toggle></button>');
  document.hidden = false;
  document.removeEventListener = (name, callback) => document.listeners.set(name,
    (document.listeners.get(name) || []).filter(item => item.callback !== callback));
  const diagram = document.getElementById('diagram'), button = document.querySelector('[data-flow-toggle]');
  button.removeEventListener = (name, callback) => button.listeners.set(name,
    (button.listeners.get(name) || []).filter(item => item.callback !== callback));
  for (const item of diagram.querySelectorAll('path')) {
    item.hasAttribute = name => item.getAttribute(name) !== null;
    item.getTotalLength = () => 100;
    item.getPointAtLength = value => ({ x: value, y: 0 });
  }
  const listeners = new Map(), mediaListeners = new Set();
  const media = { matches: false, addEventListener: (_, callback) => mediaListeners.add(callback),
    removeEventListener: (_, callback) => mediaListeners.delete(callback) };
  const window = { matchMedia: () => media,
    getComputedStyle: item => ({ getPropertyValue: name => item.style.getPropertyValue(name) || item.getAttribute(name) || '' }),
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name) };
  return { document, diagram, button, media, mediaListeners, window, listeners };
}

test('object flow follows actual start/end markers before native reversal metadata', () => {
  const f = fixture('<svg><path id="forward" data-link-id="a" d="M0,0L100,0" marker-end="url(#arrow)"/>'
    + '<path id="reverse" data-link-id="b" data-native-reverse="true" d="M0,0L100,0" marker-start="url(#arrow)"/>'
    + '<path id="both" data-link-id="c" d="M0,0L100,0" marker-start="url(#arrow)" marker-end="url(#arrow)"/>'
    + '<path id="actual" data-link-id="d" data-native-reverse="true" d="M0,0L100,0" marker-end="url(#arrow)"/>'
    + '<path id="fallback" data-link-id="e" data-native-reverse="true" d="M0,0L100,0"/></svg>');
  for (const [id, expected] of [['forward', [1]], ['reverse', [-1]], ['both', [1, -1]], ['actual', [1]], ['fallback', [-1]]]) {
    assert.deepEqual(architectureFlowDirections(f.document.getElementById(id), f.window), expected);
  }
});

test('Schedule polygons determine forward/back/both and arrowless edges have no flow', () => {
  const polygons = { forward: '<polygon points="100,-4 110,0 100,4"/>',
    back: '<polygon points="0,-4 -10,0 0,4"/>', both: '<polygon points="100,-4 110,0 100,4"/><polygon points="0,-4 -10,0 0,4"/>', none: '' };
  for (const [kind, expected] of [['forward', [1]], ['back', [-1]], ['both', [1, -1]], ['none', []]]) {
    const f = fixture('<svg><g class="edge"><title>names do not define direction</title><path d="M0,0L100,0"/>' + polygons[kind] + '</g></svg>');
    assert.deepEqual(architectureFlowDirections(f.diagram.querySelector('path'), f.window), expected);
  }
});

test('flow lifecycle keeps native SVG untouched and restores its static stroke while paused', () => {
  const f = fixture('<svg id="native" viewBox="0 0 120 60" width="120" height="60"><g transform="translate(10 20)"><path data-link-id="business" d="M0,0L100,0" stroke="#3567a6" stroke-width="2.5" marker-end="url(#a)"/></g></svg>');
  const svg = f.diagram.querySelector('svg'), original = svg.querySelector('path');
  const attributes = [...original.attributes];
  const flow = createArchitectureFlow(f);
  assert.equal(flow.refresh(svg), 1);
  const overlay = f.diagram.querySelector('[data-architecture-flow-overlay]');
  const channel = overlay.querySelector('path');
  assert.equal(overlay.parentElement, f.diagram);
  assert.equal(overlay.getAttribute('aria-hidden'), 'true');
  assert.equal(channel.getAttribute('d'), original.getAttribute('d'));
  assert.equal(channel.getAttribute('transform'), 'translate(10 20)');
  assert.equal(channel.getAttribute('stroke'), '#3567a6');
  assert.equal(channel.getAttribute('stroke-width'), '2.5');
  assert.equal(channel.getAttribute('data-link-id'), null);
  assert.equal(channel.getAttribute('id'), null);
  assert.deepEqual([...original.attributes], attributes);
  assert.equal(svg.querySelectorAll('path').length, 1);
  assert.equal(flow.running, true);
  const nativeStyle = f.diagram.querySelector('[data-architecture-flow-native]');
  assert.match(nativeStyle.textContent, /stroke-dasharray:0 110!important/);
  f.button.click();
  assert.equal(flow.enabled, false); assert.equal(flow.running, false);
  assert.equal(overlay.getAttribute('data-flow-paused'), 'true');
  assert.equal(nativeStyle.textContent, '');
  flow.setEnabled(true);
  f.media.matches = true; for (const callback of f.mediaListeners) callback();
  assert.equal(flow.running, false);
  assert.equal(nativeStyle.textContent, '');
  f.media.matches = false; for (const callback of f.mediaListeners) callback();
  f.document.hidden = true; f.document.dispatch('visibilitychange');
  assert.equal(flow.running, false);
  f.document.hidden = false; f.document.dispatch('visibilitychange');
  assert.equal(flow.running, true);
  flow.refresh(svg);
  assert.equal(overlay.parentElement, null);
  assert.equal(f.diagram.querySelectorAll('[data-architecture-flow-overlay]').length, 1);
  flow.clear(); assert.equal(flow.channelCount, 0);
  assert.equal(f.diagram.querySelectorAll('[data-architecture-flow-overlay]').length, 0);
  assert.equal(f.diagram.querySelectorAll('[data-architecture-flow-native]').length, 0);
  flow.refresh(svg); flow.dispose(); flow.dispose();
  assert.equal(flow.refresh(svg), 0);
  assert.equal(f.mediaListeners.size, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal((f.document.listeners.get('visibilitychange') || []).length, 0);
});

test('two native directions use separate path-length halves and ignore interaction hit paths', () => {
  const f = fixture('<svg id="halves" viewBox="0 0 120 60"><g class="edge">'
    + '<path data-link-hit-id="pair" d="M0,0C30,30 70,-30 100,0"/>'
    + '<path data-link-id="pair" d="M0,0C30,30 70,-30 100,0" stroke="#277a83" stroke-width="2" marker-start="url(#a)" marker-end="url(#a)"/>'
    + '</g></svg>');
  const flow = createArchitectureFlow(f);
  assert.equal(flow.refresh(), 2);
  const overlay = f.diagram.querySelector('[data-architecture-flow-overlay]');
  assert.deepEqual(overlay.querySelectorAll('.architecture-flow-channel').map(channel => channel.getAttribute('data-flow-direction')), ['forward', 'reverse']);
  assert.deepEqual(overlay.querySelectorAll('mask path').map(mask => [mask.getAttribute('pathLength'), mask.getAttribute('stroke-dasharray'), mask.getAttribute('stroke-dashoffset')]), [['1', '.5 .5', '-.5'], ['1', '.5 .5', '0']]);
  assert.ok(overlay.querySelectorAll('mask path').every(mask => mask.getAttribute('stroke-width') === '4'));
  assert.equal(f.diagram.querySelector('[data-architecture-flow-native]').textContent.split('\n').length, 1);
  flow.dispose();
});

const chromium = architectureBrowserPath({ required: false });
test('isolated browser animates native SVG paths and safely rebuilds native Graphviz directions', { skip: !chromium, timeout: 60000 }, async () => {
  const temporary = path.join(repositoryRoot, 'tmp/ecs-architecture/flow-tests');
  fs.mkdirSync(temporary, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true,
    userDataDir: fs.mkdtempSync(path.join(temporary, 'browser-')) });
  try {
    const page = await browser.newPage();
    const assets = architectureFlowAssets();
    const object = '<svg id="business-svg" width="320" height="180" viewBox="0 0 320 180">'
      + '<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path fill="context-stroke" d="M0,0L10,5L0,10z"/></marker></defs>'
      + '<g transform="translate(20 20)"><path id="native-forward" data-link-id="forward" d="M0,0L160,0" fill="none" stroke="#3567a6" stroke-width="2.5" stroke-dasharray="6 4" marker-end="url(#arrow)"/>'
      + '<path data-link-id="reverse" data-native-reverse="true" transform="translate(0 40)" d="M0,0L160,0" fill="none" stroke="#2f7161" stroke-width="2.5" stroke-dasharray="6 4" marker-start="url(#arrow)"/>'
      + '<path data-link-hit-id="both" transform="translate(0 80)" d="M0,0C40,30 120,-30 160,0" fill="none" stroke="transparent" stroke-width="12"/>'
      + '<path data-link-id="both" transform="translate(0 80)" d="M0,0C40,30 120,-30 160,0" fill="none" stroke="#3567a6" stroke-width="2.5" stroke-dasharray="6 4" marker-start="url(#arrow)" marker-end="url(#arrow)"/>'
      + '<g class="edgeLabel" transform="translate(70 -8)"><rect width="45" height="16" fill="white"/><text x="2" y="12">label</text></g></g></svg>';
    await page.setContent('<style>body{margin:0;background:#fff}#diagram{position:relative;width:max-content}svg{display:block}.dim{opacity:.2}' + assets.style + '</style><div id="diagram">' + object + '</div>' + assets.markup);
    await page.addScriptTag({ content: assets.script });
    const initial = await page.evaluate(() => {
      const diagram = document.getElementById('diagram'), svg = diagram.querySelector('svg');
      const original = svg.outerHTML;
      globalThis.flow = createArchitectureFlow({ diagram, window, button: document.querySelector('[data-flow-toggle]') });
      window.addEventListener('pagehide', () => flow.clear());
      window.addEventListener('pageshow', event => { if (event.persisted) flow.refresh(); });
      const count = flow.refresh(svg), layer = diagram.querySelector('[data-architecture-flow-overlay]');
      return { count, unchanged: original === svg.outerHTML, businessPaths: svg.querySelectorAll('[data-link-id]').length,
        directions: [...layer.querySelectorAll('.architecture-flow-channel')].map(path => path.dataset.flowDirection),
        animationDirections: [...layer.querySelectorAll('.architecture-flow-channel')].map(path => getComputedStyle(path).animationDirection),
        strokes: [...layer.querySelectorAll('.architecture-flow-channel')].map(path => [path.getAttribute('stroke'), path.getAttribute('stroke-width')]),
        suppression: getComputedStyle(svg.querySelector('[data-link-id="forward"]')).strokeDasharray,
        pointerEvents: getComputedStyle(layer).pointerEvents, ariaHidden: layer.getAttribute('aria-hidden'),
        copiedIds: [...layer.querySelectorAll('[id]')].filter(item => item.id === svg.id || svg.querySelector('[id="' + item.id + '"]')).length
          + layer.querySelectorAll('[data-link-id],[data-schedule-link-id]').length,
        labelMask: layer.querySelector('g').getAttribute('mask'),
        labelHeight: svg.querySelector('.edgeLabel').getBBox().height,
        maskRects: [...layer.querySelectorAll('mask rect')].map(item => ({ fill: item.getAttribute('fill'), transform: item.getAttribute('transform'), width: item.getAttribute('width'), height: item.getAttribute('height') })),
        dash: getComputedStyle(layer.querySelector('path')).strokeDashoffset };
    });
    assert.deepEqual(initial.directions, ['forward', 'reverse', 'forward', 'reverse']);
    assert.deepEqual(initial.animationDirections, ['normal', 'reverse', 'normal', 'reverse']);
    assert.equal(initial.count, 4); assert.equal(initial.unchanged, true); assert.equal(initial.businessPaths, 3);
    assert.deepEqual(initial.strokes, [['rgb(53, 103, 166)', '2.5'], ['rgb(47, 113, 97)', '2.5'], ['rgb(53, 103, 166)', '2.5'], ['rgb(53, 103, 166)', '2.5']]);
    assert.equal(initial.suppression, '0px, 170px');
    assert.equal(initial.pointerEvents, 'none'); assert.equal(initial.ariaHidden, 'true'); assert.equal(initial.copiedIds, 0);
    assert.match(initial.labelMask, /^url\(#business-svg-flow-mask-/);
    assert.deepEqual(initial.maskRects[1], { fill: 'black', transform: 'translate(20 20) translate(70 -8)', width: '45', height: String(initial.labelHeight) });
    await page.waitForFunction(value => getComputedStyle(document.querySelector('.architecture-flow-channel')).strokeDashoffset !== value, {}, initial.dash);
    await page.evaluate(async () => {
      for (const path of document.querySelectorAll('.architecture-flow-channel')) {
        const animation = path.getAnimations()[0]; animation.pause(); animation.currentTime = 600;
      }
      await new Promise(requestAnimationFrame);
    });
    async function pixels(filename, points) {
      const image = await loadImage(await page.screenshot({ path: path.join(temporary, filename) }));
      const canvas = createCanvas(image.width, image.height), context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return points.map(point => [...context.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data]);
    }
    const strokePixels = await pixels('colored-flow.png', [{ x: 23, y: 20 }, { x: 170, y: 24 }]);
    assert.ok(strokePixels[0].slice(0, 3).every(channel => channel > 240), 'moving gap has no stationary base stroke: ' + strokePixels[0]);
    assert.ok(strokePixels[1][2] > strokePixels[1][0] && strokePixels[1][0] < 150, 'native context-stroke arrow remains visible: ' + strokePixels[1]);
    const halfPoints = await page.evaluate(() => {
      const path = document.querySelector('[data-link-id="both"]'), length = path.getTotalLength();
      return [.2, .6].map(start => Array.from({ length: 20 }, (_, index) => {
        const point = path.getPointAtLength(length * (start + index / 100));
        return { x: path.getScreenCTM().a * point.x + path.getScreenCTM().c * point.y + path.getScreenCTM().e,
          y: path.getScreenCTM().b * point.x + path.getScreenCTM().d * point.y + path.getScreenCTM().f };
      }));
    });
    const halfProof = {};
    for (const direction of ['forward', 'reverse']) {
      await page.evaluate(async direction => {
        for (const path of document.querySelectorAll('.architecture-flow-channel')) {
          path.style.display = path.parentElement.getAttribute('mask')?.includes('-flow-half-') && path.dataset.flowDirection === direction ? '' : 'none';
        }
        await new Promise(requestAnimationFrame);
      }, direction);
      const colors = await pixels('half-' + direction + '.png', halfPoints.flat());
      const counts = [colors.slice(0, 20), colors.slice(20)].map(values => values.filter(color => color[2] > color[0] + 15 && color[0] < 220).length);
      halfProof[direction] = counts;
      assert.equal(counts[direction === 'forward' ? 0 : 1], 0, direction + ' stays in its native path-length half');
      assert.ok(counts[direction === 'forward' ? 1 : 0] >= 4, direction + ' paints its own half: ' + counts);
    }
    await page.evaluate(() => {
      flow.refresh(document.getElementById('business-svg'));
    });
    await page.evaluate(() => document.querySelector('#business-svg > g').classList.add('dim'));
    await page.waitForFunction(() => Math.abs(Number(document.querySelector('.architecture-flow-channel').getAttribute('opacity')) - .2) < .0001);
    await page.evaluate(() => document.querySelector('#business-svg > g').classList.remove('dim'));
    await page.waitForFunction(() => Number(document.querySelector('.architecture-flow-channel').getAttribute('opacity')) === 1);
    await page.evaluate(() => document.querySelector('#native-forward').style.strokeWidth = '4px');
    await page.waitForFunction(() => document.querySelector('.architecture-flow-channel').getAttribute('stroke-width') === '4');
    await page.evaluate(() => document.querySelector('#native-forward').removeAttribute('style'));
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.waitForFunction(() => !flow.running && document.querySelector('.architecture-flow-channel').getAnimations()[0].playState === 'paused'
      && getComputedStyle(document.querySelector('#native-forward')).strokeDasharray === '6px, 4px');
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    await page.waitForFunction(() => flow.running);
    const visibility = await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
      const paused = !flow.running;
      Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));
      return { paused, resumed: flow.running };
    });
    assert.deepEqual(visibility, { paused: true, resumed: true });
    const restoration = await page.evaluate(() => {
      const svg = document.getElementById('business-svg');
      svg.insertBefore(document.createElementNS('http://www.w3.org/2000/svg', 'defs'), svg.firstChild);
      const stillSuppressed = [...svg.querySelectorAll('[data-link-id]')].every(path => getComputedStyle(path).strokeDasharray.startsWith('0px, '));
      const original = svg.outerHTML;
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      const cleared = document.querySelectorAll('[data-architecture-flow-overlay],[data-architecture-flow-native]').length === 0;
      const staticDash = getComputedStyle(document.querySelector('#native-forward')).strokeDasharray;
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      return { stillSuppressed, cleared, staticDash, resumed: flow.running, count: flow.channelCount, unchanged: original === svg.outerHTML };
    });
    assert.deepEqual(restoration, { stillSuppressed: true, cleared: true, staticDash: '6px, 4px', resumed: true, count: 4, unchanged: true });
    const viz = await instance();
    const schedule = normalizeScheduleSvg(viz.renderString('digraph { graph [rankdir=LR]; edge [style=dashed, color="#6a778c", penwidth=2]; subgraph cluster_title { label=<<TABLE BGCOLOR="white" BORDER="0" CELLBORDER="0"><TR><TD>Foreground title</TD></TR></TABLE>>; a; } a -> b [id="forward", dir=forward]; a -> b [id="backward", dir=back]; a -> b [id="both", dir=both]; a -> b [id="none", dir=none]; }', { format: 'svg', engine: 'dot' }), 'schedule-flow-proof').svg;
    const native = await page.evaluate(markup => {
      const diagram = document.getElementById('diagram');
      const previous = diagram.querySelector('[data-architecture-flow-overlay]');
      diagram.innerHTML = markup;
      const svg = diagram.querySelector('svg'), original = svg.outerHTML;
      const originalDash = getComputedStyle(svg.querySelector('g.edge path')).strokeDasharray;
      const directions = Object.fromEntries([...svg.querySelectorAll('g.edge')].map(edge => [edge.id, architectureFlowDirections(edge.querySelector('path'), window)]));
      const count = flow.refresh(svg), layer = diagram.querySelector('[data-architecture-flow-overlay]');
      const nativePath = svg.querySelector('g.edge path'), copied = layer.querySelector('.architecture-flow-channel');
      const a = nativePath.getPointAtLength(nativePath.getTotalLength() / 2), b = copied.getPointAtLength(copied.getTotalLength() / 2);
      const origin = new DOMPoint(a.x, a.y).matrixTransform(nativePath.getScreenCTM());
      const overlay = new DOMPoint(b.x, b.y).matrixTransform(copied.getScreenCTM());
      const alignment = Math.hypot(origin.x - overlay.x, origin.y - overlay.y);
      const cleanExport = original === svg.outerHTML;
      const foreground = svg.querySelector('.schedule-cluster-title'), foregroundMask = [...layer.querySelectorAll('mask rect')].some(rect => rect.getAttribute('fill') === 'black' && Number(rect.getAttribute('width')) === foreground.getBBox().width);
      const arrows = [...svg.querySelectorAll('g.edge polygon')].map(polygon => ({ fill: getComputedStyle(polygon).fill, visible: getComputedStyle(polygon).visibility }));
      const suppressed = getComputedStyle(nativePath).strokeDasharray.startsWith('0px, ');
      const oldDetached = !previous.isConnected;
      const overlays = diagram.querySelectorAll('[data-architecture-flow-overlay]').length;
      document.querySelector('[data-flow-toggle]').click();
      const switchedOff = !flow.running && !flow.enabled;
      const restoredDash = getComputedStyle(nativePath).strokeDasharray;
      flow.dispose();
      return { directions, count, alignment, cleanExport, foregroundMask, arrows, suppressed, originalDash, restoredDash, oldDetached, overlays, switchedOff, remaining: diagram.querySelectorAll('[data-architecture-flow-overlay]').length, styles: diagram.querySelectorAll('[data-architecture-flow-native]').length };
    }, schedule);
    assert.deepEqual(native.directions, { forward: [1], backward: [-1], both: [-1, 1], none: [] });
    assert.equal(native.count, 4); assert.ok(native.alignment < .01, JSON.stringify(native));
    assert.equal(native.cleanExport, true); assert.equal(native.oldDetached, true); assert.equal(native.overlays, 1);
    assert.equal(native.foregroundMask, true); assert.equal(native.suppressed, true);
    assert.ok(native.arrows.every(arrow => arrow.fill === 'rgb(106, 119, 140)' && arrow.visible === 'visible'));
    assert.equal(native.restoredDash, native.originalDash);
    assert.equal(native.switchedOff, true); assert.equal(native.remaining, 0);
    assert.equal(native.styles, 0);
    fs.writeFileSync(path.join(temporary, 'browser-proof.json'), JSON.stringify({ initial, strokePixels, halfProof, visibility, restoration, native }, null, 2) + '\n');
    await page.close();
  } finally { await browser.close(); }
});

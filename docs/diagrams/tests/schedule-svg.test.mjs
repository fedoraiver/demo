import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { instance } from '@viz-js/viz';
import { normalizeScheduleSvg } from '../src/schedule-svg.mjs';
import { parseScheduleGraph, scheduleGraphInput } from '../src/schedule-graph.mjs';
import { SCHEDULE_THEME } from '../src/schedule-theme.mjs';

const dom = { DOMParser, XMLSerializer };
const parse = text => new DOMParser().parseFromString(text, 'image/svg+xml');
const serialize = element => new XMLSerializer().serializeToString(element);
const geometryTags = new Set(['path', 'polygon', 'polyline', 'rect', 'circle', 'ellipse', 'text']);
function nativeGeometry(text) {
  return [...parse(text).getElementsByTagName('*')].filter(element => geometryTags.has(element.localName)).map(element => {
    const transforms = [], anchors = [];
    for (let parent = element.parentNode; parent?.nodeType === 1; parent = parent.parentNode) {
      if (parent.hasAttribute('transform')) transforms.push(parent.getAttribute('transform'));
      if (parent.localName === 'a') anchors.push([...parent.attributes].filter(attribute => attribute.name !== 'id').map(attribute => [attribute.name, attribute.value]).sort());
    }
    return JSON.stringify({ element: serialize(element), transforms, anchors });
  }).sort();
}

const fixture = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 80">'
  + '<g id="graph0" class="graph" transform="translate(4 76)"><g id="clust1" class="cluster" transform="scale(1 1)"><title>cluster_example</title>'
  + '<g id="a_clust1" transform="translate(0 0)"><a xlink:title="集合 tooltip" xlink:href="#target">'
  + '<path fill="#f3f4f6" stroke="#6a778c" d="M0,0 L80,0 L80,-60 L0,-60 Z"/>'
  + '<polygon fill="#f3f4f6" stroke="none" points="10,-40 70,-40 70,-58 10,-58"/>'
  + '<text x="20" y="-45" font-family="Segoe UI" font-size="14">集合 &lt;T&gt;</text></a></g></g>'
  + '<g id="edge1" class="edge"><path d="M10,-50 L90,-50"/><polygon points="90,-50 85,-53 85,-47"/></g></g></svg>';

test('native title background and text paint after edges without changing geometry, transforms or tooltip anchors', () => {
  const normalized = normalizeScheduleSvg(fixture, 'schedule-title', dom).svg;
  assert.deepEqual(nativeGeometry(normalized), nativeGeometry(fixture));
  const document = parse(normalized), graph = document.getElementById('graph0'), original = document.getElementById('clust1');
  const layer = [...graph.childNodes].find(element => element.getAttribute?.('class') === 'schedule-cluster-title');
  assert.equal(layer.getAttribute('id'), 'schedule-title-cluster-title-0');
  assert.equal(layer.getAttribute('data-cluster-id'), 'clust1');
  assert.equal(layer.getAttribute('data-cluster-name'), 'cluster_example');
  assert.equal(graph.lastChild, layer);
  assert.equal(original.getElementsByTagName('path').length, 1);
  assert.equal(original.getElementsByTagName('text').length, 0);
  assert.equal(layer.getElementsByTagName('path').length, 0);
  assert.equal(layer.getElementsByTagName('polygon').length, 1);
  assert.equal(layer.getElementsByTagName('a')[0].getAttribute('xlink:title'), '集合 tooltip');
  assert.equal(layer.getElementsByTagName('a')[0].getAttribute('xlink:href'), '#target');
  const ids = [...document.getElementsByTagName('*')].map(element => element.getAttribute('id')).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(normalizeScheduleSvg(normalized, 'schedule-title', dom).svg, normalized);
});

test('unthemed cluster labels remain native and ambiguous title backgrounds fail explicitly', () => {
  const withoutBackground = fixture.replace(/<polygon fill="#f3f4f6"[^>]*\/>/, '');
  const native = normalizeScheduleSvg(withoutBackground, 'schedule-title', dom).svg;
  assert.doesNotMatch(native, /schedule-cluster-title/);
  const ambiguous = fixture.replace('<text ', '<polygon stroke="none" points="1,2 3,4 5,6"/><text ');
  assert.throws(() => normalizeScheduleSvg(ambiguous, 'schedule-title', dom), /Unsupported Graphviz cluster title background/);
});

test('all 34 real schedules keep every native geometry element and normalize idempotently', async () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../generated/dot/debugdump-manifest.json', import.meta.url), 'utf8'));
  const viz = await instance();
  let clusterTitles = 0;
  for (const entry of manifest.schedules) {
    const dot = fs.readFileSync(new URL('../generated/dot/' + entry.filename, import.meta.url), 'utf8');
    const model = parseScheduleGraph(viz, dot);
    const native = viz.renderString(scheduleGraphInput(model, SCHEDULE_THEME), { engine: 'dot', format: 'svg' });
    const normalized = normalizeScheduleSvg(native, 'schedule-' + entry.id, dom).svg;
    assert.deepEqual(nativeGeometry(normalized), nativeGeometry(native), entry.label);
    assert.equal(normalizeScheduleSvg(normalized, 'schedule-' + entry.id, dom).svg, normalized, entry.label);
    const document = parse(normalized);
    const layers = [...document.getElementsByTagName('g')].filter(element => element.getAttribute('class') === 'schedule-cluster-title');
    assert.equal(layers.length, model.subgraphs.filter(group => group.attributes.label).length, entry.label);
    clusterTitles += layers.length;
  }
  assert.equal(manifest.schedules.length, 34);
  assert.equal(clusterTitles, 243);
});

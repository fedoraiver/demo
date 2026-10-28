import assert from 'node:assert/strict';
import test from 'node:test';
import { instance } from '@viz-js/viz';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { scheduleLegendKinds, SCHEDULE_LEGEND_LABELS } from '../src/schedule-legend.mjs';
import { compileScheduleGuideSamples } from '../src/schedule-legend-compiler.mjs';
import { SCHEDULE_THEME } from '../src/schedule-theme.mjs';
import { normalizeScheduleSvg } from '../src/schedule-svg.mjs';
import { svgElements, shapeBounds } from '../src/svg-shape-geometry.mjs';

const dom = { DOMParser, XMLSerializer }, renderer = instance();
const graph = (nodes = [], edges = [], subgraphs = []) => ({ schemaVersion: 1, name: 'legend', directed: true, strict: false, attributes: {}, nodes, edges, subgraphs });
const node = (name, attributes = {}) => ({ name, attributes });
const edge = (tail, head, attributes = {}) => ({ tail, head, attributes });
const group = (name, nodes = [], subgraphs = []) => ({ name, attributes: {}, nodes, edges: [], subgraphs });
const parse = svg => new DOMParser().parseFromString(svg, 'image/svg+xml');
const classOf = (document, name) => [...document.getElementsByTagName('g')].find(element => (element.getAttribute('class') || '').split(/\s+/).includes(name));
const sameColor = (actual, expected) => assert.equal(actual.toLowerCase(), expected.toLowerCase());

test('legend classification lists actual visible node kinds, nonempty sets and edge kinds in stable order', () => {
  const model = graph([node('system', { tooltip: 'demo::system' }), node('context'), node('marker', { style: 'filled, invis' }),
    node('hidden_system', { tooltip: 'demo::hidden', style: 'invis' })],
  [edge('system', 'context'), edge('system', 'marker', { dir: 'none' })], [group('cluster_outer', ['system', 'marker']), group('cluster_empty')]);
  const before = JSON.stringify(model);
  assert.deepEqual(scheduleLegendKinds(model), ['system', 'system_set', 'context', 'order', 'set_membership']);
  assert.equal(JSON.stringify(model), before);
  assert.deepEqual(scheduleLegendKinds(graph([node('marker', { style: 'invis' })])), []);
  assert.deepEqual(scheduleLegendKinds(graph([node('hidden', { tooltip: 'demo::hidden', style: 'invis' })])), []);
  assert.deepEqual(scheduleLegendKinds(graph()), []);
});

test('visible edges to markers retain their semantics while invisible and non-forward edges do not invent order', () => {
  const nodes = [node('a', { style: 'invis' }), node('b', { style: 'invis' })];
  assert.deepEqual(scheduleLegendKinds(graph(nodes, [edge('a', 'b')])), ['order']);
  assert.deepEqual(scheduleLegendKinds(graph(nodes, [edge('a', 'b', { dir: 'forward' })])), ['order']);
  assert.deepEqual(scheduleLegendKinds(graph(nodes, [edge('a', 'b', { dir: 'none' })])), ['set_membership']);
  for (const attributes of [{ style: 'invis' }, { style: 'dashed, invis', dir: 'none' }, { dir: 'back' }, { dir: 'both' }]) {
    assert.deepEqual(scheduleLegendKinds(graph(nodes, [edge('a', 'b', attributes)])), []);
  }
});

test('marker-only and ancestor containers count as SystemSets but empty subgraphs do not', () => {
  const model = graph([node('marker', { style: 'invis' })], [],
    [group('cluster_outer', ['marker'], ['cluster_inner']), group('cluster_inner', ['marker']), group('cluster_empty')]);
  assert.deepEqual(scheduleLegendKinds(model), ['system_set']);
  assert.deepEqual(scheduleLegendKinds(graph([], [], [group('cluster_empty')])), []);
  assert.throws(() => scheduleLegendKinds({ ...model, directed: false }), /Invalid Schedule graph model/);
});

test('Graphviz guide samples use transparent unlabelled horizontal native shapes and globally unique IDs', async () => {
  const viz = await renderer, inputs = [];
  const before = JSON.stringify(SCHEDULE_THEME);
  const samples = compileScheduleGuideSamples({ renderString(input, options) {
    inputs.push({ input, options }); return viz.renderString(input, options);
  } }, dom);
  assert.deepEqual(Object.keys(samples.nodes), ['system', 'system_set', 'context']);
  assert.deepEqual(Object.keys(samples.edges), ['order', 'set_membership']);
  assert.equal(JSON.stringify(SCHEDULE_THEME), before);
  const ids = new Set();
  for (const [kind, svg] of [...Object.entries(samples.nodes), ...Object.entries(samples.edges)]) {
    const document = parse(svg), root = document.documentElement;
    assert.equal(root.getAttribute('id'), 'guide-schedule-' + kind);
    assert.equal(root.getAttribute('aria-label'), SCHEDULE_LEGEND_LABELS[kind]);
    assert.equal(root.getAttribute('data-diagram-engine'), 'graphviz');
    assert.ok(Number(root.getAttribute('width')) > 0); assert.ok(Number(root.getAttribute('height')) > 0);
    assert.doesNotThrow(() => normalizeScheduleSvg(svg, root.getAttribute('id'), dom));
    assert.doesNotMatch(svg, /data-(?:id|schedule-node|schedule-id|link-id|schedule-link-id)=/);
    for (const element of [root, ...root.getElementsByTagName('*')]) {
      const id = element.getAttribute('id');
      if (id) { assert.equal(ids.has(id), false, 'duplicate guide ID: ' + id); ids.add(id); }
    }
    assert.equal(root.getElementsByTagName('text').length, 0);
    assert.equal(root.getElementsByTagName('tspan').length, 0);
    const graph = classOf(document, 'graph');
    const backgrounds = [...graph.childNodes].filter(element => element.localName === 'polygon');
    assert.ok(backgrounds.length <= 1);
    for (const background of backgrounds) {
      assert.equal(background.getAttribute('fill'), 'transparent');
      assert.equal(background.getAttribute('stroke'), 'transparent');
    }
    const native = classOf(document, kind === 'system_set' ? 'cluster' : kind === 'order' || kind === 'set_membership' ? 'edge' : 'node');
    assert.ok(native, kind + ' native shape');
    const path = native.getElementsByTagName('path')[0];
    assert.ok(path);
    const style = kind === 'system_set' ? SCHEDULE_THEME.systemSet : kind === 'order' || kind === 'set_membership' ? SCHEDULE_THEME.edge : SCHEDULE_THEME.system;
    sameColor(path.getAttribute('stroke'), style.stroke);
    assert.equal(Number(path.getAttribute('stroke-width')), style.width);
    if (kind === 'order' || kind === 'set_membership') {
      assert.equal(native.getElementsByTagName('polygon').length, kind === 'order' ? 1 : 0);
    } else {
      sameColor(path.getAttribute('fill'), style.fill);
      assert.match(path.getAttribute('d'), /C/, 'Graphviz rounded native outline');
      const outline = svgElements(svg).find(element => element.tag === 'path');
      const box = shapeBounds(outline);
      assert.ok(box.width / box.height >= 3, 'unlabelled horizontal node swatch');
    }
    const geometry = svgElements(svg).filter(element => ['path', 'polygon'].includes(element.tag) && element.parent?.attrs.class !== 'graph').map(shapeBounds);
    const viewBox = root.getAttribute('viewBox').split(/\s+/).map(Number);
    assert.deepEqual(viewBox, [Math.min(...geometry.map(box => box.x)) - 5, Math.min(...geometry.map(box => box.y)) - 5,
      Math.max(...geometry.map(box => box.x + box.width)) - Math.min(...geometry.map(box => box.x)) + 10,
      Math.max(...geometry.map(box => box.y + box.height)) - Math.min(...geometry.map(box => box.y)) + 10]);
  }
  assert.equal(inputs.length, 5);
  for (const { input, options } of inputs) {
    assert.deepEqual(options, { engine: 'dot', format: 'svg' });
    assert.equal(input.graphAttributes.bgcolor, 'transparent');
    assert.equal(input.graphAttributes.fontname, SCHEDULE_THEME.fontFamily);
  }
  assert.equal(inputs[1].input.subgraphs[0].graphAttributes.style, 'rounded,filled');
  assert.equal(inputs[1].input.subgraphs[0].graphAttributes.fillcolor, SCHEDULE_THEME.systemSet.fill);
});

test('Graphviz guide samples are deterministic and reject unsafe renderer output', async () => {
  const viz = await renderer;
  assert.deepEqual(compileScheduleGuideSamples(viz, dom), compileScheduleGuideSamples(viz, dom));
  const base = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0,0L10,10"/></svg>';
  for (const svg of [base.replace('<path', '<script/><path'), base.replace('<path', '<path onclick="run()"'),
    base.replace('<path', '<a href="https://example.com"><path').replace('/></svg>', '/></a></svg>'),
    base.replace('<path', '<path style="fill:red"'), base.replace('viewBox="0 0 10 10"', 'viewBox="0 0 0 0"')]) {
    assert.throws(() => compileScheduleGuideSamples({ renderString: () => svg }, dom), /Unexpected Graphviz|Invalid Graphviz/);
  }
});

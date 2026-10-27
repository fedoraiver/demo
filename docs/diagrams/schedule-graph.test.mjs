import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { instance } from '@viz-js/viz';
import { assertScheduleDotProfile, scheduleGraphFromJson, scheduleGraphInput, scheduleGraphFacts, filterScheduleGraph,
  scheduleSystemCount, scheduleFilterTerms, scheduleFilterNames, scheduleNodeKind, parseScheduleGraph, scheduleLabelLongestLine } from './schedule-graph.mjs';
import { SCHEDULE_THEME } from './schedule-theme.mjs';
import { NODE_STYLES, EDGE_STYLES, ARCHITECTURE_TEXT_STYLE } from './architecture-style.mjs';
import { compileDebugdump, normalizeScheduleSvg, sha256 } from './debugdump.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const renderer = instance();
async function model(dot) {
  assertScheduleDotProfile(dot);
  const viz = await renderer;
  return parseScheduleGraph(viz, dot);
}
const names = value => value.nodes.filter(node => scheduleNodeKind(node) === 'system').map(node => node.name);
const chain = 'digraph { a[label="same",tooltip="demo::alpha"]; b[label="same",tooltip="engine::beta"]; c[tooltip="demo::gamma"]; a -> b; b -> c; }';

test('filters use full system names, comma OR, case sensitivity and exclusion veto without adding bypass edges', async () => {
  const source = await model(chain), before = JSON.stringify(source);
  assert.deepEqual(scheduleFilterTerms(' , demo::, , engine::, demo:: '), ['demo::', 'engine::']);
  assert.deepEqual(names(filterScheduleGraph(source, { include: 'same' })), []);
  assert.deepEqual(names(filterScheduleGraph(source, { include: 'demo::alpha, engine::beta', exclude: 'beta' })), ['a']);
  assert.deepEqual(names(filterScheduleGraph(source, { include: 'DEMO' })), []);
  const filtered = filterScheduleGraph(source, { include: 'demo::' });
  assert.deepEqual(names(filtered), ['a', 'c']);
  assert.deepEqual(filtered.edges, []);
  assert.deepEqual(filterScheduleGraph(source, { include: ' , ' }), source);
  assert.equal(JSON.stringify(source), before);
});

test('selected full names are exact, preserve commas and combine with legacy terms before exclusion veto', async () => {
  const fullName = 'demo::system<Tuple<A, B>>';
  const source = await model('digraph { a[label="short",tooltip="' + fullName + '"]; duplicate[tooltip="' + fullName + '"];'
    + 'prefix[tooltip="demo::system<Tuple<A"]; suffix[tooltip="B>>"]; engine[tooltip="engine::beta"]; a -> engine; engine -> duplicate; }');
  const selectedNames = [fullName, fullName], before = JSON.stringify(source);
  assert.deepEqual(scheduleFilterNames(selectedNames), [fullName]);
  assert.deepEqual(names(filterScheduleGraph(source, { includeNames: selectedNames })), ['a', 'duplicate']);
  assert.deepEqual(names(filterScheduleGraph(source, { includeNames: ['short', fullName.toUpperCase(), ' ' + fullName] })), []);
  const combined = filterScheduleGraph(source, { includeNames: [fullName], include: 'engine::', excludeNames: [fullName] });
  assert.deepEqual(names(combined), ['engine']);
  assert.deepEqual(combined.edges, []);
  assert.deepEqual(names(filterScheduleGraph(source, { includeNames: [fullName], include: 'engine::', exclude: 'engine::' })), ['a', 'duplicate']);
  assert.deepEqual(names(filterScheduleGraph(source, { excludeNames: [fullName], exclude: 'engine::' })), ['prefix', 'suffix']);
  assert.deepEqual(filterScheduleGraph(source, { includeNames: [], excludeNames: [], include: ' , ', exclude: '' }), source);
  assert.deepEqual(selectedNames, [fullName, fullName]);
  assert.equal(JSON.stringify(source), before);
  assert.throws(() => filterScheduleGraph(source, { includeNames: fullName }), /array of nonempty strings/);
  assert.throws(() => filterScheduleGraph(source, { excludeNames: [''] }), /array of nonempty strings/);
});

test('nested clusters, markers and multi-set membership remain only where a retained system requires them', async () => {
  const source = await model('digraph { subgraph cluster_outer { label="Outer"; mo[style=invis,shape=point,label=""];'
    + 'subgraph cluster_inner { label="Inner"; mi[style=invis,shape=point,label=""]; a[tooltip="demo::alpha"]; }'
    + 'subgraph cluster_unused { label="Unused"; mu[style=invis,shape=point,label=""]; b[tooltip="engine::beta"]; } }'
    + 'subgraph cluster_member { label="Member"; mm[style=invis,shape=point,label=""]; } c[tooltip="demo::gamma"]; c -> mm[dir=none,lhead=cluster_member]; a -> b; }');
  const alpha = filterScheduleGraph(source, { include: 'alpha' });
  assert.deepEqual(alpha.subgraphs.map(group => group.name), ['cluster_outer', 'cluster_inner']);
  assert.deepEqual(alpha.nodes.map(node => node.name), ['mo', 'mi', 'a']);
  assert.equal(alpha.edges.length, 0);
  const gamma = filterScheduleGraph(source, { include: 'gamma' });
  assert.deepEqual(gamma.subgraphs.map(group => group.name), ['cluster_member']);
  assert.deepEqual(gamma.nodes.map(node => node.name), ['mm', 'c']);
  assert.equal(gamma.edges.length, 1);
  const empty = filterScheduleGraph(source, { exclude: 'demo::, engine::' });
  assert.deepEqual(empty.subgraphs, []);
  assert.deepEqual(empty.nodes, []);
  assert.deepEqual(empty.edges, []);
});

test('native graph input roundtrips nested memberships, parallel edges, tooltips and escaped labels', async () => {
  const source = await model('digraph named { compound=true; subgraph cluster_a { label="集合"; a[label="quote \\" slash \\\\ generic <T> 中文",tooltip="demo::one<T>"];'
    + 'subgraph cluster_b { b[tooltip="demo::two"]; } a -> b[label="one"]; a -> b[label="two"]; } }');
  const viz = await renderer;
  const result = scheduleGraphFromJson(JSON.parse(viz.renderString(scheduleGraphInput(source), { format: 'dot_json' })));
  assert.equal(scheduleGraphFacts(result), scheduleGraphFacts(source));
  assert.equal(result.edges.length, 2);
  assert.match(result.nodes[0].attributes.label, /generic <T> 中文/);
});

test('cluster edge membership resolves Graphviz edge IDs independently of output array order', () => {
  const value = scheduleGraphFromJson({ name: 'ids', directed: true, strict: false, _subgraph_cnt: 1,
    objects: [{ _gvid: 0, name: 'cluster_a', nodes: [1, 2], edges: [19] },
      { _gvid: 1, name: 'a', tooltip: 'demo::a' }, { _gvid: 2, name: 'b', tooltip: 'demo::b' }, { _gvid: 3, name: 'c', tooltip: 'demo::c' }],
    edges: [{ _gvid: 8, tail: 1, head: 3 }, { _gvid: 19, tail: 1, head: 2 }] });
  assert.deepEqual(value.subgraphs[0].edges, [1]);
  assert.deepEqual(value.edges[value.subgraphs[0].edges[0]], { tail: 'a', head: 'b', attributes: {} });
});

test('theme is applied before layout to every visible node and cluster while preserving invisible markers', async () => {
  const source = await model('digraph { bgcolor=black; subgraph cluster_a { fontcolor=white; fillcolor=gray; m[style=invis,shape=point,label=""]; a[fontname=Times,tooltip="demo::a"]; } b[tooltip="demo::b"]; a -> b[color=yellow]; }');
  const input = scheduleGraphInput(source, SCHEDULE_THEME);
  assert.equal(input.graphAttributes.bgcolor, '#F6F8FB');
  assert.equal(input.graphAttributes.fontname, ARCHITECTURE_TEXT_STYLE.fontFamily);
  assert.equal(input.nodes.find(node => node.name === 'a').attributes.fillcolor, NODE_STYLES.system.fill);
  assert.equal(input.nodes.find(node => node.name === 'b').attributes.style, 'rounded,filled');
  assert.equal(input.nodes.find(node => node.name === 'm').attributes.style, 'invis');
  assert.equal(input.subgraphs[0].graphAttributes.fillcolor, NODE_STYLES.system_set.fill);
  assert.equal(input.subgraphs[0].graphAttributes.fontcolor, ARCHITECTURE_TEXT_STYLE.color);
  assert.equal(typeof input.subgraphs[0].graphAttributes.label.html, 'string');
  assert.match(input.subgraphs[0].graphAttributes.label.html, new RegExp('BGCOLOR="' + SCHEDULE_THEME.systemSet.fill + '"'));
  const escapedModel = structuredClone(source);
  escapedModel.subgraphs[0].attributes.label = 'State<T & "Quoted">';
  assert.match(scheduleGraphInput(escapedModel, SCHEDULE_THEME).subgraphs[0].graphAttributes.label.html, /State&lt;T &amp; &quot;Quoted&quot;&gt;/);
  assert.equal(escapedModel.subgraphs[0].attributes.label, 'State<T & "Quoted">');
  assert.equal(input.edges[0].attributes.color, EDGE_STYLES.order.stroke);
  const long = { name: 'long', attributes: { tooltip: 'demo::long', label: 'generic<' + 'a'.repeat(480) + '>\\nshort' } };
  assert.equal(scheduleLabelLongestLine(long), 489);
  const longModel = { ...source, nodes: [...source.nodes, long] };
  const longInput = scheduleGraphInput(longModel, SCHEDULE_THEME).nodes.find(node => node.name === 'long');
  assert.equal(Number(longInput.attributes.margin.split(',')[0]), (8 + 489 * 14 * 0.02) / 72);
  assert.ok(Number(longInput.attributes.margin.split(',')[0]) > Number(input.nodes.find(node => node.name === 'a').attributes.margin.split(',')[0]));
  const viz = await renderer;
  const svg = normalizeScheduleSvg(viz.renderString(input, { format: 'svg' }), 'schedule-theme').svg;
  assert.match(svg, /fill="#F6F8FB"/i);
  assert.doesNotMatch(svg, /font-family="Times/);
});

test('the two real implicit contexts are preserved without inventing a filterable system name', async () => {
  for (const filename of ['ecs-schedule-c4944ad6bf68df6d.dot', 'ecs-schedule-c9208da7b841e997.dot']) {
    const source = await model(fs.readFileSync(path.join(directory, filename), 'utf8'));
    const contexts = source.nodes.filter(node => scheduleNodeKind(node) === 'context');
    assert.equal(contexts.length, 1);
    const context = contexts[0], adjacent = source.edges.find(edge => edge.head === context.name || edge.tail === context.name);
    const system = source.nodes.find(node => node.name === (adjacent.head === context.name ? adjacent.tail : adjacent.head));
    assert.equal(scheduleNodeKind(system), 'system');
    const kept = filterScheduleGraph(source, { include: system.attributes.tooltip });
    assert.ok(kept.nodes.some(node => node.name === context.name));
    assert.equal(scheduleSystemCount(kept), 1);
    assert.equal(filterScheduleGraph(source, { include: context.name }).nodes.length, 0);
  }
});

test('unsupported HTML, external attributes, missing system names and overlapping clusters fail explicitly', async () => {
  assert.throws(() => assertScheduleDotProfile('digraph { a[label=<b>]; }'), /HTML/);
  assert.doesNotThrow(() => assertScheduleDotProfile('digraph { a[label="<b>"]; /* <html> */ }'));
  await assert.rejects(model('digraph { a[tooltip="demo::a",URL="https://example.com"]; }'), /external/);
  await assert.rejects(model('digraph { "node_System(SystemKey(1v1))"; }'), /full name/);
  await assert.rejects(model('digraph { subgraph cluster_a { a[tooltip="demo::a"]; } subgraph cluster_b { a; } }'), /Overlapping/);
  assert.throws(() => parseScheduleGraph({ render: () => ({ status: 'success', errors: [{ level: 'error', message: 'unexpected backend failure' }] }) }, 'digraph {}'), /parsing failed/);
  const source = await model('digraph { subgraph cluster_a { a[tooltip="demo::a"]; } }');
  source.subgraphs.push({ ...structuredClone(source.subgraphs[0]), name: 'cluster_overlap' });
  assert.throws(() => filterScheduleGraph(source, { include: 'demo' }), /Overlapping/);
});

test('all 34 real schedules compile in memory with lossless model hashes and unchanged raw DOT provenance', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'debugdump-manifest.json'), 'utf8'));
  const schedules = manifest.schedules.map(entry => ({ ...entry, dot: fs.readFileSync(path.join(directory, entry.filename), 'utf8') }));
  assert.equal(schedules.length, 34);
  const result = await compileDebugdump({ manifest, schedules });
  for (const view of result.views) {
    const entry = schedules.find(entry => view.id === 'schedule-' + entry.id);
    assert.equal(sha256(view.dot), entry.sha256);
    assert.equal(view.dot, entry.dot);
    assert.equal(scheduleSystemCount(view.scheduleGraph), entry.systemCount);
    assert.equal(sha256(JSON.stringify(view.scheduleGraph)), view.scheduleGraphSha256);
    const oldDotModel = scheduleGraphFromJson(JSON.parse((await renderer).renderString(entry.dot, { engine: 'dot', format: 'dot_json' })));
    assert.equal(sha256(JSON.stringify(oldDotModel)), view.scheduleGraphSha256, 'nop must preserve all 34 previous model hashes');
    const firstSystem = view.scheduleGraph.nodes.find(node => scheduleNodeKind(node) === 'system');
    if (firstSystem) {
      const exact = filterScheduleGraph(view.scheduleGraph, { includeNames: [firstSystem.attributes.tooltip] });
      assert.ok(scheduleSystemCount(exact) > 0);
      assert.ok(exact.nodes.filter(node => scheduleNodeKind(node) === 'system').every(node => node.attributes.tooltip === firstSystem.attributes.tooltip));
    }
    assert.ok(view.width > 0 && view.height > 0);
  }
});

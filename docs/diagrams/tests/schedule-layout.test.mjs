import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { instance } from '@viz-js/viz';
import { parseScheduleGraph, scheduleGraphFacts, scheduleGraphInput } from '../src/schedule-graph.mjs';
import { SCHEDULE_THEME } from '../src/schedule-theme.mjs';
import { inspectScheduleRoutes, renderScheduleLayout } from '../src/schedule-layout.mjs';
import { normalizeScheduleSvg } from '../src/schedule-svg.mjs';

const viz = instance(), dom = { DOMParser, XMLSerializer };
const fixture = name => fs.readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
const valid = route => route.issues.length === 0 && route.clearanceIssues.length === 0;

test('the themed copy hides every edge label and shares one dash without changing DOT facts', async () => {
  const renderer = await viz;
  const model = parseScheduleGraph(renderer, 'digraph { rankdir=LR; a[tooltip="demo::a"]; b[tooltip="demo::b"]; a->b[label="order",xlabel="extra",headlabel="head",taillabel="tail"]; }');
  const before = scheduleGraphFacts(model), input = scheduleGraphInput(model, SCHEDULE_THEME);
  assert.equal(SCHEDULE_THEME.version, 7);
  assert.equal(input.graphAttributes.ranksep, '1');
  assert.equal(input.graphAttributes.nodesep, '0.3');
  for (const key of ['label', 'xlabel', 'headlabel', 'taillabel']) assert.ok(!Object.hasOwn(input.edges[0].attributes, key));
  const layout = renderScheduleLayout(renderer, input);
  const svg = normalizeScheduleSvg(layout.svg, 'schedule-labels', dom).svg;
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  for (const edge of [...document.getElementsByTagName('g')].filter(group => group.getAttribute('class') === 'edge')) {
    assert.equal(edge.getElementsByTagName('text').length, 0);
    assert.equal(edge.getElementsByTagName('path')[0].getAttribute('stroke-dasharray'), '6 4');
  }
  assert.equal(scheduleGraphFacts(model), before);
  assert.equal(model.edges[0].attributes.label, 'order');
});

test('the captured StateTransition dependencies have forty unit gaps and twenty four unit visible shafts', async () => {
  const renderer = await viz, model = parseScheduleGraph(renderer, fixture('native-state-transition.dot'));
  const before = scheduleGraphFacts(model), input = scheduleGraphInput(model, SCHEDULE_THEME);
  const legacy = structuredClone(input);
  legacy.graphAttributes.ranksep = '.5';
  legacy.graphAttributes.nodesep = '.15';
  assert.ok(inspectScheduleRoutes(renderer.renderString(legacy, { format: 'svg' }), legacy).some(route => route.clearanceIssues.length));
  const layout = renderScheduleLayout(renderer, input);
  assert.equal(layout.routes.length, 3);
  assert.ok(layout.routes.every(route => valid(route) && route.endpointGap >= 40 && route.visibleShaft >= 24));
  assert.equal(scheduleGraphFacts(model), before);
});

test('compound marker constraints repair a wide source cluster within the bounded native candidates', async () => {
  const renderer = await viz;
  const model = parseScheduleGraph(renderer, 'digraph { compound=true; rankdir=LR; subgraph cluster_long { label=Long;'
    + 'm[style=invis,shape=point,label=""]; a[tooltip="demo::alpha"]; b[tooltip="demo::beta"]; m->a[style=invis]; a->b; }'
    + 'c[tooltip="demo::gamma"]; m->c[ltail=cluster_long]; }');
  const input = scheduleGraphInput(model, SCHEDULE_THEME), before = structuredClone(input);
  const initial = inspectScheduleRoutes(renderer.renderString(input, { format: 'svg' }), input);
  assert.ok(initial.some(route => route.clearanceIssues.includes('endpoint-gap')));
  const layout = renderScheduleLayout(renderer, input);
  assert.ok(layout.minlen >= 2 && layout.minlen <= 4);
  assert.ok(layout.routes.every(valid));
  assert.deepEqual(input, before);
  const document = new DOMParser().parseFromString(layout.svg, 'image/svg+xml');
  assert.equal([...document.getElementsByTagName('g')].filter(group => group.getAttribute('class') === 'edge').length, initial.length);
});

test('native forward, backward and both-direction triangles retain and validate their actual arrow ends', async () => {
  const renderer = await viz;
  for (const [direction, sides] of [['forward', ['head']], ['back', ['tail']], ['both', ['head', 'tail']], ['none', []]]) {
    const model = parseScheduleGraph(renderer, `digraph { rankdir=LR; a[tooltip="demo::a"]; b[tooltip="demo::b"]; a->b[dir=${direction}]; }`);
    const layout = renderScheduleLayout(renderer, scheduleGraphInput(model, SCHEDULE_THEME));
    assert.ok(layout.routes.every(valid));
    assert.deepEqual(Object.keys(layout.routes[0].arrowGaps), sides);
  }
});

const roundedInput = { edges: [{ tail: 'node_System(SystemKey(4v1))', head: 'node_System(SystemKey(40v1))', attributes: { id: 'schedule-edge-43' } }], subgraphs: [] };

test('the actual diagonal rounded target uses native rectangular clipping and a forward ray into its real outline', () => {
  const routes = inspectScheduleRoutes(fixture('native-rounded-clip.svg'), roundedInput);
  assert.ok(routes.every(valid));
  const contact = routes[0].arrowGaps.head;
  assert.ok(contact.boxGap < 4.25);
  assert.ok(contact.contourGap > 7);
  assert.ok(contact.roundedSetback > 5);
  assert.equal(contact.valid, true);
});

test('rounded clipping rejects additional suspension, a reversed native triangle and the wrong target', () => {
  for (const mutation of [
    document => document.getElementById('schedule-edge-43').getElementsByTagName('polygon')[0].setAttribute('transform', 'translate(-20 -3)'),
    document => document.getElementById('schedule-edge-43').getElementsByTagName('polygon')[0].setAttribute('transform', 'rotate(180 3236.195 -642.87)'),
    document => [...document.getElementsByTagName('g')].find(group => group.getAttribute('class') === 'node'
      && [...group.childNodes].some(child => child.localName === 'title' && child.textContent === roundedInput.edges[0].head)).setAttribute('transform', 'translate(500 500)'),
  ]) {
    const document = new DOMParser().parseFromString(fixture('native-rounded-clip.svg'), 'image/svg+xml');
    mutation(document);
    const routes = inspectScheduleRoutes(new XMLSerializer().serializeToString(document), roundedInput);
    assert.ok(routes.some(route => route.issues.some(issue => issue.startsWith('arrow-'))));
  }
});

test('filled native outlines without Z and foreground titles cut the visible shaft into continuous portions', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g class="node"><title>a</title><path fill="white" stroke="black" d="M0,0L20,0L20,20L0,20L0,0"/></g>'
    + '<g class="node"><title>b</title><path fill="white" stroke="black" d="M80,0L100,0L100,20L80,20L80,0"/></g>'
    + '<g class="edge" id="schedule-edge-0"><path d="M20,10L67,10"/><polygon points="67,6 77,10 67,14 67,6"/></g>'
    + '<g class="schedule-cluster-title"><polygon fill="white" stroke="none" points="20,0 78,0 78,20 20,20 20,0"/></g></svg>';
  const routes = inspectScheduleRoutes(svg, { edges: [{ tail: 'a', head: 'b', attributes: {} }], subgraphs: [] });
  assert.equal(routes[0].visibleShaft, 0);
  assert.deepEqual(routes[0].clearanceIssues, ['visible-shaft']);
});

function nestedFixture({ path = 'M20,40L87,40', title = '', container = false } = {}) {
  const child = container ? 'inner-marker' : 'child';
  const input = { edges: [{ tail: 'outer-marker', head: child, attributes: {} }], subgraphs: [{ name: 'cluster_outer',
    nodes: [{ name: 'outer-marker' }, { name: child }], subgraphs: container ? [{ name: 'cluster_inner', nodes: [{ name: child }], subgraphs: [] }] : [] }] };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g class="cluster"><title>cluster_outer</title>'
    + '<path fill="white" stroke="black" d="M0,0L200,0L200,100L0,100L0,0"/></g>'
    + '<g class="' + (container ? 'cluster' : 'node') + '"><title>' + (container ? 'cluster_inner' : child) + '</title>'
    + '<path fill="white" stroke="black" d="M100,30L140,30L140,50L100,50L100,30"/></g>'
    + '<g class="edge" id="schedule-edge-0"><path d="' + path + '"/><polygon points="87,36 97,40 87,44 87,36"/></g>'
    + title + '</svg>';
  return { input, svg };
}

test('nested edges omit only ancestor fills and retain a visible shaft of at least twenty four units in either direction', () => {
  for (const container of [false, true]) {
    const { input, svg } = nestedFixture({ container });
    const [forward] = inspectScheduleRoutes(svg, input);
    assert.equal(forward.endpointGap, null);
    assert.equal(forward.visibleShaft, 67);
    assert.ok(valid(forward));
    [input.edges[0].tail, input.edges[0].head] = [input.edges[0].head, input.edges[0].tail];
    input.edges[0].attributes.dir = 'back';
    const [reverse] = inspectScheduleRoutes(svg.replace('M20,40L87,40', 'M87,40L20,40'), input);
    assert.equal(reverse.visibleShaft, 67);
    assert.ok(valid(reverse));
  }
});

test('nested short shafts and child-node, child-container or title occlusion remain failures', () => {
  for (const options of [
    { path: 'M70,40L87,40' },
    { path: 'M140,40L87,40' },
    { path: 'M140,40L87,40', container: true },
    { title: '<g class="schedule-cluster-title"><polygon fill="white" stroke="none" points="40,30 70,30 70,50 40,50 40,30"/></g>' },
  ]) {
    const { input, svg } = nestedFixture(options), [route] = inspectScheduleRoutes(svg, input);
    assert.equal(route.endpointGap, null);
    assert.ok(route.visibleShaft < 24);
    assert.deepEqual(route.clearanceIssues, ['visible-shaft']);
  }
});

test('two markers in the same container exclude both copies of that container fill', () => {
  const input = { edges: [{ tail: 'first', head: 'second', attributes: { dir: 'none' } }],
    subgraphs: [{ name: 'cluster_same', nodes: [{ name: 'first' }, { name: 'second' }], subgraphs: [] }] };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g class="cluster"><title>cluster_same</title>'
    + '<path fill="white" stroke="black" d="M0,0L100,0L100,50L0,50L0,0"/></g>'
    + '<g class="edge" id="schedule-edge-0"><path d="M20,25L70,25"/></g></svg>';
  const [route] = inspectScheduleRoutes(svg, input);
  assert.equal(route.endpointGap, null);
  assert.equal(route.visibleShaft, 50);
  assert.ok(valid(route));
});

test('invalid final native geometry fails after four candidates', () => {
  let calls = 0;
  const renderer = { render() { calls++; return { status: 'success', errors: [], output: '<svg xmlns="http://www.w3.org/2000/svg"/>' }; } };
  assert.throws(() => renderScheduleLayout(renderer, { nodes: [{ name: 'a' }, { name: 'b' }], edges: [{ tail: 'a', head: 'b', attributes: {} }], subgraphs: [] }), /missing-path/);
  assert.equal(calls, 4);
  assert.throws(() => inspectScheduleRoutes('<svg xmlns="http://www.w3.org/2000/svg"><g class="edge" id="forged"/></svg>', { edges: [] }), /Unexpected native Schedule edge/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { arrowGeometry, inspectViewRoutes, pathIntersectsOutline, ROUTING_STYLE, routingObstacles } from './architecture-routing.mjs';
import { flattenPath, svgElements } from './svg-shape-geometry.mjs';

const card = (id, shape, extra = '') => `<g class="node" data-id="${id}" data-instance="v--${id}" ${extra}>${shape.replaceAll('PART', `data-shape-part="v--${id}"`)}</g>`;
const edge = (d, id = 'edge', extra = '') => `<path data-link-id="${id}" data-mermaid-id="e0" d="${d}" ${extra}/>`;
const view = (contents, nodes = ['a', 'b', 'obstacle'], links = [{ id: 'edge', mermaidId: 'e0', from: 'a', to: 'b' }]) => ({ id: 'v', svg: `<svg>${contents}</svg>`, nodes: nodes.map(id => ({ id })), links, scheduleLinks: [], scheduleGroups: [], entityGroups: [] });
const endpoint = id => card(id, `<rect PART x="${id === 'a' ? 0 : 180}" y="40" width="20" height="20"/>`);
const marker = '<defs><marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L10 5L0 10Z"/></marker></defs>';
const label = (x, y, width = 20, height = 10) => `<g class="edgeLabel" transform="translate(${x} ${y})"><g class="label" data-mermaid-native-id="e0"><g><rect class="background" x="0" y="0" width="${width}" height="${height}"/><text>Contract</text></g></g></g>`;

test('routing uses all native shape types and does not confuse empty polygon corners with card interiors', () => {
  for (const shape of ['<rect PART x="80" y="20" width="40" height="60"/>', '<polygon PART points="80,50 100,20 120,50 100,80"/>', '<ellipse PART cx="100" cy="50" rx="20" ry="30"/>', '<path PART d="M80 30Q100 10 120 30V70Q100 90 80 70Z"/>']) {
    const result = inspectViewRoutes(view(endpoint('a') + endpoint('b') + card('obstacle', shape) + edge('M20 50H180')));
    assert.deepEqual(result.collisions, [{ edge: 'edge', id: 'obstacle', kind: 'node' }]);
  }
  const diamond = view(endpoint('a') + endpoint('b') + card('obstacle', '<polygon PART points="80,50 100,20 120,50 100,80"/>') + edge('M80 22H89'));
  assert.equal(inspectViewRoutes(diamond).collisions.length, 0);
});

test('native curves are checked adaptively between endpoints and control points', () => {
  const result = inspectViewRoutes(view(endpoint('a') + endpoint('b') + card('obstacle', '<rect PART x="95" y="35" width="10" height="10"/>') + edge('M20 90Q100 -10 180 90')));
  assert.equal(result.edges[0].curved, true); assert.equal(result.edges[0].axis, null); assert.equal(result.collisions.length, 1);
  assert.deepEqual(ROUTING_STYLE, { axisTolerance: .5, geometryTolerance: .25, curve: 'basis', curveFallbacks: ['bumpX', 'bumpY'] });
});

test('multi-outline nodes keep every native piece as an obstacle', () => {
  const result = inspectViewRoutes(view(endpoint('a') + endpoint('b') + card('obstacle', '<rect PART x="80" y="20" width="30" height="30"/><path PART d="M85 15H115V45"/>') + edge('M112 0V19')));
  assert.equal(result.collisions.length, 1);
});

test('Entity member routes may traverse the container body while its native title remains protected', () => {
  const entity = card('entity', '<rect PART x="20" y="0" width="120" height="130"/>', 'data-presentation="entity-container"');
  const component = card('component', '<rect PART x="40" y="60" width="40" height="20"/>');
  const fixture = view(entity + component + endpoint('b') + edge('M80 70H180'), ['entity', 'component', 'b'], [{ id: 'edge', from: 'component', to: 'b', mermaidId: 'e0' }]);
  fixture.nodes[0].presentation = 'entity-container'; fixture.entityGroups = [{ id: 'entity-group', entity: 'entity', components: ['component'], headerBounds: { x: 30, y: 10, width: 100, height: 25 } }];
  assert.equal(inspectViewRoutes(fixture).collisions.length, 0);
  fixture.svg = fixture.svg.replace('M80 70H180', 'M80 70V20H180');
  assert.deepEqual(inspectViewRoutes(fixture).collisions, [{ edge: 'edge', id: 'entity', kind: 'entity-container-header' }]);
  fixture.links[0].from = 'entity';
  fixture.svg = fixture.svg.replace('M80 70V20H180', 'M80 20H180');
  assert.equal(inspectViewRoutes(fixture).collisions.length, 0);
});

test('unrelated Entity containers cannot be crossed, even between their Component cards', () => {
  const fixture = view(endpoint('a') + endpoint('b') + card('entity', '<rect PART x="80" y="20" width="40" height="100"/>') + edge('M20 50H180'), ['a', 'b', 'entity']);
  fixture.nodes[2].presentation = 'entity-container'; fixture.entityGroups = [{ entity: 'entity', components: [], headerBounds: { x: 85, y: 25, width: 30, height: 10 } }];
  assert.equal(inspectViewRoutes(fixture).collisions[0].kind, 'entity-container');
});

test('Entity corner controls remain protected even when a member edge may cross its container', () => {
  const entity = card('entity', '<rect PART x="20" y="0" width="120" height="130"/>');
  const component = card('component', '<rect PART x="40" y="60" width="40" height="20"/>');
  const fixture = view(entity + component + endpoint('b') + edge('M80 70L120 20L180 50'), ['entity', 'component', 'b'], [{ id: 'edge', from: 'component', to: 'b', mermaidId: 'e0' }]);
  fixture.nodes[0].presentation = 'entity-container';
  fixture.nodes[0].entityToggle = { entity: 'entity', expanded: true, count: 1, label: '收起组件（1）' };
  fixture.entityGroups = [{ id: 'entity-group', entity: 'entity', components: ['component'] }];
  const control = routingObstacles(fixture).find(obstacle => obstacle.kind === 'entity-control');
  assert.deepEqual(control.bounds, { x: 108, y: 8, width: 24, height: 24 });
  assert.deepEqual(inspectViewRoutes(fixture).collisions, [{ edge: 'edge', id: 'entity:toggle', kind: 'entity-control' }]);
  fixture.svg = fixture.svg.replace('M80 70L120 20L180 50', 'M80 70H180');
  assert.deepEqual(inspectViewRoutes(fixture).collisions, []);
});

test('Schedule arrows and business paths share clearance while canonical Schedule transit is allowed', () => {
  const fixture = view(endpoint('a') + endpoint('b') + card('obstacle', '<rect PART x="90" y="40" width="20" height="20"/>')
    + '<g class="cluster" data-schedule-id="schedule"><rect x="-10" y="0" width="50" height="100"/></g>'
    + '<g class="cluster" data-schedule-id="next"><rect x="160" y="0" width="50" height="100"/></g>'
    + '<path data-schedule-link-id="order" d="M40 50H160"/>', ['a', 'b', 'obstacle'], []);
  fixture.scheduleGroups = [{ id: 'schedule', nodes: ['a'] }, { id: 'next', nodes: ['b'] }]; fixture.scheduleLinks = [{ id: 'order', mermaidId: 'sc0', from: 'schedule', to: 'next' }];
  assert.deepEqual(inspectViewRoutes(fixture).collisions, [{ edge: 'order', id: 'obstacle', kind: 'node' }]);
  assert.equal(routingObstacles(fixture).filter(obstacle => obstacle.kind === 'schedule-container').length, 2);
});

test('separate Move paths cannot invent a crossing, and evenodd holes remain empty', () => {
  const obstacle = { bounds: { x: 20, y: 20, width: 60, height: 60 }, parts: [{ fillRule: 'evenodd', contours: flattenPath('M20 20H80V80H20ZM30 30H70V70H30Z') }] };
  assert.equal(pathIntersectsOutline(flattenPath('M40 50H60'), obstacle), false);
  assert.equal(pathIntersectsOutline(flattenPath('M0 0H10M90 90H100'), obstacle), false);
  assert.equal(pathIntersectsOutline(flattenPath('M0 50H100'), obstacle), true);
});

test('ELK subpixel curve jogs classify numerically as axis aligned without skipping collisions', () => {
  const fixture = view(endpoint('a') + endpoint('b') + card('obstacle', '<rect PART x="90" y="49" width="20" height="10"/>') + edge('M20 50L80 50Q100 50 110 50.4L180 50.4'));
  const inspected = inspectViewRoutes(fixture).edges[0];
  assert.equal(inspected.axis, 'horizontal'); assert.equal(inspected.curved, false); assert.equal(inspected.curveCommands, true); assert.equal(inspected.collisions.length, 1);
});

test('collinear C/Q and sub-tolerance curvature cannot disguise a diagonal straight route', () => {
  for (const d of ['M20 50C60 60 100 70 180 90', 'M20 50Q100 70 180 90', 'M20 50C40 60 60 70 80 80L100 60Q140 40 180 20', 'M20 50Q100 70.2 180 90']) {
    const inspected = inspectViewRoutes(view(endpoint('a') + endpoint('b') + edge(d), ['a', 'b'])).edges[0];
    assert.equal(inspected.axis, null, d); assert.equal(inspected.curveCommands, true, d); assert.equal(inspected.curved, false, d);
  }
  const inspected = inspectViewRoutes(view(endpoint('a') + endpoint('b') + edge('M20 50Q100 71 180 90'), ['a', 'b'])).edges[0];
  assert.equal(inspected.axis, null); assert.equal(inspected.curved, true);
});

test('native stroke widths detect overlap when the centerlines do not cross', () => {
  const fixture = view(endpoint('a') + endpoint('b') + card('obstacle', '<rect PART x="80" y="52" width="40" height="10" style="stroke:#000;stroke-width:2px"/>') + edge('M20 50H180', 'edge', 'style="stroke:#000;stroke-width:4px"'));
  assert.equal(inspectViewRoutes(fixture).collisions.length, 1);
});

test('native marker envelope catches arrowhead-only card overlaps and validates the target direction', () => {
  const fixture = view(marker + endpoint('a') + endpoint('b') + card('obstacle', '<rect PART x="173" y="52" width="2" height="2"/>') + edge('M20 50H176', 'edge', 'marker-end="url(#arrow)"'));
  const inspected = inspectViewRoutes(fixture).edges[0];
  assert.equal(inspected.collisions.length, 1); assert.deepEqual(inspected.arrowIssues, []);
  fixture.svg = fixture.svg.replace('M20 50H176', 'M20 50H184L176 50');
  assert.ok(inspectViewRoutes(fixture).edges[0].arrowIssues.includes('marker-target-direction'));
  fixture.svg = fixture.svg.replace('orient="auto"', 'orient="90"');
  assert.ok(inspectViewRoutes(fixture).edges[0].arrowIssues.includes('marker-orientation'));
});

test('native paths contact the real source outline and leave it in the forward direction', () => {
  const shapes = [
    '<rect PART x="0" y="40" width="20" height="20"/>',
    '<polygon PART points="0,50 10,40 20,50 10,60"/>',
    '<ellipse PART cx="10" cy="50" rx="10" ry="10"/>',
    '<path PART d="M0 40H20V60H0Z"/>',
    '<rect PART x="0" y="40" width="20" height="20"/><path PART d="M2 38H22V58"/>',
  ];
  for (const shape of shapes) {
    const start = shape.includes('M2 38') ? 22 : 20;
    const fixture = view(card('a', shape) + endpoint('b') + edge(`M${start} 50H180`), ['a', 'b']);
    assert.deepEqual(inspectViewRoutes(fixture).edges[0].arrowIssues, []);
    fixture.svg = fixture.svg.replace(`M${start} 50H180`, 'M49 50H180');
    assert.ok(inspectViewRoutes(fixture).edges[0].arrowIssues.includes('path-source-gap'));
    fixture.svg = fixture.svg.replace('M49 50H180', 'M0 50H10V80H180');
    assert.ok(inspectViewRoutes(fixture).edges[0].arrowIssues.includes('path-source-direction'));
  }
  const container = view('<g transform="translate(100 200)">' + card('a', '<rect PART x="0" y="0" width="100" height="100"/>')
    + edge('M50 129V160') + '</g>' + endpoint('b'), ['a', 'b']);
  container.nodes[0].presentation = 'entity-container'; container.entityGroups = [{ entity: 'a', components: [] }];
  assert.ok(inspectViewRoutes(container).edges[0].arrowIssues.includes('path-source-gap'), 'Layout wrapper bounds cannot substitute for the actual Entity border');
  container.svg = container.svg.replace('M50 129V160', 'M50 100V160');
  assert.deepEqual(inspectViewRoutes(container).edges[0].arrowIssues, []);
  container.svg = container.svg.replace('M50 100V160', 'M50 100C60 100 60 130 70 130');
  assert.deepEqual(inspectViewRoutes(container).edges[0].arrowIssues, [], 'A native curve may start tangent to the real border and bend outward');
  container.svg = container.svg.replace('M50 100C60 100 60 130 70 130', 'M50 100C60 100 60 70 70 70');
  assert.ok(inspectViewRoutes(container).edges[0].arrowIssues.includes('path-source-direction'));
});

test('marker viewBox, strokeWidth units and native local transforms follow a curve terminal tangent', () => {
  const svg = '<svg><g transform="translate(100 50)"><defs><marker id="m" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="10" markerHeight="10" orient="auto"><path transform="translate(1 0)" d="M0 0L10 5L0 10Z"/></marker></defs><path data-edge="true" d="M0 0Q0 10 0 20" style="stroke:#000;stroke-width:2" marker-end="url(#m)"/></g></svg>';
  const elements = svgElements(svg), arrow = arrowGeometry(elements.find(element => element.attrs['data-edge']), elements);
  assert.ok(Math.abs(arrow.tip[0] - 100) < 1e-8); assert.ok(Math.abs(arrow.tip[1] - 82) < 1e-8);
  assert.deepEqual(arrow.tangent, [0, 1]);
});

test('a native arrow may enter its target while its visible head still spans the actual boundary', () => {
  const fixture = view(marker + endpoint('a') + endpoint('b') + edge('M20 50H180', 'edge', 'marker-end="url(#arrow)"'), ['a', 'b']);
  assert.deepEqual(inspectViewRoutes(fixture).edges[0].arrowIssues, []);
  fixture.svg = fixture.svg.replace('M20 50H180', 'M20 50H190');
  assert.ok(inspectViewRoutes(fixture).edges[0].arrowIssues.includes('marker-target-gap'));
});

test('folded Component routes use displayed Entity endpoints for clearance and actual target arrows', () => {
  const fixture = view(marker + endpoint('a') + endpoint('b') + edge('M20 50H176', 'edge', 'marker-end="url(#arrow)"'), ['a', 'b'], [
    { id: 'edge', mermaidId: 'e0', from: 'a.Component', to: 'b.Component', displayFrom: 'a', displayTo: 'b' },
  ]);
  fixture.nodes.forEach(node => { node.presentation = 'entity-collapsed'; });
  fixture.entityGroups = ['a', 'b'].map(entity => ({ entity, components: [`${entity}.Component`], expanded: false }));
  assert.equal(routingObstacles(fixture).every(obstacle => obstacle.kind === 'node'), true);
  const inspected = inspectViewRoutes(fixture).edges[0];
  assert.deepEqual(inspected.collisions, []); assert.deepEqual(inspected.arrowIssues, []);
  fixture.svg = fixture.svg.replace('M20 50H176', 'M20 50H170');
  assert.ok(inspectViewRoutes(fixture).edges[0].arrowIssues.includes('marker-target-gap'));
});

test('folded Entity endpoints do not grant hidden Component body space to a relation label', () => {
  const fixture = view(endpoint('a') + endpoint('b') + edge('M20 50H180') + label(182, 45, 10, 5), ['a', 'b'], [
    { id: 'edge', mermaidId: 'e0', from: 'a', to: 'b.Component', displayFrom: 'a', displayTo: 'b' },
  ]);
  fixture.nodes[1].presentation = 'entity-collapsed'; fixture.entityGroups = [{ entity: 'b', components: ['b.Component'], expanded: false }];
  assert.deepEqual(inspectViewRoutes(fixture).collisions, [{ edge: 'edge', id: 'b', kind: 'edge-label', obstacleKind: 'node' }]);
});

test('actual transformed edge-label backgrounds avoid unrelated cards and both semantic endpoints', () => {
  const fixture = view(endpoint('a') + endpoint('b') + card('obstacle', '<rect PART x="90" y="20" width="30" height="20"/>')
    + edge('M20 50Q100 150 180 50') + `<g transform="translate(30 10)">${label(65, 15)}</g>` + label(5, 45, 10, 5));
  const collisions = inspectViewRoutes(fixture).collisions.filter(collision => collision.kind === 'edge-label');
  assert.deepEqual(collisions.map(collision => collision.id).sort(), ['a', 'obstacle']);
});

test('member edge labels may use Entity body space while preserving the real border and header', () => {
  const entity = card('entity', '<rect PART x="20" y="0" width="120" height="130"/>', 'data-presentation="entity-container"');
  const component = card('component', '<rect PART x="40" y="60" width="40" height="20"/>');
  const contents = entity + component + endpoint('b') + edge('M80 70H180');
  const fixture = view(contents + label(100, 90), ['entity', 'component', 'b'], [{ id: 'edge', from: 'component', to: 'b', mermaidId: 'e0' }]);
  fixture.nodes[0].presentation = 'entity-container'; fixture.entityGroups = [{ entity: 'entity', components: ['component'], headerBounds: { x: 30, y: 10, width: 100, height: 25 } }];
  assert.equal(inspectViewRoutes(fixture).collisions.length, 0);
  fixture.svg = `<svg>${contents + label(130, 90)}</svg>`;
  assert.deepEqual(inspectViewRoutes(fixture).collisions, [{ edge: 'edge', id: 'entity', kind: 'edge-label', obstacleKind: 'entity-container' }]);
  fixture.svg = `<svg>${contents + label(60, 15)}</svg>`;
  assert.ok(inspectViewRoutes(fixture).collisions.some(collision => collision.obstacleKind === 'entity-container-header'));
  fixture.links[0].from = 'entity'; fixture.svg = `<svg>${contents.replace('M80 70H180', 'M140 100H180') + label(100, 90)}</svg>`;
  assert.ok(inspectViewRoutes(fixture).collisions.some(collision => collision.obstacleKind === 'entity-container'));
});

test('Schedule membership permits label body space but never its header or phase endpoint body', () => {
  const contents = endpoint('a') + endpoint('b') + edge('M20 50H180') + '<g class="cluster" data-schedule-id="phase"><rect x="-10" y="0" width="50" height="100"/></g>';
  const fixture = view(contents + label(10, 80, 15), ['a', 'b']);
  fixture.scheduleGroups = [{ id: 'phase', nodes: ['a'], labelBounds: { x: -5, y: 5, width: 40, height: 20 } }];
  assert.equal(inspectViewRoutes(fixture).collisions.length, 0);
  fixture.svg = `<svg>${contents + label(10, 10, 15)}</svg>`;
  assert.ok(inspectViewRoutes(fixture).collisions.some(collision => collision.obstacleKind === 'schedule-container-header'));
  fixture.links[0].from = 'phase'; fixture.svg = `<svg>${contents.replace('M20 50H180', 'M40 50H180') + label(10, 80, 15)}</svg>`;
  assert.ok(inspectViewRoutes(fixture).collisions.some(collision => collision.obstacleKind === 'schedule-container'));
});

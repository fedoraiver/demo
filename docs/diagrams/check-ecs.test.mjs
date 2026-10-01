import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkArchitecture } from './check-ecs.mjs';
import { checkSvgGeometry } from './diagram-geometry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryRoot = path.join(root, 'tmp', 'architecture-check-tests');

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const port = (box, side, slot = 1, count = 1) => ({ box, side, slot, count });
const box = (id, x, y, width = 100, height = 90, container = false) =>
  `<rect data-box-id="${id}" x="${x}" y="${y}" width="${width}" height="${height}"${container ? ' data-box-container="true"' : ''}/>`;
const edge = (points, source, target, arrow = true, extra = '') =>
  `<g class="edge" data-connect="move|observe" data-source-anchor="${escape(JSON.stringify(source))}" data-target-anchor="${escape(JSON.stringify(target))}"><path d="${points.map((point, index) => `${index ? 'L' : 'M'}${point.join(',')}`).join(' ')}" stroke-width="2"${arrow ? ' marker-end="url(#arrow)"' : ''} ${extra}/></g>`;
const svg = body => `<svg xmlns="http://www.w3.org/2000/svg"><defs><marker id="arrow" markerWidth="7" markerHeight="7" viewBox="0 0 10 10" orient="auto"><path d="M0,0 L10,5 L0,10"/></marker></defs>${body}</svg>`;
function checkGeometry(content) {
  // 几何反例也保存于根 tmp，失败后可以独立查看，不覆盖正式产物。
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'geometry-'));
  const filename = path.join(directory, 'fixture.svg');
  fs.writeFileSync(filename, content);
  return checkSvgGeometry(fs.readFileSync(filename, 'utf8'));
}

function fixture() {
  // 测试仅创建根 tmp 下的最小离线产物；保留副本便于检查，不修改真实图或加载游戏。
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'case-'));
  const source = 'fn move_entity() {}\nfn observe_fire() {}\n';
  const model = {
    systems: [
      { id: 'move', name: 'move_entity', kind: 'system', events: [], source: { path: 'src/example.rs', line: 1 } },
      { id: 'observe', name: 'observe_fire', kind: 'observer', events: ['响应 EntityEvent：Fire<TestAction>'], source: { path: 'src/example.rs', line: 2 } },
    ],
    observers: [{ system: 'observe', event: 'Fire<TestAction>' }],
  };
  const registry = Object.fromEntries(model.systems.map(system => [system.id, structuredClone(system)]));
  const views = ['overview', 'schedules', 'relationships', 'events'].map(id => ({
    id,
    svg: svg(`<g data-id="move">${box('move', 0, 0)}</g><g data-id="observe">${box('observe', 200, 0)}</g>${edge([[100, 45], [200, 45]], port('move', 'right'), port('observe', 'left'))}<g data-connect=""/>`),
  }));
  const snapshots = [{ path: 'src/example.rs', text: source }];
  const diagrams = path.join(directory, 'docs', 'diagrams');
  fs.mkdirSync(diagrams, { recursive: true });
  fs.mkdirSync(path.join(directory, 'src'));
  fs.writeFileSync(path.join(directory, 'src', 'example.rs'), source);
  function save() {
    fs.writeFileSync(path.join(diagrams, 'ecs-data.json'), JSON.stringify(model));
    fs.writeFileSync(path.join(diagrams, 'ecs-architecture.html'), `<script id="architecture-data" type="application/json">${JSON.stringify({ model, registry, views })}</script>`);
    fs.writeFileSync(path.join(diagrams, 'ecs-source.html'), `<script id="sources" type="application/json">${JSON.stringify(snapshots)}</script>`);
    for (const view of views) fs.writeFileSync(path.join(diagrams, `ecs-${view.id}.svg`), view.svg);
  }
  save();
  return { directory, diagrams, model, registry, views, snapshots, save };
}

test('accepts matching offline artifacts and reports their counts', () => {
  const data = fixture();
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: 4 });
});

test('accepts CRLF and LF source differences without ignoring other text changes', () => {
  const data = fixture();
  const sourceFile = path.join(data.directory, 'src', 'example.rs');
  // 覆盖 Git 的 LF 快照与 Windows 的 CRLF 工作区，以及相反的换行组合。
  fs.writeFileSync(sourceFile, data.snapshots[0].text.replace(/\n/g, '\r\n'));
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: 4 });
  fs.writeFileSync(sourceFile, data.snapshots[0].text);
  data.snapshots[0].text = data.snapshots[0].text.replace(/\n/g, '\r\n');
  data.save();
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: 4 });
  data.snapshots[0].text = data.snapshots[0].text.replace('fn move_entity', 'fn  move_entity');
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Source snapshot mismatch: src\/example.rs/);
});

test('rejects a newly listed system omitted from every diagram', () => {
  const data = fixture();
  const system = { ...structuredClone(data.model.systems[0]), id: 'move-update' };
  data.model.systems.push(system);
  data.registry[system.id] = system;
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /System is missing from views: move-update/);
});

test('rejects a valid line number pointing at the wrong function', () => {
  const data = fixture();
  data.model.systems[0].source.line = 2;
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Function source mismatch: move_entity/);
});

test('rejects source lines outside the file', () => {
  const data = fixture();
  data.model.systems[0].source.line = 100;
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Invalid source line: src\/example.rs:100/);
});

test('rejects an outdated embedded source snapshot', () => {
  const data = fixture();
  data.snapshots[0].text += '// outdated\n';
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Source snapshot mismatch: src\/example.rs/);
});

test('rejects source paths that escape the fixture repository', () => {
  const data = fixture();
  data.model.systems[0].source.path = '../outside.rs';
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Unsafe source path/);
});

test('rejects unknown diagram connection endpoints', () => {
  const data = fixture();
  data.views[0].svg = data.views[0].svg.replace('move|observe', 'move|deleted');
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Unknown connection reference in overview: deleted/);
});

test('rejects an observer registered with a different event', () => {
  const data = fixture();
  data.model.observers[0].event = 'Fire<OtherAction>';
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Observer event mismatch: observe/);
});

test('rejects stale standalone SVG content', () => {
  const data = fixture();
  fs.appendFileSync(path.join(data.diagrams, 'ecs-overview.svg'), '\n');
  assert.throws(() => checkArchitecture(data.directory), /SVG artifact mismatch: overview/);
});

test('accepts actual centered ports after an SVG translation', () => {
  const content = svg(`<g transform="translate(12 24)">${box('a', 0, 0)}${box('b', 200, 0)}${edge([[100, 45], [200, 45]], port('a', 'right'), port('b', 'left'))}</g>`);
  assert.deepEqual(checkGeometry(content), { boxes: 2, edges: 1, ports: 2, junctions: 0 });
});

test('rejects a lone connection away from the side center despite correct metadata', () => {
  const content = svg(box('a', 0, 0) + box('b', 200, 0)
    + edge([[100, 30], [200, 30]], port('a', 'right'), port('b', 'left')));
  assert.throws(() => checkGeometry(content), /Anchor position mismatch/);
});

test('accepts two thirds and counts incoming and outgoing lines on the same side together', () => {
  const content = svg(box('a', 0, 0) + box('b', 200, 0) + box('c', 200, 200)
    + edge([[100, 30], [150, 30], [150, 45], [200, 45]], port('a', 'right', 1, 2), port('b', 'left'))
    + edge([[200, 245], [150, 245], [150, 60], [100, 60]], port('c', 'left'), port('a', 'right', 2, 2)));
  assert.deepEqual(checkGeometry(content), { boxes: 3, edges: 2, ports: 4, junctions: 0 });
});

test('rejects metadata that leaves an incoming line out of the side count', () => {
  const content = svg(box('a', 0, 0) + box('b', 200, 0) + box('c', 200, 200)
    + edge([[100, 45], [200, 45]], port('a', 'right'), port('b', 'left'))
    + edge([[200, 245], [150, 245], [150, 45], [100, 45]], port('c', 'left'), port('a', 'right')));
  assert.throws(() => checkGeometry(content), /Anchor count mismatch/);
});

test('rejects a declared second slot when only one actual line exists', () => {
  const content = svg(box('a', 0, 0) + box('b', 200, 0)
    + edge([[100, 30], [200, 30]], port('a', 'right', 1, 2), port('b', 'left', 1, 2)));
  assert.throws(() => checkGeometry(content), /Anchor count mismatch/);
});

test('rejects two lines at quarter points instead of thirds', () => {
  const content = svg(box('a', 0, 0, 100, 120) + box('b', 200, 0, 100, 120)
    + edge([[100, 30], [200, 30]], port('a', 'right', 1, 2), port('b', 'left', 1, 2))
    + edge([[100, 90], [200, 90]], port('a', 'right', 2, 2), port('b', 'left', 2, 2)));
  assert.throws(() => checkGeometry(content), /Anchor position mismatch/);
});

test('rejects overlapping independent lines that reuse a slot', () => {
  const content = svg(box('a', 0, 0) + box('b', 200, 0)
    + edge([[100, 30], [200, 30]], port('a', 'right', 1, 2), port('b', 'left', 1, 2))
    + edge([[100, 30], [200, 30]], port('a', 'right', 1, 2), port('b', 'left', 1, 2)));
  assert.throws(() => checkGeometry(content), /Duplicate anchor slot/);
});

test('rejects a connection group or arrow path without endpoint metadata', () => {
  assert.throws(() => checkGeometry(svg('<g class="edge"><path d="M0,0 L30,0"/></g>')), /Missing connection anchor metadata/);
  assert.throws(() => checkGeometry(svg('<path d="M0,0 L30,0" marker-end="url(#arrow)"/>')), /missing connection metadata/);
  const valid = edge([[100, 45], [200, 45]], port('a', 'right'), port('b', 'left'));
  assert.throws(() => checkGeometry(svg(valid.replace(/ data-target-anchor="[^"]*"/, ''))), /Missing connection anchor metadata: target/);
  assert.throws(() => checkGeometry(svg(valid.replace('class="edge"', ''))), /missing an edge group/);
});

test('rejects invented box metadata and mismatching actual rectangle dimensions', () => {
  const connection = edge([[100, 45], [200, 45]], port('a', 'right'), port('b', 'left'));
  assert.throws(() => checkGeometry(svg(box('b', 200, 0) + connection)), /Unknown anchor box: a/);
  assert.throws(() => checkGeometry(svg(box('a', 0, 0, 120) + box('b', 200, 0) + connection)), /Anchor position mismatch/);
});

test('rejects tangential or inward departures and target approaches', () => {
  const boxes = box('a', 0, 0) + box('b', 200, 0);
  const cases = [
    [[100, 45], [100, 60], [150, 60], [150, 45], [200, 45]],
    [[100, 45], [80, 45], [80, 100], [150, 100], [150, 45], [200, 45]],
    [[100, 45], [150, 45], [150, 100], [200, 100], [200, 45]],
  ];
  for (const points of cases) {
    assert.throws(() => checkGeometry(svg(boxes + edge(points, port('a', 'right'), port('b', 'left')))), /Anchor normal mismatch/);
  }
});

test('rejects zero-length and diagonal connection segments', () => {
  const boxes = box('a', 0, 0) + box('b', 200, 0);
  assert.throws(() => checkGeometry(svg(boxes + edge([[100, 45], [100, 45], [200, 45]], port('a', 'right'), port('b', 'left')))), /zero-length segment/);
  assert.throws(() => checkGeometry(svg(boxes + edge([[100, 45], [150, 60], [200, 45]], port('a', 'right'), port('b', 'left')))), /non-orthogonal segment/);
});

test('rejects marker heads on junctions or non-terminal path positions', () => {
  const boxes = box('a', 0, 0) + box('b', 200, 0);
  assert.throws(() => checkGeometry(svg(boxes + edge([[100, 45], [150, 45]], port('a', 'right'), null))), /Arrow cannot target a junction/);
  assert.throws(() => checkGeometry(svg(boxes + edge([[100, 45], [200, 45]], port('a', 'right'), port('b', 'left'), true, 'marker-mid="url(#arrow)"'))), /Arrow is only allowed at the target/);
  assert.throws(() => checkGeometry(svg(boxes + edge([[100, 45], [200, 45]], port('a', 'right'), port('b', 'left'), true, 'marker-start="url(#arrow)"'))), /Arrow is only allowed at the target/);
});

test('rejects a terminal segment hidden entirely by its arrow head', () => {
  const content = svg(box('a', 0, 0) + box('b', 114, 0)
    + edge([[100, 45], [114, 45]], port('a', 'right'), port('b', 'left')));
  assert.throws(() => checkGeometry(content), /terminal segment is too short/);
});

test('rejects an arrow marker that does not follow the actual terminal segment', () => {
  const content = svg(box('a', 0, 0) + box('b', 200, 0)
    + edge([[100, 45], [200, 45]], port('a', 'right'), port('b', 'left'))).replace('orient="auto"', 'orient="90"');
  assert.throws(() => checkGeometry(content), /must follow the terminal segment/);
});

test('accepts a shared trunk and T-junctions without multiplying its box port count', () => {
  const content = svg(box('lane', -20, -20, 500, 400, true) + box('a', 0, 0) + box('b', 250, 0) + box('c', 250, 180)
    + edge([[100, 45], [150, 45], [150, 225]], port('a', 'right'), null, false)
    + edge([[150, 45], [250, 45]], null, port('b', 'left'))
    + edge([[150, 225], [250, 225]], null, port('c', 'left')));
  assert.deepEqual(checkGeometry(content), { boxes: 4, edges: 3, ports: 3, junctions: 3 });
});

test('rejects disconnected junctions and node boundaries or interiors disguised as junctions', () => {
  const boxes = box('a', 0, 0) + box('b', 200, 0);
  assert.throws(() => checkGeometry(svg(boxes + edge([[100, 45], [150, 45]], port('a', 'right'), null, false))), /Disconnected junction/);
  assert.throws(() => checkGeometry(svg(boxes + edge([[100, 45], [200, 45]], port('a', 'right'), null, false))), /Junction disguises a box anchor/);
  assert.throws(() => checkGeometry(svg(boxes + edge([[100, 45], [220, 45]], port('a', 'right'), null, false))), /Junction is inside a node/);
});

test('rejects an isolated junction ring whose lines have no actual box anchor', () => {
  const content = svg(edge([[0, 0], [40, 0]], null, null, false)
    + edge([[40, 0], [40, 40]], null, null, false)
    + edge([[40, 40], [0, 40]], null, null, false)
    + edge([[0, 40], [0, 0]], null, null, false));
  assert.throws(() => checkGeometry(content), /Connection group has no box anchor/);
});

test('architecture validation rejects bad geometry even when SVG and embedded artifacts agree', () => {
  const data = fixture();
  data.views[0].svg = data.views[0].svg.replace('M100,45 L200,45', 'M100,30 L200,30');
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Invalid SVG geometry in overview: Anchor position mismatch/);
});

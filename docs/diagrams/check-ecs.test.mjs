import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkArchitecture } from './check-ecs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryRoot = path.join(root, 'tmp', 'architecture-check-tests');

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
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><g data-id="move"/><g data-id="observe"/><g data-connect="move|observe"/><g data-connect=""/></svg>',
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

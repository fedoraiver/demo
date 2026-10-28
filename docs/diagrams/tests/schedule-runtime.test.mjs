import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { createScheduleRenderer, scheduleRuntimeAssets } from '../src/schedule-runtime.mjs';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><path d="M1,2 L3,4"/></svg>';
const graph = { schemaVersion: 1, name: 'example', directed: true, strict: false, attributes: {},
  nodes: [{ name: 'a', attributes: { tooltip: 'demo::alpha' } }, { name: 'b', attributes: { tooltip: 'engine::beta' } }],
  edges: [{ tail: 'a', head: 'b', attributes: {} }], subgraphs: [] };
const view = { id: 'schedule-example', svg, width: 20, height: 10, systemCount: 2, scheduleGraph: graph };
function fixture(options = {}) {
  const workers = [], revoked = [];
  class Worker {
    constructor(url) { this.url = url; workers.push(this); }
    postMessage(message) { this.message = message; }
    terminate() { this.terminated = true; }
    receive(data) { this.onmessage({ data }); }
  }
  const renderer = createScheduleRenderer({ workerSource: 'worker', WorkerClass: Worker, urls: { createObjectURL: () => 'blob:' + workers.length,
    revokeObjectURL: url => revoked.push(url) }, dom: { DOMParser, XMLSerializer }, ...options });
  return { renderer, workers, revoked };
}

test('default and no-match views never instantiate a Worker or WASM', async () => {
  const { renderer, workers } = fixture();
  assert.deepEqual(await renderer.render(view), { svg, width: 20, height: 10, systemCount: 2, totalSystemCount: 2, legendKinds: ['system', 'order'], filtered: false });
  const empty = await renderer.render(view, { include: 'missing' });
  assert.deepEqual(empty, { svg: null, width: 0, height: 0, systemCount: 0, totalSystemCount: 2, legendKinds: [], filtered: true });
  assert.equal((await renderer.render(view, { includeNames: [], excludeNames: [], include: ' , ', exclude: ' ' })).filtered, false);
  assert.equal((await renderer.render(view, { includeNames: ['missing'] })).svg, null);
  assert.equal(workers.length, 0);
  renderer.dispose();
});

test('exact name selections trigger layout, union with legacy text and honor both exclusion kinds', async () => {
  const fullName = 'demo::system<Tuple<A, B>>', exactView = structuredClone(view);
  exactView.scheduleGraph.nodes[0].attributes.tooltip = fullName;
  const { renderer, workers } = fixture();
  const exact = renderer.render(exactView, { includeNames: [fullName] });
  assert.deepEqual(workers[0].message.graph.nodes.map(node => node.name), ['a']);
  workers[0].receive({ id: workers[0].message.id, svg });
  assert.equal((await exact).systemCount, 1);
  const mixed = renderer.render(exactView, { includeNames: [fullName], include: 'engine::', excludeNames: [fullName] });
  assert.deepEqual(workers[0].message.graph.nodes.map(node => node.name), ['b']);
  workers[0].receive({ id: workers[0].message.id, svg });
  assert.equal((await mixed).systemCount, 1);
  const excludeOnly = renderer.render(exactView, { excludeNames: [fullName] });
  assert.deepEqual(workers[0].message.graph.nodes.map(node => node.name), ['b']);
  workers[0].receive({ id: workers[0].message.id, svg });
  assert.equal((await excludeOnly).filtered, true);
  assert.equal((await renderer.render(exactView, { includeNames: [fullName], exclude: 'demo::' })).systemCount, 0);
  await assert.rejects(renderer.render(exactView, { includeNames: fullName }), /array of nonempty strings/);
  renderer.dispose();
});

test('Plugin source groups expand to exact members, union with saved filters and exclude whole groups', async () => {
  const grouped = { ...view, schedulePluginGroups: [
    { id: 'plugin-Alpha', systemNames: ['demo::alpha'] },
    { id: 'crate:engine', systemNames: ['engine::beta'] },
    { id: 'shared', systemNames: ['demo::alpha', 'engine::beta'] },
  ] };
  const { renderer, workers } = fixture();
  const first = renderer.render(grouped, { includePlugins: ['plugin-Alpha', 'crate:engine'], excludePlugins: ['crate:engine'] });
  assert.deepEqual(workers[0].message.graph.nodes.map(node => node.name), ['a']);
  assert.deepEqual(workers[0].message.graph.edges, []);
  workers[0].receive({ id: workers[0].message.id, svg });
  assert.equal((await first).systemCount, 1);
  const legacy = renderer.render(grouped, { includePlugins: ['missing'], includeNames: ['demo::alpha'], include: 'engine::', excludeNames: ['engine::beta'] });
  assert.deepEqual(workers[0].message.graph.nodes.map(node => node.name), ['a']);
  workers[0].receive({ id: workers[0].message.id, svg });
  assert.equal((await legacy).systemCount, 1);
  assert.equal((await renderer.render(grouped, { includePlugins: ['shared'], excludePlugins: ['shared'] })).systemCount, 0);
  assert.equal((await renderer.render(grouped, { includePlugins: ['plugin-Alpha'], exclude: 'demo::' })).systemCount, 0);
  renderer.dispose();
});

test('selected Plugin groups absent from a Schedule produce zero results without starting WASM', async () => {
  const { renderer, workers } = fixture();
  const grouped = { ...view, schedulePluginGroups: [{ id: 'empty', systemNames: [] }] };
  for (const id of ['empty', 'missing']) {
    const result = await renderer.render(grouped, { includePlugins: [id] });
    assert.equal(result.systemCount, 0);
    assert.equal(result.svg, null);
    assert.equal(result.filtered, true);
  }
  assert.equal(workers.length, 0);
  assert.equal((await renderer.render(grouped)).svg, svg);
  assert.equal(workers.length, 0);
  renderer.dispose();
});

test('submitted filtering sends only the selected graph and normalizes returned SVG', async () => {
  const { renderer, workers } = fixture();
  const pending = renderer.render(view, { include: 'demo' });
  assert.equal(workers.length, 1);
  const worker = workers[0];
  assert.deepEqual(worker.message.graph.nodes.map(node => node.name), ['a']);
  assert.deepEqual(worker.message.graph.edges, []);
  worker.receive({ id: worker.message.id - 1, svg: '<invalid/>' });
  worker.receive({ id: worker.message.id, svg });
  const result = await pending;
  assert.equal(result.systemCount, 1);
  assert.equal(result.totalSystemCount, 2);
  assert.deepEqual(result.legendKinds, ['system']);
  assert.match(result.svg, /id="schedule-example"/);
  renderer.dispose();
});

test('legend kinds follow the actual filtered graph and are published only with successful geometry', async () => {
  const contextView = structuredClone(view);
  contextView.scheduleGraph.nodes.push({ name: 'context', attributes: { label: 'ApplyDeferred' } },
    { name: 'marker', attributes: { style: 'invis', label: '', shape: 'point' } });
  contextView.scheduleGraph.edges.push({ tail: 'a', head: 'context', attributes: {} },
    { tail: 'a', head: 'marker', attributes: { dir: 'none' } },
    { tail: 'b', head: 'a', attributes: { style: 'invis' } });
  contextView.scheduleGraph.subgraphs.push({ name: 'cluster_sample', attributes: { label: 'Systems' }, nodes: ['a', 'marker'], edges: [2], subgraphs: [] });
  contextView.legendKinds = ['incorrect saved metadata'];
  const allKinds = ['system', 'system_set', 'context', 'order', 'set_membership'];
  const { renderer, workers } = fixture();
  assert.deepEqual((await renderer.render(contextView)).legendKinds, allKinds);
  let settled = false;
  const alpha = renderer.render(contextView, { includeNames: ['demo::alpha'] }).then(result => { settled = true; return result; });
  await Promise.resolve(); assert.equal(settled, false);
  assert.deepEqual(Object.keys(workers[0].message).sort(), ['graph', 'id'], 'legend metadata does not change the worker protocol');
  workers[0].receive({ id: workers[0].message.id, svg, legendKinds: ['forged worker metadata'] });
  assert.deepEqual((await alpha).legendKinds, allKinds);
  const beta = renderer.render(contextView, { includeNames: ['engine::beta'] });
  workers[0].receive({ id: workers[0].message.id, svg });
  assert.deepEqual((await beta).legendKinds, ['system']);
  assert.deepEqual((await renderer.render(contextView, { includeNames: ['missing'] })).legendKinds, []);
  const failed = renderer.render(contextView, { includeNames: ['demo::alpha'] });
  workers[0].receive({ id: workers[0].message.id, error: 'layout failed' });
  await assert.rejects(failed, /layout failed/);
  const cancelled = renderer.render(contextView, { includeNames: ['engine::beta'] });
  const rejection = assert.rejects(cancelled, { name: 'AbortError' });
  renderer.cancel(); await rejection;
  renderer.dispose();
});

test('cancellation terminates old instances and ignores their queued message and error events', async () => {
  const { renderer, workers, revoked } = fixture();
  const first = renderer.render(view, { include: 'demo' });
  const aborted = assert.rejects(first, { name: 'AbortError' });
  const old = workers[0];
  const second = renderer.render(view, { include: 'engine' });
  await aborted;
  assert.equal(old.terminated, true);
  assert.equal(revoked.length, 1);
  const current = workers[1];
  old.onerror({ message: 'stale failure' });
  old.onmessageerror();
  old.receive({ id: old.message.id, svg: '<script/>' });
  current.receive({ id: current.message.id, svg });
  assert.equal((await second).systemCount, 1);
  renderer.dispose();
});

test('worker failures, unsafe SVG, timeout, postMessage errors and disposal reject without returning replacement geometry', async () => {
  const a = fixture();
  const error = a.renderer.render(view, { include: 'demo' });
  a.workers[0].receive({ id: a.workers[0].message.id, error: 'Graphviz failed' });
  await assert.rejects(error, /Graphviz failed/);
  const unsafe = a.renderer.render(view, { include: 'demo' });
  a.workers[1].receive({ id: a.workers[1].message.id, svg: svg.replace('<path', '<script/><path') });
  await assert.rejects(unsafe, /Unexpected/);
  a.renderer.dispose();
  await assert.rejects(a.renderer.render(view), /disposed/);
  const b = fixture({ timeoutMs: 5 });
  await assert.rejects(b.renderer.render(view, { include: 'demo' }), /timed out/);
  assert.equal(b.workers[0].terminated, true);
  b.renderer.dispose();
  const c = fixture();
  const active = c.renderer.render(view, { include: 'demo' });
  c.workers[0].postMessage = () => { throw new Error('clone failed'); };
  c.workers[0].receive({ id: c.workers[0].message.id, svg });
  await active;
  await assert.rejects(c.renderer.render(view, { include: 'engine' }), /clone failed/);
  c.renderer.dispose();
});

test('offline runtime bundle defines a lazy factory without constructing a Worker or fetching assets', async () => {
  const assets = await scheduleRuntimeAssets();
  let constructors = 0;
  const window = {};
  vm.runInNewContext(assets.script, { window, structuredClone, Set, Map, Error, globalThis: { Worker: class { constructor() { constructors++; } } } });
  assert.equal(typeof window.createScheduleRenderer, 'function');
  assert.equal(constructors, 0);
  assert.doesNotMatch(assets.script, /<\/script/i);
  assert.match(assets.script, /Permission is hereby granted/);
  assert.match(assets.script, /Eclipse Public License - v 2.0/);
  assert.doesNotMatch(assets.script, /[ \t]+\r?$/m);
  const noticeLiteral = assets.script.match(/^void ("(?:[^"\\]|\\.)*");\n/);
  assert.ok(noticeLiteral, 'the complete license is embedded without changing its original whitespace');
  assert.equal(JSON.parse(noticeLiteral[1]), fs.readFileSync(new URL('../licenses/SCHEDULE-RUNTIME-LICENSES.txt', import.meta.url), 'utf8'));
});

test('the actual embedded Worker runs Graphviz without fetching any external asset', async () => {
  const { script } = await scheduleRuntimeAssets(), window = {}, sources = new Map();
  class Blob { constructor(parts) { this.source = parts.join(''); } }
  const urls = { createObjectURL: blob => { sources.set('blob:worker', blob.source); return 'blob:worker'; }, revokeObjectURL: url => sources.delete(url) };
  class Worker {
    constructor(url) {
      this.thread = new ThreadWorker("const { parentPort } = require('node:worker_threads'); globalThis.fetch = () => { throw new Error('External fetch is forbidden'); }; "
        + 'globalThis.postMessage = data => parentPort.postMessage(data); parentPort.on("message", data => globalThis.onmessage({data}));\n' + sources.get(url), { eval: true });
      this.thread.on('message', data => this.onmessage?.({ data }));
      this.thread.on('error', error => this.onerror?.(error));
    }
    postMessage(message) { this.thread.postMessage(message); }
    terminate() { this.thread.terminate(); }
  }
  vm.runInNewContext(script, { window, structuredClone, setTimeout, clearTimeout });
  const renderer = window.createScheduleRenderer({ WorkerClass: Worker, BlobClass: Blob, urls, dom: { DOMParser, XMLSerializer } });
  try {
    const actualView = structuredClone(view), fullName = 'demo::系统<Tuple<A, B>>';
    actualView.scheduleGraph.nodes[0].attributes.tooltip = fullName;
    actualView.scheduleGraph.subgraphs = [{ name: 'cluster_systems', attributes: { label: '系统集合' }, nodes: ['a', 'b'], edges: [0], subgraphs: [] }];
    actualView.schedulePluginGroups = [{ id: 'plugin-Example', systemNames: [fullName], systemCount: 1 },
      { id: 'crate:engine', systemNames: ['engine::beta'], systemCount: 1 }];
    const result = await renderer.render(actualView, { includePlugins: ['plugin-Example', 'crate:engine'], excludePlugins: ['crate:engine'] });
    assert.equal(result.systemCount, 1);
    assert.deepEqual(Array.from(result.legendKinds), ['system', 'system_set']);
    assert.match(result.svg, /<svg/);
    assert.match(result.svg, /alpha|>a<\/text>/);
    assert.match(result.svg, /class="schedule-cluster-title"/);
    assert.match(result.svg, /data-cluster-name="cluster_systems"/);
  } finally { renderer.dispose(); }
});

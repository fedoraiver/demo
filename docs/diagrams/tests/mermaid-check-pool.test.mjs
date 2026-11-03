import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { createMermaidCheckPool, MermaidCheckWorkerError } from '../src/mermaid-check-pool.mjs';
import { compileRoutedView, normalizeMermaidSvg } from '../src/mermaid-core.mjs';
import { objectRelationRuntimeAssets } from '../src/object-relation-runtime-assets.mjs';

function fixture() {
  const view = { id: 'worker-check-fixture', aspect: 'overview',
    mermaid: '---\n{"config":{"layout":"dagre","flowchart":{"nodeSpacing":32,"rankSpacing":56}}}\n---\nflowchart LR\n'
      + '  n0@{ shape: rect, label: "A" }\n  class n0 node_component\n  n1@{ shape: rect, label: "B" }\n  class n1 node_component\n',
    nodes: ['a', 'b'].map((id, index) => ({ id, instance: 'worker-' + id, mermaidId: 'n' + index, visualType: 'component', shape: 'rect', role: 'internal', displayLabel: id.toUpperCase() })),
    links: [], scheduleLinks: [], layoutLinks: [], scheduleGroups: [], entityGroups: [] };
  const registry = { a: { name: 'A', feature: 'test' }, b: { name: 'B', feature: 'test' } };
  function native(candidate, { overlap = false, broken = false } = {}) {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 150">'
      + ['a', 'b'].map((id, index) => `<g class="node" id="flowchart-n${index}-0" transform="translate(${overlap ? 50 : 50 + index * 150},75)"><rect x="-30" y="-15" width="60" height="30"/><g class="label"><text>${broken ? 'broken' : id.toUpperCase()}</text></g></g>`).join('') + '</svg>';
    return normalizeMermaidSvg(candidate, source, registry);
  }
  return { view, registry, native };
}

function trackedPool(t, jobs = 2) {
  const threads = [], operations = [];
  const pool = createMermaidCheckPool({ jobs, createWorker: () => {
    const thread = new Worker(new URL('../src/mermaid-check-worker.mjs', import.meta.url));
    const post = thread.postMessage.bind(thread);
    thread.postMessage = message => { operations.push(message.operation); return post(message); };
    threads.push(thread); return thread;
  } });
  t.after(() => pool.close());
  return { pool, threads, operations };
}

test('real worker checks preserve SVG bytes, label results, geometry errors and route errors', { timeout: 10000 }, async t => {
  const { pool, threads } = trackedPool(t), { view, native } = fixture(), compiled = native(view), before = structuredClone(compiled);
  const [geometry, labels, routes] = await Promise.all([pool.geometry(compiled), pool.labels(compiled), pool.routes(compiled)]);
  assert.deepEqual(geometry, { nodes: 2, edges: 0, layoutEdges: 0, scheduleEdges: 0, scheduleGroups: 0 });
  assert.deepEqual(labels, []); assert.deepEqual(routes, { edges: [], collisions: [] });
  assert.equal(threads.length, 2); assert.ok(threads.every(thread => thread.threadId > 0));
  assert.equal(new Set(threads.map(thread => thread.threadId)).size, 2);
  const brokenLabel = { ...compiled, nodes: compiled.nodes.map(node => ({ ...node, displayLabel: 'missing-' + node.id })) };
  assert.deepEqual(await pool.labels(brokenLabel), ['a', 'b']);
  await assert.rejects(pool.geometry({ ...compiled, width: -1 }), error => error.message === 'Mermaid viewport metadata mismatch' && !pool.isFatalError(error));
  await assert.rejects(pool.routes({ ...compiled, links: [{ id: 'missing-edge', from: 'a', to: 'b' }] }), error => error.message === 'Missing native routing path: worker-check-fixture/missing-edge' && !pool.isFatalError(error));
  assert.deepEqual(await pool.labels(compiled), []);
  assert.deepEqual(compiled, before);
  await pool.close(); assert.ok(threads.every(thread => thread.threadId === -1));
});

test('routing awaits worker label repair and retains the existing check order', { timeout: 10000 }, async t => {
  const { pool, operations } = trackedPool(t), { view, registry, native } = fixture(), sources = [];
  const result = await compileRoutedView(view, registry, async candidate => {
    sources.push(candidate.mermaid);
    return native(candidate, { broken: !candidate.mermaid.includes('"wrappingWidth": 1000') });
  }, { checks: pool });
  assert.equal(sources.length, 2); assert.equal(result.routing.rule, 'axis-or-curve');
  assert.deepEqual(operations, ['labels', 'routes', 'routes', 'labels', 'geometry']);
  assert.deepEqual(await pool.labels(result), []);
});

test('real geometry worker errors still select the original native clearance fallback', { timeout: 10000 }, async t => {
  const { pool } = trackedPool(t), { view, registry, native } = fixture(), sources = [], before = structuredClone(view);
  const result = await compileRoutedView(view, registry, async candidate => {
    sources.push(candidate.mermaid); return native(candidate, { overlap: !candidate.mermaid.includes('subgraph layout_card_') });
  }, { checks: pool });
  assert.equal(sources.length, 2); assert.match(result.mermaid, /subgraph layout_card_/);
  assert.deepEqual(view, before);
});

test('worker infrastructure errors escape the geometry fallback immediately', async () => {
  const { view, registry, native } = fixture(), failure = new MermaidCheckWorkerError(new Error('fixture crash'));
  let compilations = 0, attempts = 0;
  await assert.rejects(compileRoutedView(view, registry, async candidate => { compilations++; return native(candidate); }, {
    checks: { labels: () => [], routes: () => ({ edges: [] }), geometry: async () => { throw failure; }, isFatalError: error => error === failure },
    onAttempt: () => { attempts++; },
  }), error => error === failure);
  assert.equal(compilations, 1); assert.equal(attempts, 0);
});

test('bounded real CPU workers cross a shared barrier and keep each queued result matched to its request', { timeout: 10000 }, async t => {
  const threads = [], gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT), signal = new Int32Array(gate);
  const pool = createMermaidCheckPool({ jobs: 2, createWorker: () => {
    const thread = new Worker(`
      const { parentPort, workerData, threadId } = require('node:worker_threads');
      const gate = new Int32Array(workerData.gate);
      parentPort.on('message', ({ id, view }) => {
        if (view.barrier) {
          Atomics.add(gate, 0, 1); Atomics.notify(gate, 0);
          while (Atomics.load(gate, 0) < 2) Atomics.wait(gate, 0, 1);
        }
        let checksum = 0;
        for (let index = 0; index < view.work; index++) checksum = Math.imul(checksum ^ index, 16777619);
        parentPort.postMessage({ id, result: { request: view.id, threadId, checksum } });
      });
    `, { eval: true, workerData: { gate } });
    threads.push(thread); return thread;
  } });
  t.after(() => pool.close());
  const inputs = Array.from({ length: 6 }, (_, id) => ({ id, barrier: id < 2, work: id === 0 ? 20000000 : 1000000 }));
  const results = await Promise.all(inputs.map(view => pool.labels(view)));
  assert.equal(Atomics.load(signal, 0), 2);
  assert.equal(threads.length, 2); assert.equal(new Set(results.map(result => result.threadId)).size, 2);
  assert.deepEqual(results.map(result => result.request), inputs.map(view => view.id));
  assert.ok(results.every(result => Number.isInteger(result.checksum)));
  await pool.close(); assert.ok(threads.every(thread => thread.threadId === -1));
});

for (const mode of ['throw', 'exit', 'wrong-response']) test(`a real worker ${mode} rejects active and queued requests and terminates all threads`, { timeout: 10000 }, async t => {
  const threads = [];
  const pool = createMermaidCheckPool({ jobs: 1, createWorker: () => {
    const thread = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      parentPort.on('message', ({ id }) => {
        if (workerData === 'throw') throw new Error('fixture worker crash');
        if (workerData === 'exit') process.exit(7);
        parentPort.postMessage({ id: id + 1, result: [] });
      });
    `, { eval: true, workerData: mode });
    threads.push(thread); return thread;
  } });
  t.after(() => pool.close());
  const results = await Promise.allSettled([pool.labels({ id: 1 }), pool.routes({ id: 2 }), pool.geometry({ id: 3 })]);
  assert.ok(results.every(result => result.status === 'rejected' && pool.isFatalError(result.reason)));
  assert.equal(results[0].reason, results[2].reason);
  await assert.rejects(pool.labels({}), error => pool.isFatalError(error));
  await pool.close(); assert.ok(threads.every(thread => thread.threadId === -1));
});

test('closing an active pool rejects all work and waits for actual worker exit', { timeout: 10000 }, async () => {
  const threads = [];
  const pool = createMermaidCheckPool({ jobs: 1, createWorker: () => {
    const thread = new Worker("require('node:worker_threads').parentPort.on('message', () => {})", { eval: true }); threads.push(thread); return thread;
  } });
  const first = pool.labels({}), second = pool.routes({});
  const rejected = Promise.all([assert.rejects(first, error => pool.isFatalError(error)), assert.rejects(second, error => pool.isFatalError(error))]);
  const closing = pool.close(); assert.equal(pool.close(), closing);
  await rejected; await closing; assert.ok(threads.every(thread => thread.threadId === -1));
});

test('startup and structured-clone failures fail closed without stranding requests', { timeout: 10000 }, async t => {
  const failed = createMermaidCheckPool({ jobs: 1, createWorker: () => { throw new Error('fixture startup failure'); } });
  await assert.rejects(failed.labels({}), error => failed.isFatalError(error) && error.cause.message === 'fixture startup failure');
  await failed.close();
  const { pool, threads } = trackedPool(t, 1);
  await assert.rejects(pool.geometry({ svg: () => {} }), error => pool.isFatalError(error) && error.cause.name === 'DataCloneError');
  await pool.close(); assert.ok(threads.every(thread => thread.threadId === -1));
  for (const jobs of [0, -1, 1.5, 33, '2']) assert.throws(() => createMermaidCheckPool({ jobs }), /worker count/);
});

test('the browser relation runtime remains independent of Node worker threads', async () => {
  const { module } = await objectRelationRuntimeAssets();
  assert.ok(module.includes('createObjectRelationRenderer'));
  assert.ok(!module.includes('node:worker_threads'));
});

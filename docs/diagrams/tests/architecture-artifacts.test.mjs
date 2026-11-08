import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathsForRepository, repositoryRoot, artifactRelativePath } from '../src/paths.mjs';
import { writeExternalArchitecture, readArchitectureData, obsoleteExternalReferences, stampArchitecturePage } from '../src/architecture-artifacts.mjs';
import { startExternalArchitecture } from '../src/architecture-viewer.mjs';
import { testDocument } from './test-dom.mjs';
import { hashFile } from '../src/stream-files.mjs';

function fixture({ sidecar = false, objectRelationRuntime } = {}) {
  const temporary = path.join(repositoryRoot, 'tmp/ecs-architecture/artifact-tests');
  fs.mkdirSync(temporary, { recursive: true });
  const paths = pathsForRepository(fs.mkdtempSync(path.join(temporary, 'case-')));
  fs.mkdirSync(paths.pagesDirectory, { recursive: true });
  const data = { schemaVersion: 5, model: { schemaVersion: 2, features: [], entities: [], systems: [{ id: 'system-a' }] },
    registry: { a: { name: 'A' } }, objects: [{ id: 'a' }], objectAliases: {}, infrastructureFeatures: [],
    guideSamples: { nodes: { system: '<svg xmlns="http://www.w3.org/2000/svg"/>' }, edges: {}, schedule: { nodes: {}, edges: {} } },
    views: [{ id: 'object-a', aspect: 'object', engine: 'mermaid', objectId: 'a', centerNodeId: 'a', filename: 'ecs-object-a.svg',
      mermaidFilename: 'ecs-object-a.mmd', label: 'A', nodes: [{ id: 'a' }], links: [], width: 10, height: 10,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" id="object-a"/>', mermaid: 'flowchart TB\nA["中文"]\n' },
    { id: 'empty', aspect: 'object', svg: null, mermaid: null, filename: null, mermaidFilename: null, nodes: [], links: [] }],
  };
  const writeArtifact = (filename, text) => { const destination = path.join(paths.generatedDirectory, filename); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, text); };
  const compilerModelDirectory = path.join(paths.repositoryRoot, 'tmp/compiler');
  if (sidecar) {
    fs.mkdirSync(compilerModelDirectory, { recursive: true });
    const filename = path.join(compilerModelDirectory, 'model.calls.ndjson');
    fs.writeFileSync(filename, JSON.stringify({ id: 'call', caller: 'callable::root', callee: 'callable::helper', declaration: null,
      registeredOwners: ['a'], deferred: true, conditions: [], sourceEntries: [] }) + '\n');
    data.model.callGraph = { schemaVersion: 2, format: 'ndjson', file: 'model.calls.ndjson', sha256: hashFile(filename).sha256, edgeCount: 1 };
  }
  const copyArtifact = (filename, source, expectedSha256) => {
    const destination = path.join(paths.generatedDirectory, filename); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination);
    assert.equal(hashFile(destination).sha256, expectedSha256);
  };
  for (const view of data.views) if (view.svg) { writeArtifact(artifactRelativePath(view), view.svg); writeArtifact(artifactRelativePath(view, 'mermaid'), view.mermaid); }
  const bootstrap = writeExternalArchitecture({ paths, data, writeArtifact, copyArtifact, compilerModelDirectory, objectRelationRuntime,
    sourceCommit: 'a'.repeat(40), target: 'x86_64-pc-windows-msvc', sourcePage: '<!doctype html><html><head></head><body>完整源码快照</body></html>' });
  fs.writeFileSync(path.join(paths.pagesDirectory, 'ecs-architecture.html'), stampArchitecturePage('<script id="architecture-data" type="application/json">' + JSON.stringify(bootstrap) + '</script>', bootstrap));
  return { paths, data, bootstrap, compilerModelDirectory };
}

test('external architecture round trip preserves full facts, graph bytes and empty view nulls while runtime only carries references', () => {
  const { paths, data } = fixture();
  assert.deepEqual(readArchitectureData(paths.repositoryRoot), data);
  const runtime = JSON.parse(fs.readFileSync(path.join(paths.dataDirectory, 'runtime.json'), 'utf8'));
  assert.deepEqual(Object.keys(runtime.model).sort(), ['entities', 'features']);
  assert.equal(runtime.views[0].svg, undefined); assert.equal(runtime.views[0].nodes, undefined);
  assert.equal(runtime.views[0].resources.svg.url, '../svg/object/ecs-object-a.svg');
  assert.equal(runtime.views[0].relationCount, data.views[0].links.length);
  const metadata = JSON.parse(fs.readFileSync(path.join(paths.viewDataDirectory, 'object-a.json'), 'utf8'));
  for (const key of ['sourceCommit', 'target', 'buildId']) assert.equal(metadata[key], runtime[key]);
  assert.equal(metadata.svg, undefined); assert.equal(metadata.mermaid, undefined);
  assert.equal(fs.readFileSync(path.join(paths.objectSvgDirectory, 'ecs-object-a.svg'), 'utf8'), data.views[0].svg);
});

test('object relation runtime is manifest-bound while full graph exports and facts remain unchanged', () => {
  const source = 'export function createObjectRelationRenderer() {}', { paths, data } = fixture({ objectRelationRuntime: source });
  const manifest = JSON.parse(fs.readFileSync(path.join(paths.dataDirectory, 'manifest.json'), 'utf8'));
  const runtime = JSON.parse(fs.readFileSync(path.join(paths.dataDirectory, 'runtime.json'), 'utf8'));
  assert.deepEqual(manifest.objectRelationRuntime, { path: 'runtime/object-relations.mjs', ...hashFile(path.join(paths.generatedDirectory, 'runtime/object-relations.mjs')) });
  assert.deepEqual(runtime.objectRelationRuntime, { url: '../runtime/object-relations.mjs', sha256: manifest.objectRelationRuntime.sha256, bytes: Buffer.byteLength(source) });
  assert.deepEqual(readArchitectureData(paths.repositoryRoot), data);
  fs.appendFileSync(path.join(paths.generatedDirectory, 'runtime/object-relations.mjs'), ' ');
  assert.throws(() => readArchitectureData(paths.repositoryRoot), /resource hash mismatch/);
});

test('descriptor relation counts are checked against actual metadata links after transport hashes pass', () => {
  const { paths, bootstrap } = fixture();
  const runtimePath = path.join(paths.dataDirectory, 'runtime.json'), manifestPath = path.join(paths.dataDirectory, 'manifest.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8')), manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  runtime.views[0].relationCount++;
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  manifest.runtime = { path: manifest.runtime.path, ...hashFile(runtimePath) };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  bootstrap.runtimeSha256 = manifest.runtime.sha256; bootstrap.manifestSha256 = hashFile(manifestPath).sha256;
  const auditPath = path.join(paths.dataDirectory, 'audit-manifest.json'), audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  audit.manifest = { path: 'data/manifest.json', ...hashFile(manifestPath) }; fs.writeFileSync(auditPath, JSON.stringify(audit));
  fs.writeFileSync(path.join(paths.pagesDirectory, 'ecs-architecture.html'), '<script id="architecture-data">' + JSON.stringify(bootstrap) + '</script>');
  assert.throws(() => readArchitectureData(paths.repositoryRoot), /descriptor mismatch/);
});

test('full audit reads reject graph exports removed from both manifest and runtime descriptors', () => {
  for (const kind of ['svg', 'mermaid']) {
    const { paths, bootstrap } = fixture(), runtimePath = path.join(paths.dataDirectory, 'runtime.json'), manifestPath = path.join(paths.dataDirectory, 'manifest.json');
    const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8')), manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete manifest.views[0][kind]; delete runtime.views[0].resources[kind];
    fs.writeFileSync(runtimePath, JSON.stringify(runtime)); manifest.runtime = { path: 'data/runtime.json', ...hashFile(runtimePath) };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    bootstrap.runtimeSha256 = manifest.runtime.sha256; bootstrap.manifestSha256 = hashFile(manifestPath).sha256;
    const auditPath = path.join(paths.dataDirectory, 'audit-manifest.json'), audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    audit.manifest = { path: 'data/manifest.json', ...hashFile(manifestPath) }; fs.writeFileSync(auditPath, JSON.stringify(audit));
    fs.writeFileSync(path.join(paths.pagesDirectory, 'ecs-architecture.html'), '<script id="architecture-data">' + JSON.stringify(bootstrap) + '</script>');
    assert.throws(() => readArchitectureData(paths.repositoryRoot), new RegExp('Missing architecture ' + kind + ' artifact'));
  }
});

test('null graph text in metadata does not suppress declared exports or genuine empty views', () => {
  const { paths, data, bootstrap } = fixture(), metadataPath = path.join(paths.viewDataDirectory, 'object-a.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); metadata.svg = null; metadata.mermaid = null;
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  const runtimePath = path.join(paths.dataDirectory, 'runtime.json'), manifestPath = path.join(paths.dataDirectory, 'manifest.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8')), manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.views[0].data = { path: 'data/views/object-a.json', ...hashFile(metadataPath) };
  runtime.views[0].resources.data = { url: '../data/views/object-a.json', sha256: manifest.views[0].data.sha256, bytes: manifest.views[0].data.bytes };
  fs.writeFileSync(runtimePath, JSON.stringify(runtime)); manifest.runtime = { path: 'data/runtime.json', ...hashFile(runtimePath) };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  bootstrap.runtimeSha256 = manifest.runtime.sha256; bootstrap.manifestSha256 = hashFile(manifestPath).sha256;
  const auditPath = path.join(paths.dataDirectory, 'audit-manifest.json'), audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  audit.manifest = { path: 'data/manifest.json', ...hashFile(manifestPath) }; fs.writeFileSync(auditPath, JSON.stringify(audit));
  fs.writeFileSync(path.join(paths.pagesDirectory, 'ecs-architecture.html'), '<script id="architecture-data">' + JSON.stringify(bootstrap) + '</script>');
  assert.deepEqual(readArchitectureData(paths.repositoryRoot), data);
});

test('external architecture fails on changed or missing resources and malformed bootstrap paths', () => {
  for (const change of ['svg', 'metadata', 'runtime', 'model', 'missing', 'unsafe']) {
    const { paths, bootstrap } = fixture();
    const file = change === 'svg' || change === 'missing' ? path.join(paths.objectSvgDirectory, 'ecs-object-a.svg')
      : change === 'metadata' ? path.join(paths.viewDataDirectory, 'object-a.json') : path.join(paths.dataDirectory, change + '.json');
    if (change === 'missing') fs.unlinkSync(file);
    else if (change === 'unsafe') {
      bootstrap.manifestUrl = '../../outside.json';
      fs.writeFileSync(path.join(paths.pagesDirectory, 'ecs-architecture.html'), '<script id="architecture-data">' + JSON.stringify(bootstrap) + '</script>');
    } else fs.appendFileSync(file, ' ');
    assert.throws(() => readArchitectureData(paths.repositoryRoot), /hash mismatch|ENOENT|Unsafe/);
  }
});

test('external resource cleanup only retires managed view data and legend entries from the previous manifest', () => {
  const previous = { views: [{ data: { path: 'data/views/old.json' } }, { data: { path: 'data/views/kept.json' } }],
    guide: { path: 'svg/legend/old.svg' }, callGraph: { path: 'data/old.calls.ndjson' }, unrelated: [{ path: '../../catalog/ecs-data.json' }, { path: 'data/runtime.json' }] };
  const current = { views: [{ data: { path: 'data/views/kept.json' } }] };
  assert.deepEqual(obsoleteExternalReferences(previous, current).sort(), ['data/old.calls.ndjson', 'data/views/old.json', 'svg/legend/old.svg']);
});

test('the generated manifest and runtime bootstrap start together without loading graph files or the full build model', async () => {
  const { paths, bootstrap } = fixture({ sidecar: true }), requests = [], document = testDocument('<div id="schedule-status" hidden></div>');
  const location = new URL('http://127.0.0.1:4173/pages/ecs-architecture.html'), window = {};
  let received;
  const app = await startExternalArchitecture({ bootstrap, document, window, location,
    fetch: async url => { requests.push(url); return new Response(fs.readFileSync(path.join(paths.generatedDirectory, new URL(url).pathname))); },
    createNavigation: () => ({}), createViewer: options => { received = options; return { ready: Promise.resolve() }; },
  });
  assert.equal(Boolean(app), true, document.getElementById('schedule-status').textContent);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(url => /\/data\/(runtime|manifest)\.json$/.test(url)));
  assert.deepEqual(Object.keys(received.data.model).sort(), ['entities', 'features']);
  assert.equal(typeof received.loadView, 'function');
});

test('full compiler call graph bytes remain audit-bound and absent from the browser manifest', () => {
  const { paths, data, compilerModelDirectory } = fixture({ sidecar: true });
  const filename = path.join(paths.dataDirectory, 'model.calls.ndjson');
  assert.deepEqual(fs.readFileSync(filename), fs.readFileSync(path.join(compilerModelDirectory, 'model.calls.ndjson')));
  const manifest = JSON.parse(fs.readFileSync(path.join(paths.dataDirectory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 2); assert.equal(manifest.callGraph, undefined); assert.equal(manifest.model, undefined);
  const audit = JSON.parse(fs.readFileSync(path.join(paths.dataDirectory, 'audit-manifest.json'), 'utf8'));
  assert.deepEqual(audit.callGraph, { path: 'data/model.calls.ndjson', ...hashFile(filename) });
  assert.equal(audit.buildId, manifest.buildId);
  assert.deepEqual(readArchitectureData(paths.repositoryRoot), data);
  fs.appendFileSync(filename, ' ');
  assert.throws(() => readArchitectureData(paths.repositoryRoot), /call graph hash mismatch/);
  fs.unlinkSync(filename);
  assert.throws(() => readArchitectureData(paths.repositoryRoot), /ENOENT/);
});

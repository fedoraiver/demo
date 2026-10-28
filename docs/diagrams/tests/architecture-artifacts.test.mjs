import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathsForRepository, repositoryRoot, artifactRelativePath } from '../src/paths.mjs';
import { writeExternalArchitecture, readArchitectureData, obsoleteExternalReferences } from '../src/architecture-artifacts.mjs';
import { startExternalArchitecture } from '../src/architecture-viewer.mjs';
import { testDocument } from './test-dom.mjs';

function fixture() {
  const temporary = path.join(repositoryRoot, 'tmp/ecs-architecture/artifact-tests');
  fs.mkdirSync(temporary, { recursive: true });
  const paths = pathsForRepository(fs.mkdtempSync(path.join(temporary, 'case-')));
  fs.mkdirSync(paths.catalogDirectory, { recursive: true });
  fs.mkdirSync(paths.pagesDirectory, { recursive: true });
  fs.writeFileSync(path.join(paths.catalogDirectory, 'ecs-data.json'), '{}');
  const data = { schemaVersion: 5, model: { features: [], entities: [], systems: [{ id: 'system-a', description: '中文说明' }] },
    registry: { a: { name: 'A', description: '完整说明 <&>' } }, objects: [{ id: 'a' }], objectAliases: {},
    guideSamples: { nodes: { system: '<svg xmlns="http://www.w3.org/2000/svg"/>' }, edges: {}, schedule: { nodes: {}, edges: {} } },
    views: [{ id: 'object-a', aspect: 'object', engine: 'mermaid', objectId: 'a', centerNodeId: 'a', filename: 'ecs-object-a.svg',
      mermaidFilename: 'ecs-object-a.mmd', label: 'A', nodes: [{ id: 'a' }], links: [], width: 10, height: 10,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" id="object-a"/>', mermaid: 'flowchart TB\nA["中文"]\n' },
    { id: 'empty', aspect: 'object', svg: null, mermaid: null, filename: null, mermaidFilename: null, nodes: [], links: [] }],
  };
  const writeArtifact = (filename, text) => { const destination = path.join(paths.generatedDirectory, filename); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, text); };
  for (const view of data.views) if (view.svg) { writeArtifact(artifactRelativePath(view), view.svg); writeArtifact(artifactRelativePath(view, 'mermaid'), view.mermaid); }
  const bootstrap = writeExternalArchitecture({ paths, data, writeArtifact });
  fs.writeFileSync(path.join(paths.pagesDirectory, 'ecs-architecture.html'), '<script id="architecture-data" type="application/json">' + JSON.stringify(bootstrap) + '</script>');
  return { paths, data, bootstrap };
}

test('external architecture round trip preserves full facts, graph bytes and empty view nulls while runtime only carries references', () => {
  const { paths, data } = fixture();
  assert.deepEqual(readArchitectureData(paths.repositoryRoot), data);
  const runtime = JSON.parse(fs.readFileSync(path.join(paths.dataDirectory, 'runtime.json'), 'utf8'));
  assert.deepEqual(Object.keys(runtime.model).sort(), ['entities', 'features']);
  assert.equal(runtime.views[0].svg, undefined); assert.equal(runtime.views[0].nodes, undefined);
  assert.equal(runtime.views[0].resources.svg.url, '../svg/object/ecs-object-a.svg');
  const metadata = JSON.parse(fs.readFileSync(path.join(paths.viewDataDirectory, 'object-a.json'), 'utf8'));
  assert.equal(metadata.svg, undefined); assert.equal(metadata.mermaid, undefined);
  assert.equal(fs.readFileSync(path.join(paths.objectSvgDirectory, 'ecs-object-a.svg'), 'utf8'), data.views[0].svg);
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
    guide: { path: 'svg/legend/old.svg' }, unrelated: [{ path: '../../catalog/ecs-data.json' }, { path: 'data/runtime.json' }] };
  const current = { views: [{ data: { path: 'data/views/kept.json' } }] };
  assert.deepEqual(obsoleteExternalReferences(previous, current).sort(), ['data/views/old.json', 'svg/legend/old.svg']);
});

test('the generated manifest and runtime bootstrap start together without loading graph files or the full build model', async () => {
  const { paths, bootstrap } = fixture(), requests = [], document = testDocument('<div id="schedule-status" hidden></div>');
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

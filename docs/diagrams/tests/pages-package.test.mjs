import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathsForRepository, repositoryRoot, artifactRelativePath } from '../src/paths.mjs';
import { writeExternalArchitecture, stampArchitecturePage } from '../src/architecture-artifacts.mjs';
import { packPages, checkPages, checkPagesBudget, replacePagesDirectory, PAGES_BUDGET_BYTES } from '../src/pages-package.mjs';
import { startExternalArchitecture, renderArchitectureViewer } from '../src/architecture-viewer.mjs';
import { writeSourceViewer } from '../src/source-viewer.mjs';
import { testDocument } from './test-dom.mjs';
import { hashFile } from '../src/stream-files.mjs';

function fixture(t, { realPages = false } = {}) {
  const parent = path.join(repositoryRoot, 'tmp/ecs-architecture/pages-package-tests');
  fs.mkdirSync(parent, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(parent, 'case-')), paths = pathsForRepository(workspace);
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const put = (filename, text) => {
    const target = path.join(paths.generatedDirectory, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text);
  };
  const data = { schemaVersion: 5, model: { schemaVersion: 2, features: [], entities: [] }, registry: { a: { name: 'A', kind: 'System' } },
    infrastructureFeatures: [], guideSamples: { nodes: { system: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>' }, edges: {} },
    views: [{ id: 'object-a', aspect: 'object', engine: 'mermaid', objectId: 'a', centerNodeId: 'a', label: 'A',
      filename: 'ecs-object-a.svg', mermaidFilename: 'ecs-object-a.mmd', svg: '<svg xmlns="http://www.w3.org/2000/svg" id="object-a" viewBox="0 0 10 10"/>', mermaid: 'flowchart LR\na[A]',
      nodes: [{ id: 'a' }], links: [], sections: [], width: 10, height: 10 },
    { id: 'schedule-main', aspect: 'schedule', engine: 'graphviz', application: 'main', label: 'Update', filename: 'ecs-schedule-main.svg',
      dotFilename: 'ecs-schedule-main.dot', svg: '<svg xmlns="http://www.w3.org/2000/svg" id="schedule-main" viewBox="0 0 10 10"/>', dot: 'digraph G { a; }', nodes: [], links: [], sections: [], width: 10, height: 10 }] };
  for (const view of data.views) {
    put(artifactRelativePath(view), view.svg);
    if (view.mermaid) put(artifactRelativePath(view, 'mermaid'), view.mermaid);
    if (view.dot) put(artifactRelativePath(view, 'dot'), view.dot);
  }
  const compilerModelDirectory = path.join(workspace, 'tmp/compiler'); fs.mkdirSync(compilerModelDirectory, { recursive: true });
  fs.writeFileSync(path.join(compilerModelDirectory, 'model.calls.ndjson'), '{"id":"full-evidence"}\n');
  data.model.callGraph = { schemaVersion: 2, format: 'ndjson', file: 'model.calls.ndjson', edgeCount: 1,
    sha256: hashFile(path.join(compilerModelDirectory, 'model.calls.ndjson')).sha256 };
  const sourcePage = realPages ? fs.readFileSync(writeSourceViewer({ outputDirectory: paths.pagesDirectory, sources: [] }), 'utf8')
    : '<html><head></head><body><a href="ecs-architecture.html">架构图</a><script id="sources" type="application/json">[]</script></body></html>';
  const bootstrap = writeExternalArchitecture({ paths, data, writeArtifact: put, compilerModelDirectory,
    copyArtifact: (filename, source) => put(filename, fs.readFileSync(source)),
    sourceCommit: 'a'.repeat(40), target: 'x86_64-pc-windows-msvc', objectRelationRuntime: 'export const renderer = true;',
    sourcePage,
    licenses: [{ path: 'licenses/SCHEDULE-RUNTIME-LICENSES.txt', content: '完整依赖许可\n' }] });
  const mainPage = realPages ? renderArchitectureViewer({ ...data, features: [], externalBootstrap: bootstrap })
    : '<html><head></head><body><script id="architecture-data" type="application/json">' + JSON.stringify(bootstrap) + '</script></body></html>';
  put('pages/ecs-architecture.html', stampArchitecturePage(mainPage, bootstrap));
  put('dot/debugdump-manifest.json', '{"privateAudit":true}');
  return { workspace, paths, bootstrap, put };
}

function rewriteTransport(fixture, directory, manifest, runtime) {
  const runtimePath = path.join(directory, 'data/runtime.json'), manifestPath = path.join(directory, 'data/manifest.json');
  fs.writeFileSync(runtimePath, JSON.stringify(runtime)); manifest.runtime = { path: 'data/runtime.json', ...hashFile(runtimePath) };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fixture.bootstrap.runtimeSha256 = manifest.runtime.sha256; fixture.bootstrap.manifestSha256 = hashFile(manifestPath).sha256;
  const pagePath = path.join(directory, 'pages/ecs-architecture.html'), html = fs.readFileSync(pagePath, 'utf8');
  fs.writeFileSync(pagePath, html.replace(/(<script\b[^>]*\bid=["']architecture-data["'][^>]*>)[\s\S]*?(<\/script>)/,
    (_, before, after) => before + JSON.stringify(fixture.bootstrap) + after));
}

test('Pages package contains the complete static resource closure and excludes the full compiler audit', t => {
  const f = fixture(t), packed = packPages({ workspace: f.workspace });
  assert.equal(packed.directory, path.join(f.workspace, 'tmp/ecs-architecture/pages'));
  assert.equal(packed.budgetBytes, 900000000); assert.ok(packed.bytes > 0 && packed.bytes < PAGES_BUDGET_BYTES);
  assert.deepEqual(checkPages({ workspace: f.workspace }), packed);
  for (const filename of ['data/model.json', 'data/model.calls.ndjson', 'data/audit-manifest.json', 'dot/debugdump-manifest.json']) {
    assert.equal(fs.existsSync(path.join(packed.directory, filename)), false, filename);
    assert.ok(fs.existsSync(path.join(f.paths.generatedDirectory, filename)), 'Audit input remains available: ' + filename);
  }
  for (const filename of ['pages/ecs-source.html', 'mermaid/ecs-object-a.mmd', 'dot/ecs-schedule-main.dot', 'runtime/object-relations.mjs', 'licenses/SCHEDULE-RUNTIME-LICENSES.txt']) {
    assert.deepEqual(fs.readFileSync(path.join(packed.directory, filename)), fs.readFileSync(path.join(f.paths.generatedDirectory, filename)));
  }
});

test('Pages entry preserves deep-link query and fragment under a repository subpath', t => {
  const f = fixture(t), { directory } = packPages({ workspace: f.workspace });
  const index = fs.readFileSync(path.join(directory, 'index.html'), 'utf8'), script = /<script>([\s\S]*?)<\/script>/.exec(index)[1];
  let redirected;
  const location = new URL('https://example.github.io/demo/?object=a&node=a&workspace=D%3A%2Fdemo#detail');
  location.replace = href => { redirected = href; };
  vm.runInNewContext(script, { location, URL });
  assert.equal(redirected, 'https://example.github.io/demo/pages/ecs-architecture.html?object=a&node=a&workspace=D%3A%2Fdemo#detail');
  assert.ok(index.includes('href="pages/ecs-architecture.html"'));
});

test('actual generated viewer and source pages have a complete static resource closure', t => {
  const f = fixture(t, { realPages: true }), packed = packPages({ workspace: f.workspace });
  assert.deepEqual(checkPages({ workspace: f.workspace }), packed);
});

test('HTTPS repository-subpath bootstrap loads only public runtime and manifest resources', async t => {
  const f = fixture(t), { directory } = packPages({ workspace: f.workspace }), requests = [];
  const location = new URL('https://example.github.io/demo/pages/ecs-architecture.html'), document = testDocument('<div id="schedule-status" hidden></div>');
  const app = await startExternalArchitecture({ bootstrap: f.bootstrap, document, window: {}, location,
    fetch: async href => {
      const url = new URL(href); assert.ok(url.pathname.startsWith('/demo/')); requests.push(url.pathname);
      return new Response(fs.readFileSync(path.join(directory, url.pathname.slice('/demo/'.length))));
    }, createNavigation: () => ({}), createViewer: () => ({ ready: Promise.resolve() }) });
  assert.ok(app, document.getElementById('schedule-status').textContent);
  assert.deepEqual(requests.sort(), ['/demo/data/manifest.json', '/demo/data/runtime.json']);
});

test('pack rejects corrupt source resources before replacing the previous verified package', t => {
  const f = fixture(t), packed = packPages({ workspace: f.workspace }), before = fs.readFileSync(path.join(packed.directory, 'site-manifest.json'));
  fs.appendFileSync(path.join(f.paths.objectSvgDirectory, 'ecs-object-a.svg'), 'changed');
  assert.throws(() => packPages({ workspace: f.workspace }), /hash or size mismatch/);
  assert.deepEqual(fs.readFileSync(path.join(packed.directory, 'site-manifest.json')), before);
  assert.deepEqual(checkPages({ workspace: f.workspace }), packed);
});

test('a failed directory installation restores the complete previously checked package', t => {
  const f = fixture(t), packed = packPages({ workspace: f.workspace });
  const incoming = packPages({ workspace: f.workspace, outdir: 'tmp/ecs-architecture/incoming' });
  const previous = fs.readFileSync(path.join(packed.directory, 'site-manifest.json'));
  const injected = new Error('Injected directory installation failure');
  assert.throws(() => replacePagesDirectory(f.workspace, incoming.directory, packed.directory, {
    rename: (source, target) => { if (source === incoming.directory) throw injected; fs.renameSync(source, target); },
  }), error => error === injected);
  assert.deepEqual(fs.readFileSync(path.join(packed.directory, 'site-manifest.json')), previous);
  assert.deepEqual(checkPages({ workspace: f.workspace }), packed);
  assert.deepEqual(checkPages({ workspace: f.workspace, directory: incoming.directory }), incoming);
});

test('a tmp ancestor junction cannot redirect package writes outside the workspace', t => {
  const f = fixture(t), parent = path.dirname(f.workspace), outside = fs.mkdtempSync(path.join(parent, 'outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const sentinel = path.join(outside, 'keep.txt'); fs.writeFileSync(sentinel, 'unrelated directory');
  const taskTmp = path.join(f.workspace, 'tmp');
  assert.ok(taskTmp.startsWith(f.workspace + path.sep));
  fs.renameSync(taskTmp, path.join(f.workspace, 'original-tmp'));
  try { fs.symlinkSync(outside, taskTmp, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Directory link creation is unavailable on this host.'); return; } throw error; }
  try {
    assert.throws(() => packPages({ workspace: f.workspace }), /directories must not contain links/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unrelated directory');
    assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
  } finally { fs.unlinkSync(taskTmp); }
});

test('HTML resource links are checked for both pages while inline script text remains text', t => {
  for (const markup of ['<script src="../runtime/missing.mjs"></script>', '<link rel="stylesheet" href="../missing.css">',
    '<style>body{background:url(../missing.png)}</style>', '<img src="https://cdn.invalid/image.png">',
    '<script src="/repository/runtime/object-relations.mjs"></script>']) {
    const f = fixture(t), page = path.join(f.paths.pagesDirectory, 'ecs-architecture.html');
    fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('</body>', markup + '</body>'));
    assert.throws(() => packPages({ workspace: f.workspace }), /HTML resource is missing|External Pages HTML resource|must be repository-relative/);
  }
  const f = fixture(t), sourcePath = path.join(f.paths.pagesDirectory, 'ecs-source.html');
  fs.writeFileSync(sourcePath, fs.readFileSync(sourcePath, 'utf8').replace('</body>', '<img src="../missing-source.png"></body>'));
  const manifestPath = path.join(f.paths.dataDirectory, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.pages.source = { path: 'pages/ecs-source.html', ...hashFile(sourcePath) };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest)); f.bootstrap.manifestSha256 = hashFile(manifestPath).sha256;
  f.put('pages/ecs-architecture.html', stampArchitecturePage('<html><head></head><body><script id="architecture-data">' + JSON.stringify(f.bootstrap) + '</script></body></html>', f.bootstrap));
  assert.throws(() => packPages({ workspace: f.workspace }), /HTML resource is missing.*missing-source/);
  const valid = fixture(t), page = path.join(valid.paths.pagesDirectory, 'ecs-architecture.html');
  fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('</body>', '<script>const example=\'<img src="not-an-actual-resource.png">\';</script></body>'));
  assert.ok(packPages({ workspace: valid.workspace }).files > 0);
});

test('package checks reject extra audit files, missing assets and altered build identities', t => {
  for (const change of ['extra', 'missing', 'identity']) {
    const f = fixture(t), { directory } = packPages({ workspace: f.workspace });
    if (change === 'extra') fs.writeFileSync(path.join(directory, 'data/model.json'), '{}');
    else if (change === 'missing') fs.unlinkSync(path.join(directory, 'mermaid/ecs-object-a.mmd'));
    else {
      const filename = path.join(directory, 'site-manifest.json'), value = JSON.parse(fs.readFileSync(filename, 'utf8'));
      value.target = 'aarch64-unknown-linux-gnu'; fs.writeFileSync(filename, JSON.stringify(value));
    }
    assert.throws(() => checkPages({ workspace: f.workspace }), /Unexpected or missing|ENOENT|provenance mismatch/);
  }
});

test('public checks require every declared export even after runtime descriptors are forged to omit it', t => {
  for (const [index, kind] of [[0, 'svg'], [0, 'mermaid'], [1, 'svg'], [1, 'dot']]) {
    for (const packed of [false, true]) {
      const f = fixture(t), directory = packed ? packPages({ workspace: f.workspace }).directory : f.paths.generatedDirectory;
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'data/manifest.json'), 'utf8'));
      const runtime = JSON.parse(fs.readFileSync(path.join(directory, 'data/runtime.json'), 'utf8'));
      delete manifest.views[index][kind]; delete runtime.views[index].resources[kind];
      rewriteTransport(f, directory, manifest, runtime);
      assert.throws(() => packed ? checkPages({ workspace: f.workspace }) : packPages({ workspace: f.workspace }),
        new RegExp('Missing architecture ' + kind + ' artifact'));
    }
  }
});

test('rehashing transport descriptors cannot hide a view from a different build target', t => {
  const f = fixture(t), metadataPath = path.join(f.paths.viewDataDirectory, 'object-a.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); metadata.target = 'aarch64-unknown-linux-gnu';
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  const manifestPath = path.join(f.paths.dataDirectory, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.views[0].data = { path: 'data/views/object-a.json', ...hashFile(metadataPath) };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest)); f.bootstrap.manifestSha256 = hashFile(manifestPath).sha256;
  f.put('pages/ecs-architecture.html', stampArchitecturePage('<script id="architecture-data">' + JSON.stringify(f.bootstrap) + '</script>', f.bootstrap));
  assert.throws(() => packPages({ workspace: f.workspace }), /provenance mismatch/);
});

test('Pages source and package files cannot be hard links or symbolic links', t => {
  const f = fixture(t), { directory } = packPages({ workspace: f.workspace });
  const svg = path.join(directory, 'svg/object/ecs-object-a.svg'), linked = path.join(f.workspace, 'linked.svg');
  fs.linkSync(svg, linked);
  assert.throws(() => checkPages({ workspace: f.workspace }), /without links/);
  fs.unlinkSync(linked);
  const source = path.join(f.paths.objectSvgDirectory, 'ecs-object-a.svg');
  fs.linkSync(source, linked);
  assert.throws(() => packPages({ workspace: f.workspace }), /without links/);
  fs.unlinkSync(linked);
  fs.unlinkSync(svg);
  try { fs.symlinkSync(source, svg); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('Symbolic-link creation is unavailable on this Windows host; hard-link paths were checked.'); return; } throw error; }
  assert.throws(() => checkPages({ workspace: f.workspace }), /without links/);
});

test('Pages paths stay within the resource closure and task output directory', t => {
  const f = fixture(t);
  assert.throws(() => packPages({ workspace: f.workspace, outdir: '../outside' }), /output must remain/);
  const filename = path.join(f.paths.dataDirectory, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  manifest.licenses[0].path = '../outside.txt'; fs.writeFileSync(filename, JSON.stringify(manifest));
  const page = path.join(f.paths.pagesDirectory, 'ecs-architecture.html');
  f.bootstrap.manifestSha256 = hashFile(filename).sha256;
  fs.writeFileSync(page, stampArchitecturePage('<script id="architecture-data">' + JSON.stringify(f.bootstrap) + '</script>', f.bootstrap));
  assert.throws(() => packPages({ workspace: f.workspace }), /Invalid Pages license path|Unsafe Pages resource path/);
});

test('Pages total-byte budget accepts its boundary and rejects larger or invalid sizes', () => {
  checkPagesBudget(PAGES_BUDGET_BYTES);
  for (const size of [PAGES_BUDGET_BYTES + 1, -1, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => checkPagesBudget(size), /exceeds/);
});

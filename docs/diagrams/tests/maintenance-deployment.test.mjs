import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { repositoryRoot } from '../src/paths.mjs';
import { verifyDeployedPages } from '../src/maintenance-deployment.mjs';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
async function deploymentFixture(t, respond) {
  const parent = path.join(repositoryRoot, 'tmp/ecs-architecture/deployment-tests');
  fs.mkdirSync(parent, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(parent, 'case-'));
  const provenance = { buildId: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), target: 'x86_64-unknown-linux-gnu' };
  const meta = Object.entries(provenance).map(([key, value]) => `<meta name="architecture-${key}" content="${value}">`).join('');
  const files = new Map([
    ['data/manifest.json', JSON.stringify({ schemaVersion: 2, ...provenance })],
    ['data/runtime.json', JSON.stringify({ schemaVersion: 6, ...provenance })],
    ['data/views/first.json', JSON.stringify({ id: 'first', ...provenance })],
    ['svg/schedule/first.svg', '<svg>Schedule</svg>'], ['svg/object/first.svg', '<svg>Object</svg>'], ['svg/legend/first.svg', '<svg>Legend</svg>'],
    ['runtime/relations.mjs', 'export const fixture=true;'], ['dot/first.dot', 'digraph {}'], ['mermaid/first.mmd', 'flowchart LR'],
    ['pages/ecs-source.html', '<!doctype html><head>' + meta + '</head><body>Frozen source</body>'],
    ['index.html', '<!doctype html><head>' + meta + '</head><a href="pages/ecs-architecture.html">Open</a>'],
  ]);
  const bootstrap = { schemaVersion: 6, ...provenance, manifestUrl: '../data/manifest.json', runtimeUrl: '../data/runtime.json',
    manifestSha256: sha256(files.get('data/manifest.json')), runtimeSha256: sha256(files.get('data/runtime.json')) };
  files.set('pages/ecs-architecture.html', '<!doctype html><head>' + meta + '</head><script id="architecture-data" type="application/json">' + JSON.stringify(bootstrap) + '</script>');
  const proof = { schemaVersion: 1, ...provenance, files: [...files].map(([path, text]) => ({ path, bytes: Buffer.byteLength(text), sha256: sha256(text) })) };
  files.set('site-manifest.json', JSON.stringify(proof));
  fs.writeFileSync(path.join(workspace, 'expected.json'), files.get('site-manifest.json'));
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost'), filename = url.pathname === '/demo/' ? 'index.html' : url.pathname.slice('/demo/'.length);
    requests.push({ filename, query: url.searchParams.get('ecs-build') });
    const overridden = respond?.({ filename, requests, files });
    response.statusCode = overridden?.status || (files.has(filename) ? 200 : 404);
    response.setHeader('content-type', filename.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream');
    response.end(overridden?.body ?? files.get(filename) ?? 'Missing');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(workspace, { recursive: true, force: true }); });
  return { workspace, provenance, files, requests, url: `http://127.0.0.1:${server.address().port}/demo/`, expectedFile: 'expected.json' };
}

test('deployed HTTP verification checks exact artifact provenance and each key resource class', async t => {
  const f = await deploymentFixture(t);
  const result = await verifyDeployedPages({ ...f, expectedCommit: f.provenance.sourceCommit });
  assert.equal(result.status, 'passed'); assert.equal(result.attempts, 1);
  assert.equal(result.checkedResources, f.files.size);
  assert.deepEqual(new Set(f.requests.map(request => request.filename)), new Set(f.files.keys()));
  assert.ok(f.requests.every(request => request.query === f.provenance.buildId + '-1'));
  const evidence = JSON.parse(fs.readFileSync(result.evidencePath, 'utf8'));
  assert.deepEqual(evidence.expected, f.provenance); assert.equal(evidence.status, 'passed');
});

test('CDN retries fetch only failed and outstanding resources rather than downloading verified sources again', async t => {
  let runtimeAttempts = 0;
  const f = await deploymentFixture(t, ({ filename }) => filename === 'data/runtime.json' && ++runtimeAttempts === 1 ? { body: 'Old CDN runtime' } : undefined);
  const waits = [];
  const result = await verifyDeployedPages({ ...f, maxAttempts: 2, sleep: async milliseconds => { waits.push(milliseconds); } });
  assert.equal(result.attempts, 2); assert.deepEqual(waits, [10000]);
  assert.equal(f.requests.filter(request => request.filename === 'pages/ecs-source.html').length, 1);
  assert.equal(f.requests.filter(request => request.filename === 'data/runtime.json').length, 2);
  const evidence = JSON.parse(fs.readFileSync(result.evidencePath, 'utf8'));
  assert.match(evidence.attempts[0].error, /integrity mismatch/);
  assert.equal(evidence.attempts[0].resources.at(-1).status, 200);
});

test('persistent deployed errors fail after the bounded retry count and preserve HTTP evidence', async t => {
  const f = await deploymentFixture(t, () => ({ status: 503, body: 'Not propagated' }));
  await assert.rejects(verifyDeployedPages({ ...f, maxAttempts: 2, sleep: async () => {} }), /verification failed/);
  const evidence = JSON.parse(fs.readFileSync(path.join(f.workspace, 'tmp/ecs-architecture/deployment/verification.json'), 'utf8'));
  assert.equal(evidence.status, 'failed'); assert.equal(evidence.attempts.length, 2); assert.equal(f.requests.length, 2);
  assert.ok(evidence.attempts.every(attempt => attempt.resources[0].status === 503));
});

test('a publication proof from another commit fails before any network request', async t => {
  const f = await deploymentFixture(t);
  await assert.rejects(verifyDeployedPages({ ...f, expectedCommit: 'c'.repeat(40) }), /publication proof/);
  assert.deepEqual(f.requests, []);
});

test('matching response hashes cannot hide a different bootstrap commit', async t => {
  const f = await deploymentFixture(t), filename = 'pages/ecs-architecture.html';
  f.files.set(filename, f.files.get(filename).replace('"sourceCommit":"' + f.provenance.sourceCommit + '"', '"sourceCommit":"' + 'c'.repeat(40) + '"'));
  const proof = JSON.parse(f.files.get('site-manifest.json')), reference = proof.files.find(file => file.path === filename);
  reference.sha256 = sha256(f.files.get(filename)); reference.bytes = Buffer.byteLength(f.files.get(filename));
  f.files.set('site-manifest.json', JSON.stringify(proof));
  fs.writeFileSync(path.join(f.workspace, 'expected.json'), f.files.get('site-manifest.json'));
  await assert.rejects(verifyDeployedPages({ ...f, maxAttempts: 1 }), /verification failed/);
  const evidence = JSON.parse(fs.readFileSync(path.join(f.workspace, 'tmp/ecs-architecture/deployment/verification.json'), 'utf8'));
  assert.match(evidence.attempts[0].error, /bootstrap\/sourceCommit/);
});

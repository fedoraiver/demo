import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createArchitectureServer, runServeCli } from '../src/serve.mjs';
import { pathsForRepository, repositoryRoot } from '../src/paths.mjs';

const files = {
  'pages/ecs-architecture.html': '<main>架构图</main>',
  'pages/ecs-source.html': '<main>Source</main>',
  'svg/object/ecs-object-a.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'svg/schedule/ecs-schedule-b.svg': '<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>',
  'mermaid/ecs-object-a.mmd': 'flowchart LR\nA-->B',
  'dot/ecs-schedule-b.dot': 'digraph { a -> b; }',
  'data/manifest.json': '{"schemaVersion":1}',
  'data/notes.txt': 'Notes',
  'data/worker.js': 'export {};',
  'data/runtime.mjs': 'export default 1;',
  'data/with space.json': '{"space":true}',
};

function fixture(t, { empty = false } = {}) {
  const temporary = path.join(repositoryRoot, 'tmp/ecs-architecture/serve-tests');
  fs.mkdirSync(temporary, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporary, 'case-'));
  const { generatedDirectory } = pathsForRepository(root), previews = [];
  fs.mkdirSync(generatedDirectory, { recursive: true });
  if (!empty) for (const [name, text] of Object.entries(files)) {
    const target = path.join(generatedDirectory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  t.after(async () => {
    await Promise.all(previews.map(preview => preview.close()));
    const relative = path.relative(temporary, path.resolve(root));
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { root, generatedDirectory,
    async start(options = {}) { const preview = await createArchitectureServer({ repository: root, port: 0, ...options }); previews.push(preview); return preview; },
    track(preview) { previews.push(preview); return preview; },
  };
}

function request(preview, target, method = 'GET') {
  const address = preview.server.address();
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: address.address, port: address.port, path: target, method, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.setTimeout(3000, () => request.destroy(new Error('Preview request timed out')));
    request.on('error', reject); request.end();
  });
}

test('preview binds loopback and serves generated files with correct MIME, GET/HEAD and no-store', async t => {
  const data = fixture(t), preview = await data.start();
  assert.equal(preview.server.address().address, '127.0.0.1');
  const url = new URL(preview.url);
  assert.equal(url.pathname, '/pages/ecs-architecture.html');
  assert.equal(Number(url.port), preview.server.address().port);
  assert.equal(url.searchParams.get('workspace'), fs.realpathSync(data.root).replaceAll('\\', '/'));
  const expectedTypes = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.mmd': 'text/plain; charset=utf-8',
    '.dot': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };
  for (const [name, body] of Object.entries(files)) {
    const target = '/' + name.split('/').map(encodeURIComponent).join('/');
    const result = await request(preview, target + '?version=one');
    assert.equal(result.status, 200, name); assert.equal(result.body, body);
    assert.equal(result.headers['content-type'], expectedTypes[path.extname(name)]);
    assert.equal(Number(result.headers['content-length']), Buffer.byteLength(body));
    assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['x-content-type-options'], 'nosniff');
    const head = await request(preview, target, 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.body, '');
    assert.equal(head.headers['content-type'], result.headers['content-type']); assert.equal(head.headers['content-length'], result.headers['content-length']);
  }
});

test('legacy page and artifact basenames redirect to their new paths only when the target exists', async t => {
  const data = fixture(t), preview = await data.start();
  const redirects = { '/': '/pages/ecs-architecture.html', '/ecs-architecture.html': '/pages/ecs-architecture.html',
    '/ecs-source.html': '/pages/ecs-source.html', '/ecs-object-a.svg': '/svg/object/ecs-object-a.svg',
    '/ecs-schedule-b.svg': '/svg/schedule/ecs-schedule-b.svg', '/ecs-object-a.mmd': '/mermaid/ecs-object-a.mmd',
    '/ecs-schedule-b.dot': '/dot/ecs-schedule-b.dot', '/debugdump-manifest.json': '/data/manifest.json' };
  const query = '?workspace=E%3A%2Fproject&keep=a%23b';
  for (const [old, target] of Object.entries(redirects)) {
    const result = await request(preview, old + query);
    assert.equal(result.status, 302, old); assert.equal(result.headers.location, target + query);
    assert.equal(result.headers.location.includes('#'), false, 'no fragment override: browsers inherit the original fragment');
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal((await request(preview, result.headers.location)).status, 200);
    const head = await request(preview, old + query, 'HEAD');
    assert.equal(head.status, 302); assert.equal(head.body, ''); assert.equal(head.headers.location, target + query);
  }
  for (const missing of ['/ecs-object-missing.svg', '/ecs-schedule-missing.dot', '/ecs-object-a.dot', '/ecs-schedule-b.mmd']) {
    const result = await request(preview, missing);
    assert.equal(result.status, 404); assert.equal(result.headers.location, undefined);
  }
});

test('preview refuses traversal before URL normalization and never exposes repository directories', async t => {
  const data = fixture(t), preview = await data.start();
  fs.writeFileSync(path.join(data.root, 'secret.txt'), 'repository secret');
  fs.mkdirSync(path.join(data.root, 'docs/diagrams/catalog'), { recursive: true });
  fs.writeFileSync(path.join(data.root, 'docs/diagrams/catalog/private.json'), '{"private":true}');
  for (const target of ['/../secret.txt', '/%2e%2e/secret.txt', '/pages/%2E%2E/%2e%2e/secret.txt',
    '/%5c..%5csecret.txt', '/C:%5cWindows', '/%2f%2foutside', '/pages/./ecs-architecture.html', '/pages/%00file']) {
    const result = await request(preview, target);
    assert.equal(result.status, 403, target); assert.equal(result.body.includes('repository secret'), false);
    assert.equal(result.headers['cache-control'], 'no-store');
  }
  for (const target of ['/secret.txt', '/catalog/private.json', '/src/main.rs', '/package.json', '/pages', '/pages/', '/data/']) {
    assert.equal((await request(preview, target)).status, 404, target);
  }
  assert.equal((await request(preview, '/%zz')).status, 400);
  assert.equal((await request(preview, '//outside')).status, 400);
});

test('preview rejects directory and file paths reported as symbolic links by lstat', async t => {
  const data = fixture(t), linked = path.join(data.generatedDirectory, 'linked'), alias = path.join(data.generatedDirectory, 'data/alias.txt');
  fs.mkdirSync(linked); fs.writeFileSync(path.join(linked, 'secret.txt'), 'not served'); fs.writeFileSync(alias, 'not served');
  const lstat = fs.promises.lstat, marked = new Set([linked, alias]);
  t.mock.method(fs.promises, 'lstat', async (filename, ...args) => marked.has(filename) ? { isSymbolicLink: () => true } : lstat(filename, ...args));
  const preview = await data.start();
  assert.equal((await request(preview, '/linked/secret.txt')).status, 403);
  assert.equal((await request(preview, '/data/alias.txt')).status, 403);
});

test('a symbolic-link page ancestor is rejected before the server starts', async t => {
  const data = fixture(t), pages = path.join(data.generatedDirectory, 'pages'), lstat = fs.promises.lstat;
  t.mock.method(fs.promises, 'lstat', async (filename, ...args) => filename === pages ? { isSymbolicLink: () => true } : lstat(filename, ...args));
  await assert.rejects(data.start(), /Symbolic links are not served/);
});

test('a resolved file outside generated is rejected even when its original path is inside', async t => {
  const data = fixture(t), alias = path.join(data.generatedDirectory, 'data/alias.txt'), outside = path.join(data.root, 'secret.txt');
  fs.writeFileSync(alias, 'not served'); fs.writeFileSync(outside, 'outside generated');
  const realpath = fs.promises.realpath;
  t.mock.method(fs.promises, 'realpath', async (filename, ...args) => filename === alias ? outside : realpath(filename, ...args));
  const preview = await data.start();
  assert.equal((await request(preview, '/data/alias.txt')).status, 403);
});

test('unsupported methods and missing files do not return cached or writable resources', async t => {
  const preview = await fixture(t).start();
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const result = await request(preview, '/pages/ecs-architecture.html', method);
    assert.equal(result.status, 405); assert.equal(result.headers.allow, 'GET, HEAD');
    assert.equal(result.headers['cache-control'], 'no-store');
  }
  const missing = await request(preview, '/missing', 'HEAD');
  assert.equal(missing.status, 404); assert.equal(missing.body, ''); assert.equal(missing.headers['cache-control'], 'no-store');
});

test('missing builds, invalid ports and occupied ports fail with actionable errors', async t => {
  const missing = fixture(t, { empty: true });
  await assert.rejects(missing.start(), /先运行 npm run build --prefix docs\/diagrams/);
  const data = fixture(t), preview = await data.start(), port = preview.server.address().port;
  await assert.rejects(data.start({ port }), error => error.code === 'EADDRINUSE' && error.message.includes(String(port)) && error.message.includes('--port'));
  for (const port of [-1, 65536, '4173', 1.5, NaN]) await assert.rejects(data.start({ port }), /Invalid preview port/);
});

test('CLI parses only an optional port and prints the actual workspace URL without opening a browser', async t => {
  const data = fixture(t), output = [];
  const preview = data.track(await runServeCli(['--port', '0'], { repository: data.root, output: value => output.push(value) }));
  assert.deepEqual(output, [preview.url]); assert.equal((await request(preview, new URL(preview.url).pathname)).status, 200);
  for (const args of [['--port'], ['--port', '-1'], ['--port', '65536'], ['--port', 'no'], ['--unknown'], ['--port', '1', 'extra']]) {
    await assert.rejects(runServeCli(args, { repository: data.root, output: value => output.push(value) }), /Usage: node docs\/diagrams\/serve.mjs/);
  }
  assert.equal(output.length, 1);
});

test('the public CLI entry executes argument parsing and reports failures with a nonzero exit', () => {
  const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'docs/diagrams/serve.mjs'), '--port', 'invalid'],
    { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(result.error, undefined); assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, /Usage: node docs\/diagrams\/serve.mjs/);
});

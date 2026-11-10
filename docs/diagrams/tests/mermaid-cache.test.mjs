import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { repositoryRoot } from '../src/paths.mjs';
import { createMermaidCache, mermaidDependencyIdentity, mermaidGeometryRecord, mermaidRenderIdentity, restoreMermaidGeometry } from '../src/mermaid-cache.mjs';
import { architectureBrowserPath } from '../src/architecture-browser.mjs';

const temporary = path.join(repositoryRoot, 'tmp/ecs-architecture/reuse-fix/cache-unit-tests');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const registry = { a: { name: 'A', description: '保存对象数据。', feature: 'fixture' } };
const view = { id: 'object-cache-fixture', mermaid: 'flowchart LR\nn0[A]\n', svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
  nodes: [{ id: 'a', instance: 'a', visualType: 'component', position: { x: 1, y: 2, width: 3, height: 4 } }],
  links: [{ id: 'edge', sourceEntries: [{ path: 'src/main.rs', line: 2 }] }], scheduleGroups: [],
  width: 10, height: 10, sections: [], entityGroups: [], layoutLinks: [], bounds: { x: 0, y: 0, width: 10, height: 10 }, routing: { rule: 'axis-or-curve' } };

function fixture(t, linked = false) {
  fs.mkdirSync(temporary, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporary, 'case-')), primary = path.join(directory, 'primary');
  fs.mkdirSync(primary);
  const git = args => execFileSync('git', ['-c', 'user.name=Cache fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgSign=false', ...args], { cwd: primary, stdio: 'pipe', windowsHide: true });
  git(['init', '--quiet']);
  t.after(() => {
    const target = fs.realpathSync(directory), base = fs.realpathSync(temporary);
    assert.ok(target.startsWith(base + path.sep));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5 });
  });
  let workspace = primary;
  if (linked) {
    git(['commit', '--quiet', '--allow-empty', '-m', 'test: create isolated cache worktrees']);
    workspace = path.join(directory, 'linked');
    git(['worktree', 'add', '--quiet', '--detach', workspace, 'HEAD']);
  }
  return { workspace, primary, cache: createMermaidCache(workspace) };
}

function publish(workspace, result, fingerprint) {
  const generated = path.join(workspace, 'docs/diagrams/generated');
  function put(filename, value) {
    const target = path.join(generated, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value);
    return { path: filename, sha256: hash(value), bytes: Buffer.byteLength(value) };
  }
  const { svg, mermaid, ...metadata } = result;
  const entry = { id: result.id, renderFingerprint: fingerprint,
    data: put(`data/views/${result.id}.json`, JSON.stringify({ ...metadata, renderFingerprint: fingerprint })),
    svg: put('svg/object/fixture.svg', svg), mermaid: put('mermaid/fixture.mmd', mermaid) };
  put('data/manifest.json', JSON.stringify({ schemaVersion: 2, views: [entry] }));
  return { generated, entry };
}

test('automatically selected browsers and font context participate in geometry identity', t => {
  const { workspace } = fixture(t), packageRoot = path.join(workspace, 'docs/diagrams');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.copyFileSync(path.join(repositoryRoot, 'docs/diagrams/package-lock.json'), path.join(packageRoot, 'package-lock.json'));
  const environment = { ProgramFiles: path.join(workspace, 'programs'), MERMAID_RENDER_CONTEXT: 'fonts-v1' };
  const browser = path.join(environment.ProgramFiles, 'Google/Chrome/Application/chrome.exe');
  fs.mkdirSync(path.dirname(browser), { recursive: true }); fs.writeFileSync(browser, 'browser-v1');
  assert.equal(architectureBrowserPath({ environment, platform: 'win32' }), browser);
  const identity = mermaidDependencyIdentity(workspace, { environment, platform: 'win32' });
  assert.equal(mermaidDependencyIdentity(workspace, { environment: { ...environment, MERMAID_CHROMIUM_PATH: browser }, platform: 'win32' }), identity);
  fs.writeFileSync(browser, 'browser-v2');
  assert.notEqual(mermaidDependencyIdentity(workspace, { environment, platform: 'win32' }), identity);
  fs.writeFileSync(browser, 'browser-v1');
  assert.notEqual(mermaidDependencyIdentity(workspace, { environment: { ...environment, MERMAID_RENDER_CONTEXT: 'fonts-v2' }, platform: 'win32' }), identity);
  assert.throws(() => architectureBrowserPath({ environment: { MERMAID_CHROMIUM_PATH: browser + '.missing' } }), /does not exist/);
});

test('SVG input identity ignores source positions and tracks visible or embedded titles', () => {
  const identity = mermaidRenderIdentity(view, registry, '{}');
  assert.equal(identity.inputs.version, hash(JSON.stringify(6)));
  const moved = structuredClone(view); moved.links[0].sourceEntries[0].line = 200;
  assert.deepEqual(mermaidRenderIdentity(moved, registry, '{}'), identity);
  const described = structuredClone(view); described.links[0].displayLabel = '保留在无障碍名称的关系说明';
  assert.notEqual(mermaidRenderIdentity(described, registry, '{}').fingerprint, identity.fingerprint);
  assert.deepEqual(mermaidRenderIdentity(view, { a: { ...registry.a, description: '不参与绘图的旧字段。' } }, '{}'), identity);
  assert.notEqual(mermaidRenderIdentity(view, { a: { ...registry.a, name: 'NewName' } }, '{}').fingerprint, identity.fingerprint);
  assert.notEqual(mermaidRenderIdentity({ ...view, mermaid: view.mermaid + 'n1[B]\n' }, registry, '{}').fingerprint, identity.fingerprint);
});

test('published geometry requires a matching input and verified data, SVG and Mermaid bytes', t => {
  for (const changed of [null, 'data', 'svg', 'mermaid']) {
    const { workspace } = fixture(t), identity = mermaidRenderIdentity(view, registry, '{}');
    const { generated, entry } = publish(workspace, view, identity.fingerprint);
    if (changed) fs.appendFileSync(path.join(generated, entry[changed].path), ' ');
    const cache = createMermaidCache(workspace), candidates = [...cache.candidates(view, identity.fingerprint)];
    assert.equal(candidates.some(candidate => candidate.source === 'published'), changed === null, changed || 'intact');
    if (changed) assert.match(candidates[0].error.message, /integrity mismatch/);
    assert.deepEqual([...cache.candidates(view, '0'.repeat(64))], []);
  }
});

test('published geometry restores positions without reviving old semantic source locations', t => {
  const { workspace } = fixture(t), identity = mermaidRenderIdentity(view, registry, '{}');
  publish(workspace, view, identity.fingerprint);
  const fresh = structuredClone(view); fresh.links[0].sourceEntries[0].line = 200;
  const candidate = [...createMermaidCache(workspace).candidates(fresh, identity.fingerprint)][0];
  const result = restoreMermaidGeometry(fresh, candidate.cached);
  assert.deepEqual(result.nodes[0].position, view.nodes[0].position);
  assert.equal(result.links[0].sourceEntries[0].line, 200);
});

test('a linked worktree keeps valid geometry usable when the primary cache cannot be written', t => {
  const { workspace, cache } = fixture(t, true), identity = mermaidRenderIdentity(view, registry, '{}');
  assert.notEqual(cache.localDirectory, cache.sharedDirectory);
  const mkdir = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', (directory, ...args) => {
    if (path.resolve(directory) === cache.sharedDirectory) throw Object.assign(new Error('Read-only primary worktree'), { code: 'EACCES' });
    return mkdir(directory, ...args);
  });
  cache.store(identity.fingerprint, identity.inputs, view);
  const candidates = [...cache.candidates(view, identity.fingerprint)];
  assert.equal(candidates[0].source, 'local');
  assert.deepEqual(candidates[0].cached.geometry, mermaidGeometryRecord(view).geometry);
  assert.ok(fs.existsSync(path.join(workspace, 'tmp/ecs-architecture/mermaid-build/geometry-cache', identity.fingerprint + '.json')));
});

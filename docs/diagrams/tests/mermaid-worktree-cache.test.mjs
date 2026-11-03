import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const packageDirectory = path.join(repository, 'docs/diagrams');
const temporary = path.join(repository, 'tmp/ecs-architecture/reuse-fix/worktree-cache-tests');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const chromium = process.env.MERMAID_CHROMIUM_PATH || (process.platform === 'win32'
  ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean)
    .flatMap(base => [path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe')])
  : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']).find(candidate => fs.existsSync(candidate));

const runner = `
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { renderGraphView } from './src/architecture-renderer.mjs';
import { compileArchitectureArtifacts } from './src/mermaid-compiler.mjs';
import { checkMermaidGeometry } from './src/diagram-geometry.mjs';
import { nativeLabelMismatches } from './src/mermaid-core.mjs';
import { inspectViewRoutes } from './src/architecture-routing.mjs';
const fixture = JSON.parse(fs.readFileSync(new URL('./native-fanout.json', import.meta.url), 'utf8'));
const { registry, graph, features } = fixture;
const view = renderGraphView(fixture.view, graph, registry, features), before = JSON.stringify(view);
const launch = puppeteer.launch.bind(puppeteer);
let contextsCreated = 0;
puppeteer.launch = async options => {
  const browser = await launch(options), create = browser.createBrowserContext.bind(browser);
  browser.createBrowserContext = async (...args) => { contextsCreated++; return create(...args); };
  return browser;
};
const compiled = await compileArchitectureArtifacts([view], registry), result = compiled.views[0];
assert.equal(result.nodes.length, 14); assert.equal(result.links.length, 14);
assert.deepEqual(result.links, view.links);
assert.deepEqual(nativeLabelMismatches(result), []);
checkMermaidGeometry(result.svg, result);
const routes = inspectViewRoutes(result);
assert.deepEqual(routes.collisions, []);
assert.ok(routes.edges.every(edge => !edge.arrowIssues.length && (edge.axis ? !edge.curved : edge.curved)));
assert.equal(JSON.stringify(view), before);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
if (process.env.MERMAID_PUBLISH_FIXTURE === '1') {
  assert.match(result.renderFingerprint, /^[a-f0-9]{64}$/);
  const generated = new URL('./generated/', import.meta.url);
  const put = (filename, content) => {
    const target = new URL(filename, generated);
    fs.mkdirSync(path.dirname(fileURLToPath(target)), { recursive: true });
    fs.writeFileSync(target, content);
    return { path: filename, sha256: sha(content), bytes: Buffer.byteLength(content) };
  };
  const { svg, mermaid, ...metadata } = result;
  const entry = { id: result.id, renderFingerprint: result.renderFingerprint,
    data: put('data/views/' + result.id + '.json', JSON.stringify(metadata)),
    svg: put('svg/object/' + result.filename, svg), mermaid: put('mermaid/' + result.mermaidFilename, mermaid) };
  put('data/manifest.json', JSON.stringify({ schemaVersion: 1, views: [entry] }));
}
console.log('WORKTREE_CACHE_RESULT ' + JSON.stringify({ contextsCreated, renderFingerprint: result.renderFingerprint,
  svg: sha(result.svg), mermaid: sha(result.mermaid) }));
`;

function git(workspace, args) {
  return execFileSync('git', ['-c', `safe.directory=${workspace.replaceAll('\\', '/')}`, '-c', 'core.autocrlf=false',
    '-c', 'commit.gpgSign=false', '-c', 'user.name=Mermaid cache fixture', '-c', 'user.email=fixture@example.invalid', ...args],
  { cwd: workspace, encoding: 'utf8', windowsHide: true });
}

function fixture(t) {
  fs.mkdirSync(temporary, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporary, 'native-'));
  const primary = path.join(directory, 'primary'), linked = path.join(directory, 'linked'), dependencies = [];
  t.after(() => {
    const base = fs.realpathSync(temporary), target = fs.realpathSync(directory);
    assert.ok(target.startsWith(base + path.sep), 'Only remove the isolated cache fixture inside its temporary directory');
    for (const dependency of dependencies) {
      assert.ok(path.resolve(dependency).startsWith(path.resolve(directory) + path.sep));
      fs.unlinkSync(dependency);
    }
    fs.rmSync(target, { recursive: true, force: true });
  });
  const diagrams = path.join(primary, 'docs/diagrams');
  fs.mkdirSync(diagrams, { recursive: true });
  fs.cpSync(path.join(packageDirectory, 'src'), path.join(diagrams, 'src'), { recursive: true });
  for (const filename of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(packageDirectory, filename), path.join(diagrams, filename));
  fs.copyFileSync(new URL('./fixtures/native-system-resource-fanout.json', import.meta.url), path.join(diagrams, 'native-fanout.json'));
  fs.writeFileSync(path.join(diagrams, 'cache-runner.mjs'), runner);
  git(primary, ['init', '--quiet']);
  git(primary, ['add', 'docs']);
  git(primary, ['commit', '--quiet', '-m', 'test: isolate Mermaid worktree cache']);
  git(primary, ['worktree', 'add', '--quiet', '--detach', linked, 'HEAD']);
  function installDependencies(workspace) {
    const dependency = path.join(workspace, 'docs/diagrams/node_modules');
    fs.symlinkSync(fs.realpathSync(path.join(packageDirectory, 'node_modules')), dependency, process.platform === 'win32' ? 'junction' : 'dir');
    dependencies.push(dependency);
  }
  for (const workspace of [primary, linked]) installDependencies(workspace);
  function clone(name) {
    const workspace = path.join(directory, name);
    git(directory, ['clone', '--quiet', '--no-hardlinks', primary, workspace]);
    installDependencies(workspace);
    assert.equal(fs.existsSync(path.join(workspace, 'tmp')), false, 'An independent checkout has no temporary cache');
    assert.equal(path.resolve(workspace, git(workspace, ['rev-parse', '--git-common-dir']).trim()), path.join(workspace, '.git'));
    return workspace;
  }
  return { directory, primary, linked, clone };
}

function compile(workspace, { publish = false } = {}) {
  const stdout = execFileSync(process.execPath, [path.join(workspace, 'docs/diagrams/cache-runner.mjs')], {
    cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 240000,
    env: { ...process.env, MERMAID_CHROMIUM_PATH: chromium, MERMAID_JOBS: '1', MERMAID_PUBLISH_FIXTURE: publish ? '1' : '0' }, maxBuffer: 4 * 1024 * 1024,
  });
  const record = /^WORKTREE_CACHE_RESULT (.+)$/m.exec(stdout);
  assert.ok(record, `The real compiler must finish and report its context count: ${stdout}`);
  return JSON.parse(record[1]);
}

test('a cold linked worktree reuses strictly checked native geometry from the primary worktree', { skip: !chromium, timeout: 600000 }, t => {
  const { primary, linked } = fixture(t);
  const first = compile(primary);
  assert.equal(first.contextsCreated, 1, 'The primary worktree compiles the real fanout in one native context');
  const localCache = path.join(linked, 'tmp/ecs-architecture/mermaid-build/geometry-cache');
  assert.equal(fs.existsSync(localCache), false, 'The linked worktree starts with no local geometry cache');
  const reused = compile(linked);
  assert.equal(reused.contextsCreated, 0, 'A matching primary-worktree cache must bypass native view context creation');
  assert.equal(reused.svg, first.svg);
  assert.equal(reused.mermaid, first.mermaid);
});

test('independent checkouts reuse published native artifacts only with matching inputs and intact references', { skip: !chromium, timeout: 600000 }, async t => {
  const f = fixture(t), first = compile(f.primary, { publish: true });
  assert.equal(first.contextsCreated, 1);
  git(f.primary, ['add', 'docs/diagrams/generated']);
  git(f.primary, ['commit', '--quiet', '-m', 'test: publish verified native geometry']);

  await t.test('a cold independent checkout opens no native view context for matching published artifacts', () => {
    const workspace = f.clone('published-match'), reused = compile(workspace);
    assert.equal(reused.contextsCreated, 0, 'Published native artifacts must survive a checkout without any temporary cache');
    assert.equal(reused.renderFingerprint, first.renderFingerprint);
    assert.equal(reused.svg, first.svg);
    assert.equal(reused.mermaid, first.mermaid);
  });

  await t.test('published artifacts without an input fingerprint require fresh native compilation', () => {
    const workspace = f.clone('published-no-fingerprint'), generated = path.join(workspace, 'docs/diagrams/generated');
    const manifestPath = path.join(generated, 'data/manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = manifest.views[0], metadataPath = path.join(generated, entry.data.path);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    delete entry.renderFingerprint; delete metadata.renderFingerprint;
    const content = JSON.stringify(metadata);
    fs.writeFileSync(metadataPath, content);
    entry.data.sha256 = hash(content); entry.data.bytes = Buffer.byteLength(content);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const compiled = compile(workspace);
    assert.equal(compiled.contextsCreated, 1, 'A legacy artifact cannot establish the original native render inputs');
    assert.equal(compiled.renderFingerprint, first.renderFingerprint);
  });

  await t.test('a published SVG with a stale SHA is rejected even when its byte count matches the reference', () => {
    const workspace = f.clone('published-bad-sha'), generated = path.join(workspace, 'docs/diagrams/generated');
    const manifestPath = path.join(generated, 'data/manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = manifest.views[0];
    const svgPath = path.join(generated, entry.svg.path);
    fs.appendFileSync(svgPath, '\n');
    const corruptedSvg = hash(fs.readFileSync(svgPath));
    entry.svg.bytes++;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const compiled = compile(workspace);
    assert.equal(compiled.contextsCreated, 1, 'A failed published SHA check must trigger a fresh native context');
    assert.notEqual(compiled.svg, corruptedSvg, 'Fresh compilation must replace the rejected published SVG bytes');
    assert.equal(compiled.renderFingerprint, first.renderFingerprint);
  });

  await t.test('changed canonical descriptions invalidate the published render fingerprint', () => {
    const workspace = f.clone('published-changed-description'), fixturePath = path.join(workspace, 'docs/diagrams/native-fanout.json');
    const input = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    input.registry[input.view.centerNodeId].description += ' 当前编译具有更新的用途说明。';
    fs.writeFileSync(fixturePath, JSON.stringify(input));
    const compiled = compile(workspace);
    assert.equal(compiled.contextsCreated, 1, 'A changed description is part of the complete render input');
    assert.notEqual(compiled.renderFingerprint, first.renderFingerprint);
    assert.notEqual(compiled.svg, first.svg);
  });
});

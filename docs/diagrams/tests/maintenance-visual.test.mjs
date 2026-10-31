import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicJson, bindVisual, currentArtifacts, hash, planVisual, recordVisual, renderVisual, resolveIndex, visualReport } from '../../../.agents/skills/update-ecs-architecture/scripts/maintenance-visual.mjs';
import { maintenanceScripts } from '../../../.agents/skills/update-ecs-architecture/scripts/maintenance-paths.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureDirectory = path.join(repository, 'tmp/ecs-architecture/maintenance-visual-tests');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFvQAAAAASUVORK5CYII=', 'base64');
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
function fixture(t, { count = 5, retain = false } = {}) {
  fs.mkdirSync(fixtureDirectory, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(fixtureDirectory, 'case-'));
  t.after(() => {
    assert.ok(workspace.startsWith(fixtureDirectory + path.sep));
    if (retain) t.diagnostic('Retained isolated fixture: ' + workspace);
    else fs.rmSync(workspace, { recursive: true, force: true });
  });
  const generated = path.join(workspace, 'docs/diagrams/generated');
  fs.mkdirSync(generated, { recursive: true });
  const put = (relative, value) => {
    const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value);
    const filename = path.join(generated, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, bytes);
    return { path: relative, sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
  };
  const runtime = { registry: {}, views: [] }, views = [];
  for (let i = 0; i < count; i++) {
    const engine = i === 0 ? 'graphviz' : 'mermaid', objectId = i === 0 ? null : 'object.' + i;
    if (objectId) runtime.registry[objectId] = { kind: i % 2 ? 'Component' : 'Resource' };
    const id = 'view-' + i;
    views.push({ id, svg: put(`svg/${engine === 'graphviz' ? 'schedule' : 'object'}/${id}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" data-diagram-engine="${engine}" viewBox="0 0 100 50"><text x="1" y="20">fixture ${i}</text></svg>`), data: put(`data/views/${id}.json`, { id, engine, objectId, application: i === 0 ? 'main' : undefined, scheduleLabel: i === 0 ? 'Startup' : undefined }) });
  }
  const manifest = { schemaVersion: 1, buildId: 'fixture-build', runtime: put('data/runtime.json', runtime), views, guides: { nodes: { component: put('svg/legend/component.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="10" height="10"/></svg>') } } };
  const save = () => put('data/manifest.json', manifest);
  save();
  const indexPath = path.join(workspace, 'tmp/visual/index-v2.json');
  let batch = 0;
  const plan = options => planVisual({ workspace, indexPath, outdir: path.join(workspace, 'tmp/batch-' + ++batch), ...options });
  return { workspace, generated, manifest, put, save, plan, indexPath };
}
function renderProof(plan) {
  const records = plan.items.map(item => {
    const filename = path.join(path.dirname(plan.planPath), 'fixture-' + item.sampleIndex + '.png');
    fs.writeFileSync(filename, png);
    const image = { path: filename, sha256: hash(png) };
    return { ...item, images: [image], overview: image, nativeTiles: [], nativeSize: { width: 100, height: 50 }, overviewScale: 1, renderedAt: '2026-10-30T09:00:00+08:00', method: 'isolated test fixture' };
  });
  atomicJson(path.join(path.dirname(plan.planPath), 'render-records.json'), { schemaVersion: 2, planSha256: hash(fs.readFileSync(plan.planPath)), manifestSha256: plan.manifestSha256, records });
  return records;
}
function observation(row, overrides = {}) {
  return { path: row.path, status: 'passed', reviewer: { id: 'isolated-fixture-child', role: 'child', model: 'fixture-model', reasoningEffort: 'high' }, actualInspection: true, checkedAt: '2026-10-30T09:01:00+08:00', notes: 'Synthetic fixture observation only.', observedWith: 'fixture image', images: row.images, ...overrides };
}
function git(workspace, args, options = {}) {
  return execFileSync('git', ['-c', `safe.directory=${workspace.replaceAll('\\', '/')}`, ...args], { cwd: workspace, ...options }).toString().trim();
}
function fixtureCommit(f) {
  git(f.workspace, ['init', '--quiet']);
  function tree(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.name !== '.git' && entry.name !== 'tmp').map(entry => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? `040000 tree ${tree(target)}\t${entry.name}` : `100644 blob ${git(f.workspace, ['hash-object', '-w', '--stdin'], { input: fs.readFileSync(target) })}\t${entry.name}`;
    });
    return git(f.workspace, ['mktree'], { input: entries.join('\n') + '\n' });
  }
  const commit = git(f.workspace, ['commit-tree', tree(f.workspace)], { input: 'isolated visual test fixture\n', env: { ...process.env, GIT_AUTHOR_NAME: 'Visual Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Visual Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
  git(f.workspace, ['update-ref', 'refs/heads/main', commit]); git(f.workspace, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return commit;
}

test('all current manifest SVGs and independent legends enter a new plan', async t => {
  const f = fixture(t), plan = await f.plan();
  assert.equal(plan.items.length, 6); assert.equal(plan.mode, 'all');
  assert.ok(plan.items.some(item => item.engine === 'legend' && item.viewId === 'legend/nodes/component'));
  assert.ok(plan.items.every(item => item.sha256.length === 64 && item.status === 'pending'));
  const report = await visualReport({ workspace: f.workspace, indexPath: f.indexPath, planPath: plan.planPath });
  assert.equal(report.pending, 6); assert.equal(report.complete, false);
});
test('sample requires explicit count, seed, scope and enough room for all strata/mandatory views', async t => {
  const f = fixture(t);
  await assert.rejects(f.plan({ sample: 4 }), /sampling requires/);
  await assert.rejects(f.plan({ sample: 0, seed: 'a', scope: 'one round' }), /sampling requires/);
  await assert.rejects(f.plan({ sample: 3, seed: 'a', scope: 'one round' }), /strata/);
  await assert.rejects(f.plan({ forcedObjectIds: ['unknown'] }), /Unknown forced/);
  await assert.rejects(f.plan({ forcedViewIds: ['unknown'] }), /Unknown forced/);
  await assert.rejects(f.plan({ sample: 4, seed: 'a', scope: 'one round', forcedObjectIds: ['object.1', 'object.3'] }), /strata/);
});

test('relative visual index and output paths are anchored in the selected workspace', async t => {
  const f = fixture(t);
  assert.equal(resolveIndex(f.workspace, 'tmp/shared/index-v2.json'), path.join(f.workspace, 'tmp/shared/index-v2.json'));
  const planned = await f.plan({ outdir: 'tmp/relative visual batch' });
  assert.equal(planned.planPath, path.join(f.workspace, 'tmp/relative visual batch/plan.json'));
  const output = execFileSync(process.execPath, [path.join(repository, maintenanceScripts, 'maintenance-cli.mjs'), 'visual', 'plan', '--workspace', f.workspace, '--index', 'tmp/foreign/index-v2.json', '--outdir', 'tmp/foreign/batch'], { cwd: path.dirname(f.workspace), encoding: 'utf8', windowsHide: true });
  const foreign = JSON.parse(output);
  assert.equal(foreign.planPath, path.join(f.workspace, 'tmp/foreign/batch/plan.json'));
  assert.equal(foreign.indexPath, path.join(f.workspace, 'tmp/foreign/index-v2.json'));
});
test('hash-ranked mandatory/stratum/sqrt selection is stable and reports uncovered sample scope', async t => {
  const f = fixture(t, { count: 25 });
  const options = { sample: 9, seed: 'explicit-seed', scope: 'explicit one-round scope', forcedViewIds: ['view-3', 'view-8'] };
  const a = await f.plan(options), b = await f.plan(options);
  assert.deepEqual(a.items, b.items); assert.equal(a.items.length, 9);
  assert.deepEqual(new Set(a.items.filter(item => item.mandatory).map(item => item.viewId)), new Set(['view-3', 'view-8']));
  assert.equal(new Set(a.items.map(item => item.stratum)).size, 4);
  const report = await visualReport({ workspace: f.workspace, planPath: a.planPath });
  assert.equal(report.uncovered, 17); assert.equal(report.pending, 9); assert.equal(report.complete, false);
});
test('valid current identity/hash evidence is reused before any baseline comparison and zero candidates never launch Chromium', async t => {
  const f = fixture(t), first = await f.plan(), rows = renderProof(first);
  await recordVisual({ planPath: first.planPath, observation: { observations: rows.map(row => observation(row)) } });
  // Build metadata may change while the reviewed SVG identities and bytes stay unchanged.
  f.manifest.buildId = 'another-build'; f.save();
  const second = await f.plan();
  assert.equal(second.reusableCount, 6); assert.equal(second.candidateCount, 0); assert.equal(second.requiresRendering, false);
  const raster = await renderVisual({ planPath: second.planPath, browser: 'a-browser-that-does-not-exist' });
  assert.equal(raster.renderedCount, 0); assert.equal(raster.requiresInspection, false);
  const report = await visualReport({ workspace: f.workspace, planPath: second.planPath });
  assert.equal(report.reusedPassed, 6); assert.equal(report.complete, true);
});
test('records remain append-only, idempotent and safe under concurrent writers', async t => {
  const f = fixture(t), plan = await f.plan(), rows = renderProof(plan);
  const first = observation(rows[0]);
  await Promise.all([recordVisual({ planPath: plan.planPath, observation: first }), recordVisual({ planPath: plan.planPath, observation: { ...first } }), recordVisual({ planPath: plan.planPath, observation: observation(rows[1]) })]);
  assert.equal(read(f.indexPath).observations.length, 2);
  const before = read(f.indexPath).observations;
  await recordVisual({ planPath: plan.planPath, observation: observation(rows[0], { status: 'failed', notes: 'Fixture later failure.' }) });
  assert.deepEqual(read(f.indexPath).observations.slice(0, 2), before);
  const report = await visualReport({ workspace: f.workspace, planPath: plan.planPath });
  assert.equal(report.failed, 1); assert.equal(report.newPassed, 1); assert.equal(report.complete, false);
});
test('observation files support batches and require actual child metadata/timezone/notes/full image evidence', async t => {
  const f = fixture(t), plan = await f.plan(), rows = renderProof(plan);
  for (const overrides of [{ actualInspection: false }, { reviewer: { role: 'root', id: 'parent', model: 'test', reasoningEffort: 'high' } }, { checkedAt: '2026-10-30T09:01:00' }, { notes: '' }, { images: [] }, { objectId: 'other' }, { images: [{ ...rows[0].images[0], sha256: 'a'.repeat(64) }] }]) {
    await assert.rejects(recordVisual({ planPath: plan.planPath, observation: observation(rows[0], overrides) }), /observation|evidence|identity/i);
  }
  const observationFile = path.join(f.workspace, 'tmp/observations.json'); atomicJson(observationFile, { observations: rows.map(row => observation(row)) });
  const result = await recordVisual({ planPath: plan.planPath, observationFile });
  assert.equal(result.added, 6);
});
test('SVG, image, proof, hash and semantic identity tampering invalidate coverage', async t => {
  const f = fixture(t), plan = await f.plan(), rows = renderProof(plan);
  await recordVisual({ planPath: plan.planPath, observation: observation(rows[0]) });
  fs.appendFileSync(rows[0].images[0].path, 'changed');
  assert.equal((await f.plan()).reusableCount, 0);
  await assert.rejects(recordVisual({ planPath: plan.planPath, observation: observation(rows[0]) }), /observation/);
  const svg = path.join(f.generated, rows[0].path); fs.appendFileSync(svg, 'changed');
  await assert.rejects(f.plan(), /hash\/size/);
});
test('a changed semantic identity with identical SVG bytes must not reuse a record', async t => {
  const f = fixture(t), plan = await f.plan(), rows = renderProof(plan), row = rows.find(row => row.objectId);
  await recordVisual({ planPath: plan.planPath, observation: observation(row) });
  const view = f.manifest.views.find(view => view.id === row.viewId), metadata = read(path.join(f.generated, view.data.path));
  metadata.objectId = 'different-object'; view.data = f.put(view.data.path, metadata);
  const runtime = read(path.join(f.generated, f.manifest.runtime.path)); runtime.registry['different-object'] = { kind: row.kind };
  f.manifest.runtime = f.put(f.manifest.runtime.path, runtime); f.save();
  assert.equal((await f.plan()).reusableCount, 0);
});
test('new schema rejects old explicit formats and never implicitly opens legacy index.json', async t => {
  const f = fixture(t); fixtureCommit(f);
  const defaultIndex = resolveIndex(f.workspace);
  fs.mkdirSync(path.dirname(defaultIndex), { recursive: true }); fs.writeFileSync(path.join(path.dirname(defaultIndex), 'index.json'), 'not JSON: must never read');
  const plan = await planVisual({ workspace: f.workspace, outdir: path.join(f.workspace, 'tmp/default-plan') });
  assert.equal(plan.reusableCount, 0); assert.equal(plan.indexPath, defaultIndex);
  await assert.rejects(f.plan({ indexPath: path.join(f.workspace, 'tmp/index.json') }), /Legacy/);
  atomicJson(f.indexPath, { schemaVersion: 1, records: [] });
  await assert.rejects(f.plan(), /schemaVersion 2/);
});
test('unsafe, missing and conflicting manifest references fail before planning', async t => {
  const f = fixture(t), original = f.manifest.views[0].svg;
  for (const bad of [{ ...original, path: '../escape.svg' }, { ...original, path: 'svg\\escape.svg' }, { ...original, sha256: 'short' }, { ...original, bytes: original.bytes + 1 }]) {
    f.manifest.views[0].svg = bad; f.save(); await assert.rejects(f.plan(), /Unsafe|reference|mismatch/);
  }
  f.manifest.views[0].svg = original; f.manifest.views.push({ ...f.manifest.views[0] }); f.save();
  assert.throws(() => currentArtifacts(f.workspace), /identity|duplicate/i);
});
test('frozen inputs and selection cannot change between planning, rendering and recording', async t => {
  const f = fixture(t), plan = await f.plan(), rows = renderProof(plan);
  const changed = read(plan.planPath); changed.items.pop(); atomicJson(plan.planPath, changed);
  await assert.rejects(recordVisual({ planPath: plan.planPath, observation: observation(rows[0]) }), /selection changed/);
  await assert.rejects(renderVisual({ planPath: plan.planPath }), /selection changed/);
});
test('commit bindings are independent events, idempotent, and mismatches fail all-or-nothing', async t => {
  const f = fixture(t), commit = fixtureCommit(f), plan = await f.plan(), rows = renderProof(plan);
  await recordVisual({ planPath: plan.planPath, observation: { observations: rows.map(row => observation(row)) } });
  const facts = read(f.indexPath).observations;
  const result = await bindVisual({ workspace: f.workspace, indexPath: f.indexPath, commit });
  assert.equal(result.boundRecords, 6); assert.deepEqual(read(f.indexPath).observations, facts);
  assert.equal((await bindVisual({ workspace: f.workspace, indexPath: f.indexPath, commit })).boundRecords, 0);
  f.manifest.buildId = 'different committed build'; f.save(); const wrongCommit = fixtureCommit(f);
  const before = fs.readFileSync(f.indexPath, 'utf8');
  await assert.rejects(bindVisual({ workspace: f.workspace, indexPath: f.indexPath, commit }), /differ/);
  assert.equal(fs.readFileSync(f.indexPath, 'utf8'), before);
  assert.equal((await bindVisual({ workspace: f.workspace, indexPath: f.indexPath, commit: wrongCommit })).boundRecords, 6);
});

test('binding a new manifest ignores historical passed and failed observations without rewriting them', async t => {
  const f = fixture(t), first = fixtureCommit(f), oldPlan = await f.plan(), oldRows = renderProof(oldPlan);
  await recordVisual({ planPath: oldPlan.planPath, observation: { observations: oldRows.map((row, i) => observation(row, { status: i ? 'passed' : 'failed' })) } });
  await bindVisual({ workspace: f.workspace, indexPath: f.indexPath, commit: first });
  const oldFacts = read(f.indexPath).observations;
  f.manifest.buildId = 'new-build';
  const ref = f.manifest.views[0].svg;
  f.manifest.views[0].svg = f.put(ref.path, fs.readFileSync(path.join(f.generated, ref.path), 'utf8').replace('fixture 0', 'fixture updated'));
  f.save();
  const second = fixtureCommit(f), newPlan = await f.plan(), newRows = renderProof(newPlan);
  assert.equal(newRows.length, 1);
  await recordVisual({ planPath: newPlan.planPath, observation: observation(newRows[0], { checkedAt: '2026-10-30T10:00:00+08:00' }) });
  const bound = await bindVisual({ workspace: f.workspace, indexPath: f.indexPath, commit: second });
  assert.equal(bound.boundRecords, 6);
  assert.deepEqual(read(f.indexPath).observations.slice(0, oldFacts.length), oldFacts);
  assert.equal((await bindVisual({ workspace: f.workspace, indexPath: f.indexPath, commit: second })).boundRecords, 0);
});

test('binding reuses current evidence from another workspace and verifies committed semantic references', async t => {
  const first = fixture(t), plan = await first.plan(), rows = renderProof(plan);
  await recordVisual({ planPath: plan.planPath, observation: { observations: rows.map(row => observation(row)) } });
  const second = fixture(t);
  second.manifest.buildId = 'another-workspace-build'; second.save();
  const committed = fixtureCommit(second), oldFacts = read(first.indexPath).observations;
  assert.equal((await bindVisual({ workspace: second.workspace, indexPath: first.indexPath, commit: committed })).boundRecords, 6);
  assert.deepEqual(read(first.indexPath).observations, oldFacts);
  for (const reference of [second.manifest.runtime, second.manifest.views[0].data]) {
    const filename = path.join(second.generated, reference.path), bytes = fs.readFileSync(filename);
    fs.appendFileSync(filename, ' ');
    const staleCommit = fixtureCommit(second);
    fs.writeFileSync(filename, bytes);
    const before = fs.readFileSync(first.indexPath, 'utf8');
    await assert.rejects(bindVisual({ workspace: second.workspace, indexPath: first.indexPath, commit: staleCommit }), /reference/);
    assert.equal(fs.readFileSync(first.indexPath, 'utf8'), before);
  }
});

test('real static fixture rendering produces PNG hashes and native tiles without granting a pass', { skip: !process.env.MAINTENANCE_VISUAL_CHROMIUM }, async t => {
  const f = fixture(t, { count: 1, retain: process.env.MAINTENANCE_VISUAL_KEEP_FIXTURE === '1' });
  const ref = f.manifest.views[0].svg;
  f.manifest.views[0].svg = f.put(ref.path, '<svg xmlns="http://www.w3.org/2000/svg" id="view-0" data-diagram-engine="graphviz" viewBox="0 0 2500 1900"><rect width="2500" height="1900" fill="#F6F8FB"/><text x="20" y="40">Static compilation fixture only</text></svg>'); f.save();
  const plan = await f.plan(), item = plan.items.find(item => item.viewId === 'view-0');
  const result = await renderVisual({ planPath: plan.planPath, from: item.sampleIndex, to: item.sampleIndex, browser: process.env.MAINTENANCE_VISUAL_CHROMIUM });
  assert.equal(result.renderedCount, 1); assert.equal(result.records.length, 1);
  assert.equal(result.records[0].nativeTiles.length, 4); assert.equal(result.records[0].images.length, 5);
  for (const image of result.records[0].images) assert.equal(hash(fs.readFileSync(image.path)), image.sha256);
  const report = await visualReport({ workspace: f.workspace, planPath: plan.planPath }); assert.equal(report.newPassed, 0); assert.equal(report.pending, 2);
  assert.equal((await renderVisual({ planPath: plan.planPath, from: item.sampleIndex, to: item.sampleIndex, browser: 'unused' })).renderedCount, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepareArchitecture } from '../src/architecture-preparation.mjs';
import { repositoryRoot } from '../src/paths.mjs';
import { sha256, scheduleId, sourceFingerprint } from '../src/debugdump-input.mjs';

function fixture(t) {
  const parent = path.join(repositoryRoot, 'tmp/ecs-architecture/preparation-tests'); fs.mkdirSync(parent, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(parent, 'snapshot-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src/main.rs'), 'fn main() {}\n');
  fs.writeFileSync(path.join(workspace, 'Cargo.toml'), '[package]\nname="fixture"\nversion="0.1.0"\n');
  fs.writeFileSync(path.join(workspace, 'Cargo.lock'), '[[package]]\nname = "bevy"\nversion = "0.20.0"\n[[package]]\nname = "bevy_mod_debugdump"\nversion = "0.17.0"\n');
  const compiler = path.join(workspace, 'tmp/ecs-architecture/compiler'), directory = path.join(compiler, 'debugdump');
  fs.mkdirSync(directory, { recursive: true });
  const id = scheduleId('main', 'Update'), dot = 'digraph { }\n', filename = `schedule-${id}.dot`;
  fs.writeFileSync(path.join(directory, filename), dot);
  const fingerprint = sourceFingerprint(workspace), target = 'x86_64-unknown-linux-gnu', features = ['debugdump'];
  const runtime = { schemaVersion: 1, sourceFingerprint: fingerprint, target, features: [...features],
    schedules: [{ id, app: 'main', label: 'Update', typeId: 'schedule-runtime', dotFilename: filename, dotSha256: sha256(dot), systems: [], sets: [], hierarchy: [], dependencies: [] }] };
  const manifest = { schemaVersion: 1, bevyVersion: '0.20.0', debugdumpVersion: '0.17.0', exportedAt: 100, target, features: [...features], sourceFingerprint: fingerprint,
    schedules: [{ id, app: 'main', label: 'Update', filename, sha256: sha256(dot), systemCount: 0 }] };
  const model = { schemaVersion: 2, compiler: 'pinned-compiler', configuration: 'fixed-configuration', runtimeDirectory: directory,
    inputs: { sourceFingerprint: fingerprint, factsSha256: 'a'.repeat(64) }, objects: [], relations: [], features: [], sourceFiles: [],
    callGraph: { schemaVersion: 2, format: 'ndjson', file: 'model.calls.ndjson', sha256: sha256(''), edgeCount: 0 },
    scheduleInteractions: { schemaVersion: 1, views: [{ viewId: `schedule-${id}`, dotSha256: sha256(dot), bindings: [] }] } };
  fs.writeFileSync(path.join(compiler, 'model.calls.ndjson'), '');
  const saveModel = () => fs.writeFileSync(path.join(compiler, 'model.json'), JSON.stringify(model));
  const saveManifest = () => fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  const saveRuntime = () => {
    const bytes = JSON.stringify(runtime); fs.writeFileSync(path.join(directory, 'runtime.json'), bytes);
    model.inputs.runtimeSha256 = sha256(bytes); saveModel();
  };
  saveRuntime(); saveManifest();
  return { workspace, directory, model, manifest, runtime, saveModel, saveManifest, saveRuntime };
}

test('preparation pairs the compiler model with the exact runtime bytes and their Schedule manifest', async t => {
  const f = fixture(t), prepared = await prepareArchitecture({ workspace: f.workspace });
  assert.equal(prepared.dump.manifest.target, f.runtime.target);
  assert.equal(prepared.model.inputs.runtimeSha256, f.model.inputs.runtimeSha256);
  assert.equal(prepared.schedules.views.length, 1);
});

test('identical DOT cannot substitute a runtime snapshot from another target or feature configuration', async t => {
  for (const key of ['target', 'features']) {
    const f = fixture(t), directory = path.join(f.workspace, 'tmp/other-build');
    fs.cpSync(f.directory, directory, { recursive: true });
    const runtime = structuredClone(f.runtime), manifest = structuredClone(f.manifest);
    runtime[key] = manifest[key] = key === 'target' ? 'aarch64-unknown-linux-gnu' : ['debugdump', 'another-feature'];
    fs.writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify(runtime));
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(prepareArchitecture({ workspace: f.workspace, debugdumpDirectory: directory }), /snapshot hash mismatch/);
  }
});

test('runtime bytes and declared input hash cannot be omitted or replaced with equivalent JSON', async t => {
  for (const change of ['missing', 'bytes', 'hash']) {
    const f = fixture(t), runtimePath = path.join(f.directory, 'runtime.json');
    if (change === 'missing') fs.unlinkSync(runtimePath);
    if (change === 'bytes') fs.appendFileSync(runtimePath, '\n');
    if (change === 'hash') { delete f.model.inputs.runtimeSha256; f.saveModel(); }
    await assert.rejects(prepareArchitecture({ workspace: f.workspace }), /ENOENT|snapshot hash mismatch/);
  }
});

test('a hash-bound runtime still requires matching target, features and source provenance in its manifest', async t => {
  for (const key of ['target', 'features', 'sourceFingerprint']) {
    const f = fixture(t);
    if (key === 'target') f.runtime.target = 'aarch64-unknown-linux-gnu';
    if (key === 'features') f.runtime.features.push('another-feature');
    if (key === 'sourceFingerprint') f.runtime.sourceFingerprint = 'b'.repeat(64);
    f.saveRuntime();
    await assert.rejects(prepareArchitecture({ workspace: f.workspace }), /export provenance mismatch/);
  }
});

test('runtime Schedule records must match the selected export identities, DOT and system counts', async t => {
  for (const change of ['duplicate', 'app', 'label', 'filename', 'hash', 'systems']) {
    const f = fixture(t), schedule = f.runtime.schedules[0];
    if (change === 'duplicate') f.runtime.schedules.push(structuredClone(schedule));
    if (change === 'app') schedule.app = 'RenderApp';
    if (change === 'label') schedule.label = 'PostUpdate';
    if (change === 'filename') schedule.dotFilename = 'other.dot';
    if (change === 'hash') schedule.dotSha256 = 'b'.repeat(64);
    if (change === 'systems') schedule.systems.push({ key: 'unexpected' });
    f.saveRuntime();
    await assert.rejects(prepareArchitecture({ workspace: f.workspace }), /export Schedule count mismatch|export Schedule evidence mismatch/);
  }
});

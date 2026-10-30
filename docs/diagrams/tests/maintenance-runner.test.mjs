import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planMaintenance, runMaintenance, maintenanceStatus, maintenanceReport } from '../src/maintenance-runner.mjs';
import { fileSnapshot, digest, dependencyState, normalizedEnvironment } from '../src/maintenance-inputs.mjs';
import { sourceFingerprint, scheduleId, sha256, DEBUGDUMP_MANIFEST } from '../src/debugdump-input.mjs';
import { summarizeModel, compareModelSummaries } from '../src/maintenance-summary.mjs';
import { exportContextInputs, captureExportContext, validateExportContext } from '../src/maintenance-export-context.mjs';
import { loadCompilerSelection, resolveCompilerSelection } from '../src/maintenance-compiler-selection.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
fs.mkdirSync(path.join(repository, 'tmp'), { recursive: true });
function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(repository, 'tmp/maintenance runner '));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const put = (name, text) => { fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true }); fs.writeFileSync(path.join(workspace, name), text); };
  put('Cargo.toml', '[package]\nname="fixture"\nversion="0.1.0"\n');
  put('Cargo.lock', '[[package]]\nname = "bevy"\nversion = "0.18.0"\n\n[[package]]\nname = "bevy_mod_debugdump"\nversion = "0.15.0"\n');
  put('src/main.rs', 'fn main() {}\n');
  put('docs/diagrams/package.json', '{"name":"fixture","type":"module"}');
  put('docs/diagrams/package-lock.json', '{"name":"fixture","lockfileVersion":3,"packages":{}}');
  put('input.txt', 'input one');
  return { workspace, put };
}
function pipeline() {
  return [
    { id: 'produce', inputs: ['input.txt'], outputs: ['output.txt'], command: { command: process.execPath, args: ['-e', "const f=require('fs');f.appendFileSync('executions.txt','produce\\n');f.writeFileSync('output.txt',f.readFileSync('input.txt'));process.stdout.write('raw output\\n');"] } },
    { id: 'verify', inputs: ['input.txt', 'output.txt'], outputs: [], command: { command: process.execPath, args: ['-e', "require('fs').appendFileSync('executions.txt','verify\\n');process.stderr.write('raw stderr\\n')"] } },
  ];
}
function dumpFixture({ workspace, put }) {
  const id = scheduleId('main', 'Update'), filename = `ecs-schedule-${id}.dot`, dot = 'digraph { a [label="fixture"] }';
  put(`docs/diagrams/generated/dot/${filename}`, dot);
  put(`docs/diagrams/generated/dot/${DEBUGDUMP_MANIFEST}`, JSON.stringify({ schemaVersion: 1, bevyVersion: '0.18.0', debugdumpVersion: '0.15.0',
    sourceFingerprint: sourceFingerprint(workspace), exportedAt: 1, target: 'test', features: ['debugdump'],
    schedules: [{ id, app: 'main', label: 'Update', filename, systemCount: 1, sha256: sha256(dot) }] }));
}

test('plan is read-only without npm dependencies; validates real DOT content and Rust fingerprints', async t => {
  const f = fixture(t); dumpFixture(f);
  const before = fileSnapshot(f.workspace, ['.']);
  const plan = await planMaintenance({ workspace: f.workspace });
  assert.equal(plan.dependencies.valid, false);
  assert.equal(plan.debugdump.valid, true);
  assert.equal(plan.debugdump.context.status, 'unknown');
  assert.equal(plan.stages.find(stage => stage.id === 'export').action, 'export');
  assert.deepEqual(fileSnapshot(f.workspace, ['.']), before);
  assert.equal(fs.existsSync(path.join(f.workspace, 'tmp')), false);
  f.put('src/main.rs', 'fn main() { let _changed = 1; }');
  const stale = await planMaintenance({ workspace: f.workspace });
  assert.equal(stale.debugdump.valid, false);
  assert.match(stale.debugdump.reason, /fingerprint is stale/);
});

test('real child records argv, PID, timestamps, exit and raw streams; unchanged resume never reruns', async t => {
  const f = fixture(t), stages = pipeline();
  const first = await runMaintenance({ workspace: f.workspace, pipeline: stages });
  assert.equal(first.status, 'passed');
  assert.deepEqual(first.manual, { svg: 'pending', browser: 'pending', protocol: 'pending' });
  for (const record of first.stages) {
    assert.equal(record.command, process.execPath);
    assert.ok(record.pid > 0);
    assert.equal(record.exitCode, 0);
    assert.ok(Date.parse(record.endedAt) >= Date.parse(record.startedAt));
    assert.ok(record.queueWaitMs >= 0);
    assert.equal(record.cwd, f.workspace);
    assert.match(record.inputs.tools.node.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(fs.readFileSync(first.stages[0].stdout, 'utf8'), 'raw output\n');
  assert.equal(fs.readFileSync(first.stages[1].stderr, 'utf8'), 'raw stderr\n');
  const resumed = await runMaintenance({ workspace: f.workspace, resume: first.runId, pipeline: stages });
  assert.equal(resumed.status, 'passed');
  assert.equal(resumed.stages.length, 2);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'executions.txt'), 'utf8'), 'produce\nverify\n');
  assert.equal((await maintenanceStatus({ workspace: f.workspace })).status, 'passed');
  assert.match(await maintenanceReport({ workspace: f.workspace, format: 'markdown' }), /待实际执行/);
});

test('changing input invalidates producer and every downstream stage; HEAD metadata cannot reuse it', async t => {
  const f = fixture(t), stages = pipeline();
  const first = await runMaintenance({ workspace: f.workspace, pipeline: stages });
  f.put('input.txt', 'input two');
  const status = await maintenanceStatus({ workspace: f.workspace });
  assert.equal(status.status, 'stale');
  assert.deepEqual(status.invalidated, ['produce', 'verify']);
  const resumed = await runMaintenance({ workspace: f.workspace, resume: first.runId, pipeline: stages });
  assert.equal(resumed.status, 'passed');
  assert.deepEqual(resumed.stages.map(stage => stage.attempt), [1, 1, 2, 2]);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'output.txt'), 'utf8'), 'input two');
});

test('missing or altered output rebuilds even when all inputs are unchanged', async t => {
  const f = fixture(t), stages = pipeline();
  const first = await runMaintenance({ workspace: f.workspace, pipeline: stages });
  fs.unlinkSync(path.join(f.workspace, 'output.txt'));
  const resumed = await runMaintenance({ workspace: f.workspace, resume: first.runId, pipeline: stages });
  assert.equal(resumed.status, 'passed');
  assert.equal(resumed.stages.length, 4);
  assert.equal(resumed.stages.at(-1).attempt, 2);
});

test('nonzero exit stops downstream, preserves exact exit code, and supports retry', async t => {
  const f = fixture(t);
  const stages = pipeline();
  stages[0].command.args = ['-e', "console.error('deliberate failure'); process.exit(17)"];
  const failed = await runMaintenance({ workspace: f.workspace, pipeline: stages });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stages.length, 1);
  assert.equal(failed.stages[0].exitCode, 17);
  assert.match(fs.readFileSync(failed.stages[0].stderr, 'utf8'), /deliberate failure/);
  const resumed = await runMaintenance({ workspace: f.workspace, resume: true, pipeline: pipeline() });
  assert.equal(resumed.status, 'passed');
  assert.deepEqual(resumed.stages.map(stage => stage.id), ['produce', 'produce', 'verify']);
});

test('inputs changing during a successful command refuse pass', async t => {
  const f = fixture(t), stages = pipeline();
  stages[0].command.args = ['-e', "const f=require('fs');f.writeFileSync('output.txt','done');f.writeFileSync('input.txt','changed during execution');"];
  const state = await runMaintenance({ workspace: f.workspace, pipeline: stages });
  assert.equal(state.status, 'failed');
  assert.equal(state.stages[0].exitCode, 0);
  assert.match(state.error, /Inputs changed/);
  assert.equal(state.stages.length, 1);
});

test('lock conflict never steals, removes or kills an existing owner', async t => {
  const f = fixture(t);
  const root = path.join(f.workspace, 'tmp/ecs-architecture/maintenance');
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, 'lock.json'), original = JSON.stringify({ pid: process.pid, token: 'other-owner', runId: 'active' });
  fs.writeFileSync(lock, original);
  await assert.rejects(runMaintenance({ workspace: f.workspace, pipeline: pipeline() }), /lock conflict/);
  assert.equal(fs.readFileSync(lock, 'utf8'), original);
});

test('orphaned running record is interrupted, never inferred successful; resume repeats it', async t => {
  const f = fixture(t), stages = pipeline();
  const first = await runMaintenance({ workspace: f.workspace, pipeline: stages });
  const filename = path.join(f.workspace, 'tmp/ecs-architecture/maintenance', first.runId, 'state.json');
  const interrupted = JSON.parse(fs.readFileSync(filename, 'utf8'));
  interrupted.status = 'running'; interrupted.pid = 2147483647;
  interrupted.stages[0].status = 'running'; delete interrupted.stages[0].exitCode;
  fs.writeFileSync(filename, JSON.stringify(interrupted));
  assert.equal((await maintenanceStatus({ workspace: f.workspace })).status, 'interrupted');
  const resumed = await runMaintenance({ workspace: f.workspace, resume: true, pipeline: stages });
  assert.equal(resumed.status, 'passed');
  assert.equal(resumed.stages[0].status, 'interrupted');
  assert.equal(resumed.stages.length, 4);
});

test('new untracked input modules change the plan content fingerprint', async t => {
  const f = fixture(t);
  f.put('docs/diagrams/src/first.mjs', 'export const first=1;');
  const first = await planMaintenance({ workspace: f.workspace });
  f.put('docs/diagrams/src/new untracked.mjs', 'export const added=1;');
  const next = await planMaintenance({ workspace: f.workspace });
  assert.notEqual(digest(first.inputs), digest(next.inputs));
});

test('identity summaries retain independent registrations, generics, projections and source differences', () => {
  const before = summarizeModel({ model: { system_links: [{ id: 'edge', from: 'a', to: 'b', kind: 'read' }] },
    registry: { a: { id: 'a', kind: 'System', name: 'same', registrations: [{ schedule: 'A' }] }, b: { id: 'b', kind: 'Component', name: 'Generic<T>', componentRustType: 'Generic<T>', projectionIds: ['entity-a'], sourceEntries: [{ path: 'old.rs', line: 1 }] }, old: { id: 'old', name: 'same', kind: 'System' } } });
  const after = structuredClone(before);
  after.objects.a.registrations = [{ schedule: 'B' }];
  after.objects.b.componentRustType = 'Generic<U>';
  after.objects.b.projectionIds = ['entity-b'];
  after.objects.b.sourceEntries = [{ path: 'new.rs', line: 2 }];
  delete after.objects.old; after.objects.added = { name: 'same', kind: 'System' };
  after.relationships.edge.operation = 'filter';
  const changes = compareModelSummaries(before, after);
  assert.deepEqual(changes.objects.added, ['added']);
  assert.deepEqual(changes.objects.retired, ['old']);
  assert.deepEqual(changes.objects.preserved, ['a', 'b']);
  assert.deepEqual(changes.registrations, ['a']);
  assert.deepEqual(changes.generics, ['b']);
  assert.deepEqual(changes.projections, ['b']);
  assert.deepEqual(changes.sources, ['b']);
  assert.deepEqual(changes.relationships.changed.map(change => change.id), ['edge']);
  assert.deepEqual(changes.aliasesCreated, []);
});

test('changed command producer invalidates downstream even if output bytes stay identical', async t => {
  const f = fixture(t), stages = pipeline();
  const first = await runMaintenance({ workspace: f.workspace, pipeline: stages });
  const changed = pipeline();
  changed[0].command.args[1] += "process.stdout.write('changed producer');";
  const resumed = await runMaintenance({ workspace: f.workspace, resume: first.runId, pipeline: changed });
  assert.equal(resumed.status, 'passed');
  assert.equal(resumed.stages.length, 4);
  assert.equal(resumed.stages.at(-1).attempt, 2);
});

test('locked dependency content changes repeat preflight and all dependent stages', async t => {
  const f = fixture(t);
  f.put('external dependency.rs', 'pub struct Before;');
  const stages = [
    { id: 'preflight', inputs: ['input.txt'], outputs: [], dependencyInputs: true,
      command: { command: process.execPath, args: ['-e', "const fs=require('fs'),p=require('path'),c=require('crypto');const file=p.resolve('external dependency.rs');console.log(JSON.stringify({dependencyInputs:[{path:file,sha256:c.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}],modelSummary:{objects:{},relationships:{}}}));"] } },
    { ...pipeline()[0], dependencyInputs: true },
  ];
  const first = await runMaintenance({ workspace: f.workspace, pipeline: stages });
  assert.equal(first.status, 'passed');
  f.put('external dependency.rs', 'pub struct After;');
  assert.equal((await maintenanceStatus({ workspace: f.workspace })).status, 'stale');
  const resumed = await runMaintenance({ workspace: f.workspace, resume: first.runId, pipeline: stages });
  assert.equal(resumed.status, 'passed');
  assert.deepEqual(resumed.stages.map(stage => stage.attempt), [1, 1, 2, 2]);
});

test('changed output after its producer completed cannot produce overall success', async t => {
  const f = fixture(t), stages = pipeline();
  stages[1].command.args = ['-e', "require('fs').writeFileSync('output.txt','changed after producer');"];
  const state = await runMaintenance({ workspace: f.workspace, pipeline: stages });
  assert.equal(state.status, 'failed');
  assert.match(state.error, /Inputs changed|changed after successful stages/);
});

test('spawn failures preserve unknown exit as failure and do not start downstream', async t => {
  const f = fixture(t), stages = pipeline();
  stages[0].command = { command: path.join(f.workspace, 'missing executable'), args: [] };
  const state = await runMaintenance({ workspace: f.workspace, pipeline: stages });
  assert.equal(state.status, 'failed');
  assert.equal(state.stages[0].exitCode, null);
  assert.equal(state.stages.length, 1);
  assert.match(state.stages[0].error, /failed/);
});

test('new invocation reuses verified checkpoints in a distinct run with sourceRunId', async t => {
  const f = fixture(t), stages = pipeline();
  const first = await runMaintenance({ workspace: f.workspace, pipeline: stages });
  const second = await runMaintenance({ workspace: f.workspace, pipeline: stages });
  assert.equal(second.status, 'passed');
  assert.notEqual(second.runId, first.runId);
  assert.equal(second.sourceRunId, first.runId);
  assert.ok(second.stages.every(stage => stage.sourceRunId === first.runId));
  assert.equal(fs.readFileSync(path.join(f.workspace, 'executions.txt'), 'utf8'), 'produce\nverify\n');
  assert.ok(second.events.filter(event => event.kind === 'reuse').every(event => event.sourceRunId === first.runId));
});

test('actual child emitting CLI style pretty JSON records the entire preflight document', async t => {
  const f = fixture(t);
  f.put('pretty-preflight.mjs', "console.log(JSON.stringify({counts:{objects:1},modelSummary:{objects:{id:{kind:'System',name:'test'}},relationships:{}},dependencyInputs:[]},null,2));");
  const state = await runMaintenance({ workspace: f.workspace, pipeline: [{ id: 'preflight', inputs: ['pretty-preflight.mjs'], outputs: [], dependencyInputs: true,
    command: { command: process.execPath, args: [path.join(f.workspace, 'pretty-preflight.mjs')] } }] });
  assert.equal(state.status, 'passed');
  assert.equal(state.preflightModel.objects.id.name, 'test');
  assert.match(fs.readFileSync(state.stages[0].stdout, 'utf8'), /\n  "counts"/);
});

test('export context binds selectors, config contents, actual toolchain bytes and DOT provenance', async t => {
  const f = fixture(t); dumpFixture(f);
  const directory = path.join(f.workspace, 'docs/diagrams/generated/dot');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, DEBUGDUMP_MANIFEST), 'utf8'));
  const environment = { CARGO_HOME: f.workspace, RUSTFLAGS: '--cfg fixture', CARGO_BUILD_TARGET: 'fixture-target', CARGO_REGISTRIES_PRIVATE_TOKEN: 'never-store-this-secret' };
  const configParser = () => ({});
  const inputs = exportContextInputs(f.workspace, environment);
  assert.equal(Object.hasOwn(inputs.environment, 'CARGO_REGISTRIES_PRIVATE_TOKEN'), false);
  assert.equal(JSON.stringify(inputs).includes('never-store-this-secret'), false);
  f.put('fake cargo.exe', 'cargo fixture'); f.put('fake rustc.exe', 'rustc fixture');
  const provider = () => ({ cargo: path.join(f.workspace, 'fake cargo.exe'), rustc: path.join(f.workspace, 'fake rustc.exe') });
  await captureExportContext({ workspace: f.workspace, directory, manifest, environment, toolchainProvider: provider, configParser });
  assert.equal((await validateExportContext({ workspace: f.workspace, directory, manifest, environment, configParser })).status, 'valid');
  assert.equal((await validateExportContext({ workspace: f.workspace, directory, manifest, environment: { ...environment, RUSTFLAGS: '--cfg changed' }, configParser })).status, 'stale');
  f.put('.cargo/config.toml', '[build]\ntarget="changed"');
  assert.equal((await validateExportContext({ workspace: f.workspace, directory, manifest, environment, configParser })).status, 'stale');
  await captureExportContext({ workspace: f.workspace, directory, manifest, environment, toolchainProvider: provider, configParser });
  f.put('fake rustc.exe', 'new compiler bytes');
  assert.equal((await validateExportContext({ workspace: f.workspace, directory, manifest, environment, configParser })).status, 'stale');
  await captureExportContext({ workspace: f.workspace, directory, manifest, environment, toolchainProvider: provider, configParser });
  const different = structuredClone(manifest); different.target = 'other-target';
  assert.equal((await validateExportContext({ workspace: f.workspace, directory, manifest: different, environment, configParser })).status, 'stale');
});

test('export context selector change invalidates fake producer while secret env is excluded', async t => {
  const f = fixture(t), stages = pipeline();
  const original = process.env.RUSTFLAGS;
  try {
    process.env.RUSTFLAGS = '--cfg before';
    const first = await runMaintenance({ workspace: f.workspace, pipeline: stages });
    process.env.RUSTFLAGS = '--cfg after';
    assert.equal((await maintenanceStatus({ workspace: f.workspace })).status, 'stale');
    const next = await runMaintenance({ workspace: f.workspace, resume: first.runId, pipeline: stages });
    assert.equal(next.status, 'passed');
    assert.equal(next.stages.length, 4);
  } finally { if (original === undefined) delete process.env.RUSTFLAGS; else process.env.RUSTFLAGS = original; }
});

test('source text changes remain visible when stable object and locator lines do not change', () => {
  const before = { objects: { system: { name: 'same', kind: 'System', sourceEntries: [{ path: 'src/main.rs', line: 10 }] } }, relationships: {}, sourceFiles: { 'src/main.rs': digest('before') } };
  const after = structuredClone(before); after.sourceFiles['src/main.rs'] = digest('after');
  const changes = compareModelSummaries(before, after);
  assert.deepEqual(changes.objects.changed, []);
  assert.deepEqual(changes.sources, ['system']);
  assert.equal(changes.sourceFiles.changed[0].id, 'src/main.rs');
});

test('installed dependencies omit incompatible optional platforms without requesting npm ci', t => {
  const f = fixture(t);
  const current = { version: '1.0.0', integrity: 'fixture', resolved: 'https://fixture.invalid/current' };
  f.put('docs/diagrams/package-lock.json', JSON.stringify({ packages: { '': {}, 'node_modules/current': current,
    'node_modules/other-platform': { ...current, optional: true, os: [process.platform === 'win32' ? 'linux' : 'win32'] } } }));
  f.put('docs/diagrams/node_modules/.package-lock.json', JSON.stringify({ packages: { 'node_modules/current': current } }));
  f.put('docs/diagrams/node_modules/current/package.json', '{"version":"1.0.0"}');
  assert.equal(dependencyState(f.workspace).valid, true);
  fs.unlinkSync(path.join(f.workspace, 'docs/diagrams/node_modules/current/package.json'));
  assert.equal(dependencyState(f.workspace).valid, false);
});

test('compiler selectors use direct env before CARGO_BUILD env before hierarchical config', t => {
  const f = fixture(t), home = path.join(f.workspace, 'cargo-home');
  const configs = [
    { filename: path.join(home, 'config.toml'), data: { build: { rustc: './low/compiler', 'rustc-wrapper': './low/wrapper' } } },
    { filename: path.join(f.workspace, '.cargo/config.toml'), data: { build: { rustc: './tools/compiler', 'rustc-workspace-wrapper': './tools/workspace-wrapper' } } },
  ];
  const configured = resolveCompilerSelection({ workspace: f.workspace, environment: {}, configs });
  assert.equal(configured.rustc.path, path.join(f.workspace, 'tools/compiler'));
  assert.equal(configured['rustc-wrapper'].path, path.join(f.workspace, 'low/wrapper'));
  const environment = { CARGO_BUILD_RUSTC: './env/cargo-compiler', RUSTC: './env/direct-compiler',
    CARGO_BUILD_RUSTC_WRAPPER: './env/cargo-wrapper', RUSTC_WRAPPER: '', CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: './env/workspace-wrapper' };
  const selected = resolveCompilerSelection({ workspace: f.workspace, environment, configs });
  assert.equal(selected.rustc.path, path.join(f.workspace, 'env/direct-compiler'));
  assert.equal(selected.rustc.source, 'RUSTC');
  assert.equal(selected['rustc-wrapper'].disabled, true);
  assert.equal(selected['rustc-workspace-wrapper'].path, path.join(f.workspace, 'env/workspace-wrapper'));
  const inputs = exportContextInputs(f.workspace, environment);
  for (const key of ['CARGO_BUILD_RUSTC', 'CARGO_BUILD_RUSTC_WRAPPER', 'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER']) assert.equal(inputs.environment[key], digest(environment[key]));
});

test('injected standard parser rejects unknown Cargo includes, selector env and parse errors', async t => {
  const f = fixture(t), environment = { CARGO_HOME: f.workspace };
  f.put('.cargo/config.toml', 'parser fixture');
  await assert.rejects(loadCompilerSelection({ workspace: f.workspace, environment, configParser: () => ({ include: ['hidden.toml'] }) }), /include is unsupported/);
  await assert.rejects(loadCompilerSelection({ workspace: f.workspace, environment, configParser: () => ({ env: { RUSTC: { value: 'hidden', force: true } } }) }), /\[env\]/);
  await assert.rejects(loadCompilerSelection({ workspace: f.workspace, environment, configParser: () => { throw new Error('secret invalid text'); } }), /Cannot parse Cargo config/);
});

test('fake export captures selected custom compiler and both wrappers rather than rustup defaults', async t => {
  const f = fixture(t); dumpFixture(f);
  const directory = path.join(f.workspace, 'docs/diagrams/generated/dot');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, DEBUGDUMP_MANIFEST), 'utf8'));
  for (const name of ['fake cargo.exe', 'default compiler.exe', 'custom compiler.exe', 'wrapper.exe', 'workspace wrapper.exe']) f.put(name, name);
  const environment = { CARGO_HOME: f.workspace, CARGO_BUILD_RUSTC: './custom compiler.exe', CARGO_BUILD_RUSTC_WRAPPER: './wrapper.exe',
    CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: './workspace wrapper.exe' };
  const beforeInputs = exportContextInputs(f.workspace, environment);
  const context = await captureExportContext({ workspace: f.workspace, directory, manifest, environment, beforeInputs,
    toolchainProvider: () => ({ cargo: path.join(f.workspace, 'fake cargo.exe'), rustc: path.join(f.workspace, 'default compiler.exe') }) });
  assert.equal(context.tools.rustc.sha256, digest('custom compiler.exe'));
  assert.equal(context.tools['rustc-wrapper'].sha256, digest('wrapper.exe'));
  assert.equal(context.tools['rustc-workspace-wrapper'].sha256, digest('workspace wrapper.exe'));
  assert.equal((await validateExportContext({ workspace: f.workspace, directory, manifest, environment })).status, 'valid');
});

test('config changes during export or identity probing never write a valid sidecar', async t => {
  const f = fixture(t); dumpFixture(f);
  const directory = path.join(f.workspace, 'docs/diagrams/generated/dot');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, DEBUGDUMP_MANIFEST), 'utf8'));
  const environment = { CARGO_HOME: f.workspace }, beforeInputs = exportContextInputs(f.workspace, environment);
  f.put('fake compiler.exe', 'compiler');
  const provider = () => ({ cargo: path.join(f.workspace, 'fake compiler.exe'), rustc: path.join(f.workspace, 'fake compiler.exe') });
  f.put('.cargo/config.toml', 'changed while exporting');
  await assert.rejects(captureExportContext({ workspace: f.workspace, directory, manifest, environment, beforeInputs, toolchainProvider: provider, configParser: () => ({}) }), /configuration changed during execution/);
  fs.unlinkSync(path.join(f.workspace, '.cargo/config.toml'));
  await assert.rejects(captureExportContext({ workspace: f.workspace, directory, manifest, environment, beforeInputs,
    toolchainProvider: () => { f.put('.cargo/config.toml', 'changed during probe'); return provider(); } }), /configuration changed during execution or toolchain probing/);
  assert.equal(fs.existsSync(path.join(directory, 'maintenance-export-context.json')), false);
});

test('locked TOML parser loads escaped compiler keys and rejects malformed real config text', async t => {
  const f = fixture(t), environment = { CARGO_HOME: path.join(f.workspace, 'isolated cargo home') };
  f.put('.cargo/config.toml', '[build]\n"rust\\u0063" = "./tools/custom compiler.exe"\nrustc-wrapper = ""\n');
  const selected = await loadCompilerSelection({ workspace: f.workspace, environment });
  assert.equal(selected.rustc.path, path.join(f.workspace, 'tools/custom compiler.exe'));
  assert.equal(selected['rustc-wrapper'].disabled, true);
  f.put('.cargo/config.toml', '[build\nrustc = "broken"\n');
  await assert.rejects(loadCompilerSelection({ workspace: f.workspace, environment }), /Cannot parse Cargo config/);
});

test('PATH and PATHEXT changes invalidate context without exposing their raw values', t => {
  const f = fixture(t);
  const environment = { CARGO_HOME: f.workspace, PATH: 'private path one', PATHEXT: '.EXE' };
  const before = exportContextInputs(f.workspace, environment);
  const after = exportContextInputs(f.workspace, { ...environment, PATH: 'private path two', PATHEXT: '.COM;.EXE' });
  assert.equal(before.invocation.cargoCommand, after.invocation.cargoCommand);
  assert.notEqual(before.environment.PATH, after.environment.PATH);
  assert.notEqual(before.environment.PATHEXT, after.environment.PATHEXT);
  assert.equal(JSON.stringify(before).includes('private path one'), false);
});

test('Windows environment keys normalize Path, PATHEXT and Cargo compiler aliases consistently', t => {
  const f = fixture(t);
  const normalized = normalizedEnvironment({ Path: 'private path', Pathext: '.EXE', Cargo_Build_Rustc: './compiler.exe' }, 'win32');
  assert.deepEqual(normalized, { PATH: 'private path', PATHEXT: '.EXE', CARGO_BUILD_RUSTC: './compiler.exe' });
  assert.throws(() => normalizedEnvironment({ Path: 'one', PATH: 'two' }, 'win32'), /Conflicting case-insensitive/);
  if (process.platform !== 'win32') return;
  const environment = { Cargo_Home: f.workspace, Path: 'private path', Pathext: '.EXE', Cargo_Build_Rustc: './compiler.exe' };
  const selection = resolveCompilerSelection({ workspace: f.workspace, environment });
  assert.equal(selection.rustc.path, path.join(f.workspace, 'compiler.exe'));
  const inputs = exportContextInputs(f.workspace, environment);
  assert.equal(inputs.environment.PATH, digest('private path'));
  assert.equal(inputs.environment.CARGO_BUILD_RUSTC, digest('./compiler.exe'));
  assert.equal(Object.hasOwn(inputs.environment, 'Path'), false);
});

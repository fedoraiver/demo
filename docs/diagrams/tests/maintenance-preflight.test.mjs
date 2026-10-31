import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildArchitectureModel } from '../src/architecture-model.mjs';
import { buildComponentCatalog } from '../src/architecture-components.mjs';
import { buildObjectCatalog } from '../src/architecture-objects.mjs';
import { validatePreparedArchitecture } from '../src/maintenance-model-checks.mjs';
import { parseDebugdump, renderDebugdump, compileDebugdump } from '../src/debugdump.mjs';
import { repositoryRoot } from '../src/paths.mjs';
import { preflightArchitecture } from '../../../.agents/skills/update-ecs-architecture/scripts/maintenance-preflight.mjs';
import { createArchitectureSourceContext, applyArchitectureSourcePolicies } from '../src/architecture-source-policy.mjs';

const definition = { path: 'src/state_scoped.rs', line: 1, dependency: { name: 'bevy_state', version: '0.18.0', root: '/fixture' } };
function fixture(change = () => {}) {
  const model = { features: [{ id: 'demo', plugin: 'DemoPlugin' }], systems: [], entities: ['one', 'two', 'three', 'four', 'five'].map(id => ({ id, name: id, feature: 'demo', components: [{ id: id + '.Cleanup', name: 'DespawnOnEnter', rust_type: 'DespawnOnEnter<crate::flow::Mode>', feature: 'demo', definition_source: structuredClone(definition) }] })), nodes: [], system_links: [] };
  change(model);
  const { registry } = buildArchitectureModel(model), components = buildComponentCatalog(model, registry, { mergeSystems: false, readSource: () => '' });
  for (const record of Object.values(registry)) {
    record.sourceEntries = record.kind === 'Component' ? [{ ...definition, role: 'definition' }, { path: 'src/scene.rs', line: 1, role: 'create' }, { ...definition, role: 'destroy' }] : [{ path: 'src/scene.rs', line: 1, role: 'create' }, { path: 'src/scene.rs', line: 2, role: 'destroy' }];
    record.sourceGaps = [];
  }
  const objects = buildObjectCatalog(model, registry, { components });
  const views = objects.objects.map(object => ({ ...object, nodes: [{ id: object.id }], links: objects.graphFor(object.id).links }));
  return { model, registry, components, objects, views };
}

test('all equivalent full generic projections keep one canonical identity and complete owners', () => {
  const p = fixture();
  assert.equal(p.components.types.length, 1); assert.equal(validatePreparedArchitecture(p).projections, 5);
  assert.deepEqual(p.components.types[0].ownerEntityIds, ['entity-one', 'entity-two', 'entity-three', 'entity-four', 'entity-five']);
});

test('canonical splits are rejected by full declaration identity rather than five known IDs', () => {
  const p = fixture(model => { model.entities[4].components[0].type_id = 'accidentally-distinct'; });
  assert.equal(p.components.types.length, 2);
  assert.throws(() => validatePreparedArchitecture(p), /split canonical identities/);
});

test('generic argument differences remain separate and missing arguments fail', () => {
  const valid = fixture(model => { model.entities[4].components[0].rust_type = 'DespawnOnEnter<crate::other::Mode>'; });
  assert.equal(valid.components.types.length, 2); validatePreparedArchitecture(valid);
  const invalid = fixture(model => { model.entities[4].components[0].rust_type = 'DespawnOnEnter'; });
  assert.throws(() => validatePreparedArchitecture(invalid), /full state-scoped generic/);
});

test('every state cleanup projection needs actual create and destroy evidence even with pending gap', () => {
  for (const role of ['create', 'destroy']) {
    const p = fixture(), record = p.registry['five.Cleanup'];
    record.sourceEntries = record.sourceEntries.filter(source => source.role !== role); record.sourceGaps = ['待核实：生命周期'];
    assert.throws(() => validatePreparedArchitecture(p), new RegExp('lifecycle role ' + role));
  }
});

test('unrelated acknowledged source gaps stay visible without blocking valid preparation', () => {
  const p = fixture(); p.registry['one.Cleanup'].sourceGaps = ['待核实：其他来源']; validatePreparedArchitecture(p);
});

test('projection/owner metadata, dangling accesses and relation endpoints fail before rendering', () => {
  const owner = fixture(); owner.components.types[0].ownerEntityIds.pop(); assert.throws(() => validatePreparedArchitecture(owner), /owner projection/);
  const projection = fixture(); projection.registry['one.Cleanup'].projectionIds = ['one.Cleanup']; assert.throws(() => validatePreparedArchitecture(projection), /canonical projection metadata/);
  const access = fixture(); access.model.systems.push({ id: 'tick', reads: ['missing'] }); access.registry.tick = { id: 'tick', kind: 'System' }; assert.throws(() => validatePreparedArchitecture(access), /Dangling system access/);
  const link = fixture(); link.objects.links.push({ id: 'broken', from: 'one.Cleanup', to: 'missing' }); assert.throws(() => validatePreparedArchitecture(link), /Dangling object relationship/);
});

test('stale project function declaration identity fails despite auto-resolved source evidence', () => {
  const p = fixture(); p.model.systems.push({ id: 'tick', name: 'tick', kind: 'System', source: { path: 'src/demo.rs', line: 1 } });
  p.registry.tick = { id: 'tick', kind: 'System', sourceEntries: [{ role: 'definition', path: 'src/demo.rs', line: 2 }] };
  assert.throws(() => validatePreparedArchitecture(p), /definition is stale/);
  p.registry.tick.sourceEntries[0].line = 1;
  p.sourceAudit = { context: { read: () => ({ code: 'fn wrong() {}' }) } };
  assert.throws(() => validatePreparedArchitecture(p), /function identity mismatch/);
});

test('required object identity and member registration references cannot disappear', () => {
  const required = fixture(); required.model.required_nodes = ['missing']; assert.throws(() => validatePreparedArchitecture(required), /Required architecture node missing/);
  const member = fixture(); member.registry['entity-one'].memberIds = ['missing']; assert.throws(() => validatePreparedArchitecture(member), /Dangling member registration/);
});

test('real DOT preparation parses without SVG and rendering retains legacy compile bytes and order', async () => {
  const dump = { manifest: { schemaVersion: 1, sourceFingerprint: 'fixture' }, schedules: [{ id: 'fixture', app: 'main', label: 'Update', systemCount: 1, dot: 'digraph { a [label="tick", tooltip="demo::tick"]; }' }] };
  const parsed = await parseDebugdump(dump);
  assert(!('svg' in parsed.views[0])); assert(!('width' in parsed.views[0]));
  const direct = await compileDebugdump(dump), separate = await renderDebugdump(parsed);
  assert.equal(JSON.stringify(separate), JSON.stringify(direct));
  parsed.views[0].schedulePluginGroups = [{ id: 'plugin-DemoPlugin' }];
  const extended = await renderDebugdump(parsed);
  assert.equal(extended.views[0].svg, direct.views[0].svg);
  assert(Object.keys(extended.views[0]).indexOf('svg') < Object.keys(extended.views[0]).indexOf('exportInfo'));
  assert(Object.keys(extended.views[0]).indexOf('schedulePluginGroups') > Object.keys(extended.views[0]).indexOf('sections'));
});

test('production preflight preparation has no browser/compiler/write dependency', () => {
  for (const filename of ['.agents/skills/update-ecs-architecture/scripts/maintenance-preflight.mjs', 'docs/diagrams/src/architecture-preparation.mjs']) {
    const source = fs.readFileSync(path.join(repositoryRoot, filename), 'utf8');
    assert.doesNotMatch(source, /mermaid-compiler|puppeteer|writeFile|writeArtifact|renderDebugdump|compileDebugdump/);
  }
});

test('preflight resolves relative debugdump directories from workspace even when cwd differs', async t => {
  const parent = path.join(repositoryRoot, 'tmp/ecs-architecture/preflight-path-tests');
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, 'case-'));
  const workspace = path.join(temporary, 'workspace'), otherCwd = path.join(temporary, 'other-cwd');
  const directory = path.join(workspace, 'tmp/real-export');
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(otherCwd);
  // 在来源校验处中止，证明真实入口读到指定导出；不会调用 Cargo 或编译图形。
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 999 }));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const previousCwd = process.cwd();
  try {
    process.chdir(otherCwd);
    await assert.rejects(preflightArchitecture({ workspace, debugdumpDirectory: 'tmp/real-export' }), /Unsupported debugdump manifest schema/);
    await assert.rejects(preflightArchitecture({ workspace, debugdumpDirectory: directory }), /Unsupported debugdump manifest schema/);
  } finally { process.chdir(previousCwd); }
});

test('project source evidence is identical across file creation and enumeration orders', t => {
  const parent = path.join(repositoryRoot, 'tmp/ecs-architecture/source-order-tests');
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, 'case-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const sourceFiles = {
    'a.rs': 'fn register_a(app: &mut App) { app.add_systems(Update, tick); }\n',
    'mod.rs': 'pub fn tick() {}\n',
    'z.rs': 'fn register_z(app: &mut App) { app.add_systems(Update, tick); }\n',
  };
  const originalReadDirectory = fs.readdirSync;
  function evidence(order, reverseEnumeration) {
    const workspace = path.join(temporary, reverseEnumeration ? 'reverse' : 'forward');
    fs.mkdirSync(path.join(workspace, 'src/demo'), { recursive: true });
    for (const filename of order) fs.writeFileSync(path.join(workspace, 'src/demo', filename), sourceFiles[filename]);
    let reversedListingObserved = false;
    const replacement = t.mock.method(fs, 'readdirSync', function(directory, options) {
      const entries = originalReadDirectory.call(fs, directory, options);
      if (String(directory).startsWith(path.join(workspace, 'src'))) {
        entries.sort((a, b) => (a.name || a) < (b.name || b) ? -1 : (a.name || a) > (b.name || b) ? 1 : 0);
        if (reverseEnumeration) { entries.reverse(); reversedListingObserved ||= entries.length > 1; }
      }
      return entries;
    });
    try {
      const record = { id: 'tick', kind: 'System', name: 'tick', feature: 'demo', module: 'demo', source: { path: 'src/demo/mod.rs', line: 1 }, registrations: [{ schedule: 'Update', scope: 'runtime' }] };
      const model = { systems: [record] }, registry = { tick: record };
      const context = createArchitectureSourceContext({ repository: workspace, model });
      applyArchitectureSourcePolicies(registry, { context, model });
      if (reverseEnumeration) assert(reversedListingObserved, 'fixture must exercise reversed filesystem enumeration');
      return { files: context.projectFiles.map(file => file.path), sources: record.sourceEntries, gaps: record.sourceGaps };
    } finally { replacement.mock.restore(); }
  }
  const forward = evidence(['a.rs', 'mod.rs', 'z.rs'], false), reverse = evidence(['z.rs', 'mod.rs', 'a.rs'], true);
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.files, ['src/demo/a.rs', 'src/demo/mod.rs', 'src/demo/z.rs']);
  assert.deepEqual(forward.sources.map(source => [source.role, source.path]), [['definition', 'src/demo/mod.rs'], ['registration', 'src/demo/a.rs'], ['registration', 'src/demo/z.rs']]);
});

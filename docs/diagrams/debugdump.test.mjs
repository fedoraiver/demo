import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DEBUGDUMP_MANIFEST, sha256, scheduleId, sourceFingerprint, readDebugdump, compileDebugdump, checkDebugdumpViews, normalizeScheduleSvg, obsoleteArchitectureArtifacts } from './debugdump.mjs';
import { buildArchitectureModel } from './architecture-model.mjs';
import { buildObjectCatalog } from './architecture-objects.mjs';
import { renderGraphView } from './architecture-renderer.mjs';
import { compileArchitectureArtifacts } from './mermaid-compiler.mjs';
import { renderArchitectureViewer } from './architecture-viewer.mjs';
import { INFRASTRUCTURE_FEATURES } from './architecture-infrastructure.mjs';
import { sourcePolicyFor } from './architecture-source-policy.mjs';
import { checkArchitecture } from './check-ecs.mjs';
import { buildSchedulePluginGroups } from './schedule-plugins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = path.join(root, 'tmp/debugdump-node-tests');
// 与其它架构夹具一致，测试产物保留在根 tmp/，便于复查，不修改正式图。
function fixture() {
  fs.mkdirSync(temporary, { recursive: true });
  const repository = fs.mkdtempSync(path.join(temporary, 'case-'));
  fs.mkdirSync(path.join(repository, 'src'));
  fs.writeFileSync(path.join(repository, 'src/main.rs'), 'fn main() {}\r\n');
  fs.writeFileSync(path.join(repository, 'Cargo.toml'), '[package]\nname="example"\n');
  fs.writeFileSync(path.join(repository, 'Cargo.lock'), '[[package]]\nname = "bevy"\nversion = "0.20.0"\n[[package]]\nname = "bevy_mod_debugdump"\nversion = "0.17.0"\n');
  const schedules = ['main', 'RenderApp'].map(app => {
    const label = 'Update<状态 / "Ready">', id = scheduleId(app, label);
    const dot = 'digraph { subgraph cluster_set { label="ExampleSet"; a [label="first", tooltip="example::first"]; b [label="second", tooltip="example::second"]; a -> b; } }\n';
    const entry = { id, app, label, filename: `schedule-${id}.dot`, sha256: sha256(dot), systemCount: 2 };
    fs.writeFileSync(path.join(repository, entry.filename), dot);
    return entry;
  });
  const manifest = { schemaVersion: 1, bevyVersion: '0.20.0', debugdumpVersion: '0.17.0', exportedAt: 100, target: 'test', features: ['debugdump'], sourceFingerprint: sourceFingerprint(repository), schedules };
  const save = () => fs.writeFileSync(path.join(repository, 'manifest.json'), JSON.stringify(manifest));
  save();
  return { repository, manifest, save };
}

test('source fingerprints ignore CRLF differences but include source and lock changes', t => {
  const { repository } = fixture(t);
  const before = sourceFingerprint(repository);
  fs.writeFileSync(path.join(repository, 'src/main.rs'), 'fn main() {}\n');
  assert.equal(sourceFingerprint(repository), before);
  fs.appendFileSync(path.join(repository, 'Cargo.lock'), '# changed\n');
  assert.notEqual(sourceFingerprint(repository), before);
});

test('real Graphviz renders DOT for identically named schedules in separate applications', async t => {
  const { repository } = fixture(t);
  const result = await compileDebugdump(readDebugdump(repository, repository));
  assert.equal(result.views.length, 2);
  assert.notEqual(result.views[0].id, result.views[1].id);
  for (const view of result.views) {
    assert.equal(view.engine, 'graphviz');
    assert.match(view.svg, /<text[^>]*>first<\/text>/);
    assert.match(view.svg, /<path /);
    assert.match(view.svg, /<polygon /);
    assert.ok(view.width > 0 && view.height > 0);
    assert.deepEqual(view.nodes, []);
    fs.writeFileSync(path.join(repository, view.filename), view.svg);
    fs.writeFileSync(path.join(repository, view.dotFilename), view.dot);
  }
  fs.writeFileSync(path.join(repository, DEBUGDUMP_MANIFEST), JSON.stringify(result.manifest));
  assert.deepEqual(checkDebugdumpViews(repository, repository, result.views), result.manifest);
  const node = result.views[0].scheduleGraph.nodes[0], tooltip = node.attributes.tooltip;
  node.attributes.tooltip = 'invented::system';
  assert.throws(() => checkDebugdumpViews(repository, repository, result.views), /model hash mismatch/);
  node.attributes.tooltip = tooltip;
  const theme = result.manifest.renderer.themeSha256;
  result.manifest.renderer.themeSha256 = 'altered';
  fs.writeFileSync(path.join(repository, DEBUGDUMP_MANIFEST), JSON.stringify(result.manifest));
  assert.throws(() => checkDebugdumpViews(repository, repository, result.views), /theme or model/);
  result.manifest.renderer.themeSha256 = theme;
  fs.writeFileSync(path.join(repository, DEBUGDUMP_MANIFEST), JSON.stringify(result.manifest));
  result.views[0].svg += '\n';
  assert.throws(() => checkDebugdumpViews(repository, repository, result.views), /SVG hash mismatch/);
});

test('missing, stale, duplicate and altered exports fail before compilation', t => {
  const { repository, manifest, save } = fixture(t);
  const filename = path.join(repository, 'manifest.json');
  fs.renameSync(filename, filename + '.saved');
  assert.throws(() => readDebugdump(repository, repository), /Missing debugdump manifest/);
  save();
  manifest.schedules.push(manifest.schedules[0]); save();
  assert.throws(() => readDebugdump(repository, repository), /duplicate/);
  manifest.schedules.pop(); save();
  fs.appendFileSync(path.join(repository, manifest.schedules[0].filename), ' ');
  assert.throws(() => readDebugdump(repository, repository), /hash mismatch/);
  fs.appendFileSync(path.join(repository, 'src/main.rs'), '// changed');
  assert.throws(() => readDebugdump(repository, repository), /fingerprint is stale/);
});

test('export provenance, filenames and file presence are verified', t => {
  const { repository, manifest, save } = fixture(t);
  manifest.debugdumpVersion = '0.16.0'; save();
  assert.throws(() => readDebugdump(repository, repository), /dependency version mismatch/);
  manifest.debugdumpVersion = '0.17.0';
  const entry = manifest.schedules[0], filename = entry.filename;
  entry.filename = '../outside.dot'; save();
  assert.throws(() => readDebugdump(repository, repository), /Unsafe/);
  entry.filename = filename; save();
  fs.unlinkSync(path.join(repository, filename));
  assert.throws(() => readDebugdump(repository, repository), /Missing debugdump DOT/);
});

test('SVG normalization keeps native geometry and rejects executable or external content', () => {
  const contents = '<svg xmlns="http://www.w3.org/2000/svg" width="20pt" height="10pt" viewBox="0 0 20 10"><path d="M1,2 L3,4"/></svg>';
  const normalized = normalizeScheduleSvg(contents, 'schedule-example');
  assert.match(normalized.svg, /width="20"/);
  assert.match(normalized.svg, /d="M1,2 L3,4"/);
  assert.throws(() => normalizeScheduleSvg(contents.replace('<path', '<script/><path'), 'bad'), /Unexpected/);
  assert.throws(() => normalizeScheduleSvg(contents.replace('<path', '<a href="https:\/\/example.com"/><path'), 'bad'), /Unexpected/);
  assert.throws(() => normalizeScheduleSvg(contents.replace('<path', '<image href="data:image/svg+xml,invalid"/><path'), 'bad'), /Unexpected/);
  assert.throws(() => normalizeScheduleSvg(contents.replace('<path', '<path fill="url(https://example.com)"/><path'), 'bad'), /Unexpected/);
  assert.throws(() => normalizeScheduleSvg(contents.replace('<path', '<path style="fill:red"/><path'), 'bad'), /Unexpected/);
  assert.throws(() => normalizeScheduleSvg(contents.replace('0 0 20 10', '0 0 NaN 10'), 'bad'), /viewBox/);
});

test('artifact cleanup removes old overviews and systems while retaining exact object and schedule outputs', t => {
  const { repository } = fixture(t);
  const files = ['ecs-overview.svg', 'ecs-overview.mmd', 'ecs-plugin-ui-systems.svg', 'ecs-infrastructure-systems.mmd', 'ecs-third-party-kira-systems.svg', 'ecs-object-kept.svg', 'ecs-object-kept.mmd', 'ecs-schedule-kept.dot', 'ecs-schedule-kept.svg'];
  files.forEach(file => fs.writeFileSync(path.join(repository, file), ''));
  const views = [{ filename: 'ecs-object-kept.svg', mermaidFilename: 'ecs-object-kept.mmd' }, { filename: 'ecs-schedule-kept.svg', dotFilename: 'ecs-schedule-kept.dot' }];
  assert.deepEqual(obsoleteArchitectureArtifacts(repository, views).sort(), files.slice(0, 5).sort());
});

test('schema 4 checks actual Graphviz schedules alongside compiled object SVG without restoring retired views', async t => {
  const { repository } = fixture(t);
  const features = [{ id: 'example', plugin: 'ExamplePlugin', label: '示例插件' }];
  const model = { features, systems: [], observers: [], entities: [], resources: [], relationships: [], node_features: {},
    nodes: [{ id: 'plugin-ExamplePlugin', name: 'ExamplePlugin', feature: 'example', kind: 'Plugin', description: '示例插件。' },
      ...INFRASTRUCTURE_FEATURES.map(feature => ({ id: feature.overviewNode, name: feature.identifier, feature: feature.id, kind: 'Plugin', description: '基础设施。' }))] };
  const { registry } = buildArchitectureModel(model);
  for (const record of Object.values(registry)) { record.sourceEntries = []; record.sourceGaps = ['测试夹具无生产声明。']; }
  const catalog = buildObjectCatalog(model, registry);
  const objects = catalog.objects.map(object => renderGraphView({ id: object.viewId, aspect: 'object', feature: object.feature,
    objectId: object.id, centerNodeId: object.id, label: object.id, summary: '独立对象。' }, catalog.graphFor(object.id), registry, features));
  const compiled = await compileArchitectureArtifacts(objects, registry);
  const schedules = await compileDebugdump(readDebugdump(repository, repository));
  const grouped = buildSchedulePluginGroups({ model, views: schedules.views });
  const views = [...grouped.views, ...compiled.views];
  const directory = path.join(repository, 'docs/diagrams');
  fs.mkdirSync(directory, { recursive: true });
  for (const view of views) {
    fs.writeFileSync(path.join(directory, view.filename), view.svg);
    if (view.mermaidFilename) fs.writeFileSync(path.join(directory, view.mermaidFilename), view.mermaid);
    if (view.dotFilename) fs.writeFileSync(path.join(directory, view.dotFilename), view.dot);
  }
  fs.writeFileSync(path.join(directory, DEBUGDUMP_MANIFEST), JSON.stringify(schedules.manifest));
  fs.writeFileSync(path.join(directory, 'ecs-data.json'), JSON.stringify(model));
  fs.writeFileSync(path.join(directory, 'ecs-source.html'), '<script id="sources" type="application/json">[]</script>');
  const saveViewer = overrides => fs.writeFileSync(path.join(directory, 'ecs-architecture.html'), renderArchitectureViewer({ model, registry, views, features,
    objects: catalog.objects, guideSamples: compiled.guideSamples,
    schedulePluginCatalog: grouped.catalog,
    sourceRoleLabels: Object.fromEntries(sourcePolicyFor('edge').groups.map(group => [group.role, group.label])), ...overrides }));
  saveViewer();
  const check = () => checkArchitecture(repository, { dependencyDefinitions: {}, cargoMetadata: { packages: [] }, requireDependencyDefinitions: false });
  assert.equal(check().objects, catalog.objects.length);
  saveViewer({ schedulePluginCatalog: [] });
  assert.throws(check, /Plugin source catalog is stale/);
  saveViewer({ views: views.map((view, index) => index ? view : { ...view, schedulePluginGroups: [] }) });
  assert.throws(check, /Plugin source membership is stale/);
  saveViewer();
  fs.writeFileSync(path.join(directory, 'ecs-overview.svg'), '<svg/>');
  assert.throws(check, /SVG file set does not match/);
});

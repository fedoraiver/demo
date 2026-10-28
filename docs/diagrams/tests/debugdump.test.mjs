import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { instance } from '@viz-js/viz';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { DEBUGDUMP_MANIFEST, sha256, scheduleId, sourceFingerprint, readDebugdump, compileDebugdump, checkDebugdumpViews, normalizeScheduleSvg, obsoleteArchitectureArtifacts } from '../src/debugdump.mjs';
import { buildArchitectureModel } from '../src/architecture-model.mjs';
import { buildObjectCatalog } from '../src/architecture-objects.mjs';
import { renderGraphView } from '../src/architecture-renderer.mjs';
import { compileArchitectureArtifacts } from '../src/mermaid-compiler.mjs';
import { renderArchitectureViewer } from '../src/architecture-viewer.mjs';
import { INFRASTRUCTURE_FEATURES } from '../src/architecture-infrastructure.mjs';
import { sourcePolicyFor, applyArchitectureSourcePolicies } from '../src/architecture-source-policy.mjs';
import { checkArchitecture, checkScheduleObjectMetadata, checkScheduleGuideSamples } from '../src/check-ecs.mjs';
import { buildSchedulePluginGroups } from '../src/schedule-plugins.mjs';
import { buildScheduleObjects } from '../src/schedule-objects.mjs';
import { createDependencySourceResolver } from '../src/dependency-sources.mjs';
import { compileScheduleGuideSamples } from '../src/schedule-legend-compiler.mjs';
import { artifactFile, pathsForRepository } from '../src/paths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const temporary = path.join(root, 'tmp/debugdump-node-tests');

test('Schedule guide validation checks actual Graphviz colors, arrows, identities and safe SVG', async () => {
  const samples = compileScheduleGuideSamples(await instance(), { DOMParser, XMLSerializer });
  assert.doesNotThrow(() => checkScheduleGuideSamples(samples));
  const changed = edit => { const copy = structuredClone(samples); edit(copy); return copy; };
  assert.throws(() => checkScheduleGuideSamples(changed(copy => { delete copy.nodes.context; })), /catalog mismatch/);
  assert.throws(() => checkScheduleGuideSamples(changed(copy => { copy.nodes.system = copy.nodes.system.replace('stroke="#3567a6"', 'stroke="#ff0000"'); })), /appearance mismatch/);
  assert.throws(() => checkScheduleGuideSamples(changed(copy => { copy.edges.order = copy.edges.set_membership; })), /identity mismatch/);
  assert.throws(() => checkScheduleGuideSamples(changed(copy => { copy.nodes.context = copy.nodes.context.replace('id="guide-schedule-context-graph"', 'id="guide-schedule-system-graph"'); })), /Duplicate read guide SVG ID/);
  assert.throws(() => checkScheduleGuideSamples(changed(copy => { copy.nodes.system = copy.nodes.system.replace('</svg>', '<script/></svg>'); })), /Unexpected Graphviz SVG element/);
});

test('Schedule guide validation rejects opaque backgrounds, visible labels and narrow or unevenly framed samples', async () => {
  const samples = compileScheduleGuideSamples(await instance(), { DOMParser, XMLSerializer });
  const changed = (section, kind, edit) => {
    const copy = structuredClone(samples), document = new DOMParser().parseFromString(copy[section][kind], 'image/svg+xml');
    edit(document, document.documentElement);
    copy[section][kind] = new XMLSerializer().serializeToString(document.documentElement);
    return copy;
  };
  const classOf = (document, name) => [...document.getElementsByTagName('g')].find(element => (element.getAttribute('class') || '').split(/\s+/).includes(name));
  const addBackground = (document, fill, stroke = 'transparent') => {
    const graph = classOf(document, 'graph');
    const polygon = [...graph.childNodes].find(element => element.localName === 'polygon') || document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', '0,0 1,0 1,1 0,1'); polygon.setAttribute('fill', fill); polygon.setAttribute('stroke', stroke);
    if (!polygon.parentNode) graph.insertBefore(polygon, graph.firstChild);
  };
  for (const section of ['nodes', 'edges']) for (const kind of Object.keys(samples[section])) {
    assert.doesNotThrow(() => checkScheduleGuideSamples(changed(section, kind, document => addBackground(document, 'transparent'))));
    for (const [fill, stroke] of [['#FFFFFF', 'transparent'], ['transparent', '#F6F8FB']]) {
      assert.throws(() => checkScheduleGuideSamples(changed(section, kind, document => addBackground(document, fill, stroke))), /background is not transparent/);
    }
    for (const tag of ['text', 'tspan']) assert.throws(() => checkScheduleGuideSamples(changed(section, kind, (document, root) => {
      const label = document.createElementNS('http://www.w3.org/2000/svg', tag); label.textContent = 'System'; root.appendChild(label);
    })), /Unexpected visible text/);
    assert.throws(() => checkScheduleGuideSamples(changed(section, kind, (_, root) => {
      const [x, y, width, height] = root.getAttribute('viewBox').split(/\s+/).map(Number);
      root.setAttribute('viewBox', [x - 1, y, width + 2, height].join(' ')); root.setAttribute('width', String(width + 2));
    })), /padding mismatch/);
  }
  for (const kind of Object.keys(samples.nodes)) assert.throws(() => checkScheduleGuideSamples(changed('nodes', kind, document => {
    classOf(document, kind === 'system_set' ? 'cluster' : 'node').setAttribute('transform', 'scale(0.2 1)');
  })), /node is not horizontal/);
  assert.throws(() => checkScheduleGuideSamples(changed('nodes', 'system', (document, root) => {
    const rectangle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rectangle.setAttribute('width', '10'); rectangle.setAttribute('height', '10'); rectangle.setAttribute('fill', '#FFFFFF'); root.appendChild(rectangle);
  })), /background is not transparent/);
});
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
    assert.deepEqual(view.legendKinds, ['system', 'system_set', 'order']);
    fs.writeFileSync(path.join(repository, view.filename), view.svg);
    fs.writeFileSync(path.join(repository, view.dotFilename), view.dot);
  }
  fs.writeFileSync(path.join(repository, DEBUGDUMP_MANIFEST), JSON.stringify(result.manifest));
  assert.deepEqual(checkDebugdumpViews(repository, repository, result.views), result.manifest);
  const legendKinds = result.views[0].legendKinds;
  result.views[0].legendKinds = ['system'];
  assert.throws(() => checkDebugdumpViews(repository, repository, result.views), /legend categories mismatch/);
  result.views[0].legendKinds = legendKinds;
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

test('classified cleanup removes only unlisted managed graph artifacts and preserves data, legends and unrelated files', t => {
  const { repository } = fixture(t), paths = pathsForRepository(repository);
  const views = [{ aspect: 'object', filename: 'ecs-object-kept.svg', mermaidFilename: 'ecs-object-kept.mmd' }, { aspect: 'schedule', filename: 'ecs-schedule-kept.svg', dotFilename: 'ecs-schedule-kept.dot' }];
  for (const directory of [paths.objectSvgDirectory, paths.scheduleSvgDirectory, paths.mermaidDirectory, paths.dotDirectory, paths.dataDirectory, paths.legendSvgDirectory]) fs.mkdirSync(directory, { recursive: true });
  for (const view of views) for (const kind of ['svg', ...(view.mermaidFilename ? ['mermaid'] : []), ...(view.dotFilename ? ['dot'] : [])]) fs.writeFileSync(artifactFile(paths, view, kind), '');
  const stale = ['svg/object/ecs-object-old.svg', 'svg/schedule/ecs-schedule-old.svg', 'mermaid/ecs-object-old.mmd', 'dot/ecs-schedule-old.dot'];
  for (const filename of [...stale, 'data/ecs-object-old.svg', 'svg/legend/ecs-legend.svg', 'svg/object/README.md', 'dot/debugdump-manifest.json']) fs.writeFileSync(path.join(paths.generatedDirectory, filename), '');
  fs.mkdirSync(path.join(paths.objectSvgDirectory, 'ecs-directory.svg'));
  assert.deepEqual(obsoleteArchitectureArtifacts(paths, views).sort(), [...stale].sort());
});

test('classified Schedule validation reads DOT and manifest separately from SVG without accepting a flat fallback', async t => {
  const { repository } = fixture(t), paths = pathsForRepository(repository);
  const result = await compileDebugdump(readDebugdump(repository, repository));
  fs.mkdirSync(paths.dotDirectory, { recursive: true }); fs.mkdirSync(paths.scheduleSvgDirectory, { recursive: true });
  fs.writeFileSync(path.join(paths.dotDirectory, DEBUGDUMP_MANIFEST), JSON.stringify(result.manifest));
  for (const view of result.views) {
    fs.writeFileSync(artifactFile(paths, view, 'dot'), view.dot); fs.writeFileSync(artifactFile(paths, view), view.svg);
  }
  assert.deepEqual(checkDebugdumpViews(paths.dotDirectory, repository, result.views), result.manifest);
  const first = result.views[0];fs.writeFileSync(path.join(paths.dotDirectory, first.filename), first.svg);fs.unlinkSync(artifactFile(paths, first));
  assert.throws(() => checkDebugdumpViews(paths.dotDirectory, repository, result.views), /ENOENT/);
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
    sourceRoleLabels: Object.fromEntries(sourcePolicyFor('edge').groups.map(group => [group.role, group.label])), ...overrides }).replace('{"schemaVersion":5,"model":', '{"schemaVersion":4,"model":'));
  saveViewer();
  const check = () => checkArchitecture(repository, { dependencyDefinitions: {}, cargoMetadata: { packages: [] }, requireDependencyDefinitions: false });
  assert.equal(check().objects, catalog.objects.length);
  const forged = structuredClone(registry);
  forged['plugin-DefaultPlugins'].scheduleEvidence = { schemaVersion: 1 };
  saveViewer({ registry: forged });
  assert.throws(check, /Schedule object evidence mismatch: plugin-DefaultPlugins/);
  saveViewer({ schedulePluginCatalog: [] });
  assert.throws(check, /Plugin source catalog is stale/);
  saveViewer({ views: views.map((view, index) => index ? view : { ...view, schedulePluginGroups: [] }) });
  assert.throws(check, /Plugin source membership is stale/);
  saveViewer();
  fs.writeFileSync(path.join(directory, 'ecs-overview.svg'), '<svg/>');
  assert.throws(check, /SVG file set does not match/);
});

test('schema 5 recomputes complete Schedule object bindings and source-backed extensions', async t => {
  const { repository, manifest, save } = fixture(t);
  fs.writeFileSync(path.join(repository, 'Cargo.toml'), '[package]\nname="demo"\n');
  fs.writeFileSync(path.join(repository, 'src/main.rs'), 'fn main() {}\n');
  fs.mkdirSync(path.join(repository, 'src/character'));
  fs.writeFileSync(path.join(repository, 'src/character/mod.rs'), 'fn log_configuration() {}\n');
  fs.writeFileSync(path.join(repository, 'src/character/motion.rs'), 'fn log_character_velocity() {}\n');
  for (const schedule of manifest.schedules) {
    const dot = 'digraph { a [label="log_configuration", tooltip="demo::character::log_configuration"]; b [label="log_character_velocity", tooltip="demo::character::motion::log_character_velocity"]; a -> b; }\n';
    fs.writeFileSync(path.join(repository, schedule.filename), dot);
    schedule.sha256 = sha256(dot);
  }
  manifest.sourceFingerprint = sourceFingerprint(repository); save();
  const schedules = await compileDebugdump(readDebugdump(repository, repository));
  const features = [{ id: 'example', plugin: 'ExamplePlugin', label: '示例插件' }];
  const base = { features, systems: [], observers: [], entities: [], resources: [], relationships: [], node_features: {},
    nodes: [{ id: 'plugin-ExamplePlugin', name: 'ExamplePlugin', feature: 'example', kind: 'Plugin', description: '示例插件。' },
      ...INFRASTRUCTURE_FEATURES.map(feature => ({ id: feature.overviewNode, name: feature.identifier, feature: feature.id, kind: 'Plugin', description: '基础设施。' }))] };
  const metadata = { packages: [{ name: 'demo', version: '0.1.0', manifest_path: path.join(repository, 'Cargo.toml') }] }, resolver = createDependencySourceResolver(metadata);
  const extension = buildScheduleObjects({ model: base, views: schedules.views, repository, metadata, resolver });
  const { model, scheduleInteractions } = extension, { registry } = buildArchitectureModel(model);
  for (const record of Object.values(registry)) if (!record.scheduleEvidence) { record.sourceEntries = []; record.sourceGaps = ['测试夹具无生产声明。']; }
  applyArchitectureSourcePolicies(Object.fromEntries(Object.entries(registry).filter(([, record]) => record.scheduleEvidence)), { model, repository, dependencyContext: { metadata, resolver } });
  const catalog = buildObjectCatalog(model, registry);
  const objects = catalog.objects.map(object => renderGraphView({ id: object.viewId, aspect: 'object', feature: object.feature,
    objectId: object.id, centerNodeId: object.id, label: object.id }, catalog.graphFor(object.id), registry, features));
  const compiled = await compileArchitectureArtifacts(objects, registry), grouped = buildSchedulePluginGroups({ model: base, views: schedules.views });
  const views = [...grouped.views, ...compiled.views], directory = path.join(repository, 'docs/diagrams');
  fs.mkdirSync(directory, { recursive: true });
  for (const view of views) {
    fs.writeFileSync(path.join(directory, view.filename), view.svg);
    if (view.mermaidFilename) fs.writeFileSync(path.join(directory, view.mermaidFilename), view.mermaid);
    if (view.dotFilename) fs.writeFileSync(path.join(directory, view.dotFilename), view.dot);
  }
  fs.writeFileSync(path.join(directory, DEBUGDUMP_MANIFEST), JSON.stringify(schedules.manifest));
  fs.writeFileSync(path.join(directory, 'ecs-data.json'), JSON.stringify(base));
  fs.writeFileSync(path.join(directory, 'ecs-source.html'), '<script id="sources" type="application/json">' + JSON.stringify(['src/main.rs', 'src/character/mod.rs', 'src/character/motion.rs'].map(filename => ({ path: filename, text: fs.readFileSync(path.join(repository, filename), 'utf8') }))) + '</script>');
  const saveViewer = overrides => fs.writeFileSync(path.join(directory, 'ecs-architecture.html'), renderArchitectureViewer({ model, registry, views, features, scheduleInteractions,
    objects: catalog.objects, guideSamples: compiled.guideSamples, schedulePluginCatalog: grouped.catalog,
    sourceRoleLabels: Object.fromEntries(sourcePolicyFor('edge').groups.map(group => [group.role, group.label])), ...overrides }));
  const check = () => checkArchitecture(repository, { dependencyDefinitions: {}, cargoMetadata: metadata, requireDependencyDefinitions: false });
  saveViewer(); assert.equal(check().objects, catalog.objects.length);
  const forged = structuredClone(registry);
  forged['plugin-DefaultPlugins'].definition_source = { path: 'src/main.rs', line: 1 };
  saveViewer({ registry: forged });
  assert.throws(check, /Unexpected dependency definition source: plugin-DefaultPlugins/);
  forged['plugin-DefaultPlugins'].scheduleEvidence = { schemaVersion: 1 };
  saveViewer({ registry: forged });
  assert.throws(check, /Schedule object evidence mismatch: plugin-DefaultPlugins/);
  const forgedBody = structuredClone(registry);
  forgedBody['plugin-ExamplePlugin'].bodyOperations = [{ objectId: 'plugin-DefaultPlugins', operation: 'insert', via: 'commands', method: 'insert_resource' }];
  saveViewer({ registry: forgedBody });
  assert.throws(check, /Schedule body operation metadata mismatch: plugin-ExamplePlugin/);
  const missingEvidence = structuredClone(registry), system = Object.values(missingEvidence).find(record => record.scheduleEvidence?.kind === 'system');
  delete system.scheduleEvidence;
  saveViewer({ registry: missingEvidence });
  assert.throws(check, /Schedule object evidence mismatch/);
  saveViewer({ scheduleInteractions: { schemaVersion: 1, views: [] } });
  assert.throws(check, /interaction directory is stale or incomplete/);
  const altered = structuredClone(registry), target = Object.values(altered).find(record => record.scheduleEvidence?.kind === 'system');
  target.sourceEntries[0].line += 1;
  saveViewer({ registry: altered });
  assert.throws(check, /Schedule object source or metadata mismatch/);
  saveViewer({ model: { ...model, nodes: model.nodes.slice(0, -1) } });
  assert.throws(check, /Embedded architecture model does not match/);
});

test('Schedule object metadata checks replay unresolved component evidence and reject removed or forged gaps', () => {
  const registry = {
    system: { id: 'system', name: 'spawn_lighting', kind: 'System', sourceEntries: [], sourceGaps: [], scheduleEvidence: { schemaVersion: 1, kind: 'system' } },
    name: { id: 'name', name: 'Name', kind: 'Component', sourceEntries: [], sourceGaps: [] },
  };
  const fact = { system: 'system', component: 'name', operation: 'insert', evidence: 'source', targetScope: 'type-only', projectionIds: [] };
  const catalog = buildObjectCatalog({ systems: [], nodes: [], system_links: [] }, registry, { components: { accesses: [fact, fact] } });
  const gap = '待核实：Name 的 insert 操作尚未确定实体投影，未据此建立具体投影关系。';
  const actual = structuredClone(registry); actual.system.sourceGaps = [gap];
  checkScheduleObjectMetadata(actual, registry, catalog.unresolvedAccesses);
  assert.deepEqual(registry.system.sourceGaps, [gap]);
  checkScheduleObjectMetadata(actual, registry, catalog.unresolvedAccesses);
  const removed = structuredClone(actual); removed.system.sourceGaps = [];
  assert.throws(() => checkScheduleObjectMetadata(removed, registry, catalog.unresolvedAccesses), /Schedule object source or metadata mismatch/);
  const forged = structuredClone(actual); forged.system.sourceGaps.push('虚构缺口');
  assert.throws(() => checkScheduleObjectMetadata(forged, registry, catalog.unresolvedAccesses), /Schedule object source or metadata mismatch/);
  const changed = structuredClone(actual); changed.system.name = 'another function';
  assert.throws(() => checkScheduleObjectMetadata(changed, registry, catalog.unresolvedAccesses), /Schedule object source or metadata mismatch/);
});

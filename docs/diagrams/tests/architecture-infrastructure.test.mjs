import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { projectInfrastructureFeatures, projectPluginMenu } from '../src/architecture-infrastructure.mjs';
import { createCompilerObjectCatalog } from '../src/rustc-model.mjs';
import { createArchitectureSearch } from '../src/architecture-search.mjs';
import { renderArchitectureViewer } from '../src/architecture-viewer.mjs';
import { readArchitectureData, writeExternalArchitecture } from '../src/architecture-artifacts.mjs';
import { pathsForRepository, repositoryRoot } from '../src/paths.mjs';
import { testDocument } from './test-dom.mjs';

const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/compiler-plugin-menu.json', import.meta.url), 'utf8'));
const registryFor = () => Object.fromEntries(structuredClone(captured.objects).map(object => [object.id, object]));

test('captured compiler declarations select five infrastructure entries and six real Plugin objects', () => {
  const registry = registryFor(), before = structuredClone(registry), infrastructure = projectInfrastructureFeatures(registry, { requireComplete: true });
  assert.deepEqual(infrastructure.map(entry => entry.id), ['infrastructure', 'avian', 'enhanced_input', 'kira', 'egui']);
  assert.deepEqual(infrastructure.map(entry => registry[entry.overviewNode].typeIdentity.defPath), [
    'bevy_internal::default_plugins::DefaultPlugins', 'avian3d::PhysicsPlugins', 'bevy_enhanced_input::EnhancedInputPlugin',
    'bevy_kira_audio::AudioPlugin', 'bevy_egui::EguiPlugin',
  ]);
  const menu = projectPluginMenu(captured.features, registry, infrastructure);
  assert.equal(menu.project.length, 14); assert.equal(menu.infrastructure.length, 6);
  assert.deepEqual(menu.infrastructure.slice(-2).map(entry => registry[entry.overviewNode].typeIdentity.defPath), ['bevy_egui::EguiPlugin', 'bevy_inspector_egui::quick::WorldInspectorPlugin']);
  assert.ok(menu.project.every(entry => registry[entry.overviewNode].typeIdentity.crateName === 'demo'));
  assert.deepEqual(registry, before);
});

test('native selectors reject missing or ambiguous identities and never fall back to a display name', () => {
  const registry = registryFor(), kira = projectInfrastructureFeatures(registry).find(entry => entry.id === 'kira').overviewNode;
  const original = structuredClone(registry[kira]);
  registry[kira].typeIdentity.defPath = 'bevy_audio::AudioPlugin';
  assert.throws(() => projectInfrastructureFeatures(registry, { requireComplete: true }), /Missing.*bevy_kira_audio::AudioPlugin/);
  registry[kira] = original; registry['distinct-type-instance'] = { ...original, id: 'distinct-type-instance' };
  assert.throws(() => projectInfrastructureFeatures(registry), /Ambiguous.*bevy_kira_audio::AudioPlugin/);
  delete registry['distinct-type-instance'];
  registry[kira].name = '显示名称可以变化'; registry[kira].fullName = '其他显示名称'; registry[kira].typeIdentity.local = true;
  assert.equal(projectInfrastructureFeatures(registry).find(entry => entry.id === 'kira').overviewNode, kira);
  const dependencyFeature = { id: 'dependency-as-feature', label: '单元内声明', overviewNode: kira };
  assert.throws(() => projectPluginMenu([dependencyFeature], registry), /Invalid project Plugin feature/, 'unit-local does not mean project-owned');
});

test('captured model produces the same valid runtime targets and HTML options while unlisted plugins remain searchable', t => {
  const registry = registryFor(), model = { schemaVersion: 2, features: captured.features, objects: Object.values(registry), relations: [] };
  const catalog = createCompilerObjectCatalog(model, registry), infrastructureFeatures = projectInfrastructureFeatures(registry, { requireComplete: true });
  const data = { schemaVersion: 5, model, registry, infrastructureFeatures, objects: catalog.objects, objectAliases: {},
    guideSamples: { nodes: {}, edges: {}, schedule: { nodes: {}, edges: {} } },
    views: catalog.objects.map(object => ({ id: object.viewId, aspect: 'object', objectId: object.id, centerNodeId: object.id, nodes: [], links: [], svg: null })),
  };
  const parent = path.join(repositoryRoot, 'tmp/ecs-architecture/plugin-menu-tests'); fs.mkdirSync(parent, { recursive: true });
  const paths = pathsForRepository(fs.mkdtempSync(path.join(parent, 'case-'))); t.after(() => fs.rmSync(paths.repositoryRoot, { recursive: true, force: true }));
  const writeArtifact = (filename, content) => { const target = path.join(paths.generatedDirectory, filename); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
  const bootstrap = writeExternalArchitecture({ paths, data, writeArtifact });
  const html = renderArchitectureViewer({ ...data, features: model.features, externalBootstrap: bootstrap });
  writeArtifact('pages/ecs-architecture.html', html);
  const runtime = readArchitectureData(paths.repositoryRoot);
  assert.deepEqual(runtime.infrastructureFeatures, infrastructureFeatures);
  const document = testDocument(html), options = document.getElementById('view-select').querySelectorAll('option'), byView = new Map(data.views.map(view => [view.id, view]));
  assert.equal(options.length, 20);
  assert.ok(options.every(option => ['Plugin', 'PluginGroup'].includes(runtime.registry[byView.get(option.value)?.objectId]?.kind)));
  for (const entry of runtime.infrastructureFeatures) for (const id of entry.objectIds) {
    assert.ok(runtime.registry[id]); assert.ok(options.some(option => byView.get(option.value).objectId === id));
  }
  const unlisted = Object.values(registry).find(object => object.typeIdentity.defPath === 'bevy_audio::AudioPlugin');
  assert.ok(unlisted); assert.equal(options.some(option => byView.get(option.value).objectId === unlisted.id), false);
  assert.ok(createArchitectureSearch({ objects: catalog.objects, registry }).search(unlisted.name).includes(unlisted.id));
  assert.equal(document.querySelectorAll('optgroup').some(group => group.getAttribute('label') === '其他插件'), false);
  const runtimeFile = path.join(paths.dataDirectory, 'runtime.json'), manifestFile = path.join(paths.dataDirectory, 'manifest.json');
  const distributed = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')); distributed.infrastructureFeatures[0].overviewNode = 'missing-native-object';
  const text = JSON.stringify(distributed); fs.writeFileSync(runtimeFile, text);
  const digest = value => crypto.createHash('sha256').update(value).digest('hex'), manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.runtime.sha256 = digest(text); manifest.runtime.bytes = Buffer.byteLength(text); const manifestText = JSON.stringify(manifest); fs.writeFileSync(manifestFile, manifestText);
  const auditFile = path.join(paths.dataDirectory, 'audit-manifest.json'), audit = JSON.parse(fs.readFileSync(auditFile, 'utf8'));
  audit.manifest.sha256 = digest(manifestText); audit.manifest.bytes = Buffer.byteLength(manifestText); fs.writeFileSync(auditFile, JSON.stringify(audit));
  bootstrap.runtimeSha256 = manifest.runtime.sha256; bootstrap.manifestSha256 = digest(manifestText);
  writeArtifact('pages/ecs-architecture.html', '<script id="architecture-data">' + JSON.stringify(bootstrap) + '</script>');
  assert.throws(() => readArchitectureData(paths.repositoryRoot), /infrastructure menu projection mismatch/);
});

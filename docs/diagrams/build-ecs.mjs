// 导入真实调度图并生成对象图与离线源码；不加载或执行游戏。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArchitectureModel } from './architecture-model.mjs';
import { renderGraphView } from './architecture-renderer.mjs';
import { compileArchitectureArtifacts } from './mermaid-compiler.mjs';
import { renderArchitectureViewer } from './architecture-viewer.mjs';
import { buildComponentCatalog } from './architecture-components.mjs';
import { buildObjectCatalog } from './architecture-objects.mjs';
import { applyArchitectureSourcePolicies, applyArchitectureEdgeSourcePolicies, auditProductionEcsCoverage, sourcePolicyFor } from './architecture-source-policy.mjs';
import { DEBUGDUMP_MANIFEST, readDebugdump, compileDebugdump, obsoleteArchitectureArtifacts, sourceFingerprint } from './debugdump.mjs';
import { scheduleRuntimeAssets } from './schedule-runtime.mjs';
import { buildSchedulePluginGroups } from './schedule-plugins.mjs';
import { writeSourceViewer } from './source-viewer.mjs';
import { createSourceLocator } from './source-locator.mjs';
import { DEPENDENCY_SOURCE_DEFINITIONS } from './architecture-source-definitions.mjs';
import { readCargoMetadata, createDependencySourceResolver, attachDependencySources, dependencySourceKey } from './dependency-sources.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--debugdump' || !args[1])) throw new Error('Usage: node docs/diagrams/build-ecs.mjs [--debugdump <export-directory>]');
const dump = readDebugdump(args.length ? path.resolve(args[1]) : directory, root, args.length ? 'manifest.json' : DEBUGDUMP_MANIFEST);
const schedules = await compileDebugdump(dump);
const model = JSON.parse(fs.readFileSync(path.join(directory, 'ecs-data.json'), 'utf8'));
const pluginGroups = buildSchedulePluginGroups({ model, views: schedules.views });
schedules.views = pluginGroups.views;
const architecture = buildArchitectureModel(model);
const { registry, features } = architecture;
const locateSource = createSourceLocator(root);
for (const feature of features) {
  const declaration = locateSource(feature.source.path, new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?struct\\s+${feature.plugin}\\b`));
  if (declaration.line !== feature.source.line) throw new Error(`Plugin source entry is stale: ${feature.plugin}`);
}
registry['app-main'].source = locateSource('src/main.rs', /^\s*fn\s+main\b/);
const cargoMetadata = readCargoMetadata(root);
const dependencySources = createDependencySourceResolver(cargoMetadata);
attachDependencySources(registry, dependencySources, DEPENDENCY_SOURCE_DEFINITIONS);
const components = buildComponentCatalog(model, registry, { mergeSystems: false });
const sourceOptions = { model, repository: root, registry, dependencyContext: { metadata: cargoMetadata, resolver: dependencySources } };
const sourceAudit = applyArchitectureSourcePolicies(registry, sourceOptions);
const coverage = auditProductionEcsCoverage(registry, { ...sourceOptions, context: sourceAudit.context });
if (coverage.gaps.length) throw new Error(coverage.gaps.join('\n'));
for (const record of Object.values(registry)) {
  if (!['System', 'Observer'].includes(record.kind) && record.sourcePolicyKind !== 'system') continue;
  const declarations = (record.sourceEntries || []).filter(source => source.role === 'definition').flatMap(source => {
    const lines = source.dependency ? dependencySources.read(source).lines : fs.readFileSync(path.join(root, source.path), 'utf8').split(/\r?\n/);
    if (!/\bfn\s+\w+/.test(lines[source.line - 1] || '')) return [];
    const signature = lines.slice(source.line - 1, source.line + 149).join('\n').split('{')[0].trim();
    return signature ? [signature] : [];
  });
  record.filters = [...new Set([...declarations, ...(record.filters || [])])];
}
const objects = buildObjectCatalog(model, registry, { components });
for (const access of objects.unresolvedAccesses) {
  const record = registry[access.system], type = registry[access.component]?.name || access.component;
  const gap = `待核实：${type} 的 ${access.operation} 操作尚未确定实体投影，未据此建立具体投影关系。`;
  record.sourceGaps = [...new Set([...(record.sourceGaps || []), gap])];
}
let views = [];
for (const object of objects.objects) {
  const graph = objects.graphFor(object.id);
  views.push(renderGraphView({ id: object.viewId, feature: object.feature, aspect: 'object', label: `${registry[object.id].name} · 对象关系`, summary: ['Plugin', 'PluginGroup'].includes(object.kind)
    ? '插件单卡；完整说明、契约、归属及源码在右侧查看。'
    : object.kind === 'Entity'
    ? '中心实体与直接关联的非组件对象；组件清单在右侧查看，保留原关系方向及身份，不递归展开间接关系。'
    : '中心对象与所有直接关联对象；完整保留入边、出边及原投影和注册身份，不递归展开间接关系。',
    objectId: object.id, centerNodeId: object.id,
  }, graph, registry, features));
}
for (const view of views) {
  applyArchitectureEdgeSourcePolicies(view.links, { ...sourceOptions, context: sourceAudit.context });
}
for (const id of model.required_nodes ?? []) {
  if (!registry[id] || !views.some(view => view.nodes.some(node => node.id === architecture.resolveNode(id)) || view.projectionIds?.includes(architecture.resolveNode(id)))) throw new Error(`Required architecture node is missing from views: ${id}`);
}
const compiled = await compileArchitectureArtifacts(views, registry);
views = [...schedules.views, ...compiled.views];
const artifactViews = views;
// 编译期间源码发生变化时先中止，不删除或覆盖上一批正式图。
if (sourceFingerprint(root) !== dump.manifest.sourceFingerprint) throw new Error('Source changed while building architecture; export schedules again');
const stagedArtifacts = fs.mkdtempSync(path.join(root, 'tmp/ecs-architecture/artifact-write-'));
function writeArtifact(filename, content) {
  const target = path.join(directory, filename);
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content) return;
  // Windows 浏览器可能映射正在查看的 HTML，不能原地截断；写完整后替换也避免读到半份产物。
  const staged = path.join(stagedArtifacts, filename);
  fs.writeFileSync(staged, content);
  fs.renameSync(staged, target);
}
for (const view of artifactViews) if (view.svg) {
  writeArtifact(view.filename, view.svg);
  if (view.mermaidFilename) writeArtifact(view.mermaidFilename, view.mermaid);
  if (view.dotFilename) writeArtifact(view.dotFilename, view.dot);
}
writeArtifact(DEBUGDUMP_MANIFEST, JSON.stringify(schedules.manifest, null, 2) + '\n');

function sourceReferences(value, sources = new Map()) {
  if (!value || typeof value !== 'object') return sources;
  if (typeof value.path === 'string' && Number.isSafeInteger(value.line)) {
    sources.set(value.dependency ? dependencySourceKey(value) : value.path, value);
  }
  for (const child of Object.values(value)) sourceReferences(child, sources);
  return sources;
}
const sources = [...sourceReferences({ model, registry, views }).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, source]) => source.dependency
  ? { path: key, text: dependencySources.read(source).text, source: { ...source, line: 1 } }
  : { path: key, text: fs.readFileSync(path.resolve(root, key), 'utf8') });
writeSourceViewer({ outputDirectory: directory, sources });
const runtimeAssets = await scheduleRuntimeAssets();
writeArtifact('ecs-architecture.html', renderArchitectureViewer({ model, registry, views, features, runtimeAssets, schedulePluginCatalog: pluginGroups.catalog, guideSamples: compiled.guideSamples, objects: objects.objects, objectAliases: model.object_aliases || {},
  sourceRoleLabels: Object.fromEntries(sourcePolicyFor('edge').groups.map(group => [group.role, group.label])),
}));
for (const filename of obsoleteArchitectureArtifacts(directory, artifactViews)) fs.unlinkSync(path.join(directory, filename));
fs.rmdirSync(stagedArtifacts);
console.log(JSON.stringify({ features: features.length, views: views.length, objects: objects.objects.length, svgs: artifactViews.filter(view => view.svg).length, mermaid: artifactViews.filter(view => view.mermaid).length, systems: model.systems.length, sources: sources.length }));

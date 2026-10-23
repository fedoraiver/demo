// 从已核对清单生成插件视图与离线源码；不加载或执行游戏。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArchitectureModel } from './architecture-model.mjs';
import { INFRASTRUCTURE_FEATURES, architectureViewId } from './architecture-infrastructure.mjs';
import { renderGraphView, renderOverview } from './architecture-renderer.mjs';
import { compileArchitectureArtifacts } from './mermaid-compiler.mjs';
import { renderArchitectureViewer } from './architecture-viewer.mjs';
import { buildComponentCatalog } from './architecture-components.mjs';
import { applyArchitectureSourcePolicies, applyArchitectureEdgeSourcePolicies, sourcePolicyFor } from './architecture-source-policy.mjs';
import { writeSourceViewer } from './source-viewer.mjs';
import { createSourceLocator } from './source-locator.mjs';
import { DEPENDENCY_SOURCE_DEFINITIONS } from './architecture-source-definitions.mjs';
import { readCargoMetadata, createDependencySourceResolver, attachDependencySources, dependencySourceKey } from './dependency-sources.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const model = JSON.parse(fs.readFileSync(path.join(directory, 'ecs-data.json'), 'utf8'));
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
const components = buildComponentCatalog(model, registry);
const sourceOptions = { model, repository: root, registry, dependencyContext: { metadata: cargoMetadata, resolver: dependencySources } };
const sourceAudit = applyArchitectureSourcePolicies(registry, sourceOptions);
for (const record of Object.values(registry)) {
  if (!['system', 'observer', 'Engine system'].includes(record.kind) && record.sourcePolicyKind !== 'system') continue;
  const declarations = (record.sourceEntries || []).filter(source => source.role === 'definition').flatMap(source => {
    const lines = source.dependency ? dependencySources.read(source).lines : fs.readFileSync(path.join(root, source.path), 'utf8').split(/\r?\n/);
    if (!/\bfn\s+\w+/.test(lines[source.line - 1] || '')) return [];
    const signature = lines.slice(source.line - 1, source.line + 149).join('\n').split('{')[0].trim();
    return signature ? [signature] : [];
  });
  record.filters = [...new Set([...declarations, ...(record.filters || [])])];
}
const labels = { systems: '系统与调度', data: '数据与实体', events: '事件与协作' };
let views = [renderOverview(model, registry, features)];
for (const feature of [...features, ...INFRASTRUCTURE_FEATURES]) {
  for (const [aspect, label] of Object.entries(labels)) {
    const id = architectureViewId(feature.id, aspect);
    const graph = architecture.graphFor(feature.id, aspect);
    views.push(renderGraphView({ id, feature: feature.id, aspect, label: `${feature.label} · ${label}`, summary: `${feature.label}的${label}；外部契约保留摘要，可跳转到所属插件。` }, graph, registry, features, aspect === 'systems' ? architecture.scheduleGroups(graph) : []));
  }
}
for (const type of components.types) {
  const graph = components.graphFor(type.id);
  views.push(renderGraphView({ id: type.viewId, feature: type.feature, aspect: 'component', label: `${type.name} · 组件关系`, summary: '左侧为包含组件的实体，中间为组件类型，右侧每个系统函数只显示一次；连线表达访问与生命周期操作。',
    componentTypeId: type.id, componentNodeId: type.componentNodeId, projectionIds: type.projectionIds, ownerEntityIds: type.ownerEntityIds, componentDetails: type.details,
  }, graph, registry, features));
}
for (const view of views) applyArchitectureEdgeSourcePolicies(view.links, { ...sourceOptions, context: sourceAudit.context });
for (const id of model.required_nodes ?? []) {
  if (!registry[id] || !views.some(view => view.nodes.some(node => node.id === architecture.resolveNode(id)) || view.projectionIds?.includes(architecture.resolveNode(id)))) throw new Error(`Required architecture node is missing from views: ${id}`);
}
const compiled = await compileArchitectureArtifacts(views, registry);
views = compiled.views;
const artifactViews = views;
const outputs = new Set(artifactViews.flatMap(view => [view.filename, view.mermaidFilename]).filter(Boolean));
for (const filename of fs.readdirSync(directory)) {
  if ((/^ecs-(plugin-.+|infrastructure-.+|third-party-.+|component-.+)\.(svg|mmd)$/.test(filename) || ['ecs-schedules.svg', 'ecs-relationships.svg', 'ecs-events.svg'].includes(filename)) && !outputs.has(filename)) fs.unlinkSync(path.join(directory, filename));
}
function writeArtifact(filename, content) {
  const target = path.join(directory, filename);
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) fs.writeFileSync(target, content);
}
for (const view of artifactViews) if (view.svg) { writeArtifact(view.filename, view.svg); writeArtifact(view.mermaidFilename, view.mermaid); }

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
writeArtifact('ecs-architecture.html', renderArchitectureViewer({ model, registry, views, features, guideSamples: compiled.guideSamples, componentTypes: components.types,
  sourceRoleLabels: Object.fromEntries(sourcePolicyFor('edge').groups.map(group => [group.role, group.label])),
}));
console.log(JSON.stringify({ features: features.length, views: views.length, componentTypes: components.types.length, svgs: artifactViews.filter(view => view.svg).length, mermaid: artifactViews.filter(view => view.mermaid).length, systems: model.systems.length, sources: sources.length }));

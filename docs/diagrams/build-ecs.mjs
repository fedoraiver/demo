// 从已核对清单生成插件视图与离线源码；不加载或执行游戏。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArchitectureModel } from './architecture-model.mjs';
import { INFRASTRUCTURE_FEATURES, architectureViewId } from './architecture-infrastructure.mjs';
import { renderGraphView, renderOverview } from './architecture-renderer.mjs';
import { compileArchitectureArtifacts } from './mermaid-compiler.mjs';
import { renderArchitectureViewer } from './architecture-viewer.mjs';
import { buildArchitectureRuntimeAssets } from './architecture-runtime-assets.mjs';
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
const dependencySources = createDependencySourceResolver(readCargoMetadata(root));
attachDependencySources(registry, dependencySources, DEPENDENCY_SOURCE_DEFINITIONS);
const labels = { systems: '系统与调度', data: '数据与实体', events: '事件与协作' };
let views = [renderOverview(model, registry, features)];
for (const feature of [...features, ...INFRASTRUCTURE_FEATURES]) {
  for (const [aspect, label] of Object.entries(labels)) {
    const id = architectureViewId(feature.id, aspect);
    const graph = architecture.graphFor(feature.id, aspect);
    views.push(renderGraphView({ id, feature: feature.id, aspect, label: `${feature.label} · ${label}`, summary: `${feature.label}的${label}；外部契约保留摘要，可跳转到所属插件。` }, graph, registry, features, aspect === 'systems' ? architecture.scheduleGroups(graph) : []));
  }
}
for (const id of model.required_nodes ?? []) {
  if (!registry[id] || !views.some(view => view.nodes.some(node => node.id === architecture.resolveNode(id)))) throw new Error(`Required architecture node is missing from views: ${id}`);
}
const compiled = await compileArchitectureArtifacts(views, registry);
views = compiled.views;
const artifactViews = views.flatMap(view => [view, ...Object.values(view.entityViews || {})]);
const outputs = new Set(artifactViews.flatMap(view => [view.filename, view.mermaidFilename]).filter(Boolean));
for (const filename of fs.readdirSync(directory)) {
  if ((/^ecs-(plugin-.+|infrastructure-.+|third-party-.+)\.(svg|mmd)$/.test(filename) || ['ecs-schedules.svg', 'ecs-relationships.svg', 'ecs-events.svg'].includes(filename)) && !outputs.has(filename)) fs.unlinkSync(path.join(directory, filename));
}
function writeArtifact(filename, content) {
  const target = path.join(directory, filename);
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) fs.writeFileSync(target, content);
}
for (const view of artifactViews) if (view.svg) { writeArtifact(view.filename, view.svg); writeArtifact(view.mermaidFilename, view.mermaid); }

function sourceReferences(value, sources = new Set()) {
  if (!value || typeof value !== 'object') return sources;
  if (value.source?.path) sources.add(value.source.path);
  for (const [key, child] of Object.entries(value)) if (key !== 'source') sourceReferences(child, sources);
  return sources;
}
const sources = [...sourceReferences({ model, registry })].sort().map(sourcePath => ({ path: sourcePath, text: fs.readFileSync(path.resolve(root, sourcePath), 'utf8') }));
const dependencyFiles = new Map();
for (const node of Object.values(registry)) if (node.definition_source) {
  const source = node.definition_source, key = dependencySourceKey(source);
  if (!dependencyFiles.has(key)) dependencyFiles.set(key, { path: key, text: dependencySources.read(source).text, source: { ...source, line: 1 } });
}
sources.push(...[...dependencyFiles.values()].sort((a, b) => a.path.localeCompare(b.path)));
writeSourceViewer({ outputDirectory: directory, sources });
const runtimeScript = await buildArchitectureRuntimeAssets();
writeArtifact('ecs-architecture.html', renderArchitectureViewer({ model, registry, views, features, guideSamples: compiled.guideSamples, runtimeScript }));
console.log(JSON.stringify({ features: features.length, views: views.length, entityViews: artifactViews.length - views.length, svgs: artifactViews.filter(view => view.svg).length, mermaid: artifactViews.filter(view => view.mermaid).length, systems: model.systems.length, sources: sources.length }));

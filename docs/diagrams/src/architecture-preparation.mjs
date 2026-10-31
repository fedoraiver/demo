// 构建与预检共用真实调度、对象身份和源码准备；此模块不编译 SVG 或写正式产物。
import fs from 'node:fs';
import path from 'node:path';
import { buildArchitectureModel } from './architecture-model.mjs';
import { renderGraphView } from './architecture-renderer.mjs';
import { buildComponentCatalog } from './architecture-components.mjs';
import { buildObjectCatalog } from './architecture-objects.mjs';
import { applyArchitectureSourcePolicies, applyArchitectureEdgeSourcePolicies, auditProductionEcsCoverage } from './architecture-source-policy.mjs';
import { DEBUGDUMP_MANIFEST, readDebugdump } from './debugdump-input.mjs';
import { parseDebugdump } from './debugdump.mjs';
import { buildSchedulePluginGroups } from './schedule-plugins.mjs';
import { buildScheduleObjects } from './schedule-objects.mjs';
import { createSourceLocator } from './source-locator.mjs';
import { DEPENDENCY_SOURCE_DEFINITIONS } from '../catalog/architecture-source-definitions.mjs';
import { readCargoMetadata, createDependencySourceResolver, attachDependencySources } from './dependency-sources.mjs';
import { pathsForRepository } from './paths.mjs';
import { validatePreparedArchitecture } from './maintenance-model-checks.mjs';

export async function prepareArchitecture({ workspace, debugdumpDirectory } = {}) {
  const root = path.resolve(workspace), paths = pathsForRepository(root);
  const dump = readDebugdump(debugdumpDirectory ? path.resolve(root, debugdumpDirectory) : paths.dotDirectory, root, debugdumpDirectory ? 'manifest.json' : DEBUGDUMP_MANIFEST);
  const schedules = await parseDebugdump(dump);
  const baseModel = JSON.parse(fs.readFileSync(path.join(paths.catalogDirectory, 'ecs-data.json'), 'utf8'));
  const cargoMetadata = readCargoMetadata(root);
  const dependencySources = createDependencySourceResolver(cargoMetadata);
  const { model, scheduleInteractions } = buildScheduleObjects({ model: baseModel, views: schedules.views, repository: root, metadata: cargoMetadata, resolver: dependencySources });
  const pluginGroups = buildSchedulePluginGroups({ model: baseModel, views: schedules.views });
  schedules.views = pluginGroups.views;
  const architecture = buildArchitectureModel(model);
  const { registry, features } = architecture;
  const locateSource = createSourceLocator(root);
  for (const feature of features) {
    const declaration = locateSource(feature.source.path, new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?struct\\s+${feature.plugin}\\b`));
    if (declaration.line !== feature.source.line) throw new Error(`Plugin source entry is stale: ${feature.plugin}`);
  }
  registry['app-main'].source = locateSource('src/main.rs', /^\s*fn\s+main\b/);
  attachDependencySources(registry, dependencySources, DEPENDENCY_SOURCE_DEFINITIONS);
  const components = buildComponentCatalog(model, registry, { mergeSystems: false, readSource: filename => fs.readFileSync(path.join(root, filename), 'utf8') });
  const sourceOptions = { model, components, repository: root, registry, dependencyContext: { metadata: cargoMetadata, resolver: dependencySources } };
  const sourceAudit = applyArchitectureSourcePolicies(registry, sourceOptions);
  const coverage = auditProductionEcsCoverage(registry, { ...sourceOptions, context: sourceAudit.context });
  if (coverage.gaps.length) throw new Error(coverage.gaps.join('\n'));
  for (const record of Object.values(registry)) {
    if (record.scheduleEvidence?.schemaVersion === 1) continue;
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
  const prepared = { paths, dump, schedules, model, architecture, registry, features, components, objects, sourceOptions, sourceAudit, dependencySources, pluginGroups, scheduleInteractions, views };
  validatePreparedArchitecture(prepared);
  return prepared;
}

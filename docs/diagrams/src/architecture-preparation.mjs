// Rust 负责语义模型；此入口只读取证据并准备 Graphviz 与 Mermaid 的展示输入。
import path from 'node:path';
import { renderGraphView } from './architecture-renderer.mjs';
import { DEBUGDUMP_MANIFEST, readDebugdump } from './debugdump-input.mjs';
import { parseDebugdump } from './debugdump.mjs';
import { pathsForRepository } from './paths.mjs';
import { readCompilerModel, createCompilerObjectCatalog, compilerSourceResolver, bindCompilerSchedules } from './rustc-model.mjs';

export async function prepareArchitecture({ workspace, debugdumpDirectory } = {}) {
  const root = path.resolve(workspace), paths = pathsForRepository(root);
  const { model: analysis, filename: analysisFilename } = readCompilerModel(root);
  const selected = debugdumpDirectory || analysis.runtimeDirectory || 'tmp/ecs-architecture/compiler/debugdump';
  const directory = path.resolve(root, selected);
  const dump = readDebugdump(directory, root, directory === paths.dotDirectory ? DEBUGDUMP_MANIFEST : 'manifest.json');
  const schedules = await parseDebugdump(dump);
  const registry = Object.fromEntries(analysis.objects.map(object => [object.id, object]));
  const model = analysis, features = analysis.features;
  const scheduleInteractions = bindCompilerSchedules(analysis, schedules.views);
  const objects = createCompilerObjectCatalog(analysis, registry);
  const pluginGroups = { catalog: analysis.schedulePluginCatalog || [], views: schedules.views };
  for (const view of schedules.views) view.schedulePluginGroups = analysis.schedulePluginGroups?.[view.id] || [];
  const views = objects.objects.map(object => renderGraphView({ id: object.viewId, feature: object.feature, aspect: 'object',
    label: registry[object.id].name + ' · 对象关系', summary: ['Plugin', 'PluginGroup'].includes(object.kind)
      ? '插件单卡；完整关系保存在对象目录中。' : object.kind === 'Entity'
        ? '实体创建模板与直接关联的非组件对象。' : '当前对象及全部直接关联对象。',
    objectId: object.id, centerNodeId: object.id,
  }, objects.graphFor(object.id), registry, features));
  const components = { types: analysis.objects.filter(object => object.kind === 'Component'), typeByProjectionId: {}, accesses: [] };
  return { paths, dump, schedules, model, analysis, analysisFilename, registry, features, components, objects,
    dependencySources: compilerSourceResolver(analysis), pluginGroups, scheduleInteractions, views };
}

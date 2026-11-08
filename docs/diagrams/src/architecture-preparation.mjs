// Rust 负责语义模型；此入口只读取证据并准备 Graphviz 与 Mermaid 的展示输入。
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { renderGraphView } from './architecture-renderer.mjs';
import { DEBUGDUMP_MANIFEST, readDebugdump, sha256 } from './debugdump-input.mjs';
import { parseDebugdump } from './debugdump.mjs';
import { pathsForRepository } from './paths.mjs';
import { readCompilerModel, createCompilerObjectCatalog, compilerSourceResolver, bindCompilerSchedules } from './rustc-model.mjs';

// DOT 相同不证明注册快照来自同一构建；先绑定原始运行时字节，再核对其导出清单。
function checkRuntimeSnapshot(analysis, dump, directory) {
  const filename = path.join(directory, 'runtime.json');
  if (!fs.lstatSync(filename).isFile()) throw new Error('Missing or unsafe compiler runtime snapshot');
  const bytes = fs.readFileSync(filename);
  if (!/^[a-f0-9]{64}$/.test(analysis.inputs.runtimeSha256 || '') || sha256(bytes) !== analysis.inputs.runtimeSha256) throw new Error('Compiler/runtime snapshot hash mismatch');
  const runtime = JSON.parse(bytes);
  if (runtime.schemaVersion !== 1 || !Array.isArray(runtime.schedules)) throw new Error('Invalid compiler runtime snapshot');
  for (const key of ['sourceFingerprint', 'target', 'features']) assert.deepEqual(runtime[key], dump.manifest[key], 'Compiler/runtime export provenance mismatch: ' + key);
  assert.equal(runtime.sourceFingerprint, analysis.inputs.sourceFingerprint, 'Compiler/runtime source fingerprint mismatch');
  const schedules = new Map(runtime.schedules.map(schedule => [schedule.id, schedule]));
  if (schedules.size !== runtime.schedules.length || schedules.size !== dump.schedules.length) throw new Error('Compiler/runtime export Schedule count mismatch');
  for (const entry of dump.schedules) {
    const schedule = schedules.get(entry.id);
    if (!schedule || !Array.isArray(schedule.systems) || schedule.app !== entry.app || schedule.label !== entry.label
      || schedule.dotFilename !== entry.filename || schedule.dotSha256 !== entry.sha256 || schedule.systems.length !== entry.systemCount) throw new Error('Compiler/runtime export Schedule evidence mismatch: ' + entry.id);
  }
}

export async function prepareArchitecture({ workspace, debugdumpDirectory } = {}) {
  const root = path.resolve(workspace), paths = pathsForRepository(root);
  const { model: analysis, filename: analysisFilename } = readCompilerModel(root);
  const selected = debugdumpDirectory || analysis.runtimeDirectory || 'tmp/ecs-architecture/compiler/debugdump';
  const directory = path.resolve(root, selected);
  const dump = readDebugdump(directory, root, directory === paths.dotDirectory ? DEBUGDUMP_MANIFEST : 'manifest.json');
  checkRuntimeSnapshot(analysis, dump, directory);
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

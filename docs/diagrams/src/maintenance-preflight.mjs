// 预检只读取编译器已发布的模型和证据，不运行 Cargo、浏览器或写正式产物。
import path from 'node:path';
import fs from 'node:fs';
import { prepareArchitecture } from './architecture-preparation.mjs';
import { sha256, sourceFingerprint } from './debugdump-input.mjs';
import { summarizeModel } from './maintenance-summary.mjs';
import { summarizeAnalysisGaps } from './rustc-model.mjs';
import { createMermaidCache, mermaidDependencyIdentity, mermaidRenderIdentity } from './mermaid-cache.mjs';

export async function preflightArchitecture({ workspace, debugdumpDirectory } = {}) {
  const prepared = await prepareArchitecture({ workspace, debugdumpDirectory });
  const { model, registry, objects, dump, schedules } = prepared;
  const dependencyInputs = model.sourceFiles.filter(source => source.dependency).map(source => ({
    path: path.resolve(source.dependency.root, source.path), sha256: sha256(fs.readFileSync(path.resolve(source.dependency.root, source.path))),
  })).sort((a, b) => a.path.localeCompare(b.path));
  if (sourceFingerprint(workspace) !== dump.manifest.sourceFingerprint) throw new Error('Source changed during architecture preflight; extract again');
  const dependencies = mermaidDependencyIdentity(workspace);
  const identities = new Map(prepared.views.filter(view => view.mermaid).map(view => [view.id, mermaidRenderIdentity(view, registry, dependencies)]));
  return {
    counts: { features: model.features.length, systems: model.objects.filter(object => ['System', 'Observer'].includes(object.kind)).length,
      objects: objects.objects.length, componentTypes: model.objects.filter(object => object.kind === 'Component').length,
      relationships: objects.links.length, schedules: schedules.views.length, analysisGaps: model.analysisGaps?.length || 0 },
    analysisGapSummary: summarizeAnalysisGaps(model),
    renderCache: createMermaidCache(workspace).plan(prepared.views, identities),
    inputFingerprint: sha256(JSON.stringify({ inputs: model.inputs, dependencyInputs })),
    modelSummary: summarizeModel({ model, registry, objects: objects.objects, views: prepared.views }), dependencyInputs,
  };
}

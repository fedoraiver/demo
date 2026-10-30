// 与正式构建共用准备路径；只返回审阅摘要，不启动浏览器或写正式产物。
import fs from 'node:fs';
import path from 'node:path';
import { prepareArchitecture } from './architecture-preparation.mjs';
import { sha256, sourceFingerprint } from './debugdump-input.mjs';
import { summarizeModel } from './maintenance-summary.mjs';

export async function preflightArchitecture({ workspace, debugdumpDirectory } = {}) {
  const prepared = await prepareArchitecture({ workspace, debugdumpDirectory });
  const { model, registry, components, objects, dump, schedules } = prepared;
  const dependencyFiles = new Map();
  function references(value) {
    if (!value || typeof value !== 'object') return;
    if (value.dependency && typeof value.path === 'string' && Number.isSafeInteger(value.line)) {
      prepared.dependencySources.read(value);
      const filename = path.resolve(value.dependency.root, value.path);
      dependencyFiles.set(filename, { path: filename, sha256: sha256(fs.readFileSync(filename)) });
      return;
    }
    for (const child of Object.values(value)) references(child);
  }
  references({ model, registry, views: prepared.views });
  const dependencyInputs = [...dependencyFiles.values()].sort((a, b) => a.path.localeCompare(b.path));
  const catalogInputs = fs.readdirSync(prepared.paths.catalogDirectory).sort().map(filename => [filename, sha256(fs.readFileSync(path.join(prepared.paths.catalogDirectory, filename)))]);
  const fingerprint = sourceFingerprint(workspace);
  if (fingerprint !== dump.manifest.sourceFingerprint) throw new Error('Source changed during architecture preflight; export schedules again');
  return {
    counts: { features: model.features.length, systems: model.systems.length, objects: objects.objects.length, projections: Object.keys(components.typeByProjectionId).length, componentTypes: components.types.length, relationships: objects.links.length, schedules: schedules.views.length },
    inputFingerprint: sha256(JSON.stringify({ sourceFingerprint: fingerprint, catalogInputs, dependencyInputs, schedules: dump.schedules.map(entry => [entry.id, entry.sha256]) })),
    modelSummary: summarizeModel({ model, registry, objects: objects.objects, views: prepared.views }), dependencyInputs,
  };
}

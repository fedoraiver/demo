// 导入真实调度图并生成对象图与离线源码；不加载或执行游戏。
import fs from 'node:fs';
import path from 'node:path';
import { compileArchitectureArtifacts } from './mermaid-compiler.mjs';
import { renderArchitectureViewer } from './architecture-viewer.mjs';
import { sourcePolicyFor } from './architecture-source-policy.mjs';
import { DEBUGDUMP_MANIFEST, renderDebugdump, obsoleteArchitectureArtifacts, sourceFingerprint } from './debugdump.mjs';
import { scheduleRuntimeAssets } from './schedule-runtime.mjs';
import { dependencySourceKey } from './dependency-sources.mjs';
import { prepareArchitecture } from './architecture-preparation.mjs';
import { writeSourceViewer } from './source-viewer.mjs';
import { pathsForRepository, repositoryRoot, artifactRelativePath } from './paths.mjs';
import { writeExternalArchitecture, obsoleteExternalReferences } from './architecture-artifacts.mjs';
import { INFRASTRUCTURE_FEATURES } from './architecture-infrastructure.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, EXTERNAL_REFERENCE_STYLE } from './architecture-style.mjs';
import { SCHEDULE_LEGEND_LABELS } from './schedule-legend.mjs';

const root = repositoryRoot, paths = pathsForRepository(root), directory = paths.generatedDirectory;
const previousManifestPath = path.join(paths.dataDirectory, 'manifest.json');
const previousManifest = fs.existsSync(previousManifestPath) ? JSON.parse(fs.readFileSync(previousManifestPath, 'utf8')) : null;
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--debugdump' || !args[1])) throw new Error('Usage: node docs/diagrams/build-ecs.mjs [--debugdump <export-directory>]');
const { dump, schedules: parsedSchedules, model, registry, features, objects, dependencySources, pluginGroups, scheduleInteractions, views: objectViews } = await prepareArchitecture({ workspace: root, debugdumpDirectory: args[1] });
const schedules = await renderDebugdump(parsedSchedules);
let views = objectViews;
const compiled = await compileArchitectureArtifacts(views, registry);
views = [...schedules.views, ...compiled.views];
const artifactViews = views;
// 编译期间源码发生变化时先中止，不删除或覆盖上一批正式图。
if (sourceFingerprint(root) !== dump.manifest.sourceFingerprint) throw new Error('Source changed while building architecture; export schedules again');
const stagedArtifacts = fs.mkdtempSync(path.join(root, 'tmp/ecs-architecture/artifact-write-'));
function writeArtifact(filename, content) {
  const target = path.resolve(directory, filename);
  if (!target.startsWith(directory + path.sep)) throw new Error('Unsafe architecture output path');
  if (Buffer.byteLength(content) >= 100 * 1024 * 1024) throw new Error('Architecture artifact exceeds 100 MiB: ' + filename);
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content) return;
  // Windows 浏览器可能映射正在查看的 HTML，不能原地截断；写完整后替换也避免读到半份产物。
  const staged = path.join(stagedArtifacts, filename);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(staged, content);
  fs.renameSync(staged, target);
}
for (const view of artifactViews) if (view.svg) {
  writeArtifact(artifactRelativePath(view), view.svg);
  if (view.mermaidFilename) writeArtifact(artifactRelativePath(view, 'mermaid'), view.mermaid);
  if (view.dotFilename) writeArtifact(artifactRelativePath(view, 'dot'), view.dot);
}
writeArtifact('dot/' + DEBUGDUMP_MANIFEST, JSON.stringify(schedules.manifest, null, 2) + '\n');

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
writeSourceViewer({ outputDirectory: paths.pagesDirectory, sources });
const runtimeAssets = await scheduleRuntimeAssets();
const data = { schemaVersion: 5, model, registry, views, guideSamples: compiled.guideSamples, scheduleLegendLabels: SCHEDULE_LEGEND_LABELS,
  objects: objects.objects, objectAliases: model.object_aliases || {}, sourceRoleLabels: Object.fromEntries(sourcePolicyFor('edge').groups.map(group => [group.role, group.label])),
  schedulePluginCatalog: pluginGroups.catalog, scheduleInteractions, infrastructureFeatures: INFRASTRUCTURE_FEATURES,
  styles: { nodes: NODE_STYLES, edges: EDGE_STYLES, selection: SELECTION_STYLE, externalReference: EXTERNAL_REFERENCE_STYLE } };
const externalBootstrap = writeExternalArchitecture({ paths, data, writeArtifact });
writeArtifact('pages/ecs-architecture.html', renderArchitectureViewer({ ...data, features, runtimeAssets, externalBootstrap }));
for (const filename of obsoleteArchitectureArtifacts(paths, artifactViews)) fs.unlinkSync(path.join(directory, filename));
const currentManifest = JSON.parse(fs.readFileSync(previousManifestPath, 'utf8'));
for (const filename of obsoleteExternalReferences(previousManifest, currentManifest)) {
  const target = path.resolve(directory, filename);
  if (!target.startsWith(directory + path.sep)) throw new Error('Unsafe obsolete architecture resource');
  if (fs.existsSync(target)) fs.unlinkSync(target);
}
if (!stagedArtifacts.startsWith(paths.temporaryDirectory + path.sep)) throw new Error('Unsafe architecture staging directory');
fs.rmSync(stagedArtifacts, { recursive: true });
console.log(JSON.stringify({ features: features.length, views: views.length, objects: objects.objects.length, svgs: artifactViews.filter(view => view.svg).length, mermaid: artifactViews.filter(view => view.mermaid).length, systems: model.systems.length, sources: sources.length }));

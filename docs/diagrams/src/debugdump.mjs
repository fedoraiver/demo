// 只导入真实 App 导出的调度事实；Graphviz 负责布局，对象关系继续由 Mermaid 生成。
import fs from 'node:fs';
import path from 'node:path';
import { instance, graphvizVersion } from '@viz-js/viz';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { parseScheduleGraph, scheduleGraphInput, scheduleGraphFacts, SCHEDULE_MODEL_VERSION } from './schedule-graph.mjs';
import { SCHEDULE_THEME, SCHEDULE_THEME_VERSION } from './schedule-theme.mjs';
import { normalizeScheduleSvg as normalizeSvg } from './schedule-svg.mjs';
import { scheduleLegendKinds } from './schedule-legend.mjs';
import { artifactFile, artifactRelativePath, pathsForRepository } from './paths.mjs';

export { DEBUGDUMP_MANIFEST, sha256, scheduleId, sourceFingerprint, readDebugdump } from './debugdump-input.mjs';
import { DEBUGDUMP_MANIFEST, sha256, sourceFingerprint, readDebugdump } from './debugdump-input.mjs';
const rendererVersion = '3.31.0';
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };

/** 校验 SVG 并归一化根尺寸与身份，不修改 Graphviz 的节点、路径和箭头。 */
export function normalizeScheduleSvg(text, id) {
  return normalizeSvg(text, id, { DOMParser, XMLSerializer });
}

/** 只解析和往返核对 DOT，不编译 SVG。 */
export async function parseDebugdump({ manifest, schedules }) {
  const viz = await instance();
  const exportInfo = Object.fromEntries(['bevyVersion', 'debugdumpVersion', 'exportedAt', 'target', 'sourceFingerprint'].map(key => [key, manifest[key]]));
  const views = schedules.map(entry => {
    const id = `schedule-${entry.id}`;
    const scheduleGraph = parseScheduleGraph(viz, entry.dot);
    const roundtrip = parseScheduleGraph(viz, scheduleGraphInput(scheduleGraph));
    requireCondition(scheduleGraphFacts(scheduleGraph) === scheduleGraphFacts(roundtrip), `Schedule Graphviz model roundtrip mismatch: ${id}`);
    const scheduleGraphSha256 = sha256(JSON.stringify(scheduleGraph));
    return { id, engine: 'graphviz', aspect: 'schedule', feature: null, application: entry.app, scheduleLabel: entry.label,
      label: `${entry.app} · ${entry.label}`, filename: `ecs-${id}.svg`, dotFilename: `ecs-${id}.dot`, dot: entry.dot,
      scheduleGraph, scheduleGraphSha256, scheduleThemeSha256: sha256(JSON.stringify(SCHEDULE_THEME)), legendKinds: scheduleLegendKinds(scheduleGraph),
      exportInfo, systemCount: entry.systemCount, nodes: [], links: [], scheduleLinks: [], sections: [] };
  });
  return { views, manifest, schedules };
}

/** 语义预检通过后才运行 SVG 布局；保持原调度视图字段顺序与哈希。 */
export async function renderDebugdump({ manifest, schedules, views: inputViews }) {
  const viz = await instance();
  const views = inputViews.map(view => {
    const geometry = normalizeScheduleSvg(viz.renderString(scheduleGraphInput(view.scheduleGraph, SCHEDULE_THEME), { engine: 'dot', format: 'svg' }), view.id);
    const result = {};
    for (const [key, value] of Object.entries(view)) {
      if (key === 'exportInfo') Object.assign(result, geometry);
      result[key] = value;
    }
    return result;
  });
  const outputManifest = { ...manifest, renderer: { packageVersion: rendererVersion, graphvizVersion, modelVersion: SCHEDULE_MODEL_VERSION,
    themeVersion: SCHEDULE_THEME_VERSION, themeSha256: sha256(JSON.stringify(SCHEDULE_THEME)) },
    schedules: schedules.map((entry, index) => { const { dot, ...data } = entry; return { ...data, filename: views[index].dotFilename,
      modelSha256: views[index].scheduleGraphSha256, svgSha256: sha256(views[index].svg) }; }) };
  return { views, manifest: outputManifest };
}

/** 兼容独立调用；构建入口在共享 preparation 后单独渲染。 */
export async function compileDebugdump(dump) {
  return renderDebugdump(await parseDebugdump(dump));
}

/** 核对正式清单与内嵌 SVG；不把 Graphviz 节点 ID 当作 ECS 对象身份。 */
export function checkDebugdumpViews(directory, root, views) {
  const paths = pathsForRepository(root), classified = path.resolve(directory) === paths.dotDirectory;
  const data = readDebugdump(directory, root, DEBUGDUMP_MANIFEST);
  requireCondition(data.manifest.renderer?.packageVersion === rendererVersion && data.manifest.renderer?.graphvizVersion === graphvizVersion, 'Debugdump Graphviz renderer version is stale');
  requireCondition(data.manifest.renderer.modelVersion === SCHEDULE_MODEL_VERSION && data.manifest.renderer.themeVersion === SCHEDULE_THEME_VERSION
    && data.manifest.renderer.themeSha256 === sha256(JSON.stringify(SCHEDULE_THEME)), 'Debugdump Schedule theme or model version is stale');
  const expected = new Map(data.schedules.map(entry => [`schedule-${entry.id}`, entry]));
  requireCondition(views.length === expected.size, 'Debugdump Schedule view count mismatch');
  const seen = new Set();
  for (const view of views) {
    const entry = expected.get(view.id);
    requireCondition(entry && !seen.has(view.id), `Invalid or duplicate Schedule view: ${view.id}`);
    seen.add(view.id);
    requireCondition(view.engine === 'graphviz' && view.aspect === 'schedule' && view.feature === null && view.application === entry.app
      && view.scheduleLabel === entry.label && view.systemCount === entry.systemCount && view.dotFilename === entry.filename && view.dot === entry.dot, `Schedule view metadata mismatch: ${view.id}`);
    const info = Object.fromEntries(['bevyVersion', 'debugdumpVersion', 'exportedAt', 'target', 'sourceFingerprint'].map(key => [key, data.manifest[key]]));
    requireCondition(JSON.stringify(view.exportInfo) === JSON.stringify(info), `Schedule provenance mismatch: ${view.id}`);
    requireCondition(view.filename === `ecs-${view.id}.svg` && sha256(view.svg) === entry.svgSha256, `Schedule SVG hash mismatch: ${view.id}`);
    requireCondition(view.scheduleGraphSha256 === entry.modelSha256 && sha256(JSON.stringify(view.scheduleGraph)) === entry.modelSha256
      && view.scheduleThemeSha256 === data.manifest.renderer.themeSha256, `Schedule graph model hash mismatch: ${view.id}`);
    scheduleGraphFacts(view.scheduleGraph);
    requireCondition(JSON.stringify(view.legendKinds) === JSON.stringify(scheduleLegendKinds(view.scheduleGraph)), `Schedule legend categories mismatch: ${view.id}`);
    const normalized = normalizeScheduleSvg(view.svg, view.id);
    requireCondition(view.width === normalized.width && view.height === normalized.height && normalized.svg === view.svg, `Schedule SVG dimensions mismatch: ${view.id}`);
    requireCondition(fs.readFileSync(classified ? artifactFile(paths, view) : path.join(directory, view.filename), 'utf8') === view.svg, `Schedule SVG file mismatch: ${view.id}`);
    requireCondition(['nodes', 'links', 'scheduleLinks', 'sections'].every(key => Array.isArray(view[key]) && view[key].length === 0), `Schedule SVG has object interaction metadata: ${view.id}`);
    requireCondition(!view.mermaid && !view.mermaidFilename, `Schedule SVG must not have Mermaid source: ${view.id}`);
  }
  return data.manifest;
}

/** 正式图仅保留本次清单列出的 Schedule 和 object 文件。 */
export function obsoleteArchitectureArtifacts(directory, views) {
  if (typeof directory !== 'string') {
    const paths = directory, outputs = new Set(views.flatMap(view => ['svg', 'mermaid', 'dot'].filter(kind => kind === 'svg' ? view.filename : kind === 'mermaid' ? view.mermaidFilename : view.dotFilename).map(kind => artifactRelativePath(view, kind))));
    const managed = [[paths.objectSvgDirectory, /^ecs-.*\.svg$/], [paths.scheduleSvgDirectory, /^ecs-.*\.svg$/], [paths.mermaidDirectory, /^ecs-.*\.mmd$/], [paths.dotDirectory, /^ecs-.*\.dot$/]];
    return managed.flatMap(([parent, pattern]) => fs.existsSync(parent) ? fs.readdirSync(parent, { withFileTypes: true }).filter(entry => entry.isFile() && pattern.test(entry.name)).map(entry => path.relative(paths.generatedDirectory, path.join(parent, entry.name)).replaceAll('\\', '/')).filter(filename => !outputs.has(filename)) : []);
  }
  const outputs = new Set(views.flatMap(view => [view.filename, view.mermaidFilename, view.dotFilename]).filter(Boolean));
  return fs.readdirSync(directory).filter(filename => /^ecs-.*\.(svg|mmd|dot)$/.test(filename) && !outputs.has(filename));
}

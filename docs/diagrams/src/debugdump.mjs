// 只导入真实 App 导出的调度事实；Graphviz 负责布局，对象关系继续由 Mermaid 生成。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { instance, graphvizVersion } from '@viz-js/viz';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { parseScheduleGraph, scheduleGraphInput, scheduleGraphFacts, SCHEDULE_MODEL_VERSION } from './schedule-graph.mjs';
import { SCHEDULE_THEME, SCHEDULE_THEME_VERSION } from './schedule-theme.mjs';
import { normalizeScheduleSvg as normalizeSvg } from './schedule-svg.mjs';
import { scheduleLegendKinds } from './schedule-legend.mjs';
import { artifactFile, artifactRelativePath, pathsForRepository } from './paths.mjs';

export const DEBUGDUMP_MANIFEST = 'debugdump-manifest.json';
const rendererVersion = '3.31.0';
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const scheduleId = (app, label) => sha256(`${app}\0${label}`).slice(0, 16);
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };

/** 与 Rust 导出器共用换行归一化和按仓库相对路径排序的指纹协议。 */
export function sourceFingerprint(root) {
  const filenames = ['Cargo.toml', 'Cargo.lock'];
  if (fs.existsSync(path.join(root, 'build.rs'))) filenames.push('build.rs');
  function walk(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const filename = `${directory}/${entry.name}`;
      requireCondition(!entry.isSymbolicLink(), `Source fingerprint does not support symlinks: ${filename}`);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile() && filename.endsWith('.rs')) filenames.push(filename);
    }
  }
  walk('src');
  const hash = crypto.createHash('sha256');
  for (const filename of filenames.sort()) hash.update(filename + '\0' + fs.readFileSync(path.join(root, filename), 'utf8').replace(/\r\n/g, '\n') + '\0');
  return hash.digest('hex');
}

function lockedVersion(root, name) {
  const packages = fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8').split('[[package]]');
  return packages.find(item => new RegExp(`^name = "${name}"$`, 'm').test(item))?.match(/^version = "([^"]+)"/m)?.[1];
}

/** 在任何正式产物写入之前核实来源与所有 DOT；失败不复用旧图。 */
export function readDebugdump(directory, root, filename = 'manifest.json') {
  const manifestPath = path.join(directory, filename);
  requireCondition(fs.existsSync(manifestPath), `Missing debugdump manifest: ${manifestPath}. Run cargo run --locked --features debugdump -- --dump-schedules tmp/debugdump, then build with --debugdump tmp/debugdump`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  requireCondition(manifest.schemaVersion === 1, 'Unsupported debugdump manifest schema');
  for (const [field, crate] of [['bevyVersion', 'bevy'], ['debugdumpVersion', 'bevy_mod_debugdump']]) {
    requireCondition(manifest[field] === lockedVersion(root, crate), `Debugdump dependency version mismatch: ${crate}`);
  }
  requireCondition(manifest.sourceFingerprint === sourceFingerprint(root), 'Debugdump source fingerprint is stale; run the export command again');
  requireCondition(Number.isSafeInteger(manifest.exportedAt) && manifest.exportedAt >= 0 && typeof manifest.target === 'string' && manifest.target.length > 0, 'Invalid debugdump provenance');
  requireCondition(Array.isArray(manifest.features) && manifest.features.includes('debugdump'), 'Debugdump feature provenance is missing');
  requireCondition(Array.isArray(manifest.schedules) && manifest.schedules.length > 0, 'Debugdump contains no schedules');
  const ids = new Set();
  const schedules = manifest.schedules.map(entry => {
    requireCondition(typeof entry.app === 'string' && entry.app.length > 0 && typeof entry.label === 'string' && entry.label.length > 0, 'Invalid debugdump Schedule identity');
    const id = scheduleId(entry.app, entry.label);
    requireCondition(entry.id === id && !ids.has(id), `Invalid or duplicate debugdump Schedule: ${entry.id}`);
    ids.add(id);
    requireCondition([`schedule-${id}.dot`, `ecs-schedule-${id}.dot`].includes(entry.filename), `Unsafe debugdump DOT filename: ${entry.filename}`);
    requireCondition(Number.isSafeInteger(entry.systemCount) && entry.systemCount >= 0, `Invalid debugdump system count: ${id}`);
    const file = path.join(directory, entry.filename);
    requireCondition(fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink() && fs.statSync(file).isFile(), `Missing debugdump DOT: ${entry.filename}`);
    const dot = fs.readFileSync(file, 'utf8');
    requireCondition(sha256(dot) === entry.sha256, `Debugdump DOT hash mismatch: ${entry.filename}`);
    return { ...entry, dot };
  });
  schedules.sort((a, b) => (a.app === 'main' ? '' : a.app).localeCompare(b.app === 'main' ? '' : b.app) || a.label.localeCompare(b.label));
  return { manifest, schedules };
}

/** 校验 SVG 并归一化根尺寸与身份，不修改 Graphviz 的节点、路径和箭头。 */
export function normalizeScheduleSvg(text, id) {
  return normalizeSvg(text, id, { DOMParser, XMLSerializer });
}

/** 构建默认调度 SVG，与浏览器筛选共用结构模型和主题。 */
export async function compileDebugdump({ manifest, schedules }) {
  const viz = await instance();
  const exportInfo = Object.fromEntries(['bevyVersion', 'debugdumpVersion', 'exportedAt', 'target', 'sourceFingerprint'].map(key => [key, manifest[key]]));
  const views = schedules.map(entry => {
    const id = `schedule-${entry.id}`;
    const scheduleGraph = parseScheduleGraph(viz, entry.dot);
    const roundtrip = parseScheduleGraph(viz, scheduleGraphInput(scheduleGraph));
    requireCondition(scheduleGraphFacts(scheduleGraph) === scheduleGraphFacts(roundtrip), `Schedule Graphviz model roundtrip mismatch: ${id}`);
    const scheduleGraphSha256 = sha256(JSON.stringify(scheduleGraph));
    const geometry = normalizeScheduleSvg(viz.renderString(scheduleGraphInput(scheduleGraph, SCHEDULE_THEME), { engine: 'dot', format: 'svg' }), id);
    return { id, engine: 'graphviz', aspect: 'schedule', feature: null, application: entry.app, scheduleLabel: entry.label,
      label: `${entry.app} · ${entry.label}`, filename: `ecs-${id}.svg`, dotFilename: `ecs-${id}.dot`, dot: entry.dot,
      scheduleGraph, scheduleGraphSha256, scheduleThemeSha256: sha256(JSON.stringify(SCHEDULE_THEME)), legendKinds: scheduleLegendKinds(scheduleGraph),
      ...geometry, exportInfo, systemCount: entry.systemCount, nodes: [], links: [], scheduleLinks: [], sections: [] };
  });
  const outputManifest = { ...manifest, renderer: { packageVersion: rendererVersion, graphvizVersion, modelVersion: SCHEDULE_MODEL_VERSION,
    themeVersion: SCHEDULE_THEME_VERSION, themeSha256: sha256(JSON.stringify(SCHEDULE_THEME)) },
    schedules: schedules.map((entry, index) => { const { dot, ...data } = entry; return { ...data, filename: views[index].dotFilename,
      modelSha256: views[index].scheduleGraphSha256, svgSha256: sha256(views[index].svg) }; }) };
  return { views, manifest: outputManifest };
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

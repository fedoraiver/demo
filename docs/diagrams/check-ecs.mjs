// 只读核对已维护的架构清单与交付产物；不分析 Rust 调度语义，也不运行游戏。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { checkSvgGeometry } from './diagram-geometry.mjs';

const viewIds = ['overview', 'schedules', 'relationships', 'events'];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function embeddedJson(html, id) {
  // 只读取生成器约定的 JSON 容器，不执行 HTML 内的脚本。
  const match = html.match(new RegExp(`<script\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/script>`));
  requireCondition(match, `Missing embedded JSON: ${id}`);
  return JSON.parse(match[1]);
}

function attributeValues(svg, name) {
  return [...svg.matchAll(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'g'))].map(match =>
    match[2].replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, entity) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[entity]));
}

/** 核对清单、图、源码入口和快照；成功返回数量摘要，失败抛出英文错误。 */
export function checkArchitecture(root) {
  requireCondition(typeof root === 'string' && path.isAbsolute(root), 'Repository root must be an absolute path');
  const repository = fs.realpathSync(root);
  const directory = path.join(repository, 'docs', 'diagrams');
  const requiredFiles = ['ecs-data.json', 'ecs-architecture.html', 'ecs-source.html', ...viewIds.map(id => `ecs-${id}.svg`)];
  for (const file of requiredFiles) {
    requireCondition(fs.existsSync(path.join(directory, file)), `Missing architecture artifact: ${file}`);
  }
  const model = JSON.parse(fs.readFileSync(path.join(directory, 'ecs-data.json'), 'utf8'));
  const artifact = embeddedJson(fs.readFileSync(path.join(directory, 'ecs-architecture.html'), 'utf8'), 'architecture-data');
  requireCondition(isDeepStrictEqual(model, artifact.model), 'Embedded architecture model does not match ecs-data.json');
  requireCondition(Array.isArray(model.systems) && Array.isArray(model.observers), 'Invalid architecture system or observer list');
  requireCondition(artifact.registry && typeof artifact.registry === 'object' && !Array.isArray(artifact.registry), 'Invalid architecture registry');
  requireCondition(Array.isArray(artifact.views) && artifact.views.length === viewIds.length, 'Expected four architecture views');
  const registry = artifact.registry;
  const visibleIds = new Set();
  const seenViews = new Set();
  for (const view of artifact.views) {
    requireCondition(viewIds.includes(view.id) && !seenViews.has(view.id), `Invalid or duplicate architecture view: ${view.id}`);
    seenViews.add(view.id);
    requireCondition(typeof view.svg === 'string', `Missing SVG in architecture view: ${view.id}`);
    requireCondition(fs.readFileSync(path.join(directory, `ecs-${view.id}.svg`), 'utf8') === view.svg, `SVG artifact mismatch: ${view.id}`);
    try { checkSvgGeometry(view.svg); } catch (error) { throw new Error(`Invalid SVG geometry in ${view.id}: ${error.message}`); }
    for (const id of attributeValues(view.svg, 'data-id')) {
      requireCondition(Object.hasOwn(registry, id), `Unknown node reference in ${view.id}: ${id}`);
      visibleIds.add(id);
    }
    for (const connection of attributeValues(view.svg, 'data-connect')) {
      // 未声明数据端点的概览顺序箭头使用空值；非空端点没有特殊豁免。
      if (!connection) continue;
      for (const id of connection.split('|')) {
        requireCondition(Object.hasOwn(registry, id), `Unknown connection reference in ${view.id}: ${id}`);
      }
    }
  }
  const systems = new Map();
  for (const system of model.systems) {
    requireCondition(typeof system.id === 'string' && system.id && !systems.has(system.id), `Invalid or duplicate system ID: ${system.id}`);
    systems.set(system.id, system);
    requireCondition(visibleIds.has(system.id), `System is missing from views: ${system.id}`);
  }
  for (const observer of model.observers) {
    const system = systems.get(observer.system);
    requireCondition(system?.kind === 'observer' && registry[observer.system]?.kind === 'observer', `Invalid observer system: ${observer.system}`);
    // 清单现有 events 使用“响应 EntityEvent：”前缀；移除该前缀后精确匹配。
    const matchesEvent = item => typeof observer.event === 'string' && Array.isArray(item.events)
      && item.events.some(event => typeof event === 'string' && event.replace(/^响应 EntityEvent[：:]\s*/, '') === observer.event);
    requireCondition(matchesEvent(system) && matchesEvent(registry[observer.system]), `Observer event mismatch: ${observer.system}`);
  }

  const files = new Map();
  function readSource(sourcePath) {
    requireCondition(typeof sourcePath === 'string' && sourcePath && !sourcePath.includes('\0')
      && !path.isAbsolute(sourcePath) && !path.win32.isAbsolute(sourcePath), `Unsafe source path: ${sourcePath}`);
    const absolute = path.resolve(repository, sourcePath);
    const isInside = candidate => {
      const relative = path.relative(repository, candidate);
      return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    requireCondition(isInside(absolute), `Unsafe source path: ${sourcePath}`);
    if (files.has(sourcePath)) return files.get(sourcePath);
    requireCondition(fs.existsSync(absolute), `Missing source file: ${sourcePath}`);
    requireCondition(isInside(fs.realpathSync(absolute)) && fs.statSync(absolute).isFile(), `Unsafe source file: ${sourcePath}`);
    const text = fs.readFileSync(absolute, 'utf8');
    const source = { text, lines: text.replace(/\r\n?/g, '\n').split('\n') };
    files.set(sourcePath, source);
    return source;
  }
  const referencedPaths = new Set();
  function visitSources(value) {
    if (!value || typeof value !== 'object') return;
    if (value.source != null) {
      const source = value.source;
      const file = readSource(source.path);
      referencedPaths.add(source.path);
      requireCondition(Number.isSafeInteger(source.line) && source.line >= 1 && source.line <= file.lines.length,
        `Invalid source line: ${source.path}:${source.line}`);
      if (value.kind === 'system' || value.kind === 'observer') {
        // 只核对源码入口行的函数名，不能据此推断函数行为或注册完整性。
        const declaration = file.lines[source.line - 1].match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|const|unsafe)\s+)*fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|<)/);
        requireCondition(declaration?.[1] === value.name, `Function source mismatch: ${value.name} at ${source.path}:${source.line}`);
      }
    } else if (value.kind === 'system' || value.kind === 'observer') {
      throw new Error(`Missing function source: ${value.name}`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'source') visitSources(child);
    }
  }
  visitSources(model);
  visitSources(registry);

  const snapshots = embeddedJson(fs.readFileSync(path.join(directory, 'ecs-source.html'), 'utf8'), 'sources');
  requireCondition(Array.isArray(snapshots), 'Invalid source snapshot list');
  const snapshotPaths = new Set();
  for (const snapshot of snapshots) {
    requireCondition(!snapshotPaths.has(snapshot.path), `Duplicate source snapshot: ${snapshot.path}`);
    snapshotPaths.add(snapshot.path);
    // Git 提交快照与 Windows 工作区可能分别使用 LF、CRLF；仅统一换行，不忽略其他内容差异。
    requireCondition(typeof snapshot.text === 'string'
      && snapshot.text.replace(/\r\n/g, '\n') === readSource(snapshot.path).text.replace(/\r\n/g, '\n'),
      `Source snapshot mismatch: ${snapshot.path}`);
  }
  for (const sourcePath of referencedPaths) {
    requireCondition(snapshotPaths.has(sourcePath), `Missing source snapshot: ${sourcePath}`);
  }
  return { systems: systems.size, sources: snapshotPaths.size, views: seenViews.size };
}

const filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  try {
    console.log(JSON.stringify(checkArchitecture(path.resolve(path.dirname(filename), '../..'))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

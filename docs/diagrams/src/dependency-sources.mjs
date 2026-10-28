// 依赖声明由审阅清单指定；Cargo 提供本机锁定版本的目录，不把个人目录写入维护清单。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { infrastructureFeature } from './architecture-infrastructure.mjs';
import { nodeKindOf } from './architecture-kinds.mjs';
import { DEPENDENCY_SOURCE_DEFINITIONS } from '../catalog/architecture-source-definitions.mjs';

export function readCargoMetadata(repository) {
  return JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--offline', '--format-version', '1'], {
    cwd: repository, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  }));
}

function relativeSourcePath(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f\\:<>"|?*]/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe dependency source path: ${value}`);
  return value;
}

export function dependencySourceKey(source) {
  const dependency = source?.dependency;
  if (!dependency || typeof dependency.name !== 'string' || typeof dependency.version !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(dependency.name)
    || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(dependency.version)) throw new Error('Invalid dependency source identity');
  return `cargo/${dependency.name}-${dependency.version}/${relativeSourcePath(source.path)}`;
}

export function dependencyDefinitionTargets(registry, definitions = DEPENDENCY_SOURCE_DEFINITIONS) {
  const declared = new Set(['Component', 'Plugin', 'PluginGroup', 'System', 'Observer', 'Synchronization', 'SystemSet', 'Observer group']);
  return Object.values(registry).filter(node => {
    // 此类声明由调度源码目录按完整身份解析，产物校验会重算目录并逐字段核对。
    if (node.scheduleEvidence?.schemaVersion === 1) return false;
    if (!infrastructureFeature(node.defined_in || node.feature)) return false;
    const kind = nodeKindOf(node);
    // 聚合只定位已审阅的真实流程入口，不能假造与卡片同名的类型或函数。
    return declared.has(kind) || (kind === 'Engine flow' && Object.hasOwn(definitions, node.id));
  }).map(node => node.id);
}

export function createDependencySourceResolver(metadata) {
  if (!Array.isArray(metadata?.packages)) throw new Error('Invalid Cargo package metadata');
  const files = new Map();
  function packageFor(name, version) {
    const matches = metadata.packages.filter(item => item.name === name && (!version || item.version === version));
    if (matches.length !== 1 || !matches[0].source?.startsWith('registry+')) throw new Error(`Expected one locked registry package: ${name}${version ? '@' + version : ''}`);
    const record = matches[0];
    const root = fs.realpathSync(path.dirname(record.manifest_path));
    return { record, root };
  }
  function read(source) {
    dependencySourceKey(source);
    const { record, root } = packageFor(source.dependency.name, source.dependency.version);
    if (source.dependency.root !== root.replaceAll('\\', '/')) throw new Error(`Dependency source root mismatch: ${record.name}`);
    const absolute = path.resolve(root, relativeSourcePath(source.path));
    const inside = candidate => {
      const relative = path.relative(root, candidate);
      return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
    };
    if (!inside(absolute) || !fs.existsSync(absolute) || !inside(fs.realpathSync(absolute)) || !fs.statSync(absolute).isFile()) throw new Error(`Unsafe or missing dependency source file: ${source.path}`);
    if (!files.has(absolute)) {
      const text = fs.readFileSync(absolute, 'utf8');
      files.set(absolute, { text, lines: text.replace(/\r\n?/g, '\n').split('\n') });
    }
    return files.get(absolute);
  }
  function resolve(definition) {
    const { record, root } = packageFor(definition.package, definition.version);
    const source = { path: relativeSourcePath(definition.path), line: 1, dependency: { name: record.name, version: record.version, root: root.replaceAll('\\', '/') } };
    const file = read(source);
    if (!definition.pattern && (!/^(?:struct|enum|type|trait|fn)$/.test(definition.kind) || !/^[A-Za-z_]\w*$/.test(definition.symbol))) throw new Error(`Invalid dependency declaration: ${record.name}/${source.path}`);
    // 水平空白不能吞掉声明前一行；重名的 cfg 类型必须由审阅清单的精确 pattern 区分。
    const pattern = new RegExp(definition.pattern || `^[ \\t]*(?:pub(?:\\([^)]*\\))?[ \\t]+)?${definition.kind}[ \\t]+${definition.symbol}\\b`, 'gm');
    const text = file.lines.join('\n');
    const matches = [...text.matchAll(pattern)].map(match => text.slice(0, match.index).split('\n').length);
    if (matches.length !== 1) throw new Error(`Expected one dependency declaration: ${record.name}/${source.path} ${definition.symbol || definition.pattern}; found ${matches.length}`);
    source.line = matches[0];
    return source;
  }
  return { read, resolve };
}

export function attachDependencySources(registry, resolver, definitions) {
  for (const id of dependencyDefinitionTargets(registry, definitions)) {
    if (!definitions[id]) throw new Error(`Missing dependency definition: ${id}`);
    registry[id].definition_source = resolver.resolve(definitions[id]);
  }
}

export function checkDependencySources(registry, resolver, definitions, requireAll = true) {
  const targets = new Set(dependencyDefinitionTargets(registry, definitions));
  for (const id of targets) {
    if (!definitions[id]) {
      if (requireAll) throw new Error(`Missing dependency definition: ${id}`);
      continue;
    }
    if (!isDeepStrictEqual(registry[id].definition_source, resolver.resolve(definitions[id]))) throw new Error(`Dependency definition source mismatch: ${id}`);
  }
  for (const [id, node] of Object.entries(registry)) if (node.scheduleEvidence?.schemaVersion !== 1 && node.definition_source && (!definitions[id] || !targets.has(id))) throw new Error(`Unexpected dependency definition source: ${id}`);
}

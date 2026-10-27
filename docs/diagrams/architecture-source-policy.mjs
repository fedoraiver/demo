import fs from 'node:fs';
import path from 'node:path';
import { NODE_KINDS, nodeKindOf } from './architecture-kinds.mjs';
import { TYPE_PACKAGES, ENTITY_SOURCE_EVIDENCE, HIERARCHY_OWNED_ENTITIES, IMPORTED_ENTITIES, MARKER_ONLY_RESOURCES, RELATED_IMPLEMENTATIONS, SYSTEM_REGISTRATION_EVIDENCE, EDGE_SOURCE_EVIDENCE } from './architecture-source-evidence.mjs';

const roleLabels = Object.freeze({
  definition: '定义位置', registration: '注册位置', create: '创建位置', destroy: '销毁位置',
  initialize: '初始化位置', insert: '插入位置', remove: '移除位置', parameter: '参数位置',
  cleanup: '清理实现', message_definition: '消息类型定义', action_definition: '动作类型定义',
  build: '构建实现', install: '安装位置', assembly: '装配位置', run: '运行入口',
  configure: '配置位置', implementation: '实际实现', close: '关闭位置', related: '相关实现',
  operation: '操作位置',
});

const policies = {
  component: ['definition'],
  entity: ['create', 'destroy'],
  system: ['definition', 'registration'],
  observer: ['definition', 'registration'],
  resource: ['definition', 'initialize', 'insert', 'remove'],
  local: ['parameter', 'definition', 'initialize'],
  non_send: ['definition', 'initialize', 'insert', 'remove', 'cleanup'],
  message: ['definition'],
  message_buffer: ['definition', 'message_definition', 'registration', 'initialize', 'remove'],
  event: ['definition', 'action_definition'],
  plugin: ['definition', 'build', 'install'],
  plugin_group: ['definition', 'build', 'install'],
  app: ['create', 'assembly', 'run'],
  system_set: ['definition', 'configure'],
  scheduling_constraint: ['configure'],
  shared_data_contract: ['definition', 'configure', 'parameter'],
  system_param: ['definition', 'configure', 'parameter'],
  query_data: ['definition', 'configure', 'parameter'],
  relationship: ['definition', 'configure', 'parameter'],
  entity_reference: ['definition', 'configure', 'parameter'],
  sync: ['definition', 'implementation', 'registration', 'configure'],
  system_group: ['configure', 'implementation'],
  observer_group: ['configure', 'implementation'],
  engine_flow: ['configure', 'implementation'],
  registration_helper: ['definition', 'configure'],
  external_io: ['definition', 'create', 'install', 'implementation', 'close'],
  platform_api: ['definition', 'create', 'install', 'implementation', 'close'],
  platform_event: ['definition', 'create', 'install', 'implementation', 'close'],
  note: ['related'],
  lifecycle_note: ['related'],
  bsn_layout: ['related'],
  operation_result: ['related'],
  edge: Object.keys(roleLabels),
};

const aliases = {
  ...Object.fromEntries(Object.entries(NODE_KINDS).map(([kind, descriptor]) => [kind.toLowerCase(), descriptor.sourcePolicyKind])),
  ...Object.fromEntries(Object.keys(policies).map(kind => [kind, kind])),
  component: 'component', entity: 'entity', system: 'system', 'engine system': 'system',
  observer: 'observer', 'engine observers': 'observer_group', resource: 'resource',
  local: 'local', 'local<t>': 'local', nonsend: 'non_send', 'nonsend<t>': 'non_send', non_send: 'non_send',
  message: 'message', messages: 'message_buffer', 'messages<t>': 'message_buffer', message_buffer: 'message_buffer',
  event: 'event', entityevent: 'event', plugin: 'plugin', plugingroup: 'plugin_group', plugin_group: 'plugin_group',
  app: 'app', systemset: 'system_set', 'engine systemset': 'system_set', 'engine system set': 'system_set', system_set: 'system_set',
  '调度契约': 'scheduling_constraint', 'scheduling contract': 'scheduling_constraint', systemparam: 'system_param', system_param: 'system_param',
  querydata: 'query_data', query_data: 'query_data', relationship: 'relationship',
  sync: 'sync', '同步节点': 'sync', '引擎流程聚合': 'engine_flow',
  'native platform bridge': 'platform_api', 'native platform event': 'platform_event', '原生平台接口': 'platform_api',
  layout: 'bsn_layout', 'component write': 'operation_result', 'data write': 'operation_result', 'result note': 'operation_result',
  edge: 'edge', link: 'edge',
};

/** The caller supplies semantic kind; visual shape is deliberately irrelevant. */
export function sourcePolicyFor(kind) {
  const canonical = aliases[String(kind ?? '').trim().toLowerCase()] ?? 'unknown';
  const roles = [...(policies[canonical] ?? [])];
  return { kind: canonical, roles, groups: roles.map(role => ({ role, label: roleLabels[role] })) };
}

const slash = value => value.replaceAll('\\', '/');
const isAbsolute = value => /^(?:[A-Za-z]:\/|\/)/.test(value);
const isWindows = value => /^[A-Za-z]:\//.test(value) || value.startsWith('//');
const invalidCharacters = /[\u0000-\u001f\u007f<>"|?*]/;

function checkedPath(value, { absolute = false } = {}) {
  if (typeof value !== 'string' || !value || invalidCharacters.test(value)) throw new Error('Invalid source path');
  const normalized = slash(value);
  if (isAbsolute(normalized) !== absolute || (!absolute && normalized.includes(':'))
    || (absolute && normalized.replace(/^[A-Za-z]:/, '').includes(':'))
    || normalized.split('/').some(part => part === '.' || part === '..')) throw new Error(`Unsafe source path: ${value}`);
  const body = normalized.replace(/^(?:[A-Za-z]:\/|\/\/|\/)/, '');
  if (!body || body.split('/').some(part => !part)) throw new Error(`Invalid source path: ${value}`);
  return normalized;
}

function checkedRoot(value) {
  if (typeof value !== 'string') throw new Error('Invalid source root');
  const normalized = slash(value).replace(/\/+$/, '');
  if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}/`;
  if (!normalized && value.startsWith('/')) return '/';
  return checkedPath(normalized, { absolute: true });
}

function relativeToRoot(file, root) {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const compare = value => isWindows(root) ? value.toLowerCase() : value;
  return compare(file).startsWith(compare(prefix)) ? file.slice(prefix.length) : null;
}

function checkedDependency(value) {
  if (!value || typeof value !== 'object' || !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(value.name ?? '')
    || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(value.version ?? '')) throw new Error('Invalid dependency source identity');
  return { ...value, root: checkedRoot(value.root) };
}

function dependenciesFrom(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(checkedDependency);
  if (value.name && value.version && value.root) return [checkedDependency(value)];
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return entries.map(([key, entry]) => {
    if (entry && typeof entry === 'object') return checkedDependency(entry);
    const match = /^(.+)@(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?)$/.exec(key);
    if (!match) throw new Error(`Dependency root requires package name and version: ${key}`);
    return checkedDependency({ name: match[1], version: match[2], root: entry });
  });
}

/** Validate locators without a filesystem dependency or machine-specific defaults. */
export function normalizeSourceEntry(source, { dependencyRoots, workspaceRoot } = {}) {
  if (!source || typeof source !== 'object' || !Number.isSafeInteger(source.line) || source.line < 1
    || (source.column !== undefined && (!Number.isSafeInteger(source.column) || source.column < 1))) throw new Error('Invalid source location');
  if (typeof source.path !== 'string') throw new Error('Invalid source path');
  const file = checkedPath(source.path, { absolute: isAbsolute(slash(source.path)) });
  const result = { ...source, path: file };
  if (source.dependency) {
    const dependency = checkedDependency(source.dependency);
    const relative = isAbsolute(file) ? relativeToRoot(file, dependency.root) : file;
    if (!relative) throw new Error(`Dependency source escapes its root: ${file}`);
    const expected = dependenciesFrom(dependencyRoots).filter(item => item.name === dependency.name && item.version === dependency.version);
    if (expected.length && !expected.some(item => relativeToRoot(`${dependency.root}/_`, item.root) === '_')) throw new Error('Dependency source root mismatch');
    result.path = checkedPath(relative);
    result.dependency = dependency;
    delete result.unresolved;
    return result;
  }
  if (!isAbsolute(file)) { delete result.unresolved; return result; }
  const matches = dependenciesFrom(dependencyRoots).map(dependency => ({ dependency, relative: relativeToRoot(file, dependency.root) }))
    .filter(item => item.relative).sort((a, b) => b.dependency.root.length - a.dependency.root.length);
  if (matches.length) {
    if (matches[1]?.dependency.root.length === matches[0].dependency.root.length
      && JSON.stringify(matches[1].dependency) !== JSON.stringify(matches[0].dependency)) throw new Error('Ambiguous dependency source root');
    result.path = checkedPath(matches[0].relative);
    result.dependency = matches[0].dependency;
    delete result.unresolved;
    return result;
  }
  if (workspaceRoot) {
    const relative = relativeToRoot(file, checkedRoot(workspaceRoot));
    if (relative) { result.path = checkedPath(relative); delete result.unresolved; return result; }
  }
  // Unknown absolute locators remain explicit for the caller to report; never guess a Cargo package.
  return { ...result, unresolved: true };
}

function sourceIdentity(source) {
  const dependency = source.dependency;
  const path = slash(source.path ?? '');
  return JSON.stringify([source.role, isWindows(path) ? path.toLowerCase() : path, source.line, source.column ?? 1,
    dependency?.name ?? '', dependency?.version ?? '', dependency?.root ? (isWindows(slash(dependency.root)) ? slash(dependency.root).toLowerCase() : slash(dependency.root)) : '']);
}

/** Only explicit, reviewed roles authorize a locator; this never classifies the old generic source field. */
export function sourceEntriesFor(record, { kind = record?.kind, reviewedEntries } = {}) {
  const policy = sourcePolicyFor(kind);
  const candidates = reviewedEntries ?? [
  ...(record?.sourceEntries ?? record?.source_entries ?? []),
    ...(record?.sources ?? []).filter(source => source.role),
    ...(record?.source?.role ? [record.source] : []),
    ...(record?.definition_source ? [{ ...record.definition_source, role: 'definition' }] : []),
  ];
  if (!Array.isArray(candidates)) throw new Error('Reviewed source entries must be an array');
  const byIdentity = new Map();
  for (const source of candidates) {
    if (!source || !policy.roles.includes(source.role)) continue;
    const key = sourceIdentity(source);
    const labels = [...new Set([source.label, ...(source.labels ?? [])].filter(label => typeof label === 'string' && label.trim()))];
    if (!byIdentity.has(key)) { byIdentity.set(key, { ...source, labels }); continue; }
    const existing = byIdentity.get(key);
    existing.labels = [...new Set([...existing.labels, ...labels])];
  }
  const order = new Map(policy.roles.map((role, index) => [role, index]));
  return [...byIdentity.values()].sort((a, b) => order.get(a.role) - order.get(b.role));
}

/** Registry kind describes semantics; a rounded engine aggregate is never inferred to be one function. */
export function sourcePolicyKindFor(record) {
  return NODE_KINDS[nodeKindOf(record)].sourcePolicyKind;
}

const word = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const firstType = value => /^([A-Za-z_]\w*)/.exec(String(value))?.[1];
const compact = value => String(value).replace(/\s+/g, '').replace(/\b(?:crate|self|super)::/g, '').replaceAll('::<', '<');
const pending = value => '待核实：' + String(value).replace(/^(?:待核实[:：]\s*)+/, '');
const uniqueValues = values => [...new Set(values.filter(Boolean))];

// Preserve offsets while excluding comments and string literals from syntax evidence.
function rustCode(text) {
  let output = '', index = 0, blockDepth = 0, quote = null;
  while (index < text.length) {
    const char = text[index], next = text[index + 1];
    if (blockDepth) {
      if (char === '/' && next === '*') { blockDepth++; output += '  '; index += 2; }
      else if (char === '*' && next === '/') { blockDepth--; output += '  '; index += 2; }
      else { output += char === '\n' ? '\n' : ' '; index++; }
    } else if (quote) {
      if (char === '\\') { output += '  '; index += 2; }
      else { output += char === '\n' ? '\n' : ' '; index++; if (char === quote) quote = null; }
    } else if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') { output += ' '; index++; }
    } else if (char === '/' && next === '*') { blockDepth = 1; output += '  '; index += 2; }
    else if (char === '"') { quote = char; output += ' '; index++; }
    else { output += char; index++; }
  }
  return output;
}

function balancedEnd(text, start, open = '(', close = ')') {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === open) depth++;
    if (text[index] === close && --depth === 0) return index;
  }
  return -1;
}

function firstArgument(text) {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    if ('([{<'.includes(text[index])) depth++;
    if (')]}>' .includes(text[index])) depth--;
    if (text[index] === ',' && depth === 0) return text.slice(0, index).trim();
  }
  return text.trim();
}

function rustCalls(file) {
  const calls = [], expression = /(?:\.\s*([a-z_]\w*)|\b(on))\s*/g;
  for (const match of file.code.matchAll(expression)) {
    const method = match[1] || match[2];
    if (!['add_systems', 'add_observer', 'observe', 'on', 'add_plugins', 'configure_sets', 'init_resource', 'init_non_send', 'init_non_send_resource', 'insert_resource', 'insert_non_send_resource', 'remove_resource', 'remove_non_send_resource', 'add_message', 'init_state', 'add_sub_state', 'init_asset', 'add_audio_channel'].includes(method)) continue;
    let start = match.index + match[0].length, generic = '';
    if (file.code.slice(start, start + 3) === '::<') {
      const end = balancedEnd(file.code, start + 2, '<', '>');
      if (end < 0) continue;
      generic = file.code.slice(start + 3, end); start = end + 1;
    }
    while (/\s/.test(file.code[start] || '') && start < file.code.length) start++;
    if (file.code[start] !== '(') continue;
    const end = balancedEnd(file.code, start);
    if (end < 0) continue;
    calls.push({ method, generic, body: file.code.slice(start + 1, end), start: match.index, end, file });
  }
  return calls;
}

/** Read-only source index shared by node and edge audits during one build. */
export function createArchitectureSourceContext({ repository, dependencyContext = {}, model } = {}) {
  if (!repository) throw new Error('Source policies require the repository root');
  const roots = (dependencyContext.metadata?.packages || []).filter(item => item.source?.startsWith('registry+')).map(item => ({ name: item.name, version: item.version, root: slash(path.dirname(item.manifest_path)) }));
  const files = new Map(), packageFiles = new Map(), projectFiles = [];
  function read(source) {
    const normalized = normalizeSourceEntry(source, { workspaceRoot: repository, dependencyRoots: roots });
    if (normalized.unresolved) throw new Error(`Unresolved source path: ${source.path}`);
    const filename = path.resolve(normalized.dependency?.root || repository, normalized.path);
    if (!files.has(filename)) {
      const text = fs.readFileSync(filename, 'utf8').replace(/\r\n?/g, '\n');
      const code = rustCode(text).replace(/#\[cfg\(test\)\]\s*mod\s+tests\s*\{[\s\S]*$/, match => match.replace(/[^\n]/g, ' '));
      files.set(filename, { path: normalized.path, dependency: normalized.dependency, filename, text, code, lines: text.split('\n'), calls: null });
    }
    return files.get(filename);
  }
  function sourceAt(file, offset, role, label) {
    const line = file.text.slice(0, offset).split('\n').length;
    return { role, label, path: file.path, line, column: 1, ...(file.dependency ? { dependency: file.dependency } : {}) };
  }
  function walk(directory, dependency, output) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!['tests', 'examples', 'benches'].includes(entry.name)) walk(path.join(directory, entry.name), dependency, output); }
      else if (entry.name.endsWith('.rs') && !/(?:^|_)tests?\.rs$|test_support\.rs$/.test(entry.name)) {
        const filename = path.join(directory, entry.name);
        const base = dependency?.root || repository;
        output.push(read({ path: slash(path.relative(base, filename)), line: 1, ...(dependency ? { dependency } : {}) }));
      }
    }
  }
  walk(path.join(repository, 'src'), null, projectFiles);
  function inPackage(packageName) {
    if (!packageFiles.has(packageName)) {
      const candidates = roots.filter(item => item.name === packageName);
      if (candidates.length !== 1) { packageFiles.set(packageName, []); return []; }
      const result = [];
      walk(path.join(candidates[0].root, 'src'), candidates[0], result);
      packageFiles.set(packageName, result);
    }
    return packageFiles.get(packageName);
  }
  function callsIn(file) { return file.calls ||= rustCalls(file); }
  function declaration(symbol, { source, packageName, feature, fn = false } = {}) {
    const pattern = new RegExp(`^[ \\t]*(?:(?:pub(?:\\([^)]*\\))?|unsafe|async|extern(?:[ \\t]+\"[^\"]*\")?)[ \\t]+)*(?:${fn ? 'fn' : 'struct|enum|type|trait'})[ \\t]+${word(symbol)}\\b`, 'gm');
    const result = [];
    const search = packageName ? inPackage(packageName) : projectFiles;
    for (const file of search) for (const match of file.code.matchAll(pattern)) result.push(sourceAt(file, match.index, 'definition', `${fn ? '函数' : '类型'}定义：${symbol}`));
    if (source) {
      const exact = result.filter(item => item.path === slash(source.path) && item.line === source.line);
      if (exact.length === 1) return exact[0];
      const sameFile = result.filter(item => item.path === slash(source.path));
      if (sameFile.length === 1) return sameFile[0];
    }
    const local = feature ? result.filter(item => item.path.startsWith(`src/${feature}/`)) : [];
    return (local.length === 1 ? local : result).length === 1 ? (local.length === 1 ? local : result)[0] : null;
  }
  function resolveEvidence(descriptor) {
    let dependency;
    if (descriptor.package) {
      const matches = roots.filter(item => item.name === descriptor.package);
      if (matches.length !== 1) return [];
      dependency = matches[0];
    }
    const file = read({ path: descriptor.path, line: 1, ...(dependency ? { dependency } : {}) });
    const matches = file.lines.flatMap((line, index) => line.includes(descriptor.contains) ? [index + 1] : []);
    const lines = descriptor.line ? (matches.includes(descriptor.line) ? [descriptor.line] : []) : descriptor.all ? matches : matches.length === 1 ? matches : [];
    return lines.map(line => ({ role: descriptor.role, label: descriptor.label, path: descriptor.path, line, column: 1, ...(dependency ? { dependency } : {}) }));
  }
  function verified(source, role, label) {
    if (!source?.path) return null;
    const normalized = normalizeSourceEntry({ ...source, role, label }, { workspaceRoot: repository, dependencyRoots: roots });
    const file = read(normalized);
    if (normalized.line > file.lines.length) throw new Error(`Source line out of bounds: ${normalized.path}:${normalized.line}`);
    return normalized;
  }
  return { repository, roots, projectFiles, read, inPackage, sourceAt, callsIn, declaration, resolveEvidence, verified, model };
}

function typeDefinitions(record, context) {
  if (record.definition_source) return [context.verified(record.definition_source, 'definition', `类型定义：${record.name}`)];
  const names = record.name === 'State<AppState> / NextState<AppState>' ? ['State', 'NextState', 'AppState']
    : record.name === 'State<PlayState> / NextState<PlayState>' ? ['State', 'NextState', 'PlayState']
      : [firstType(record.name)];
  return names.filter(Boolean).map(symbol => context.declaration(symbol, { source: record.source, packageName: TYPE_PACKAGES[symbol], feature: record.defined_in || record.feature })).filter(Boolean);
}

function systemDefinition(record, context) {
  if (record.definition_source) return context.verified(record.definition_source, 'definition', `函数定义：${record.name}`);
  return context.declaration(record.name, { source: record.source, feature: record.module || record.feature, fn: true });
}

function systemRegistrations(record, context, observer = false) {
  const definition = systemDefinition(record, context);
  if (!definition) return [];
  if (SYSTEM_REGISTRATION_EVIDENCE[record.id]) return SYSTEM_REGISTRATION_EVIDENCE[record.id].flatMap(descriptor => context.resolveEvidence(descriptor));
  const declarationLine = context.read(definition).lines[definition.line - 1];
  const symbol = /\bfn\s+([A-Za-z_]\w*)/.exec(declarationLine)?.[1] || record.name;
  // WorldInspectorPlugin 先把这个真实函数转为配置变量，再把变量注册进 Schedule。
  if (record.id === 'inspector_pass') return context.resolveEvidence({ package: 'bevy-inspector-egui', path: 'src/quick.rs', contains: 'app.add_systems(EguiPrimaryContextPass, system)', line: 88, role: 'registration', label: 'Schedule 注册：EguiPrimaryContextPass（system = world_inspector_ui.into_configs()）' });
  const methods = observer ? ['add_observer', 'observe', 'on'] : ['add_systems'];
  const search = definition.dependency ? [...context.projectFiles, ...context.inPackage(definition.dependency.name)] : context.projectFiles;
  const registeredBody = call => {
    if (observer) return call.body;
    const schedule = firstArgument(call.body);
    let body = call.body.slice(schedule.length + 1);
    const configuration = /\.\s*(?:before|after|before_ignore_deferred|after_ignore_deferred|run_if|distributive_run_if|in_set|ambiguous_with)\s*\(/g;
    const ranges = [...body.matchAll(configuration)].map(match => [match.index, balancedEnd(body, match.index + match[0].lastIndexOf('('))]);
    for (const [start, end] of ranges.reverse()) if (end >= 0) body = body.slice(0, start) + body.slice(end + 1);
    return body;
  };
  const schedules = new Set((record.registrations || []).map(registration => compact(registration.schedule)).filter(Boolean));
  return search.flatMap(file => context.callsIn(file).filter(call => methods.includes(call.method)
    && (observer || !schedules.size || schedules.has(compact(firstArgument(call.body))))
    && new RegExp(`\\b${word(symbol)}\\b`).test(registeredBody(call))).map(call => context.sourceAt(file, call.start, 'registration', observer ? `Observer 注册：${call.method}` : `Schedule 注册：${firstArgument(call.body).replace(/\s+/g, ' ')}`)));
}

function typeLifecycle(record, context, definitions) {
  const symbol = firstType(record.name), sources = [];
  if (MARKER_ONLY_RESOURCES.has(record.id)) return sources;
  const family = /^Messages</.test(record.name) ? 'Messages' : symbol;
  const wanted = compact(record.name.split(' / ')[0]);
  const typeArgument = /^\w+<([\s\S]+)>$/.exec(record.name.split(' / ')[0])?.[1];
  const methods = ['init_resource', 'init_non_send', 'init_non_send_resource', 'insert_resource', 'insert_non_send_resource', 'remove_resource', 'remove_non_send_resource', 'add_message', 'init_state', 'add_sub_state', 'init_asset', 'add_audio_channel'];
  const collect = (file, framework = false) => {
    for (const call of context.callsIn(file)) {
      if (!methods.includes(call.method)) continue;
      const generic = compact(call.generic), argument = compact(firstArgument(call.body));
      const direct = generic === wanted || argument === wanted || argument.startsWith(wanted + '(') || argument.startsWith(wanted + '{') || argument.startsWith(wanted + '::');
      const message = family === 'Messages' && call.method === 'add_message' && generic === compact(typeArgument);
      // 框架可用 hover::HoverMap 等模块限定名初始化；仅接受已唯一核实且同包的真实声明。
      const qualifiedResource = framework && /^[A-Za-z_]\w*$/.test(wanted)
        && definitions.some(source => source.dependency?.name === file.dependency?.name)
        && new RegExp(`^(?:[A-Za-z_]\\w*::)+${word(wanted)}$`).test(generic);
      const qualifiedMessage = framework && family === 'Messages' && call.method === 'add_message'
        && /^[A-Za-z_]\w*$/.test(typeArgument || '') && TYPE_PACKAGES[typeArgument] === file.dependency?.name
        && new RegExp(`^(?:[A-Za-z_]\\w*::)+${word(typeArgument)}$`).test(generic);
      const state = ['State', 'NextState'].includes(family) && ['init_state', 'add_sub_state'].includes(call.method) && generic === compact(typeArgument);
      const asset = family === 'Assets' && call.method === 'init_asset' && generic === compact(typeArgument);
      const channel = family === 'AudioChannel' && call.method === 'add_audio_channel' && generic === compact(typeArgument);
      const genericFramework = framework && ((family === 'Assets' && /^Assets<[A-Z]\w*>$/.test(generic)) || (family === 'Messages' && /^Messages<[A-Z]\w*>$/.test(generic)) || (family === 'AudioChannel' && /^AudioChannel<[A-Z]\w*>$/.test(generic)) || (family === 'ContextInstances' && /^ContextInstances<[A-Z]\w*>$/.test(generic)));
      if (!direct && !message && !qualifiedResource && !qualifiedMessage && !state && !asset && !channel && !genericFramework) continue;
      if (framework && genericFramework) {
        const enclosing = [...file.code.slice(0, call.start).matchAll(/\bfn\s+([A-Za-z_]\w*)/g)].at(-1)?.[1];
        if (/^(?:deregister|unregister|remove|cleanup)/.test(enclosing || '') || /remove/.test(call.method)) continue;
      }
      const role = /remove/.test(call.method) ? 'remove' : /insert/.test(call.method) ? 'insert' : /add_message/.test(call.method) ? 'registration' : 'initialize';
      sources.push(context.sourceAt(file, call.start, role, `${framework ? '框架执行' : '项目'}：${call.method}${call.generic ? `::<${call.generic.replace(/\s+/g, ' ')}>` : ''}`));
    }
  };
  context.projectFiles.forEach(file => collect(file));
  const packages = uniqueValues([TYPE_PACKAGES[family], ['Assets', 'Messages'].includes(family) ? TYPE_PACKAGES[firstType(typeArgument)] : null, record.id === 'resource.TimePhysics' ? 'avian3d' : null, family === 'AppTypeRegistry' ? 'bevy_app' : null, ...definitions.map(source => source.dependency?.name)]);
  for (const packageName of packages) context.inPackage(packageName).forEach(file => collect(file, true));
  if (family === 'Assets') sources.push(...context.resolveEvidence({ package: 'bevy_asset', path: 'src/lib.rs', contains: 'self.insert_resource(assets)', role: 'initialize', label: '框架执行：AssetApp::init_asset 将 Assets<A> 插入 World' }));
  for (const definition of definitions.filter(source => !source.dependency)) {
    const file = context.read(definition), name = firstType(record.name);
    for (const match of file.code.matchAll(new RegExp(`impl\\s+(?:Default|FromWorld)\\s+for\\s+${word(name)}\\b`, 'g'))) sources.push(context.sourceAt(file, match.index, 'initialize', `自定义初始化：${name} 的 ${match[0].includes('FromWorld') ? 'FromWorld' : 'Default'} 实现`));
  }
  if (sources.some(source => source.dependency && ['initialize', 'insert', 'registration'].includes(source.role))) {
    const enable = family === 'AppTypeRegistry' ? context.resolveEvidence({ path: 'src/main.rs', contains: 'App::new()', role: 'initialize', label: '项目启用：创建 App 及其默认反射注册表' })[0]
      : frameworkEnable(record.id === 'resource.TimePhysics' ? { ...record, defined_in: 'avian' } : record, context);
    if (enable) sources.push({ ...enable, role: 'initialize', label: family === 'AppTypeRegistry' ? enable.label : `项目启用：${enable.label}（提供资源自动初始化）` });
  }
  return sources;
}

function frameworkEnable(record, context) {
  const feature = record.defined_in || record.feature;
  const symbol = feature === 'avian' ? 'PhysicsPlugins' : feature === 'egui' ? 'EguiPlugin'
    : feature === 'kira' || /AudioChannel|AudioSource|AudioInstance/.test(record.name) ? 'KiraAudioPlugin'
      : feature === 'enhanced_input' ? 'EnhancedInputPlugin' : 'DefaultPlugins';
  for (const file of context.projectFiles) for (const call of context.callsIn(file)) if (call.method === 'add_plugins' && new RegExp(`\\b${symbol}\\b`).test(call.body)) return context.sourceAt(file, call.start, 'install', `安装 ${symbol}`);
  return null;
}

function entitySources(record, context, gaps) {
  if (record.canonical_entity && record.canonical_entity !== record.id) return entitySources({ ...record, id: record.canonical_entity, canonical_entity: null }, context, gaps);
  const sources = [];
  for (const descriptor of ENTITY_SOURCE_EVIDENCE[record.id] || []) {
    const resolved = context.resolveEvidence(descriptor);
    if (!resolved.length) gaps.push(`未能唯一核实${descriptor.label}（${descriptor.path}）`);
    sources.push(...resolved);
  }
  if (HIERARCHY_OWNED_ENTITIES.has(record.id)) {
    sources.push(...context.resolveEvidence({ package: 'bevy_ecs', path: 'src/relationship/mod.rs', contains: 'fn on_despawn(mut world: DeferredWorld', role: 'destroy', label: '框架执行：关系目标销毁时级联销毁 linked_spawn 子实体' }));
    const relation = (record.components || []).find(component => component.name === 'ChildOf' || /ActionOf|BindingOf/.test(component.name));
    if (relation?.source) sources.push(context.verified(relation.source, 'destroy', '项目配置：实体归属于级联生命周期关系'));
  }
  if (IMPORTED_ENTITIES.has(record.id)) {
    const imported = context.resolveEvidence({ package: 'bevy_world_serialization', path: 'src/world_asset_spawner.rs', contains: 'world_asset.write_to_world_with', role: 'create', label: '框架执行：把资产实例实体写入运行 World', all: true });
    sources.push(...imported);
    if (!imported.length) gaps.push('导入实体的实际实例化入口尚未唯一定位');
  }
  if (sources.some(source => source.role === 'create' && /BSN|spawn_scene/.test(source.label))) sources.push(...context.resolveEvidence({ package: 'bevy_scene', path: 'src/spawn.rs', contains: 'fn spawn_scene', line: 361, role: 'create', label: '框架执行：Commands::spawn_scene 创建根实体并排队装配' }));
  if (!sources.some(source => source.role === 'create')) gaps.push('实体的实际创建位置尚未完整核实');
  if (!sources.some(source => source.role === 'destroy')) gaps.push('实体的显式或自动销毁位置尚未完整核实；不能据此断言没有销毁路径');
  return sources;
}

function sourcesForNode(record, registry, context, gaps) {
  const kind = sourcePolicyFor(sourcePolicyKindFor(record)).kind;
  if (record.memberIds?.length || record.registrationIds?.length) {
    const members = (record.memberIds || record.registrationIds).map(id => registry[id]).filter(member => member && member !== record);
    if (members.length && kind === 'system') return members.flatMap(member => sourcesForNode(member, registry, context, gaps));
  }
  if (kind === 'component') {
    const result = typeDefinitions(record, context);
    if (!result.length) gaps.push('实际 Component 类型定义尚未唯一核实');
    return result;
  }
  if (kind === 'entity') return entitySources(record, context, gaps);
  if (['system', 'observer'].includes(kind)) {
    const definition = systemDefinition(record, context);
    const registrations = systemRegistrations(record, context, kind === 'observer');
    if (!definition) gaps.push('真实系统或 Observer 函数定义尚未唯一核实');
    if (!registrations.length) gaps.push(kind === 'observer' ? 'Observer 的全部注册位置尚未完整核实' : '系统的全部 Schedule 注册位置尚未完整核实');
    return [definition, ...registrations].filter(Boolean);
  }
  if (['resource', 'message_buffer', 'non_send'].includes(kind)) {
    const definitions = typeDefinitions(record, context), sources = [...definitions];
    if (kind === 'message_buffer') {
      const argument = /^Messages<([\s\S]+)>$/.exec(record.name)?.[1], symbol = firstType(argument);
      const message = symbol && context.declaration(symbol, { packageName: TYPE_PACKAGES[symbol], feature: record.feature });
      if (message) sources.push({ ...message, role: 'message_definition', label: `消息类型定义：${argument}` });
      else gaps.push('缓冲容器所承载的消息类型定义尚未唯一核实');
    }
    sources.push(...typeLifecycle(record, context, definitions));
    sources.push(...(RELATED_IMPLEMENTATIONS[record.id] || []).flatMap(descriptor => context.resolveEvidence(descriptor)));
    if (MARKER_ONLY_RESOURCES.has(record.id)) gaps.push('该类型仅用作泛型或插件配置标记，未核实存在独立资源实例；不列初始化或移除入口');
    else if (!sources.some(source => ['initialize', 'insert', 'registration'].includes(source.role))) gaps.push('该资源的初始化或插入位置尚未完整核实');
    if (!definitions.length) gaps.push('实际存储类型定义尚未唯一核实');
    if (kind === 'non_send') for (const file of context.projectFiles.filter(file => /window_policy\/(?:windows|macos)\.rs$/.test(file.path))) for (const match of file.code.matchAll(/fn\s+drop\s*\(/g)) sources.push(context.sourceAt(file, match.index, 'cleanup', `原生守卫释放：${file.path.includes('windows') ? 'Windows' : 'macOS'} NativeWindowPolicy::drop`));
    return sources;
  }
  if (kind === 'local') {
    const sources = [], source = record.source && context.read(record.source);
    if (source) {
      const parameterLines = source.lines.map((line, index) => ({ line, index })).filter(({ line }) => /\bLocal\s*</.test(line));
      const targetType = /Local<(.+)>/.exec(record.name)?.[1];
      const matches = targetType ? parameterLines.filter(({ line }) => compact(line).includes(`Local<${compact(targetType)}>`)) : parameterLines.filter(({ line }) => /previous_layout|previous/.test(line));
      const nearest = matches.sort((a, b) => Math.abs(a.index + 1 - record.source.line) - Math.abs(b.index + 1 - record.source.line));
      if (nearest.length) sources.push({ role: 'parameter', label: '系统私有状态：Local<T> 参数声明', path: source.path, line: nearest[0].index + 1, column: 1 });
      const customSymbols = uniqueValues((targetType || '').match(/[A-Z][A-Za-z0-9_]*/g) || []);
      for (const symbol of customSymbols) {
        const definition = context.declaration(symbol, { source: record.source, feature: record.feature });
        if (definition && !['Entity', 'Vec2', 'HashMap', 'HashSet', 'Option', 'SettingKey'].includes(symbol)) sources.push(definition);
      }
    }
    if (!sources.some(source => source.role === 'parameter')) gaps.push('所属系统的 Local<T> 参数位置尚未唯一核实');
    return sources;
  }
  if (['message', 'event'].includes(kind)) {
    const types = record.name.split(/\s*\/\s*/).flatMap(value => /^(?:Pointer)<(.*)>$/.exec(value) ? ['Pointer'] : [firstType(value)]).filter(Boolean);
    const sources = types.map(symbol => context.declaration(symbol, { packageName: TYPE_PACKAGES[symbol], source: record.source, feature: record.feature })).filter(Boolean);
    const action = /(?:Fire|Complete|Cancel)<([A-Za-z_]\w*)>/.exec(record.name)?.[1];
    if (action) { const definition = context.declaration(action, { feature: record.feature }); if (definition) sources.push({ ...definition, role: 'action_definition', label: `动作类型定义：${action}` }); }
    if (!sources.length) gaps.push('真实事件或消息类型定义尚未唯一核实');
    return sources;
  }
  if (['plugin', 'plugin_group'].includes(kind)) {
    const sources = typeDefinitions(record, context);
    const declaration = sources[0] && context.read(sources[0]).lines[sources[0].line - 1];
    const symbol = /\b(?:struct|enum)\s+([A-Za-z_]\w*)/.exec(declaration || '')?.[1] || (/KiraAudioPlugin/.test(record.name) ? 'AudioPlugin' : record.name);
    const search = sources[0]?.dependency ? context.inPackage(sources[0].dependency.name) : context.projectFiles;
    for (const file of search) {
      const impl = new RegExp(`impl(?:<[^>]*>)?\\s+(?:Plugin|PluginGroup)\\s+for\\s+${word(symbol)}\\b`, 'g');
      for (const match of file.code.matchAll(impl)) sources.push(context.sourceAt(file, match.index, 'build', `构建实现：${record.name}`));
    }
    for (const file of context.projectFiles) for (const call of context.callsIn(file)) if (call.method === 'add_plugins' && [symbol, record.name].some(name => new RegExp(`\\b${word(name)}\\b`).test(call.body))) sources.push(context.sourceAt(file, call.start, 'install', `安装：${record.name}`));
    // 这些插件由已核实的框架插件组安装，不能把任意同名引用或排序约束当作安装。
    const nestedInstallations = {
      'plugin-UiWidgetsPlugins': ['bevy_ui_widgets', 'bevy_internal', 'src/default_plugins.rs', 'bevy_ui_widgets:::UiWidgetsPlugins,', 'DefaultPlugins'],
      'plugin-DefaultPickingPlugins': ['bevy_picking', 'bevy_internal', 'src/default_plugins.rs', 'bevy_picking:::DefaultPickingPlugins,', 'DefaultPlugins'],
      'plugin-ButtonPlugin': ['bevy_ui_widgets', 'bevy_ui_widgets', 'src/lib.rs', '.add(ButtonPlugin)', 'UiWidgetsPlugins'],
      'plugin-PickingPlugin': ['bevy_picking', 'bevy_picking', 'src/lib.rs', '.add(PickingPlugin)', 'DefaultPickingPlugins'],
      'plugin-InteractionPlugin': ['bevy_picking', 'bevy_picking', 'src/lib.rs', '.add(InteractionPlugin)', 'DefaultPickingPlugins'],
    };
    const nested = nestedInstallations[record.id];
    if (nested && sources[0]?.dependency?.name === nested[0]) {
      const [, packageName, sourcePath, contains, parent] = nested;
      sources.push(...context.resolveEvidence({ package: packageName, path: sourcePath, contains, role: 'install', label: `框架装配：${parent} 安装 ${symbol}` }));
    }
    if (record.name === 'SessionLogPlugin') sources.push(...context.resolveEvidence({ path: 'src/main.rs', contains: 'app.add_plugins(logging)', role: 'install', label: '安装：SessionLogPlugin::prepare 返回的日志插件' }));
    if (record.name === 'DefaultPlugins') sources.push(...context.resolveEvidence({ package: 'bevy_app', path: 'src/plugin_group.rs', contains: 'fn build(self) -> $crate::PluginGroupBuilder', role: 'build', label: '框架生成：plugin_group! 的 PluginGroup::build 实现' }));
    if (!sources.some(source => source.role === 'definition')) gaps.push('插件类型定义尚未唯一核实');
    if (!sources.some(source => source.role === 'build')) gaps.push('插件构建实现尚未唯一核实');
    if (!sources.some(source => source.role === 'install')) gaps.push('插件的全部项目安装位置尚未完整核实');
    if (!sources.length) gaps.push('插件的实际类型定义、构建和安装位置尚未唯一核实');
    return sources;
  }
  if (kind === 'app') {
    const file = context.read({ path: 'src/main.rs', line: 1 });
    return [...[['App::new()', 'create', '创建 App'], ['LaunchMode::Game => app.run()', 'run', '进入游戏应用运行'], ['inspector::dump_schedules(&mut app, &directory)', 'run', '导出已注册调度并返回']].flatMap(([contains, role, label]) => context.resolveEvidence({ path: file.path, contains, role, label })), ...context.callsIn(file).filter(call => call.method === 'add_plugins').map(call => context.sourceAt(file, call.start, 'assembly', '应用装配：安装插件或插件组'))];
  }
  if (['system_group', 'observer_group', 'engine_flow', 'registration_helper'].includes(kind)) {
    const sources = [];
    for (const descriptor of RELATED_IMPLEMENTATIONS[record.id] || []) {
      const resolved = context.resolveEvidence(descriptor);
      if (!resolved.length) gaps.push(`未能唯一核实${descriptor.label}（${descriptor.path}）`);
      sources.push(...resolved);
    }
    if (kind === 'registration_helper') {
      if (record.source) {
        const file = context.read(record.source), line = file.lines[record.source.line - 1] || '';
        if (/\bfn\s+[A-Za-z_]\w*\s*\(/.test(line)) sources.push(context.verified(record.source, 'definition', '注册辅助函数定义'));
      }
      if (!sources.some(source => source.role === 'definition')) gaps.push('注册辅助函数的真实定义尚未唯一核实');
      if (!sources.some(source => source.role === 'configure')) gaps.push('注册辅助函数的调用／装配位置尚未完整核实');
      return sources;
    }
    const memberIds = uniqueValues([...(record.memberIds || []), ...(context.model?.system_links || [])
      .filter(link => link.from === record.id && link.kind === 'registration').map(link => link.to)]);
    for (const member of memberIds.map(id => registry[id]).filter(Boolean)) {
      const definition = systemDefinition(member, context);
      if (definition) sources.push({ ...definition, role: 'implementation', label: `成员函数定义：${member.name}` });
      const observer = sourcePolicyFor(sourcePolicyKindFor(member)).kind === 'observer';
      sources.push(...systemRegistrations(member, context, observer).map(source => ({ ...source, role: 'configure', label: `成员配置：${member.name}；${source.label}` })));
    }
    if (kind === 'observer_group' && record.definition_source) {
      const file = context.read(record.definition_source), line = file.lines[record.definition_source.line - 1] || '';
      if (/^\s*impl\b/.test(line)) {
        sources.push(context.verified(record.definition_source, 'configure', 'Observer 分组安装配置'));
        const start = file.code.indexOf(line.trim()), open = file.code.indexOf('{', start), end = balancedEnd(file.code, open, '{', '}');
        for (const call of context.callsIn(file).filter(call => call.start > open && call.end < end && ['add_observer', 'observe', 'on'].includes(call.method))) {
          const symbol = firstType(firstArgument(call.body));
          if (!symbol) continue;
          const definition = context.declaration(symbol, { source: record.definition_source, packageName: record.definition_source.dependency?.name, fn: true });
          if (definition) sources.push({ ...definition, role: 'implementation', label: `成员 Observer 函数定义：${symbol}` });
          sources.push(context.sourceAt(file, call.start, 'configure', `成员 Observer 注册：${symbol}`));
        }
      } else sources.push(context.verified(record.definition_source, 'implementation', 'Observer 分组相关实现入口'));
    } else if (record.definition_source) sources.push(context.verified(record.definition_source, 'implementation', '流程聚合关联入口；不表示单个系统定义'));
    if (record.source) sources.push(context.verified(record.source, kind === 'observer_group' ? 'configure' : 'implementation', kind === 'observer_group' ? '项目控件装配入口' : '分组或流程相关实现入口'));
    if (!sources.some(source => source.role === 'configure')) gaps.push('分组或流程的全部成员及启用配置尚未完整核实');
    if (!sources.some(source => source.role === 'implementation')) gaps.push('分组或流程的实际成员／执行实现尚未完整核实');
    return sources;
  }
  if (['system_set', 'scheduling_constraint', 'shared_data_contract', 'system_param', 'query_data', 'relationship', 'entity_reference', 'sync'].includes(kind)) {
    const sources = typeDefinitions(record, context), symbol = firstType(record.name);
    if (['system_param', 'query_data'].includes(kind)) for (const descriptor of RELATED_IMPLEMENTATIONS[record.id] || []) sources.push(...context.resolveEvidence(descriptor));
    if (kind === 'system_set') for (const descriptor of RELATED_IMPLEMENTATIONS[record.id] || []) {
      const resolved = context.resolveEvidence(descriptor);
      if (!resolved.length) gaps.push(`未能唯一核实${descriptor.label}（${descriptor.path}）`);
      sources.push(...resolved);
    }
    const search = kind === 'system_set' && sources[0]?.dependency ? [...context.projectFiles, ...context.inPackage(sources[0].dependency.name)] : context.projectFiles;
    const target = /^([A-Za-z_]\w*::[A-Za-z_]\w*)/.exec(record.name)?.[1] || symbol;
    for (const file of search) for (const call of context.callsIn(file)) if (call.method === 'configure_sets' && target && new RegExp(`\\b${word(target)}\\b`).test(call.body)) sources.push(context.sourceAt(file, call.start, 'configure', `配置：${target} 的调度集合约束`));
    if (record.source) {
      const file = context.read(record.source), line = file.lines[record.source.line - 1] || '';
      if (kind === 'sync') sources.push(context.verified(record.source, 'configure', '项目同步或引擎流程配置入口'));
      else if (['relationship', 'entity_reference'].includes(kind) && /ChildOf|ColliderOf|ActionOf|BindingOf|\.target|character|sole_markers|animation_player|collider/.test(record.name)) sources.push(context.verified(record.source, 'configure', kind === 'relationship' ? '关系声明或实际装配配置' : '实体引用字段声明或配置'));
      else if (!sources.length && /\.chain\(|\.before\(|\.after\(|configure_sets/.test(line)) sources.push(context.verified(record.source, 'configure', '调度契约配置'));
    }
    const reviewedConfigurations = {
      'state-paused': ['src/game_flow/mod.rs', '.add_systems(OnEnter(PlayState::Paused), pause_simulation)'],
      'volume-request-source': ['src/ui/volume.rs', 'fn sample_slider_pointer('],
      'flow-audio-order': ['src/game_flow/mod.rs', '(UiSystems::Style, AudioSystems::Mix, AudioSystems::Playback).chain()'],
    };
    if (reviewedConfigurations[record.id]) {
      const [sourcePath, contains] = reviewedConfigurations[record.id];
      sources.push(...context.resolveEvidence({ path: sourcePath, contains, role: 'configure', label: '实际调度或流程配置' }));
    }
    if (kind === 'system_set' && !sources.some(source => source.role === 'configure')) gaps.push('该 SystemSet 的显式配置或启用入口尚未完整核实');
    if (!sources.length) gaps.push('该集合、参数或流程契约的声明／配置位置尚未唯一核实');
    return sources;
  }
  if (['external_io', 'platform_api', 'platform_event'].includes(kind)) {
    const sources = (RELATED_IMPLEMENTATIONS[record.id] || []).flatMap(descriptor => context.resolveEvidence(descriptor));
    if (record.source) sources.push(context.verified(record.source, 'implementation', '外部 I/O 或平台接口相关实现'));
    return sources;
  }
  if (['note', 'lifecycle_note', 'bsn_layout', 'operation_result'].includes(kind)) {
    const sources = (RELATED_IMPLEMENTATIONS[record.id] || []).flatMap(descriptor => context.resolveEvidence({ ...descriptor, role: 'related' }));
    if (record.definition_source) sources.push(context.verified(record.definition_source, 'related', '说明关联的类型或实现入口'));
    if (record.source) sources.push(context.verified(record.source, 'related', '说明所依据的相关实现'));
    if (!sources.length) gaps.push('该说明的支持实现尚未唯一核实');
    return sources;
  }
  gaps.push(`尚未为语义类型 ${record.kind} 核实源码入口`);
  return [];
}

/** Attach reviewed semantic source entry lists without replacing descriptions or legacy provenance. */
export function applyArchitectureSourcePolicies(registry, options = {}) {
  const context = options.context || createArchitectureSourceContext(options);
  let entries = 0, gaps = 0;
  for (const record of Object.values(registry)) {
    if (record.alias_of) continue;
    record.sourcePolicyKind = sourcePolicyKindFor(record);
    const sourceGaps = [], candidates = sourcesForNode(record, registry, context, sourceGaps);
    record.sourceEntries = sourceEntriesFor(record, { kind: sourcePolicyKindFor(record), reviewedEntries: candidates });
    record.sourceGaps = uniqueValues([...(record.sourceGaps || []), ...sourceGaps].map(pending));
    entries += record.sourceEntries.length; gaps += record.sourceGaps.length;
  }
  for (const record of Object.values(registry)) if (record.alias_of && registry[record.alias_of]) {
    record.sourceEntries = registry[record.alias_of].sourceEntries;
    record.sourceGaps = registry[record.alias_of].sourceGaps;
    record.sourcePolicyKind = sourcePolicyKindFor(registry[record.alias_of]);
  }
  const dependencySources = Object.values(registry).flatMap(record => record.sourceEntries || []).filter(source => source.dependency);
  return { entries, gaps, dependencySources, context };
}

/** Audit project ECS declarations and registration sites, without treating helpers as systems. */
export function auditProductionEcsCoverage(registry, { context, ...options } = {}) {
  context ||= createArchitectureSourceContext(options);
  const declarations = [], registrations = [];
  const ecsDerives = /\b(Component|Resource|States|SubStates|SystemSet|SystemParam|QueryData|Message|Event|EntityEvent|InputAction)\b/g;
  for (const file of context.projectFiles) {
    const testRanges = [];
    for (const test of file.code.matchAll(/#\[\s*cfg\s*\(\s*test\s*\)\s*\]/g)) {
      const tail = file.code.slice(test.index + test[0].length);
      const item = /^\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(fn|mod|struct|enum|impl|use|const|static|type|trait)\b/.exec(tail);
      if (!item) continue;
      const start = test.index + test[0].length + item[0].length;
      const open = file.code.indexOf('{', start), semicolon = file.code.indexOf(';', start);
      const end = semicolon >= 0 && (open < 0 || semicolon < open) ? semicolon : open >= 0 ? balancedEnd(file.code, open, '{', '}') : -1;
      if (end >= 0) testRanges.push([test.index, end]);
    }
    const testOnly = offset => testRanges.some(([start, end]) => offset >= start && offset <= end);
    const expression = /((?:#\[[^\]]*\]\s*)+)(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum)\s+([A-Za-z_]\w*)/g;
    for (const match of file.code.matchAll(expression)) {
      if (testOnly(match.index)) continue;
      if (/#\[\s*cfg\s*\(\s*test\s*\)\s*\]/.test(match[1])) continue;
      const derives = [...match[1].matchAll(/#\[\s*derive\s*\(([^)]*)\)\s*\]/g)].flatMap(derive => [...derive[1].matchAll(ecsDerives)].map(value => value[1]));
      if (!derives.length) continue;
      const offset = match.index + match[0].search(/\b(?:struct|enum)\s/);
      declarations.push({ ...context.sourceAt(file, offset, derives.includes('InputAction') ? 'action_definition' : 'definition', match[2]), name: match[2], derives });
    }
    for (const call of context.callsIn(file)) if (!testOnly(call.start) && ['add_systems', 'add_observer', 'observe', 'on'].includes(call.method)) {
      registrations.push({ ...context.sourceAt(file, call.start, 'registration', call.method), method: call.method });
    }
  }
  const entries = Object.values(registry).filter(record => !record.alias_of).flatMap(record => record.sourceEntries || []).filter(source => !source.dependency);
  const at = (expected, roles) => entries.some(source => roles.includes(source.role) && source.path === expected.path && source.line === expected.line);
  const gaps = [
    ...declarations.filter(declaration => !at(declaration, declaration.derives.includes('Message') ? ['definition', 'message_definition'] : [declaration.role])).map(declaration => `生产 ECS 声明未覆盖：${declaration.name}（${declaration.path}:${declaration.line}）`),
    ...registrations.filter(registration => !at(registration, ['registration', 'configure'])).map(registration => `生产 ECS 注册未覆盖：${registration.method}（${registration.path}:${registration.line}）`),
  ];
  return { declarations, registrations, gaps };
}

/** Component access facts may already carry more precise audited operations; keep those authoritative. */
export function applyArchitectureEdgeSourcePolicies(links, options = {}) {
  const context = options.context || createArchitectureSourceContext(options), registry = options.registry || {};
  const originals = new Map((context.model?.system_links || []).map(link => [link.id, link]));
  const reviewedEntries = entries => entries.map(source => source.role === 'call' ? { ...source, role: 'operation', label: source.label || '调用处' } : source);
  function evaluateOriginal(link) {
    const reviewed = reviewedEntries(link.sourceEntries || []), gaps = [...(link.sourceGaps || [])];
    for (const descriptor of EDGE_SOURCE_EVIDENCE[link.id] || []) {
      const resolved = context.resolveEvidence(descriptor);
      reviewed.push(...resolved);
      if (!resolved.length) gaps.push(pending(`未能唯一核实${descriptor.label}（${descriptor.path}）`));
    }
    if (!reviewed.length && link.source?.path) reviewed.push(context.verified(link.source, 'operation', '建立该关系的实际实现'));
    if (!reviewed.length && ['registration', 'membership', 'constraint', 'order'].includes(link.kind)) {
      const sources = [registry[link.from], registry[link.to]].filter(Boolean).flatMap(record => record.sourceEntries || []).filter(source => ['registration', 'configure', 'install'].includes(source.role));
      reviewed.push(...sources);
    }
    const sourceEntries = sourceEntriesFor(link, { kind: 'edge', reviewedEntries: reviewed });
    if (!sourceEntries.length) gaps.push(pending('该关系的具体操作位置尚未完成源码核实'));
    return { sourceEntries, ...(gaps.length || link.sourceGaps ? { sourceGaps: uniqueValues(gaps) } : {}) };
  }
  for (const link of links) {
    if (link.projection !== 'observer-trigger') { Object.assign(link, evaluateOriginal(link)); continue; }
    // 原链逐段独立评估，避免一段证据掩盖另一段缺口；不回写清单，也不递归追踪投影。
    const lineage = (link.originalLinkIds || []).map(id => originals.get(id)).filter(Boolean).map(evaluateOriginal);
    link.sourceEntries = sourceEntriesFor(link, { kind: 'edge', reviewedEntries: [
      ...reviewedEntries(link.sourceEntries || []), ...lineage.flatMap(original => original.sourceEntries),
    ] });
    const gaps = [...(link.sourceGaps || []), ...lineage.flatMap(original => original.sourceGaps || [])];
    if (lineage.length !== 2) gaps.push(pending('触发投影缺少完整的发出与订阅原关系'));
    if (!link.sourceEntries.length) gaps.push(pending('该关系的具体操作位置尚未完成源码核实'));
    if (gaps.length || link.sourceGaps) link.sourceGaps = uniqueValues(gaps);
  }
  return links;
}

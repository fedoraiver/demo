// 编译器模型是唯一语义输入；这里只检查分发契约并投影可见的一跳图。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { NODE_KINDS, nodeKindOf } from './architecture-kinds.mjs';
import { sourceFingerprint } from './debugdump-input.mjs';
import { scheduleNodeKind } from './schedule-graph.mjs';
import { visitNdjson } from './stream-files.mjs';

export const ANALYSIS_MODEL = 'tmp/ecs-architecture/compiler/model.json';
export const SOURCE_ROLE_LABELS = Object.freeze({
  definition: '定义位置', registration: '注册位置', create: '创建位置', destroy: '销毁位置',
  initialize: '初始化位置', insert: '插入位置', remove: '移除位置', parameter: '参数位置',
  cleanup: '清理实现', message_definition: '消息类型定义', action_definition: '动作类型定义',
  build: '构建实现', install: '安装位置', assembly: '装配位置', run: '运行入口',
  configure: '配置位置', implementation: '实际实现', close: '关闭位置', related: '相关实现',
  operation: '操作位置', call: '调用位置',
});
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const requireCondition = (value, message) => { if (!value) throw new Error(message); };
const unique = values => [...new Set(values)];
const explanatory = new Set(['Note', 'Lifecycle note', 'BSN layout', 'Operation result']);
const sourceEntry = entry => entry && typeof entry.path === 'string' && Number.isSafeInteger(entry.line);
const guardKinds = new Set(['condition', 'unless', 'match-value', 'match-arm']);

export function summarizeAnalysisGaps(model) {
  const gaps = model.analysisGaps || [];
  const counts = field => Object.fromEntries([...Map.groupBy(gaps, gap => gap[field])].sort(([a], [b]) => a.localeCompare(b)).map(([key, entries]) => [key, entries.length]));
  return { count: gaps.length, byKind: counts('kind'), byUnit: counts('unit') };
}

function safeRelative(filename) {
  requireCondition(typeof filename === 'string' && filename && !/[\u0000-\u001f\\:<>"|?*]/.test(filename)
    && !path.isAbsolute(filename) && !path.win32.isAbsolute(filename)
    && filename.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe compiler source path: ' + filename);
  return filename;
}

export function sourceKey(source) {
  safeRelative(source?.path);
  if (!source.dependency) return source.path;
  const { name, version } = source.dependency;
  requireCondition(typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name)
    && typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(version), 'Invalid compiler dependency identity');
  return `cargo/${name}-${version}/${source.path}`;
}

function sourceFilename(workspace, source) {
  const root = source.dependency ? source.dependency.root : workspace;
  requireCondition(typeof root === 'string' && path.isAbsolute(root), 'Missing compiler source package root');
  const filename = path.resolve(root, safeRelative(source.path));
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(filename));
  requireCondition(relative && relative !== '..' && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative) && fs.statSync(filename).isFile(), 'Compiler source escapes its package: ' + source.path);
  return filename;
}

export function compilerCallGraphFile(model, modelDirectory) {
  const graph = model.callGraph;
  requireCondition(graph?.schemaVersion === 2 && graph.format === 'ndjson' && /^[a-f0-9]{64}$/.test(graph.sha256)
    && Number.isSafeInteger(graph.edgeCount) && graph.edgeCount >= 0, 'Unsupported compiler call graph sidecar');
  requireCondition(typeof modelDirectory === 'string' && path.isAbsolute(modelDirectory), 'Missing compiler call graph directory');
  const root = fs.realpathSync(modelDirectory), filename = path.resolve(root, safeRelative(graph.file));
  const relative = path.relative(root, fs.realpathSync(filename));
  requireCondition(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
    && fs.lstatSync(filename).isFile(), 'Compiler call graph escapes its model directory');
  return filename;
}

function sourceSnapshots(model, { workspace, checkSources = true } = {}) {
  const snapshots = new Map();
  for (const source of model.sourceFiles) {
    const key = sourceKey(source);
    requireCondition(!snapshots.has(key) && typeof source.content === 'string' && /^[a-f0-9]{64}$/.test(source.sha256)
      && hash(source.content) === source.sha256, 'Invalid or duplicate compiler source snapshot: ' + key);
    if (workspace && checkSources) requireCondition(fs.readFileSync(sourceFilename(workspace, source), 'utf8').replace(/\r\n/g, '\n')
      === source.content.replace(/\r\n/g, '\n'), 'Compiler source snapshot is stale: ' + key);
    snapshots.set(key, source);
  }
  return snapshots;
}

function sourceReferenceValidator(snapshots) {
  const lineCounts = new Map([...snapshots].map(([key, source]) => [key, source.content.split('\n').length]));
  return function references(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.path === 'string' && Number.isSafeInteger(value.line)) {
      const key = sourceKey(value);
      requireCondition(lineCounts.has(key) && value.line >= 1 && value.line <= lineCounts.get(key)
        && (!value.column || Number.isSafeInteger(value.column) && value.column >= 1), 'Compiler source entry has no matching snapshot: ' + key);
      requireCondition(value.guardKind === undefined || value.role === 'operation' && guardKinds.has(value.guardKind), 'Invalid compiler guard kind: ' + value.guardKind);
      return;
    }
    for (const child of Object.values(value)) references(child);
  };
}

// 候选组以编译器端点为准；unresolved 根上下文不补造组所有者或互斥关系。
function validateEntityAlternatives(model, registry) {
  const groups = new Map(), templates = new Set(), contexts = new Map(), selections = new Set(['one-of', 'unresolved']);
  const contextFields = ['alternativeGroups', 'alternativeGroup', 'alternativeSelection', 'alternativeContext', 'possible'];
  const identity = value => typeof value === 'string' && value.trim();
  const contextArray = value => Array.isArray(value) && value.every(identity) && new Set(value).size === value.length;
  const context = (record, label) => {
    requireCondition(record.possible === undefined || typeof record.possible === 'boolean', 'Invalid compiler entity possibility: ' + label);
    requireCondition(record.alternativeGroup == null || identity(record.alternativeGroup), 'Invalid compiler alternative group: ' + label);
    requireCondition(record.alternativeSelection == null || selections.has(record.alternativeSelection), 'Invalid compiler alternative selection: ' + label);
    requireCondition((record.alternativeGroup == null) === (record.alternativeSelection == null)
      && (record.alternativeGroup == null || record.possible === true), 'Inconsistent compiler alternative context: ' + label);
    const explicit = contextFields.some(field => Object.hasOwn(record, field));
    requireCondition(!explicit || contextArray(record.alternativeContext)
      && record.possible === (record.alternativeContext.length > 0)
      && (record.alternativeGroup == null || record.alternativeContext.at(-1) === record.alternativeGroup),
    'Invalid compiler entity alternative context: ' + label);
    contexts.set(record.id, record.alternativeContext || []);
  };
  for (const object of model.objects) {
    if (object.kind !== 'Entity') {
      requireCondition(!contextFields.some(field => Object.hasOwn(object, field)),
        'Compiler alternative metadata requires an Entity: ' + object.id);
      continue;
    }
    context(object, object.id);
    if (object.templateId !== undefined) {
      requireCondition(identity(object.templateId) && !templates.has(object.templateId), 'Invalid or duplicate compiler entity template: ' + object.id);
      templates.add(object.templateId);
    }
    requireCondition(object.alternativeGroups === undefined || Array.isArray(object.alternativeGroups), 'Invalid compiler alternative group list: ' + object.id);
  }
  for (const object of model.objects.filter(object => object.kind === 'Entity')) {
    for (const group of object.alternativeGroups || []) {
      requireCondition(group && identity(group.id) && !groups.has(group.id) && selections.has(group.selection)
        && Array.isArray(group.candidates) && group.candidates.length && new Set(group.candidates).size === group.candidates.length
        && Array.isArray(group.sourceEntries) && group.sourceEntries.every(sourceEntry), 'Invalid compiler alternative group: ' + object.id);
      for (const candidateId of group.candidates) {
        const candidate = registry.get(candidateId);
        requireCondition(candidateId !== object.id && candidate?.kind === 'Entity', 'Invalid compiler alternative candidate endpoint: ' + group.id);
        requireCondition(candidate.possible === true && candidate.alternativeGroup === group.id && candidate.alternativeSelection === group.selection
          && isDeepStrictEqual(contexts.get(candidateId), [...contexts.get(object.id), group.id]),
          'Compiler alternative candidate crosses its group: ' + candidateId);
      }
      groups.set(group.id, { ...group, owner: object.id, linked: new Set() });
    }
  }
  const unresolvedRoots = new Set();
  for (const object of model.objects.filter(object => object.kind === 'Entity' && object.alternativeGroup != null)) {
    const group = groups.get(object.alternativeGroup);
    requireCondition(group ? group.candidates.includes(object.id) : object.alternativeSelection === 'unresolved',
      'Unknown compiler alternative context: ' + object.id);
    if (!group) {
      requireCondition(isDeepStrictEqual(contexts.get(object.id), [object.alternativeGroup]), 'Invalid unresolved compiler root context: ' + object.id);
      unresolvedRoots.add(object.id);
    }
  }
  const structuralChildren = new Map(), nested = new Set();
  const structuralLink = (from, to) => {
    if (!structuralChildren.has(from)) structuralChildren.set(from, []);
    structuralChildren.get(from).push(to); nested.add(to);
  };
  for (const relation of model.relations) {
    requireCondition(relation.possible === undefined || typeof relation.possible === 'boolean', 'Invalid compiler relationship possibility: ' + relation.id);
    requireCondition(relation.alternativeGroup == null || identity(relation.alternativeGroup) && relation.possible === true,
      'Invalid compiler relationship alternative group: ' + relation.id);
    if (relation.kind === 'alternative') {
      const group = groups.get(relation.alternativeGroup);
      requireCondition(group && relation.possible === true && relation.selection === group.selection && relation.from === group.owner
        && group.candidates.includes(relation.to) && !group.linked.has(relation.to), 'Invalid compiler alternative relationship: ' + relation.id);
      requireCondition(contextArray(relation.alternativeContext) && isDeepStrictEqual(relation.alternativeContext, contexts.get(relation.to)),
        'Compiler alternative relationship crosses its context: ' + relation.id);
      requireCondition(isDeepStrictEqual(relation.sourceEntries, group.sourceEntries), 'Compiler alternative relationship evidence differs from its group: ' + relation.id);
      group.linked.add(relation.to); structuralLink(relation.from, relation.to);
    } else {
      const entityId = relation.kind === 'create' ? relation.to : ['contains', 'relationship'].includes(relation.kind) ? relation.from : null;
      const entity = registry.get(entityId);
      const requiresContext = contexts.get(entityId)?.length > 0
        && (['create', 'contains'].includes(relation.kind) || relation.kind === 'relationship' && relation.evidence === 'assembly');
      if (requiresContext || ['possible', 'alternativeGroup', 'alternativeContext'].some(field => Object.hasOwn(relation, field))) {
        requireCondition(entity?.kind === 'Entity' && relation.possible === entity.possible
          && (relation.alternativeGroup ?? null) === (entity.alternativeGroup ?? null)
          && relation.selection === undefined && contextArray(relation.alternativeContext) && isDeepStrictEqual(relation.alternativeContext, contexts.get(entityId))
          && (relation.kind !== 'relationship' || registry.get(relation.to)?.kind === 'Entity'), 'Compiler relationship crosses its entity context: ' + relation.id);
      }
    }
    if (relation.kind === 'relationship' && relation.evidence === 'assembly') {
      const child = registry.get(relation.to);
      requireCondition(registry.get(relation.from)?.kind === 'Entity' && child?.kind === 'Entity' && child.alternativeGroup == null
        && isDeepStrictEqual(contexts.get(relation.from), contexts.get(relation.to)), 'Compiler child crosses its alternative context: ' + relation.id);
      structuralLink(relation.from, relation.to);
    }
  }
  for (const group of groups.values()) requireCondition(group.linked.size === group.candidates.length,
    'Missing compiler alternative relationship: ' + group.id);
  for (const root of unresolvedRoots) requireCondition(!nested.has(root), 'Unresolved compiler root is nested: ' + root);
  for (const relation of model.relations.filter(relation => relation.kind === 'create'))
    requireCondition(!nested.has(relation.to), 'Compiler create targets a nested template directly: ' + relation.id);
  const reachable = new Set([...contexts].filter(([id, groups]) => !groups.length || unresolvedRoots.has(id)).map(([id]) => id));
  const queue = [...reachable];
  for (let index = 0; index < queue.length; index++) for (const child of structuralChildren.get(queue[index]) || []) {
    if (!reachable.has(child)) { reachable.add(child); queue.push(child); }
  }
  for (const [id, groups] of contexts) requireCondition(!groups.length || reachable.has(id), 'Compiler alternative context is unreachable: ' + id);
}

// 单独检查完整调用图；架构模型仍须通过全部绑定与来源校验。
export function validateCompilerCallGraph(model, { modelDirectory, registry, snapshots } = {}) {
  const filename = compilerCallGraphFile(model, modelDirectory);
  registry ||= new Map(model.objects.map(object => [object.id, object]));
  const references = sourceReferenceValidator(snapshots || sourceSnapshots(model));
  const edgeIds = new Set(), identity = value => typeof value === 'string' && value.trim();
  const visit = edge => {
    requireCondition(edge && identity(edge.id) && !edgeIds.has(edge.id), 'Invalid or duplicate compiler call edge identity: ' + edge?.id);
    edgeIds.add(edge.id);
    requireCondition(identity(edge.caller) && (edge.callee === null || identity(edge.callee))
      && (edge.declaration === null || identity(edge.declaration)), 'Invalid compiler callable identity: ' + edge.id);
    requireCondition(Array.isArray(edge.registeredOwners) && edge.registeredOwners.every(owner => registry.has(owner)),
      'Unknown compiler call registration owner: ' + edge.id);
    requireCondition(typeof edge.deferred === 'boolean' && Array.isArray(edge.sourceEntries) && edge.sourceEntries.every(sourceEntry)
      && Array.isArray(edge.conditions) && edge.conditions.every(condition => sourceEntry(condition) && typeof condition.expression === 'string'),
    'Invalid compiler call evidence: ' + edge.id);
    references(edge);
  };
  const result = visitNdjson(filename, visit);
  requireCondition(result.sha256 === model.callGraph.sha256, 'Compiler call graph hash mismatch');
  requireCondition(result.records === model.callGraph.edgeCount, 'Compiler call graph edge count mismatch');
  return { edgeCount: result.records, sha256: result.sha256, bytes: result.bytes };
}

export function validateCompilerModel(model, { workspace, checkSources = true, modelDirectory } = {}) {
  requireCondition(!model?.bindingErrors?.length, 'Compiler/runtime binding is incomplete: ' + JSON.stringify(model?.bindingErrors));
  requireCondition(model?.schemaVersion === 2 && Array.isArray(model.objects) && Array.isArray(model.relations)
    && Array.isArray(model.features) && Array.isArray(model.sourceFiles), 'Unsupported compiler architecture model');
  requireCondition(typeof model.compiler === 'string' && model.compiler && model.configuration != null, 'Missing compiler model provenance');
  requireCondition(model.inputs && /^[a-f0-9]{64}$/.test(model.inputs.sourceFingerprint), 'Missing compiler source fingerprint');
  if (workspace) requireCondition(model.inputs.sourceFingerprint === sourceFingerprint(workspace), 'Compiler architecture source fingerprint is stale');
  const features = new Set(), registry = new Map(), relations = new Set();
  for (const feature of model.features) {
    requireCondition(typeof feature.id === 'string' && feature.id && !features.has(feature.id)
      && typeof feature.label === 'string' && feature.label, 'Invalid compiler feature identity');
    features.add(feature.id);
  }
  for (const object of model.objects) {
    requireCondition(typeof object.id === 'string' && object.id && !registry.has(object.id), 'Duplicate compiler object identity: ' + object.id);
    requireCondition(NODE_KINDS[object.kind] && nodeKindOf(object) === object.kind, 'Unknown compiler object kind: ' + object.kind);
    requireCondition(features.has(object.feature), 'Unknown compiler object feature: ' + object.id);
    requireCondition(typeof object.name === 'string' && object.name, 'Missing compiler object name: ' + object.id);
    requireCondition(Array.isArray(object.sourceEntries) && Array.isArray(object.sourceGaps), 'Missing compiler object evidence: ' + object.id);
    if (object.typeIdentity != null) {
      const identity = object.typeIdentity;
      requireCondition(identity && typeof identity === 'object' && identity.declarationId === object.declarationId
        && typeof identity.declarationId === 'string' && identity.declarationId && typeof identity.crateName === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(identity.crateName)
        && typeof identity.defPath === 'string' && identity.defPath.startsWith(identity.crateName + '::') && typeof identity.local === 'boolean'
        && Array.isArray(identity.roles) && identity.roles.every(role => typeof role === 'string' && role)
        && new Set(identity.roles).size === identity.roles.length, 'Invalid compiler type declaration identity: ' + object.id);
      if (identity.package !== undefined) {
        const { name, version } = identity.package || {};
        requireCondition(typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name)
          && typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(version)
          && object.sourceEntries.some(entry => entry.role === 'definition' && entry.dependency?.name === name && entry.dependency.version === version),
        'Compiler type package has no definition evidence: ' + object.id);
      }
      requireCondition(identity.roles.includes(object.kind) || object.kind === 'NonSend', 'Compiler type role differs from object kind: ' + object.id);
    }
    registry.set(object.id, object);
  }
  for (const relation of model.relations) {
    requireCondition(typeof relation.id === 'string' && relation.id && !relations.has(relation.id), 'Duplicate compiler relation identity: ' + relation.id);
    requireCondition(registry.has(relation.from) && registry.has(relation.to), 'Dangling compiler relationship: ' + relation.id);
    requireCondition(Array.isArray(relation.sourceEntries || []), 'Invalid compiler relationship evidence: ' + relation.id);
    relations.add(relation.id);
  }
  validateEntityAlternatives(model, registry);
  requireCondition(model.analysisGaps === undefined || Array.isArray(model.analysisGaps), 'Invalid compiler analysis gap list');
  for (const gap of model.analysisGaps || []) {
    requireCondition(gap && ['unit', 'owner', 'kind', 'reason'].every(field => typeof gap[field] === 'string' && gap[field].trim())
      && Array.isArray(gap.sourceEntries) && gap.sourceEntries.every(sourceEntry), 'Invalid compiler analysis gap');
  }
  const snapshots = sourceSnapshots(model, { workspace, checkSources }), references = sourceReferenceValidator(snapshots);
  references({ objects: model.objects, relations: model.relations, features: model.features, analysisGaps: model.analysisGaps });
  validateCompilerCallGraph(model, { modelDirectory, registry, snapshots });
  requireCondition(model.scheduleInteractions?.schemaVersion === 1 && Array.isArray(model.scheduleInteractions.views), 'Missing compiler Schedule binding catalog');
  const bound = new Set();
  for (const view of model.scheduleInteractions.views) {
    requireCondition(typeof view.viewId === 'string' && !bound.has(view.viewId) && /^[a-f0-9]{64}$/.test(view.dotSha256)
      && Array.isArray(view.bindings), 'Invalid compiler Schedule view binding');
    bound.add(view.viewId); const names = new Set();
    for (const binding of view.bindings) {
      requireCondition(typeof binding.graphName === 'string' && !names.has(binding.graphName) && registry.has(binding.objectId)
        && ['system', 'set', 'context'].includes(binding.kind), 'Invalid compiler Schedule node binding: ' + binding.graphName);
      names.add(binding.graphName);
    }
  }
  return { registry, snapshots };
}

export function readCompilerModel(workspace, { filename = ANALYSIS_MODEL } = {}) {
  const absolute = path.resolve(workspace, filename);
  requireCondition(fs.existsSync(absolute), `Missing compiler architecture model: ${absolute}. Run the maintenance extract/model stages first`);
  const model = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  return { model, filename: absolute, ...validateCompilerModel(model, { workspace, modelDirectory: path.dirname(absolute) }) };
}

export function createCompilerObjectCatalog(model, inputRegistry) {
  const registry = inputRegistry || Object.fromEntries(model.objects.map(object => [object.id, object]));
  const objects = model.objects.filter(record => NODE_KINDS[record.kind].visualType && !explanatory.has(record.kind)).map(record => ({
    id: record.id, sourceNodeId: record.id, viewId: 'object-' + hash(record.id).slice(0, 16), feature: record.feature, kind: record.kind,
  }));
  const objectById = Object.fromEntries(objects.map(object => [object.id, object]));
  const links = model.relations.filter(link => NODE_KINDS[registry[link.from]?.kind]?.visualType && NODE_KINDS[registry[link.to]?.kind]?.visualType).map(presentRelation);
  const neighbors = new Map(objects.map(object => [object.id, []]));
  for (const link of links) for (const id of unique([link.from, link.to])) neighbors.get(id)?.push(link);
  const systemFamilies = new Map(model.objects.flatMap(record => {
    const registrations = record.registrations || [], applications = unique(registrations.map(entry => entry.application));
    if (record.kind !== 'System' || record.callableIds?.length !== 1 || typeof record.callableIds[0] !== 'string' || !record.callableIds[0]
      || (record.registrationScope && record.registrationScope !== 'runtime') || !registrations.length
      || registrations.some(entry => entry.scope !== 'runtime') || applications.length !== 1
      || typeof applications[0] !== 'string' || !applications[0].trim()) return [];
    return [[record.id, JSON.stringify([applications[0], record.callableIds[0]])]];
  }));
  function graphFor(id) {
    const object = objectById[id]; requireCondition(object, 'Unknown compiler architecture object: ' + id);
    const incident = neighbors.get(id), selected = ['Plugin', 'PluginGroup'].includes(object.kind) ? [] : object.kind === 'Entity'
      ? incident.filter(link => [link.from, link.to].every(endpoint => registry[endpoint].kind !== 'Component')) : incident;
    const ids = unique([id, ...selected.flatMap(link => [link.from, link.to])]);
    // 仅折叠当前一跳中同一应用的具体函数卡片；注册对象、关系端点及证据仍独立。
    const families = Map.groupBy(ids, endpoint => systemFamilies.has(endpoint) ? 'system:' + systemFamilies.get(endpoint) : 'object:' + endpoint);
    const displayIds = new Map(), members = new Map();
    for (const family of families.values()) {
      const display = family.includes(id) ? id : [...family].sort()[0];
      members.set(display, [...family].sort());
      for (const endpoint of family) displayIds.set(endpoint, display);
    }
    return { centerNodeId: id, empty: false, nodes: unique(ids.map(endpoint => displayIds.get(endpoint))).map(endpoint => ({ id: endpoint,
      ...(members.get(endpoint).length > 1 ? { sourceNodeIds: members.get(endpoint) } : {}),
      role: registry[endpoint].feature === object.feature ? 'internal' : 'external', group: endpoint === id ? '当前对象' : '直接关联对象' })),
    links: selected.map(link => ({ ...link,
      ...(displayIds.get(link.from) !== link.from ? { displayFrom: displayIds.get(link.from) } : {}),
      ...(displayIds.get(link.to) !== link.to ? { displayTo: displayIds.get(link.to) } : {}),
    })) };
  }
  return { objects, objectById, links, graphFor, unresolvedAccesses: [] };
}

// 查看器实体索引属于展示投影，不补造组件归属或源码事实。
export function viewerModel(model) {
  const entities = model.objects.filter(object => object.kind === 'Entity').map(entity => ({ id: entity.id, canonical_entity: entity.id,
    components: model.relations.filter(relation => (relation.operation || relation.kind) === 'contains' && [relation.from, relation.to].includes(entity.id))
      .map(relation => ({ id: relation.from === entity.id ? relation.to : relation.from })) }));
  return { ...model, entities, systems: model.objects.filter(object => ['System', 'Observer'].includes(object.kind)) };
}

// 视觉类别只映射已给出的事实类型，不改变事实端点、方向或身份。
export function presentRelation(relation) {
  const kind = ({ filter: 'reference', condition: 'reference', alternative: 'reference', event: 'observe', trigger: 'emit', mutable_access: 'write', insert: 'write', remove: 'write', initialize: 'write',
    create: 'write', modify: 'write', despawn: 'write', publish: 'write', membership: 'registration', contains: 'reference' })[relation.kind] || relation.kind;
  return kind === relation.kind ? { ...relation } : { ...relation, factKind: relation.kind, operation: relation.operation || relation.kind, kind };
}

export function bindCompilerSchedules(model, views) {
  const bindings = new Map(model.scheduleInteractions.views.map(view => [view.viewId, view]));
  requireCondition(bindings.size === views.length, 'Compiler/runtime Schedule count mismatch');
  for (const view of views) {
    const binding = bindings.get(view.id);
    requireCondition(binding && binding.dotSha256 === hash(view.dot), 'Compiler/runtime Schedule DOT binding mismatch: ' + view.id);
    const actualNames = new Set([...view.scheduleGraph.nodes.map(node => node.name), ...view.scheduleGraph.subgraphs.map(group => group.name)]);
    for (const node of binding.bindings) requireCondition(actualNames.has(node.graphName), 'Compiler binding does not exist in DOT: ' + node.graphName);
    const names = new Map(binding.bindings.map(node => [node.graphName, node]));
    for (const node of view.scheduleGraph.nodes.filter(node => scheduleNodeKind(node) === 'system'))
      requireCondition(names.get(node.name)?.kind === 'system', 'Compiler binding is missing an actual Schedule system: ' + node.name);
    for (const group of view.scheduleGraph.subgraphs.filter(group => group.name.startsWith('clusternode_Set(')))
      requireCondition(names.get(group.name)?.kind === 'set', 'Compiler binding is missing an actual Schedule set: ' + group.name);
  }
  return model.scheduleInteractions;
}

export function compilerSourceResolver(model) {
  const files = new Map(model.sourceFiles.map(source => [sourceKey(source), source]));
  return { read(source) {
    const file = files.get(sourceKey(source)); requireCondition(file, 'Missing compiler source snapshot: ' + source.path);
    return { text: file.content, lines: file.content.split(/\r?\n/) };
  } };
}

export function checkCompilerRegistry(actual, model) {
  requireCondition(isDeepStrictEqual(actual, Object.fromEntries(model.objects.map(object => [object.id, object]))), 'Rendered object registry differs from compiler model');
}

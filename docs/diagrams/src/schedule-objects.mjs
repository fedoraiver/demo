// 调度实例与声明对象分离；只扩充对象目录，不重写 Graphviz 原始图形或关系。
import crypto from 'node:crypto';
import { scheduleNodeKind, validateScheduleGraph } from './schedule-graph.mjs';
import { createScheduleSourceCatalog } from './schedule-source-catalog.mjs';
import { SCHEDULE_OBJECT_MAPPING_VERSION, EXISTING_SCHEDULE_SYSTEM_NAMES, EXISTING_SCHEDULE_SET_DECLARATIONS, EXISTING_MAIN_WORLD_RESOURCE_NAMES, SCHEDULE_CONTEXT_DECLARATIONS, SCHEDULE_REVIEWED_REGISTRATION_SPLITS } from '../catalog/schedule-object-mappings.mjs';

export const SCHEDULE_INTERACTION_VERSION = 1;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const hash = values => sha256(JSON.stringify(values)).slice(0, 16);
const unique = values => [...new Set(values.filter(Boolean))];
const distinct = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
const displayType = fullName => fullName.replace(/\b(?:[A-Za-z_]\w*::)+([A-Za-z_]\w*)/g, '$1');
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };
const recordsOf = model => [...(model.systems || []), ...(model.resources || []), ...(model.nodes || [])];
const scheduleLabel = value => String(value || '').replace(/\b(?:AppState|PlayState)::/g, '').replace(/\s+/g, '');
const matchesSchedule = (record, view) => (record.registrations || [{ schedule: record.schedule }]).some(registration =>
  (!registration.application ? view.application === 'main' : registration.application === view.application)
  && scheduleLabel(registration.schedule) === scheduleLabel(view.scheduleLabel));
const bindingId = (viewId, dotSha256, kind, graphName) => 'schedule-node-' + hash([viewId, dotSha256, kind, graphName]);

function projectSystemName(record) {
  const override = EXISTING_SCHEDULE_SYSTEM_NAMES[record.id];
  if (override) return override;
  if (!record.source?.path?.startsWith('src/') || !record.module || !/^[A-Za-z_]\w*$/.test(record.name)) return null;
  const module = record.source.path.replace(/^src\//, '').replace(/(?:\/)?(?:main|lib|mod)\.rs$/, '').replace(/\.rs$/, '').split('/').filter(Boolean).join('::');
  return 'demo::' + (module ? module + '::' : '') + record.name;
}

function sourceFeature(info, fullName, model) {
  const identity = fullName || info.fullName, definition = info.definition || info.sourceEntries?.find(entry => entry.role === 'definition');
  const packageName = definition?.dependency?.name || (definition?.path?.startsWith('src/') ? 'demo' : identity?.match(/^([A-Za-z_]\w*)::/)?.[1]) || info.sourceEntries?.find(entry => entry.dependency)?.dependency.name;
  if (['avian3d', 'bevy_transform_interpolation'].includes(packageName)) return 'avian';
  if (['bevy_egui', 'bevy_inspector_egui', 'bevy-inspector-egui'].includes(packageName)) return 'egui';
  if (packageName === 'bevy_enhanced_input') return 'enhanced_input';
  if (packageName === 'bevy_kira_audio') return 'kira';
  const candidates = packageName === 'demo' ? [definition?.path?.split('/')[1], identity?.split('::')[1]] : [];
  return candidates.find(id => model.features?.some(feature => feature.id === id)) || 'infrastructure';
}

/** 展开真实容器和多集合成员边，marker 只用于桥接集合身份。 */
export function scheduleSetMembers(graph) {
  const { nodes, groups, parents, directOwners } = validateScheduleGraph(graph);
  const members = new Map(graph.subgraphs.map(group => [group.name, new Set(group.nodes)]));
  const membership = graph.edges.filter(edge => edge.attributes.dir === 'none');
  for (const [name, collected] of members) {
    let previous = -1;
    while (previous !== collected.size) {
      previous = collected.size;
      for (const edge of membership) {
        if (!collected.has(edge.head)) continue;
        collected.add(edge.tail);
        const owner = directOwners.get(edge.tail);
        if (scheduleNodeKind(nodes.get(edge.tail)) === 'marker' && owner) for (const member of groups.get(owner).nodes) collected.add(member);
      }
    }
    members.set(name, new Set([...collected].filter(name => scheduleNodeKind(nodes.get(name)) === 'system')));
  }
  return { nodes, groups, parents, directOwners, members };
}

function evidence(occurrence, kind = occurrence.kind) {
  return { schemaVersion: 1, kind, occurrences: [{ viewId: occurrence.viewId, dotSha256: occurrence.dotSha256, graphName: occurrence.graphName, kind: occurrence.kind }] };
}

function newRecord(id, occurrence, info, model) {
  requireCondition(info && typeof info.description === 'string' && info.description.trim(), 'Missing reviewed Schedule description: ' + occurrence.fullName);
  const sourceEntries = distinct(info.sourceEntries || []), definition = info.definition || sourceEntries.find(source => source.role === 'definition');
  return {
    id, name: info.name || occurrence.label || occurrence.fullName, kind: info.kind || (occurrence.kind === 'set' ? 'SystemSet' : 'System'),
    description: info.description, display_summary: info.display_summary || info.description,
    feature: info.feature || sourceFeature(info, occurrence.fullName, model), module: info.module || occurrence.fullName?.match(/^([A-Za-z_]\w*)::/)?.[1] || 'engine',
    ...(occurrence.kind === 'context' ? {} : { registered_by: occurrence.application + ' / ' + occurrence.scheduleLabel }), schedule: occurrence.scheduleLabel,
    registrations: [{ application: occurrence.application, schedule: occurrence.scheduleLabel, scope: occurrence.kind === 'context' ? 'dependency-target' : 'runtime' }],
    reads: [], writes: [], filters: unique(info.filters || []), events: unique(info.events || []),
    notes: unique([...(info.notes || []), ...(occurrence.kind === 'context' ? ['此卡片是原生调度依赖端点，不记录为本调度中的系统执行实例。'] : [])]), ...(info.fields?.length ? { fields: [...info.fields] } : {}),
    sourceEntries, sourceGaps: unique(info.sourceGaps || []), ...(definition ? { definition_source: definition } : {}),
    scheduleEvidence: evidence(occurrence), ...(occurrence.fullName ? { scheduleFullName: occurrence.fullName } : {}),
  };
}

function setDeclarationKey(info) {
  const packageName = (info.definition?.dependency?.name || info.sourceEntries?.find(entry => entry.dependency)?.dependency.name || 'demo').replaceAll('-', '_');
  const name = info.name || info.fullName || '';
  const localName = /(?:^|::)([A-Z][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?)$/.exec(name)?.[1];
  return localName ? packageName + '\0' + localName : null;
}

export function buildScheduleObjects({ model: input, views, repository, metadata, resolver, sourceCatalog }) {
  const model = structuredClone(input), source = sourceCatalog || createScheduleSourceCatalog({ repository, metadata, resolver });
  model.systems ||= []; model.nodes ||= []; model.system_links ||= [];
  const originalRecords = recordsOf(model), byId = new Map(originalRecords.map(record => [record.id, record]));
  const systems = new Map(), knownSets = new Map(), existingResources = new Map();
  const registrationSplits = [];
  for (const [id, split] of Object.entries(SCHEDULE_REVIEWED_REGISTRATION_SPLITS)) {
    const record = byId.get(id); if (!record) continue;
    requireCondition(projectSystemName(record) === split.fullName, 'Reviewed Schedule split no longer identifies the same declaration: ' + id);
    record.registrations = (record.registrations || []).filter(registration => scheduleLabel(registration.schedule) === scheduleLabel(split.reuse.schedule)
      && (registration.application || 'main') === split.reuse.application);
    requireCondition(record.registrations.length === 1, 'Reviewed Schedule split is missing its original registration: ' + id);
    registrationSplits.push({ record, ...split });
  }
  for (const record of originalRecords.filter(record => record.kind === 'System')) {
    const name = projectSystemName(record);
    if (name) { if (!systems.has(name)) systems.set(name, []); systems.get(name).push(record); }
  }
  for (const [id, [packageName, localName]] of Object.entries(EXISTING_SCHEDULE_SET_DECLARATIONS)) if (byId.has(id)) knownSets.set(packageName + '\0' + localName, id);
  for (const record of originalRecords.filter(record => ['Resource', 'NonSend', 'Messages<T>'].includes(record.kind || 'Resource'))) {
    const authored = EXISTING_MAIN_WORLD_RESOURCE_NAMES[record.id], fullName = record.fullName || record.rust_type || authored;
    const world = record.application || record.world || (authored ? 'main' : null);
    if (!fullName || !world) continue;
    const key = JSON.stringify([record.kind || 'Resource', fullName, world]);
    requireCondition(!existingResources.has(key), 'Ambiguous existing Schedule resource identity: ' + fullName + ' / ' + world);
    existingResources.set(key, record.id);
  }
  const interactions = { schemaVersion: SCHEDULE_INTERACTION_VERSION, views: [] }, newSystems = [], accessed = new Map(), accessDescriptions = new Map();
  const addRecord = record => {
    requireCondition(!byId.has(record.id), 'Duplicate Schedule object identity: ' + record.id);
    byId.set(record.id, record); (record.scheduleEvidence?.kind === 'system' ? model.systems : model.nodes).push(record);
    return record;
  };
  const linkKeys = new Map(model.system_links.map(link => [JSON.stringify([link.kind, link.from, link.to, link.label || '']), link]));
  function addLink(from, to, kind, label, occurrence, relation, sources = [], edgeIndex) {
    if (!from || !to || from === to) return;
    const key = JSON.stringify([kind, from, to, label || '']);
    const relationEvidence = { viewId: occurrence.viewId, dotSha256: occurrence.dotSha256, relation, ...(edgeIndex === undefined ? {} : { edgeIndex }) };
    if (linkKeys.has(key)) {
      const previous = linkKeys.get(key);
      if (previous.scheduleEvidence) {
        previous.sourceEntries = distinct([...(previous.sourceEntries || []), ...sources]);
        previous.scheduleEvidence.occurrences = distinct([...previous.scheduleEvidence.occurrences, ...evidence(occurrence).occurrences]);
        previous.scheduleEvidence.relations = distinct([...previous.scheduleEvidence.relations, relationEvidence]);
      }
      return previous;
    }
    const link = { id: 'schedule-relation-' + hash([occurrence.viewId, relation, edgeIndex ?? null, key]), from, to, kind, label: label || '',
      sourceEntries: distinct(sources), scheduleEvidence: { ...evidence(occurrence), relations: [relationEvidence] } };
    linkKeys.set(key, link); model.system_links.push(link); return link;
  }
  const configurationSources = record => (record?.sourceEntries || []).filter(source => ['registration', 'configure'].includes(source.role));
  for (const view of views.filter(view => view.aspect === 'schedule')) {
    requireCondition(typeof view.id === 'string' && typeof view.dot === 'string' && typeof view.application === 'string' && typeof view.scheduleLabel === 'string', 'Invalid Schedule object input');
    const dotSha256 = sha256(view.dot), graph = view.scheduleGraph, context = scheduleSetMembers(graph), mapped = new Map();
    const entry = { viewId: view.id, dotSha256, bindings: [] }, occurrenceFor = (kind, graphName, label, fullName) => ({
      viewId: view.id, dotSha256, application: view.application, scheduleLabel: view.scheduleLabel, graphName, kind, label, fullName,
    });
    const bind = (occurrence, objectId) => {
      requireCondition(!mapped.has(occurrence.graphName), 'Duplicate Schedule binding: ' + occurrence.graphName);
      mapped.set(occurrence.graphName, objectId);
      entry.bindings.push({ id: bindingId(view.id, dotSha256, occurrence.kind, occurrence.graphName), kind: occurrence.kind, graphName: occurrence.graphName, objectId });
    };
    for (const node of graph.nodes.filter(node => scheduleNodeKind(node) === 'system')) {
      const occurrence = occurrenceFor('system', node.name, node.attributes.label, node.attributes.tooltip);
      const existing = (systems.get(occurrence.fullName) || []).filter(record => matchesSchedule(record, view));
      requireCondition(existing.length < 2, 'Ambiguous existing Schedule system: ' + occurrence.fullName + ' / ' + view.scheduleLabel);
      if (existing.length) {
        const info = source.resolveSystem(occurrence.fullName, { ...occurrence, skipParameterAccess: true });
        newSystems.push({ occurrence, record: existing[0], accesses: [], bodyOperations: info.bodyOperations || [], bodySourceGaps: info.sourceGaps || [] });
        bind(occurrence, existing[0].id); continue;
      }
      const split = registrationSplits.find(split => split.fullName === occurrence.fullName && split.instances.some(registration => registration.application === view.application && scheduleLabel(registration.schedule) === scheduleLabel(view.scheduleLabel)));
      const info = source.resolveSystem(occurrence.fullName, { ...occurrence, ...(split ? { skipParameterAccess: true } : {}) }), id = 'schedule-system-' + hash([view.application, view.scheduleLabel, node.name, occurrence.fullName]);
      const record = addRecord(newRecord(id, occurrence, info, model));
      if (split) {
        for (const field of ['source', 'reads', 'writes', 'filters', 'events', 'fields', 'component_accesses', 'accesses']) if (split.record[field] !== undefined) record[field] = structuredClone(split.record[field]);
        record.registered_by = split.record.registered_by;
        record.registrations = split.instances.filter(registration => registration.application === view.application && scheduleLabel(registration.schedule) === scheduleLabel(view.scheduleLabel)).map(registration => ({ ...structuredClone(registration), schedule: view.scheduleLabel }));
        const family = unique([...(split.record.registrationFamilyIds || []), split.record.id, id]);
        record.registrationFamilyIds = family; split.record.registrationFamilyIds = family;
        record.declarationEvidenceFrom = split.record.id;
        for (const original of input.system_links || []) if (['read', 'write', 'reference', 'trigger'].includes(original.kind) && (original.from === split.record.id || original.to === split.record.id)) {
          const from = original.from === split.record.id ? id : original.from, to = original.to === split.record.id ? id : original.to;
          const copied = addLink(from, to, original.kind, original.label, occurrence, 'shared-declaration', original.sourceEntries || []);
          if (copied) for (const field of ['operation', 'evidence', 'notes', 'sourceGaps', 'projectionIds']) if (original[field] !== undefined) copied[field] = structuredClone(original[field]);
        }
      }
      newSystems.push({ occurrence, record, accesses: split ? [] : info.accesses || [], bodyOperations: info.bodyOperations || [] }); bind(occurrence, id);
    }
    for (const group of graph.subgraphs) {
      const names = [...context.members.get(group.name)].map(name => context.nodes.get(name).attributes.tooltip);
      const occurrence = occurrenceFor('set', group.name, group.attributes.label, null);
      const info = source.resolveSet(group.attributes.label, occurrence, names), existing = knownSets.get(setDeclarationKey(info));
      if (existing) { bind(occurrence, existing); continue; }
      const id = 'schedule-set-' + hash([view.application, view.scheduleLabel, group.name]);
      bind(occurrence, addRecord(newRecord(id, occurrence, { ...info, kind: 'SystemSet' }, model)).id);
    }
    const endpoint = (name, cluster) => cluster ? mapped.get(cluster) : mapped.get(name) || mapped.get(context.directOwners.get(name));
    // 旧同步对象表达特定命令边界，只有原始两侧依赖都吻合时才能复用。
    for (const existing of originalRecords.filter(record => record.kind === 'Synchronization' && matchesSchedule(record, view))) {
      const before = (input.system_links || []).filter(link => ['order', 'dependency'].includes(link.kind) && link.to === existing.id);
      const after = (input.system_links || []).filter(link => ['order', 'dependency'].includes(link.kind) && link.from === existing.id);
      if (!before.length || !after.length) continue;
      const candidates = graph.nodes.filter(node => node.attributes.tooltip === 'bevy_ecs::apply_deferred' && byId.get(mapped.get(node.name))?.scheduleEvidence)
        .filter(node => before.every(link => graph.edges.some(edge => edge.head === node.name && endpoint(edge.tail, edge.attributes.ltail) === link.from))
          && after.every(link => graph.edges.some(edge => edge.tail === node.name && endpoint(edge.head, edge.attributes.lhead) === link.to)));
      if (candidates.length !== 1) continue;
      const node = candidates[0], previous = mapped.get(node.name), binding = entry.bindings.find(binding => binding.graphName === node.name);
      byId.delete(previous); model.systems = model.systems.filter(record => record.id !== previous);
      const pending = newSystems.findIndex(item => item.record.id === previous); if (pending >= 0) newSystems.splice(pending, 1);
      mapped.set(node.name, existing.id); binding.objectId = existing.id;
    }
    for (const node of graph.nodes.filter(node => scheduleNodeKind(node) === 'context')) {
      const occurrence = occurrenceFor('context', node.name, node.name, null), declaration = SCHEDULE_CONTEXT_DECLARATIONS[node.name];
      const info = source.resolveContext?.(node.name, occurrence, declaration) || resolveContextSource(declaration, occurrence, resolver);
      const id = 'schedule-context-' + hash([view.application, view.scheduleLabel, node.name]);
      bind(occurrence, addRecord(newRecord(id, occurrence, info, model)).id);
    }
    const scheduleOccurrence = occurrenceFor('schedule', view.id, view.application + ' · ' + view.scheduleLabel, null);
    const scheduleId = 'schedule-registration-' + hash([view.application, view.scheduleLabel]);
    const sources = distinct(entry.bindings.flatMap(binding => configurationSources(byId.get(binding.objectId))));
    addRecord({ id: scheduleId, name: scheduleOccurrence.label, kind: 'Engine flow', feature: 'infrastructure',
      description: '应用 ' + view.application + ' 中已注册的 ' + view.scheduleLabel + ' 调度。成员与顺序来自 finish 后的真实注册快照，不表示系统已执行或运行条件已满足。',
      display_summary: '保存本应用调度的注册上下文与成员。', sourceEntries: sources, sourceGaps: [], scheduleEvidence: evidence(scheduleOccurrence, 'schedule') });
    for (const binding of entry.bindings) {
      const occurrence = occurrenceFor(binding.kind, binding.graphName);
      if (binding.kind === 'context') addLink(scheduleId, binding.objectId, 'reference', '依赖端点', occurrence, 'context', configurationSources(byId.get(binding.objectId)));
      else addLink(scheduleId, binding.objectId, 'registration', view.application + ' / ' + view.scheduleLabel, occurrence, 'registration', configurationSources(byId.get(binding.objectId)));
    }
    for (const [child, parent] of context.parents) addLink(mapped.get(parent), mapped.get(child), 'registration', '', occurrenceFor('set', child), 'membership', configurationSources(byId.get(mapped.get(child))));
    for (const node of graph.nodes.filter(node => scheduleNodeKind(node) !== 'marker')) {
      const owner = context.directOwners.get(node.name);
      if (owner) addLink(mapped.get(owner), mapped.get(node.name), 'registration', '', occurrenceFor(scheduleNodeKind(node), node.name), 'membership', configurationSources(byId.get(mapped.get(node.name))));
    }
    graph.edges.forEach((edge, edgeIndex) => {
      const from = endpoint(edge.tail, edge.attributes.ltail), to = endpoint(edge.head, edge.attributes.lhead), occurrence = occurrenceFor(scheduleNodeKind(context.nodes.get(edge.tail)), edge.tail);
      requireCondition(from && to, 'Unmapped Schedule relation endpoint: ' + view.id + '/' + edgeIndex);
      if (edge.attributes.dir === 'none') addLink(to, from, 'registration', '', occurrence, 'membership', configurationSources(byId.get(from)), edgeIndex);
      else addLink(from, to, 'order', '', occurrence, 'order', distinct([...configurationSources(byId.get(from)), ...configurationSources(byId.get(to))]), edgeIndex);
    });
    interactions.views.push(entry);
  }
  function accessObject(occurrence, record, access, body = false) {
    if (!access.fullName) { (record.sourceGaps ||= []).push('访问类型尚未确定完整声明身份：' + access.type); return null; }
    const scope = access.kind === 'Local' ? record.id + (access.parameterKey ? '\0' + access.parameterKey : '') : ['Resource', 'NonSend', 'Messages<T>'].includes(access.kind) ? access.scope === 'main' ? 'main' : occurrence.application : 'declaration';
    const key = JSON.stringify([access.kind, access.fullName, scope]); let id = accessed.get(key) || existingResources.get(key);
    if (id) accessed.set(key, id);
    if (!id) {
      id = 'schedule-access-' + hash([key]); accessed.set(key, id);
      const sources = distinct((body ? access.typeSourceEntries : access.sourceEntries) || []), definition = access.definition || sources.find(source => source.role === 'definition');
      const description = access.description || '声明类型 ' + access.fullName + '，由调度系统的 ' + access.kind + ' 参数或查询访问；此卡片表示类型与访问范围，不指定项目实体投影。';
      accessDescriptions.set(id, new Set([description]));
      addRecord({ id, name: displayType(access.fullName), kind: access.kind, feature: sourceFeature({ ...access, definition }, access.fullName, model),
        description,
        display_summary: access.display_summary || '承载调度系统参数或查询访问的数据。', scheduleFullName: access.fullName,
        fields: unique([...(access.fields || []), ...(access.usageContexts || []).map(context => '已核实使用场景：' + context), ...(access.kind === 'Local' && access.parameterKey ? ['系统参数：' + access.parameterKey] : [])]),
        usageContexts: unique(access.usageContexts || []), ...(access.kind === 'Local' && access.parameterKey ? { parameterKey: access.parameterKey } : {}),
        sourceEntries: sources, sourceGaps: unique([...(access.sourceGaps || []), ...(!definition ? ['类型定义尚未唯一定位；当前仅核实' + (body ? '函数体操作入口' : '系统参数或查询入口') + '，不为原生类型、标准容器或未知声明补造项目内定义。'] : [])]),
        ...(definition ? { definition_source: definition } : {}), scheduleEvidence: evidence(occurrence, 'access') });
    } else if (byId.get(id).scheduleEvidence?.kind === 'access') {
      const target = byId.get(id); target.sourceEntries = distinct([...target.sourceEntries, ...((body ? access.typeSourceEntries : access.sourceEntries) || [])]);
      target.scheduleEvidence.occurrences = distinct([...target.scheduleEvidence.occurrences, ...evidence(occurrence).occurrences]);
      if (access.description) accessDescriptions.get(id).add(access.description);
      target.description = [...accessDescriptions.get(id)].join('\n\n');
      target.usageContexts = unique([...target.usageContexts, ...(access.usageContexts || [])]);
      target.fields = unique([...target.fields, ...(access.fields || []), ...(access.usageContexts || []).map(context => '已核实使用场景：' + context)]);
      target.sourceGaps = unique([...target.sourceGaps, ...(access.sourceGaps || [])]);
    }
    return id;
  }
  for (const { occurrence, record, accesses, bodyOperations = [], bodySourceGaps = [] } of newSystems) {
    for (const access of accesses) {
    requireCondition(['Component', 'Resource', 'Messages<T>', 'Local', 'NonSend', 'SystemParam', 'QueryData'].includes(access.kind) && ['read', 'write', 'filter', 'reference'].includes(access.operation), 'Invalid reviewed Schedule access');
    const id = accessObject(occurrence, record, access); if (!id) continue;
    if (['read', 'write'].includes(access.operation)) (record[access.operation === 'write' ? 'writes' : 'reads'] ||= []).push(id);
    const link = addLink(access.operation === 'write' ? record.id : id, access.operation === 'write' ? id : record.id, ['filter', 'reference'].includes(access.operation) ? 'reference' : access.operation,
      access.operation === 'filter' ? '存在 / 变更过滤' : access.operation === 'reference' ? '参数 / 查询数据' : '', occurrence, 'access', access.sourceEntries || []);
    if (link) Object.assign(link, { operation: access.operation, evidence: ['declaration'], registrationIds: [record.id] });
    }
    if (bodySourceGaps.length) record.sourceGaps = unique([...(record.sourceGaps || []), ...bodySourceGaps]);
    for (const operation of bodyOperations) {
      requireCondition(['Component', 'Resource', 'Messages<T>', 'NonSend', 'EntityEvent', 'QueryData'].includes(operation.kind)
        && ['insert', 'remove', 'initialize', 'read', 'mutable_access', 'trigger', 'reference', 'publish'].includes(operation.operation)
        && ['commands', 'world', 'message_writer'].includes(operation.via)
        && Array.isArray(operation.sourceEntries) && operation.sourceEntries.some(entry => entry.role === 'operation'), 'Invalid reviewed Schedule body operation');
      requireCondition((operation.kind !== 'EntityEvent' || operation.operation === 'trigger') && (operation.kind !== 'QueryData' || operation.operation === 'reference')
        && (operation.kind !== 'Messages<T>' || ['publish', 'read', 'mutable_access'].includes(operation.operation)), 'Invalid reviewed Schedule body target');
      const id = accessObject(occurrence, record, operation, true); if (!id) continue;
      const reading = ['read', 'reference'].includes(operation.operation), kind = operation.operation === 'trigger' ? 'trigger' : operation.operation === 'reference' ? 'reference' : reading ? 'read' : 'write';
      const labels = { insert: '添加', remove: '移除', initialize: '初始化', read: '只读访问', mutable_access: '可变访问', trigger: '触发事件', reference: '查询数据', publish: '发布消息' };
      const label = (operation.deferred ? '延迟' : '正文') + labels[operation.operation];
      record.bodyOperations = distinct([...(record.bodyOperations || []), { objectId: id, operation: operation.operation, via: operation.via, method: operation.method,
        deferred: operation.deferred === true, scope: operation.scope || 'current', sourceEntries: distinct(operation.sourceEntries),
        ...(operation.condition ? { condition: operation.condition } : {}), ...(operation.helper ? { helper: operation.helper } : {}) }]);
      const link = addLink(reading ? id : record.id, reading ? record.id : id, kind, label, occurrence, 'body-operation', operation.sourceEntries);
      if (link) Object.assign(link, { operation: operation.operation, evidence: unique([...(link.evidence || []), 'body']), registrationIds: unique([...(link.registrationIds || []), record.id]),
        bodyOperations: distinct([...(link.bodyOperations || []), { operation: operation.operation, via: operation.via, method: operation.method, deferred: operation.deferred === true,
          scope: operation.scope || 'current', ...(operation.condition ? { condition: operation.condition } : {}), ...(operation.helper ? { helper: operation.helper } : {}) }]) });
    }
  }
  for (const record of byId.values()) if (record.scheduleEvidence) for (const field of ['reads', 'writes', 'sourceGaps']) if (record[field]) record[field] = unique(record[field]);
  validateScheduleInteractions(interactions, views, new Set(byId.keys()));
  return { model, scheduleInteractions: interactions, mappingVersion: SCHEDULE_OBJECT_MAPPING_VERSION };
}

function resolveContextSource(declaration, occurrence, resolver) {
  requireCondition(declaration && resolver, 'Missing reviewed Schedule context: ' + occurrence.graphName);
  const definition = resolver.resolve({ package: declaration.package, path: declaration.path, symbol: declaration.symbol, kind: declaration.declarationKind });
  const sourceEntries = declaration.kind === 'Synchronization' ? [{ ...definition, role: 'definition', label: '实际同步类型：' + declaration.symbol }] : [];
  if (declaration.configuration) {
    const file = resolver.read(definition), lines = file.lines, matches = lines.flatMap((line, index) => line.includes(declaration.configuration.contains) ? [index + 1] : []);
    requireCondition(matches.length === 1, 'Ambiguous Schedule context configuration: ' + occurrence.graphName);
    sourceEntries.push({ ...definition, line: matches[0], role: 'configure', label: '缺失目标的真实 after 配置' });
  }
  return { kind: declaration.kind, name: declaration.name, description: declaration.description, display_summary: declaration.display_summary,
    ...(declaration.kind === 'Synchronization' ? { definition } : {}), sourceEntries, sourceGaps: [] };
}

export function validateScheduleInteractions(catalog, views, objectIds) {
  requireCondition(catalog?.schemaVersion === SCHEDULE_INTERACTION_VERSION && Array.isArray(catalog.views), 'Invalid Schedule interaction version');
  const schedules = views.filter(view => view.aspect === 'schedule'), entries = new Map(catalog.views.map(entry => [entry.viewId, entry]));
  requireCondition(entries.size === catalog.views.length && entries.size === schedules.length, 'Schedule interaction view coverage mismatch');
  for (const view of schedules) {
    const entry = entries.get(view.id), dotSha256 = sha256(view.dot), expected = new Map([
      ...view.scheduleGraph.nodes.filter(node => scheduleNodeKind(node) !== 'marker').map(node => [node.name, scheduleNodeKind(node)]),
      ...view.scheduleGraph.subgraphs.map(group => [group.name, 'set']),
    ]);
    requireCondition(entry?.dotSha256 === dotSha256 && Array.isArray(entry.bindings), 'Schedule interaction DOT hash mismatch: ' + view.id);
    const names = new Set(), ids = new Set();
    for (const binding of entry.bindings) {
      requireCondition(expected.get(binding.graphName) === binding.kind && !names.has(binding.graphName) && !ids.has(binding.id)
        && binding.id === bindingId(view.id, dotSha256, binding.kind, binding.graphName) && typeof binding.objectId === 'string' && binding.objectId.length
        && (!objectIds || objectIds.has(binding.objectId)), 'Invalid Schedule interaction binding: ' + view.id + '/' + binding.graphName);
      names.add(binding.graphName); ids.add(binding.id);
    }
    requireCondition(names.size === expected.size, 'Schedule interaction object coverage mismatch: ' + view.id);
  }
  return catalog;
}

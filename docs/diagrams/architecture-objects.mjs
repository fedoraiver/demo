// 对象目录保留每个实体投影与注册身份；所有视图从同一份直接关系集合取边。
import crypto from 'node:crypto';
import { NODE_KINDS, nodeKindOf } from './architecture-kinds.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
const unique = values => [...new Set(values.filter(Boolean))];
const distinct = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
const explanationKinds = new Set(['Note', 'Lifecycle note', 'BSN layout', 'Operation result']);
const accessLabels = { read: '查询访问', write: '可变访问', insert: '添加', remove: '移除', filter: '存在 / 变更过滤', reflect_read: '反射查看', reflect_write: '反射可选编辑' };
const reading = operation => ['read', 'filter', 'reflect_read'].includes(operation);

export function isArchitectureObject(record) {
  return !record.alias_of && Boolean(NODE_KINDS[nodeKindOf(record)].visualType) && !explanationKinds.has(nodeKindOf(record));
}

export function buildObjectCatalog(model, registry, { components = { accesses: [] } } = {}) {
  const resolve = id => registry[id]?.alias_of || id;
  const objects = Object.values(registry).filter(isArchitectureObject).map(record => ({
    id: record.id, sourceNodeId: record.id, viewId: `object-${hash(record.id)}`, feature: record.feature, kind: nodeKindOf(record),
  }));
  const objectById = Object.fromEntries(objects.map(object => [object.id, object]));
  const links = [], byId = new Map();
  function add(link) {
    const entry = { ...link, from: resolve(link.from), to: resolve(link.to) };
    for (const id of [entry.from, entry.to]) if (!registry[id] || !NODE_KINDS[nodeKindOf(registry[id])].visualType) throw new Error(`对象关系端点不可绘制：${entry.id}/${id}`);
    if (byId.has(entry.id)) throw new Error(`重复的对象关系：${entry.id}`);
    byId.set(entry.id, entry); links.push(entry); return entry;
  }
  for (const link of model.system_links || []) add(link);
  function generated(category, from, to, metadata) {
    return add({ id: `object-${category}-${hash(`${from}|${to}|${metadata.operation || metadata.label || ''}`)}`, from, to, ...metadata });
  }
  function sources(record, roles) {
    return (record?.sourceEntries || []).filter(source => roles.includes(source.role));
  }
  // 挂载关系针对原投影及其所属实体，不将同类型组件重定向到首个实体。
  for (const entity of model.entities || []) for (const component of entity.components || []) {
    const owner = `entity-${entity.id}`;
    generated('contains', component.id, owner, { kind: 'reference', operation: 'contains', label: '可能挂载于',
      projectionIds: [component.id], notes: ['表示该实体类别可能包含此组件，不表示每个实例始终拥有该组件。'],
      sourceEntries: sources(registry[owner], ['create']) });
  }
  // 关系记录仍以边表达，其声明及约束供实体图和关系组件图共同阅读。
  for (const relationship of model.relationships || []) {
    const link = byId.get(relationship.id);
    if (link) for (const key of ['description', 'cardinality', 'reverse', 'linked_spawn']) if (relationship[key] !== undefined) link[key] = relationship[key];
    if (relationship.from_component) generated('entity-target', relationship.from_component, `entity-${relationship.to}`, {
      kind: 'reference', operation: 'entity_target', label: relationship.component_field || relationship.name,
      originalLinkIds: [relationship.id], notes: [relationship.description, ...(relationship.component_target_notes || [])],
      sourceEntries: distinct([...sources(registry[relationship.id], ['definition', 'parameter', 'configure']), ...(relationship.component_target_sources || [])]),
      sourceGaps: relationship.component_target_sources?.some(source => source.role === 'operation') ? []
        : ['待核实：以下入口说明引用字段或关系声明，具体赋值、插入或关系建立位置尚待核实。'],
    });
  }
  const componentFacts = new Map(), unresolvedAccesses = [];
  for (const fact of components.accesses || []) {
    // 类型匹配只说明候选集合；多实体的访问声明不能证明某次 Commands 操作的实际接收实体。
    if (fact.evidence === 'source' && ((fact.targetScope === 'type-only' && !fact.projectionIds?.length)
      || (fact.targetScope === 'declared-candidates' && fact.projectionIds?.length > 1))) {
      unresolvedAccesses.push(fact); continue;
    }
    const ids = fact.projectionIds?.length ? fact.projectionIds : [fact.component];
    for (const component of unique(ids)) {
      if (registry[component]?.kind !== 'Component') throw new Error(`组件访问缺少投影：${component}`);
      if (!registry[fact.system]) throw new Error(`组件访问缺少注册：${fact.system}`);
      const key = `${fact.system}|${component}`;
      if (!componentFacts.has(key)) componentFacts.set(key, []);
      componentFacts.get(key).push({ ...fact, component, projectionIds: [component] });
    }
  }
  for (const facts of componentFacts.values()) {
    const precise = facts.filter(fact => fact.evidence !== 'declaration');
    const selected = facts.filter(fact => fact.evidence !== 'declaration' || !precise.some(other => reading(other.operation) === reading(fact.operation)));
    for (const [operation, accesses] of Map.groupBy(selected, fact => fact.operation)) {
      const { system, component } = accesses[0], from = reading(operation) ? component : system, to = reading(operation) ? system : component;
      const originals = unique(accesses.flatMap(fact => fact.originalLinkIds || []));
      const existing = links.filter(link => link.from === from && link.to === to && ['read', 'write'].includes(link.kind) && !link.operation);
      const metadata = { kind: operation === 'filter' ? 'reference' : reading(operation) ? 'read' : 'write', operation,
        label: unique(accesses.map(fact => fact.label)).join('；') || accessLabels[operation],
        projectionIds: [component], registrationIds: [system], evidence: unique(accesses.map(fact => fact.evidence)),
        sourceEntries: distinct(accesses.flatMap(fact => fact.sourceEntries || [])),
        notes: unique(accesses.flatMap(fact => fact.notes || [])), sourceGaps: unique(accesses.flatMap(fact => fact.sourceGaps || [])),
        originalLinkIds: unique([...originals, ...existing.map(link => link.id)]), accesses };
      if (metadata.evidence.every(value => value === 'declaration')) metadata.sourceGaps.push('待核实：当前仅确认访问声明，不据此断言字段赋值或组件生命周期操作。');
      if (existing.length) for (const link of existing) Object.assign(link, metadata);
      else generated('access', from, to, metadata);
    }
  }
  // 资源、Local 与消息声明同样参与关系目录；已有具体关系不重复生成。
  for (const system of model.systems || []) for (const [field, kind] of [['reads', 'read'], ['writes', 'write']]) for (const id of unique(registry[system.id]?.[field] || system[field] || [])) {
    if (registry[id]?.kind === 'Component') continue;
    const from = kind === 'read' ? id : system.id, to = kind === 'read' ? system.id : id;
    if (links.some(link => link.from === from && link.to === to && link.kind === kind)) continue;
    generated('access-declaration', from, to, { kind, label: '访问声明', evidence: ['declaration'],
      sourceEntries: sources(registry[system.id], ['definition']).map(source => ({ ...source, role: 'related', label: '系统访问声明对应函数' })),
      sourceGaps: ['待核实：该访问来自系统清单，具体参数或操作位置尚待逐项核实。'] });
  }
  const plugins = new Map((model.features || []).map(feature => [feature.id, `plugin-${feature.plugin}`]));
  for (const entity of model.entities || []) for (const feature of entity.assembled_by || []) {
    const plugin = plugins.get(feature), owner = `entity-${entity.id}`;
    if (registry[plugin]) generated('assembly', plugin, owner, { kind: 'reference', operation: 'assembly', label: '装配归属',
      notes: ['表示该插件负责此类实体的装配，不表示插件 build 函数直接生成运行时实例。'],
      sourceEntries: sources(registry[owner], ['create']) });
  }
  const sets = Object.values(registry).filter(record => record.kind === 'SystemSet' && !record.alias_of);
  for (const system of model.systems || []) {
    const record = registry[system.id], plugin = plugins.get(record.registered_by);
    if (registry[plugin] && !links.some(link => link.from === plugin && link.to === system.id && link.kind === 'registration')) generated('registration', plugin, system.id, {
      kind: 'registration', label: '', sourceEntries: sources(record, ['registration']),
    });
    for (const registration of system.registrations || []) {
      if (registration.scope !== 'runtime') continue;
      for (const name of registration.sets || []) {
        const set = sets.find(candidate => candidate.id !== system.id && candidate.name === name)
          || sets.find(candidate => candidate.id !== system.id && name.startsWith(candidate.name + '::'));
        if (!set || links.some(link => link.from === set.id && link.to === system.id && link.kind === 'registration')) continue;
        generated('membership', set.id, system.id, { kind: 'registration', label: name,
          sourceEntries: sources(record, ['registration']), notes: [`Schedule：${registration.schedule}`] });
      }
    }
  }
  const neighbors = new Map(objects.map(object => [object.id, []]));
  for (const link of links) for (const id of unique([link.from, link.to])) neighbors.get(id)?.push(link);
  function graphFor(id) {
    const object = objectById[resolve(id)];
    if (!object) throw new Error(`未知 ECS 对象：${id}`);
    // 插件只展示自身卡片；实体图隐藏组件，完整关系仍保留在共享目录中。
    const incident = neighbors.get(object.id);
    const selected = ['Plugin', 'PluginGroup'].includes(object.kind) ? [] : object.kind === 'Entity'
      ? incident.filter(link => [link.from, link.to].every(id => nodeKindOf(registry[id]) !== 'Component')) : incident;
    const ids = unique([object.id, ...selected.flatMap(link => [link.from, link.to])]);
    return { centerNodeId: object.id, empty: false,
      nodes: ids.map(id => ({ id, role: registry[id].feature === object.feature ? 'internal' : 'external', group: id === object.id ? '当前对象' : '直接关联对象' })),
      links: selected.map(link => ({ ...link })) };
  }
  return { objects, objectById, links, unresolvedAccesses, graphFor };
}

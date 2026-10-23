// 将已核对清单组织为功能局部图；这里不推断 Rust 语义或绘制图形。
import { INFRASTRUCTURE_FEATURES, infrastructureFeature } from './architecture-infrastructure.mjs';

export const SCHEDULE_GROUP_DISPLAY_LABELS = Object.freeze({
  FixedLast: 'FixedLast',
  FixedPostUpdate: 'FixedPostUpdate',
  EguiPrimaryContextPass: 'EguiPrimaryContextPass',
  RenderApp: 'RenderApp',
  NativePlatformEvents: '原生平台回调',
  EventTriggered: 'Observer',
  Explanatory: '约束与说明',
});

export function scheduleGroupLabel(group, registry) {
  if (group.id !== 'StateTransition') return SCHEDULE_GROUP_DISPLAY_LABELS[group.id] ?? group.label;
  const schedules = [...new Set(group.nodes.flatMap(node => {
    const id = typeof node === 'string' ? node : node.id;
    return (registry[id]?.registrations || []).filter(registration => registration.scope === 'runtime').map(registration => registration.schedule);
  }))];
  if (!schedules.length || schedules.some(schedule => typeof schedule !== 'string' || !schedule.trim())) throw new Error(`调度分组 ${group.id} 缺少有效的运行时 Schedule 注册`);
  const types = schedules.map(schedule => /^\s*([A-Za-z_]\w*)\s*(?:[({]|$)/.exec(schedule)?.[1]);
  if (types.some(type => !type)) throw new Error(`调度分组 ${group.id} 无法识别 Schedule 类型`);
  return [...new Set(types)].join('\n');
}

// 主入口统一装配插件；保留清单记录，但不在各图重复展示这类注册关系。
export function isMainPluginRegistration(link, registry) {
  return link.kind === 'registration' && link.from === 'app-main' && registry[link.to]?.kind === 'Plugin';
}

export function buildArchitectureModel(model) {
  const features = model.features || [];
  const featureById = new Map(features.map(feature => [feature.id, feature]));
  const registry = {};
  const systems = new Set((model.systems || []).map(system => system.id));
  const observers = new Set((model.observers || []).map(observer => observer.system));
  const resources = new Set((model.resources || []).map(resource => resource.id));
  const components = new Set();
  const entityById = new Map();
  const componentEntity = new Map();
  const extraById = new Map((model.nodes || []).map(node => [node.id, node]));

  function register(id, node) {
    if (registry[id]) throw new Error(`重复的架构节点：${id}`);
    const feature = node.feature || model.node_features?.[id];
    if (!feature) throw new Error(`架构节点 ${id} 缺少明确的功能归属`);
    if (!infrastructureFeature(feature) && !featureById.has(feature)) throw new Error(`架构节点 ${id} 的功能不存在：${feature}`);
    registry[id] = { ...node, id, feature };
  }
  for (const system of model.systems || []) {
    const feature = system.feature || (featureById.has(system.module) ? system.module : 'infrastructure');
    register(system.id, { ...system, feature, registered_by: system.registered_by || feature });
  }
  for (const resource of model.resources || []) {
    register(resource.id, { ...resource, kind: resource.kind || (resource.id.startsWith('local.') ? 'Local' : resource.id.startsWith('non_send.') ? 'NonSend' : 'Resource'), defined_in: resource.defined_in || resource.feature || model.node_features?.[resource.id] || 'infrastructure' });
  }
  for (const entity of model.entities || []) {
    const entityId = `entity-${entity.id}`;
    entityById.set(entityId, entity);
    register(entityId, { ...entity, kind: 'Entity', identity: entityId });
    for (const component of entity.components) {
      components.add(component.id);
      componentEntity.set(component.id, entityId);
      register(component.id, { ...component, kind: 'Component', owner: entity.name, defined_in: component.defined_in || component.feature || model.node_features?.[component.id] || 'infrastructure' });
    }
  }
  for (const node of model.nodes || []) register(node.id, node);
  // 关系沿连线阅读，也保留独立详情；不因此添加实体之外的额外卡片。
  for (const relation of model.relationships || []) {
    register(relation.id, { ...relation, kind: 'Relationship', relationship_kind: relation.kind });
  }
  // 旧入口仍可定位同一个插件；别名不用于合并不同系统注册或不同实体组件。
  const aliases = model.node_aliases || {};
  for (const [alias, target] of Object.entries(aliases)) {
    const from = registry[alias], to = registry[target];
    if (!from || !to || aliases[target] || alias === target || from.kind !== 'Plugin' || to.kind !== 'Plugin' || from.feature !== to.feature || from.name !== to.name || from.source?.path !== to.source?.path || from.source?.line !== to.source?.line) throw new Error(`无效的同插件旧入口别名：${alias} → ${target}`);
    from.alias_of = target;
    to.aliases = [...(to.aliases || []), alias];
  }
  const resolveNode = id => aliases[id] || id;
  const ownerOf = id => registry[id]?.feature || model.node_features?.[id] || 'infrastructure';
  const links = (model.system_links || []).map(link => ({ ...link, from: resolveNode(link.from), to: resolveNode(link.to) }));
  const linkIds = new Set();
  for (const link of links) {
    if (linkIds.has(link.id)) throw new Error(`重复的架构关系：${link.id}`);
    if (!registry[link.from] || !registry[link.to]) throw new Error(`架构关系 ${link.id} 的端点不存在`);
    linkIds.add(link.id);
  }
  const viewLinks = links.filter(link => !isMainPluginRegistration(link, registry));
  const kind = id => registry[id]?.kind || '';
  const isMessage = id => /EntityEvent|Message|External I\/O|Native platform event|Engine observers/.test(kind(id)) || /^Messages</.test(registry[id]?.name || '');
  const isRegistration = id => /Plugin|Registration helper/.test(kind(id));
  const isSystem = id => systems.has(id) || /^(?:system|sync|engine)$/i.test(kind(id)) || /SystemSet|Engine system|Scheduling contract|Native platform bridge/.test(kind(id));
  const eventEndpoint = id => isMessage(id) || extraById.get(id)?.aspects?.includes('events');
  const eventLink = link => link.kind === 'trigger' || link.kind === 'registration' || ((link.kind === 'read' || link.kind === 'write' || link.kind === 'reference') && (eventEndpoint(link.from) || eventEndpoint(link.to)));
  const relationIds = new Set((model.relationships || []).map(relation => relation.id));

  function graphFor(featureId, aspect) {
    if (!infrastructureFeature(featureId) && !featureById.has(featureId)) throw new Error(`功能不存在：${featureId}`);
    if (!['systems', 'data', 'events'].includes(aspect)) throw new Error(`架构视图不存在：${aspect}`);
    const internal = new Set();
    const projectionEntities = new Set();
    const owned = id => ownerOf(id) === featureId;
    for (const [id, node] of Object.entries(registry)) {
      if (node.alias_of) continue;
      if (!owned(id)) continue;
      const extra = extraById.get(id);
      if (extra?.aspects?.includes(aspect)) internal.add(id);
      if (aspect === 'systems' && systems.has(id) && !observers.has(id)) internal.add(id);
      if (aspect === 'data' && (resources.has(id) || components.has(id))) internal.add(id);
      if (aspect === 'events' && (observers.has(id) || isMessage(id) || isRegistration(id))) internal.add(id);
    }
    if (aspect === 'data') {
      for (const [id, entity] of entityById) {
        const assembledHere = entity.assembled_by?.includes(featureId);
        const homeHere = owned(id);
        const definesComponent = entity.components.some(component => owned(component.id));
        const candidate = entity.features?.includes(featureId) || assembledHere || homeHere;
        if (candidate && (definesComponent || assembledHere || homeHere)) {
          internal.add(id);
          projectionEntities.add(id);
        }
      }
    }
    // 消息消费系统和外部输出也属于通信阅读范围；不展开全部普通读写。
    if (aspect === 'events') for (const link of viewLinks.filter(eventLink)) {
      if (owned(link.from)) internal.add(link.from);
      if (owned(link.to)) internal.add(link.to);
    }
    const selectedLinks = viewLinks.filter(link => {
      // 共享实体不转移关系的功能归属；每条实体关系只在定义它的功能中展开。
      if (relationIds.has(link.id)) return aspect === 'data' && ownerOf(link.id) === featureId;
      if (!internal.has(link.from) && !internal.has(link.to)) return false;
      if (aspect === 'systems') return (link.kind === 'order' && isSystem(link.from) && isSystem(link.to)) || (link.kind === 'registration' && !isRegistration(link.from) && isSystem(link.from) && isSystem(link.to));
      if (aspect === 'events') return eventLink(link) || ((link.kind === 'read' || link.kind === 'write') && (observers.has(link.from) || observers.has(link.to)));
      return link.kind === 'transition' || ((link.kind === 'read' || link.kind === 'write' || link.kind === 'reference') && (resources.has(link.from) || resources.has(link.to) || components.has(link.from) || components.has(link.to)));
    });
    const visible = new Set(internal);
    for (const link of selectedLinks) { visible.add(link.from); visible.add(link.to); }
    const entityGroups = [];
    if (aspect === 'data') for (const [entityId, entity] of entityById) {
      if (!visible.has(entityId) && !entity.components.some(component => visible.has(component.id))) continue;
      const members = entity.components.map(component => component.id);
      if (!members.length) continue;
      entityGroups.push({ id: `entity-group-${entity.id}`, entity: entityId, components: members });
      // 实体及完整组件在关系筛选后补齐，不扩展系统、其他实体或业务关系。
      visible.add(entityId);
      for (const id of members) visible.add(id);
    }
    const isInternal = id => internal.has(id) || owned(id);
    const featureLabel = id => featureById.get(id)?.label || infrastructureFeature(id)?.label;
    function groupFor(id) {
      if (!isInternal(id)) return `外部契约 · ${featureLabel(ownerOf(id))}`;
      if (id === 'app-main') return '应用入口';
      if (projectionEntities.has(id)) return '同一实体的组件';
      if (components.has(id)) return `组件定义 · ${entityById.get(componentEntity.get(id)).name}`;
      if (id.startsWith('local.')) return '系统私有状态';
      if (resources.has(id)) return isMessage(id) ? '事件与消息' : '共享资源与状态';
      if (observers.has(id)) return 'Observer';
      if (isMessage(id)) return kind(id) === 'External I/O' ? '日志与外部输出' : '事件与消息';
      if (isRegistration(id)) return '插件注册与装配';
      if (kind(id) === 'sync' || /SystemSet|Scheduling contract/.test(kind(id))) return '调度与命令同步';
      return aspect === 'data' ? '数据契约与结构说明' : aspect === 'events' ? '消息处理与平台桥接' : '功能系统';
    }
    const graphNodes = [...visible].map(id => ({
      id,
      role: isInternal(id) ? 'internal' : 'external',
      group: groupFor(id),
      ...(projectionEntities.has(id) ? { projection_components: entityById.get(id).components.filter(component => ownerOf(component.id) === featureId).map(component => component.id) } : {}),
    }));
    return { nodes: graphNodes, links: selectedLinks.map(({ id, from, to, kind: linkKind, label }) => ({ id, from, to, kind: linkKind, label })), ...(aspect === 'data' ? { entityGroups } : {}), empty: graphNodes.length === 0 };
  }
  function scheduleGroups(graph) {
    const groups = new Map((model.schedule_groups || []).map(group => [group.id, { ...group, nodes: [] }]));
    const seen = new Set();
    for (const node of graph.nodes) {
      if (seen.has(node.id)) throw new Error(`调度图重复节点：${node.id}`);
      seen.add(node.id);
      if (!registry[node.id]) throw new Error(`调度图未知节点：${node.id}`);
      if (systems.has(node.id) && (!Object.hasOwn(registry[node.id], 'schedule') || !registry[node.id].schedule_group)) throw new Error(`系统 ${node.id} 缺少明确的 Schedule 注册`);
      const groupId = registry[node.id].schedule_group || 'Explanatory';
      const group = groups.get(groupId);
      if (!group) throw new Error(`节点 ${node.id} 的调度分组不存在：${groupId}`);
      group.nodes.push(node);
    }
    // 列内只按既有 order 边排序；无依赖的系统保持原清单顺序，不生成排版用执行边。
    for (const group of groups.values()) {
      const pending = new Map(group.nodes.map(node => [node.id, 0]));
      const successors = new Map(group.nodes.map(node => [node.id, new Set()]));
      for (const link of graph.links) {
        if (link.kind !== 'order' || !pending.has(link.from) || !pending.has(link.to) || successors.get(link.from).has(link.to)) continue;
        successors.get(link.from).add(link.to);
        pending.set(link.to, pending.get(link.to) + 1);
      }
      const ordered = [];
      while (ordered.length < group.nodes.length) {
        const next = group.nodes.find(node => pending.get(node.id) === 0);
        if (!next) throw new Error(`调度分组 ${group.id} 中存在循环执行依赖`);
        ordered.push(next);
        pending.delete(next.id);
        for (const successor of successors.get(next.id)) pending.set(successor, pending.get(successor) - 1);
      }
      group.nodes = ordered;
    }
    return [...groups.values()].filter(group => group.nodes.length).sort((a, b) => a.order - b.order)
      .map(group => ({ ...group, label: scheduleGroupLabel(group, registry) }));
  }
  return { registry, features, infrastructureFeatures: INFRASTRUCTURE_FEATURES, ownerOf, graphFor, scheduleGroups, resolveNode };
}

// Mermaid 展示中的 Schedule 标签与 Observer 位置；语义模型由 Rust 产出。
import { nodeKindOf } from './architecture-kinds.mjs';
import crypto from 'node:crypto';

// 无固定 Schedule 的触发节点保留真实身份，由来源连线安排位置。
export function isUnscheduledTriggerNode(record) {
  return nodeKindOf(record) === 'Observer' || record.schedule_group === 'EventTriggered';
}

// 系统图压缩两跳事件关系；对象图仍使用原关系，不能把来源当成 Observer 的直接对象邻居。
export function projectObserverTriggers(links, registry) {
  const distinct = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
  const emissions = Map.groupBy(links.filter(link => link.kind === 'trigger' && registry[link.to]?.kind === 'EntityEvent'), link => link.to);
  return links.filter(link => link.kind === 'trigger' && registry[link.from]?.kind === 'EntityEvent' && registry[link.to]?.kind === 'Observer').flatMap(subscription =>
    (emissions.get(subscription.from) || []).map(emission => ({
      id: `observer-trigger-${crypto.createHash('sha256').update(`${emission.id}|${subscription.id}`).digest('hex').slice(0, 16)}`,
      from: emission.from, to: subscription.to, kind: 'trigger', label: subscription.label || registry[subscription.from].name,
      projection: 'observer-trigger', eventId: subscription.from, originalLinkIds: [emission.id, subscription.id],
      notes: distinct([emission.label, ...(emission.notes || []), ...(subscription.notes || [])].filter(value => value && value !== '触发')),
      sourceEntries: distinct([...(emission.sourceEntries || []), ...(subscription.sourceEntries || [])]),
      sourceGaps: distinct([...(emission.sourceGaps || []), ...(subscription.sourceGaps || [])]),
    })));
}

// 附属只决定画布位置；真实 Schedule 成员始终由 nodes 保存，不给回调或机制源增加注册。
export function buildObserverPlacement(graph, registry, scheduleGroups) {
  const groups = scheduleGroups.map(group => ({ ...group, visualAttachments: [] }));
  const nodeId = node => typeof node === 'string' ? node : node.id;
  const unscheduled = new Set(graph.nodes.filter(node => isUnscheduledTriggerNode(registry[node.id])).map(node => node.id));
  const triggers = graph.links.filter(link => link.projection === 'observer-trigger');
  const neighbors = new Map();
  for (const { from, to } of triggers) for (const [id, other] of [[from, to], [to, from]]) {
    if (!neighbors.has(id)) neighbors.set(id, new Set());
    neighbors.get(id).add(other);
  }
  const pending = new Set(neighbors.keys()), branches = [];
  function place(ids) {
    const attachments = graph.nodes.filter(node => ids.has(node.id) && unscheduled.has(node.id)).map(node => node.id);
    if (!attachments.length) return;
    const hosts = groups.filter(group => group.nodes.some(node => ids.has(nodeId(node))));
    if (hosts.length === 1) hosts[0].visualAttachments.push(...attachments);
    else {
      const members = new Set(attachments);
      branches.push({ id: `observer-branch-${crypto.createHash('sha256').update([...members].sort().join('|')).digest('hex').slice(0, 16)}`,
        nodes: attachments, anchorSourceIds: [...new Set(triggers.filter(link => members.has(link.from)).map(link => link.from))] });
    }
    for (const id of attachments) unscheduled.delete(id);
  }
  while (pending.size) {
    const ids = new Set(), queue = [pending.values().next().value];
    while (queue.length) {
      const id = queue.pop();
      if (!pending.delete(id)) continue;
      ids.add(id);queue.push(...neighbors.get(id));
    }
    place(ids);
  }
  // 无已核实发出边的孤立回调仍保留卡片，来源缺口由语义校验报告。
  for (const id of [...unscheduled]) place(new Set([id]));
  for (const group of groups) if (!group.visualAttachments.length) delete group.visualAttachments;
  return { groups, branches };
}

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
  return link.kind === 'registration' && link.from === 'app-main' && ['Plugin', 'PluginGroup'].includes(registry[link.to]?.kind);
}

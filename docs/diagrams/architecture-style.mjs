// 节点、连线、图例与导出共同使用这份视觉语义，不修改清单中的 Rust 类型或关系身份。
import { NODE_KINDS, nodeKindOf } from './architecture-kinds.mjs';
export const SELECTION_STYLE = {
  fillStrokeRatio: .22, strokeExtraPx: 2, ringWidthPx: 2, ringGapPx: 1,
  ringColor: '#2563EB', ringOpacity: .85, filterPaddingPx: 2,
};

export const EXTERNAL_REFERENCE_STYLE = { dash: '6 4', description: '节点虚线边框表示外部引用', legendLabel: 'Dashed node outlines indicate external references.' };

export function selectedFillColor(stroke, ratio = SELECTION_STYLE.fillStrokeRatio) {
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(stroke || '');
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(stroke || '');
  const channels = hex ? (hex[1].length === 3 ? [...hex[1]].map(channel => channel + channel) : hex[1].match(/../g)).map(channel => Number.parseInt(channel, 16)) : rgb?.slice(1, 4).map(Number);
  return channels ? '#' + channels.map(channel => Math.round(channel * ratio + 255 * (1 - ratio)).toString(16).padStart(2, '0')).join('').toUpperCase() : null;
}

function nodeStyle(label, legendLabel, shape, stroke, width = 1.6) {
  const fill = '#' + stroke.slice(1).match(/../g).map(channel => Math.round(Number.parseInt(channel, 16) * .08 + 255 * .92).toString(16).padStart(2, '0')).join('').toUpperCase();
  return { label, legendLabel, shape, fill, stroke, width };
}

export const NODE_STYLES = {
  system: nodeStyle('系统', 'System', 'rounded', '#3567A6'),
  observer: nodeStyle('Observer', 'Observer', 'hex', '#7B4DB2'),
  entity: nodeStyle('实体', 'Entity', 'rounded', '#A6533B', 2.2),
  component: nodeStyle('组件', 'Component', 'rounded', '#4B8060'),
  resource: nodeStyle('共享资源', 'Resource', 'cyl', '#A5792C'),
  local: nodeStyle('系统私有状态', 'Local<T>', 'notch-rect', '#AA8752'),
  non_send: nodeStyle('主线程状态', 'NonSend<T>', 'tag-rect', '#A5633A'),
  message: nodeStyle('消息契约', 'Message', 'lean-r', '#247B91'),
  message_buffer: nodeStyle('消息缓冲', 'Messages<T>', 'cyl', '#247B91'),
  event: nodeStyle('触发事件', 'EntityEvent', 'stadium', '#B66B2D'),
  system_set: nodeStyle('系统集合', 'SystemSet', 'lin-rect', '#6A778C'),
  system_param: nodeStyle('系统参数', 'SystemParam', 'notch-rect', '#3B8790'),
  query_data: nodeStyle('查询数据声明', 'QueryData', 'notch-rect', '#567A51'),
  scheduling_constraint: nodeStyle('调度约束', 'Scheduling constraint', 'lin-rect', '#7C6AA6'),
  shared_data_contract: nodeStyle('共享数据契约', 'Shared data contract', 'tag-rect', '#4A8580'),
  sync: nodeStyle('命令同步', 'Synchronization', 'rounded', '#8B6A42'),
  system_group: nodeStyle('系统分组', 'System group', 'fr-rect', '#607C96'),
  observer_group: nodeStyle('Observer 分组', 'Observer group', 'hex', '#9A648D'),
  engine_flow: nodeStyle('引擎流程聚合', 'Engine flow', 'stadium', '#557C78'),
  plugin: nodeStyle('插件', 'Plugin', 'fr-rect', '#4A6389', 2.2),
  plugin_group: nodeStyle('插件组', 'PluginGroup', 'fr-rect', '#735C93', 2.2),
  app: nodeStyle('应用装配入口', 'App', 'fr-rect', '#3A7B87', 2.2),
  registration_helper: nodeStyle('注册辅助入口', 'Registration helper', 'tag-rect', '#8A7548'),
  external_io: nodeStyle('外部 I/O', 'External I/O', 'lean-l', '#526A78'),
  platform_api: nodeStyle('原生平台接口', 'Platform API', 'lean-l', '#8A6555'),
  platform_event: nodeStyle('原生平台事件', 'Platform event', 'lean-r', '#916B45'),
  note: nodeStyle('说明', 'Note', 'doc', '#9A9B88', 1.2),
  lifecycle_note: nodeStyle('生命周期说明', 'Lifecycle note', 'doc', '#8E766D', 1.2),
  bsn_layout: nodeStyle('BSN 布局', 'BSN layout', 'doc', '#6C8D9D', 1.2),
  operation_result: nodeStyle('操作结果', 'Operation result', 'doc', '#7D8963', 1.2),
};

export const EDGE_STYLES = {
  schedule: { label: 'Schedule 先后', legendLabel: 'Schedule order', stroke: '#334155', width: 3, dash: null },
  order: { label: '显式执行依赖', legendLabel: 'Explicit ordering', stroke: '#334155', width: 2, dash: null },
  nested: { label: '内部调度', legendLabel: 'Nested schedule execution', stroke: '#334155', width: 1.8, dash: '10 5' },
  read: { label: '读取：数据 → 系统', legendLabel: 'Read access', stroke: '#3567A6', width: 1.6, dash: '6 4' },
  write: { label: '修改：系统 → 数据', legendLabel: 'Write / Output', stroke: '#2F7161', width: 1.8, dash: null },
  publish: { label: '发布：生产者 → 消息缓冲', legendLabel: 'Message write', stroke: '#247B91', width: 1.8, dash: '10 4 2 4' },
  consume: { label: '消费：消息缓冲 → 消费者', legendLabel: 'Message read', stroke: '#247B91', width: 1.8, dash: '2 4' },
  emit: { label: '发出：发起者 → 事件', legendLabel: 'Event trigger', stroke: '#B66B2D', width: 1.8, dash: null },
  observe: { label: '触发：来源 → Observer', legendLabel: 'Observer invocation', stroke: '#B66B2D', width: 1.8, dash: '2 4' },
  transition: { label: '状态转换', legendLabel: 'State transition', stroke: '#A64E76', width: 2, dash: '10 4 2 4' },
  reference: { label: '普通引用：持有者 → 目标', legendLabel: 'Reference', stroke: '#7B4DB2', width: 1.5, dash: '6 4' },
  relationship: { label: 'Bevy 关系：关系源 → 目标', legendLabel: 'Relationship', stroke: '#7B4DB2', width: 1.8, dash: null },
  set_membership: { label: '系统集合 → 成员系统', legendLabel: 'SystemSet membership', stroke: '#6A778C', width: 1.4, dash: '2 4' },
  group_membership: { label: '系统分组 → 成员系统', legendLabel: 'System group membership', stroke: '#607C96', width: 1.4, dash: '2 4' },
  constraint: { label: '调度契约 → 参与集合', legendLabel: 'Ordering contract participation', stroke: '#6A778C', width: 1.4, dash: '10 4 2 4' },
  registration: { label: '装配方 → 注册对象', legendLabel: 'Registration', stroke: '#64748B', width: 1.5, dash: '6 4' },
  dependency: { label: '契约使用方 → 提供方', legendLabel: 'Dependency', stroke: '#64748B', width: 1.5, dash: '10 5' },
};

export function mermaidStyleDefinitions(nodeTypes, edgeTypes) {
  return [
    ...nodeTypes.map(type => { const style = NODE_STYLES[type]; return `classDef node_${type} fill:${style.fill},stroke:${style.stroke},stroke-width:${style.width}px,color:#1F3340`; }),
    ...edgeTypes.map(type => { const style = EDGE_STYLES[type]; return `classDef edge_${type} stroke:${style.stroke},stroke-width:${style.width}px${style.dash ? `,stroke-dasharray:${style.dash}` : ''}`; }),
    `classDef external_node stroke-dasharray:${EXTERNAL_REFERENCE_STYLE.dash}`,
  ];
}

export function visualTypeOf(node) {
  const type = NODE_KINDS[nodeKindOf(node)].visualType;
  if (!type) throw new Error(`Architecture relationship record is not a drawable node: ${node?.id || node?.kind}`);
  return type;
}

const messageTypes = new Set(['message', 'message_buffer']);
const directSemantics = new Set(['order', 'transition', 'reference', 'relationship', 'dependency']);

export function edgeSemanticOf(link, registry) {
  if (directSemantics.has(link.kind)) return link.kind;
  const from = registry[link.from], to = registry[link.to];
  if (!from || !to) throw new Error(`Architecture edge endpoint missing: ${link.id || `${link.from} → ${link.to}`}`);
  if (link.kind === 'read') return messageTypes.has(visualTypeOf(from)) ? 'consume' : 'read';
  if (link.kind === 'write') return messageTypes.has(visualTypeOf(to)) ? 'publish' : 'write';
  if (link.kind === 'trigger') {
    if (link.projection === 'observer-trigger' && registry[link.eventId]?.kind === 'EntityEvent' && visualTypeOf(to) === 'observer') return 'observe';
    if (visualTypeOf(from) === 'event' && ['observer', 'observer_group'].includes(visualTypeOf(to))) return 'observe';
    if (visualTypeOf(to) === 'event') return 'emit';
    throw new Error(`Architecture trigger has no event/Observer contract: ${link.id}`);
  }
  if (link.kind === 'registration') {
    const kind = nodeKindOf(from);
    if (kind === 'Scheduling constraint') return 'constraint';
    if (kind === 'SystemSet') return 'set_membership';
    if (kind === 'System group') return 'group_membership';
    if (['Plugin', 'PluginGroup', 'App', 'Registration helper'].includes(kind)) return 'registration';
    throw new Error(`Architecture registration source is not classified: ${link.id}`);
  }
  throw new Error(`Unknown architecture edge kind: ${link.kind} (${link.id || 'unnamed'})`);
}

export function displayLabelOf(link, semantic, registry) {
  if (!Object.hasOwn(EDGE_STYLES, semantic)) throw new Error(`Unknown architecture edge semantic: ${semantic}`);
  let label = String(link.label ?? '').trim();
  if (!label) return '';
  // 只移除关系类别前缀；条件、Commands 可见时机和具体领域名仍留在线上。
  label = label.replace(/^(?:R\s*\/\s*W|R|W)(?:\s+|$)/, '').trim();
  if (['read', 'write', 'publish', 'consume', 'dependency'].includes(semantic)) {
    label = label.replace(/^(?:读写|读取|写入|修改|消费|发布|使用)\s*(?:\/\s*)?/, '').trim();
  }
  if (semantic === 'registration') label = label.replace(/^(?:首先安装|先安装|再安装|显式安装|安装|注册)\s*/, '').trim();
  if (['order', 'nested', 'schedule'].includes(semantic)) {
    label = label.replace(/^chain(?:\s*\/\s*)?/, '').replace(/^(?:after|before)\((.+)\)$/, '$1').replace(/^(?:after|before)\s+/, '').replace(/\s*→\s*$/, '').trim();
  }
  if (/^(?:R|W|读取|写入|修改|触发|发布|消费|安装|注册|after|before|chain)$/.test(label)) return '';
  return label;
}

export function scheduleLinksFor(groups) {
  const ids = new Set();
  for (const group of groups) {
    if (ids.has(group.id)) throw new Error(`Duplicate Schedule group: ${group.id}`);
    ids.add(group.id);
  }
  const mainTracks = new Set(['startup', 'frame', 'conditional', 'fixed']);
  const main = groups.filter(group => mainTracks.has(group.track) || group.id === 'RunFixedMainLoop.AfterFixedMainLoop').toSorted((a, b) => a.order - b.order);
  const links = main.slice(1).map((group, index) => ({ id: `schedule-${main[index].id}-${group.id}`, from: main[index].id, to: group.id, edgeSemantic: 'schedule', displayLabel: '' }));
  if (ids.has('PostUpdate') && ids.has('EguiPrimaryContextPass')) links.push({ id: 'nested-PostUpdate-EguiPrimaryContextPass', from: 'PostUpdate', to: 'EguiPrimaryContextPass', edgeSemantic: 'nested', displayLabel: '' });
  return links;
}

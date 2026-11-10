// 节点、连线、图例与导出共同使用这份视觉语义，不修改清单中的 Rust 类型或关系身份。
import { NODE_KINDS, nodeKindOf } from './architecture-kinds.mjs';
export const ARCHITECTURE_TEXT_STYLE = { fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif', color: '#1F3340', fontSize: 14 };
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
  event: nodeStyle('触发事件', 'Event / EntityEvent', 'stadium', '#B66B2D'),
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
  schedule: { label: 'Schedule先后', legendLabel: 'Schedule order', stroke: '#334155', width: 3, dash: '6 4' },
  order: { label: '执行依赖', legendLabel: 'Explicit ordering', stroke: '#334155', width: 2, dash: '6 4' },
  nested: { label: '内部调度', legendLabel: 'Nested schedule execution', stroke: '#334155', width: 1.8, dash: '6 4' },
  read: { label: '读访问', messageLabel: '消息读访问', legendLabel: 'Read access', stroke: '#3567A6', width: 1.6, dash: '6 4' },
  mutable_access: { label: '写访问', messageLabel: '消息写访问', legendLabel: 'Mutable access', stroke: '#2F7161', width: 1.8, dash: '6 4' },
  read_write: { label: '读写访问', legendLabel: 'Read / Mutable access', stroke: '#277A83', width: 2, dash: '6 4' },
  write: { label: '写访问', messageLabel: '消息写访问', legendLabel: 'Write access', stroke: '#2F7161', width: 1.6, dash: '6 4' },
  filter: { label: '查询筛选', legendLabel: 'Query filter', stroke: '#7A6F42', width: 1.4, dash: '6 4' },
  contains: { label: '包含', legendLabel: 'Component membership', stroke: '#4B8060', width: 1.4, dash: '6 4' },
  create: { label: '创建', legendLabel: 'Entity creation', stroke: '#A6533B', width: 2, dash: '6 4' },
  insert: { label: '插入', legendLabel: 'Insertion', stroke: '#42844E', width: 2, dash: '6 4' },
  remove: { label: '移除', legendLabel: 'Removal', stroke: '#A44D4D', width: 2, dash: '6 4' },
  initialize: { label: '按需初始化', legendLabel: 'Initialization', stroke: '#A5792C', width: 2, dash: '6 4' },
  despawn: { label: '销毁', legendLabel: 'Entity destruction', stroke: '#99483E', width: 2.2, dash: '6 4' },
  publish: { label: '发布消息', legendLabel: 'Message publication', stroke: '#247B91', width: 1.8, dash: '6 4' },
  consume: { label: '消息读访问', legendLabel: 'Message read', stroke: '#247B91', width: 1.8, dash: '6 4' },
  emit: { label: '触发事件', legendLabel: 'Event trigger', stroke: '#B66B2D', width: 1.8, dash: '6 4' },
  observe: { label: '接收事件', legendLabel: 'Event reception', stroke: '#B66B2D', width: 1.8, dash: '6 4' },
  transition: { label: '状态转换', legendLabel: 'State transition', stroke: '#A64E76', width: 2, dash: '6 4' },
  reference: { label: '引用', legendLabel: 'Reference', stroke: '#7B4DB2', width: 1.5, dash: '6 4' },
  relationship: { label: 'Bevy关系', legendLabel: 'Relationship', stroke: '#7B4DB2', width: 1.8, dash: '6 4' },
  set_membership: { label: '集合成员', legendLabel: 'SystemSet membership', stroke: '#6A778C', width: 1.4, dash: '6 4' },
  group_membership: { label: '分组成员', legendLabel: 'System group membership', stroke: '#607C96', width: 1.4, dash: '6 4' },
  constraint: { label: '调度契约参与', legendLabel: 'Ordering contract participation', stroke: '#6A778C', width: 1.4, dash: '6 4' },
  registration: { label: '注册', legendLabel: 'Registration', stroke: '#64748B', width: 1.5, dash: '6 4' },
  condition: { label: '条件绑定', legendLabel: 'Condition binding', stroke: '#7B6F9C', width: 1.5, dash: '6 4' },
  alternative: { label: '结构候选', legendLabel: 'Structural alternative', stroke: '#8C6E43', width: 1.6, dash: '6 4' },
  dependency: { label: '契约依赖', legendLabel: 'Dependency', stroke: '#64748B', width: 1.5, dash: '6 4' },
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

const directSemantics = new Set(['order', 'transition', 'reference', 'relationship', 'dependency', 'observe', 'emit']);
const factSemantics = new Set(['read', 'mutable_access', 'filter', 'contains', 'create', 'insert', 'remove', 'initialize', 'despawn', 'publish', 'consume', 'condition', 'alternative']);

function isEventIdentity(record) {
  if (!record) return false;
  return ['Event', 'EntityEvent'].includes(nodeKindOf(record))
    || record.typeIdentity?.roles?.some(role => role === 'Event' || role === 'EntityEvent');
}

export function edgeSemanticOf(link, registry) {
  const kind = link.factKind ?? link.operation ?? link.kind;
  if (directSemantics.has(kind)) return kind;
  const from = registry[link.from], to = registry[link.to];
  if (!from || !to) throw new Error(`Architecture edge endpoint missing: ${link.id || `${link.from} → ${link.to}`}`);
  if (factSemantics.has(kind)) return kind;
  if (kind === 'write') return link.evidence === 'parameter' ? 'mutable_access' : 'write';
  if (kind === 'event') return 'observe';
  if (kind === 'trigger') {
    const observer = ['Observer', 'Observer group'].includes(nodeKindOf(to));
    if (link.projection === 'observer-trigger' && isEventIdentity(registry[link.eventId]) && observer) return 'observe';
    if (isEventIdentity(from) && observer) return 'observe';
    if (isEventIdentity(to)) return 'emit';
    throw new Error(`Architecture trigger has no event/Observer contract: ${link.id}`);
  }
  if (kind === 'registration' || kind === 'membership') {
    const kind = nodeKindOf(from);
    if (kind === 'Scheduling constraint') return 'constraint';
    if (kind === 'SystemSet') return 'set_membership';
    if (kind === 'System group') return 'group_membership';
    // 真实 Schedule 的注册上下文不是 Plugin，仍可明确表达快照中的成员注册。
    if (kind === 'Engine flow' && from.scheduleEvidence?.kind === 'schedule' && link.scheduleEvidence?.relations?.some(relation => relation.relation === 'registration')) return 'registration';
    if (['Plugin', 'PluginGroup', 'App', 'Registration helper'].includes(kind)) return 'registration';
    throw new Error(`Architecture registration source is not classified: ${link.id}`);
  }
  throw new Error(`Unknown architecture edge kind: ${link.kind} (${link.id || 'unnamed'})`);
}

const edgeLabelPrefixes = {
  schedule: ['Schedule 先后', 'Schedule先后'],
  order: ['显式执行依赖', '执行依赖', 'chain', 'after', 'before'],
  nested: ['内部调度', 'chain', 'after', 'before'],
  read: ['读取：数据 → 系统', '消息读访问', '读访问', '读取', '读写', '消费'],
  mutable_access: ['可变访问：系统 → 数据', '消息写访问', '写访问', '可变访问', '写入', '修改', '读写'],
  read_write: ['读取与可变访问', '读写访问', '读访问', '写访问', '读取', '可变访问', '读写'],
  write: ['修改：系统 → 数据', '写访问：系统 → 数据', '消息写访问', '写访问', '可变访问', '写入', '修改', '读写'],
  filter: ['存在性约束', '查询筛选'], contains: ['实体包含组件', '包含组件', '包含'],
  create: ['创建实体', '创建'], insert: ['插入组件或资源', '插入'], remove: ['移除组件或资源', '移除'],
  initialize: ['按需初始化'], despawn: ['销毁实体', '销毁'],
  publish: ['发布：生产者 → 消息缓冲', '发布消息', '写入消息', '发布', '写入'],
  consume: ['消费：消息缓冲 → 消费者', '消息读访问', '消费消息', '读取', '消费'],
  emit: ['发出：发起者 → 事件', '触发事件', '发出', '触发'],
  observe: ['触发：来源 → Observer', '接收事件', '观察事件', '触发'],
  transition: ['状态转换'], reference: ['普通引用：持有者 → 目标', '普通引用', '引用'],
  relationship: ['Bevy 关系：关系源 → 目标', 'Bevy关系'],
  set_membership: ['系统集合 → 成员系统', '集合成员'], group_membership: ['系统分组 → 成员系统', '分组成员'],
  constraint: ['调度契约 → 参与集合', '调度契约参与'],
  registration: ['装配方 → 注册对象', '注册调用', '安装调用', '首先安装', '显式安装', '先安装', '再安装', '安装', '注册'],
  condition: ['条件绑定', '运行条件'], alternative: ['结构候选'],
  dependency: ['契约使用方 → 提供方', '契约依赖', '读取', '使用', '发布'],
};

export function edgeLabelDetailsOf(link, semantic) {
  if (!Object.hasOwn(EDGE_STYLES, semantic)) throw new Error(`Unknown architecture edge semantic: ${semantic}`);
  let detail = String(link.label ?? '').trim();
  const prefixes = [...edgeLabelPrefixes[semantic], 'R / W', 'R/W', 'R', 'W'].sort((a, b) => b.length - a.length);
  // 仅识别确定的类别前缀与分隔符，领域名称和约束原文保持完整。
  let previous;
  do {
    previous = detail;
    for (const prefix of prefixes) {
      if (detail === prefix) return '';
      if (detail.startsWith(prefix) && /^[\s:：/·]/.test(detail.slice(prefix.length))) {
        detail = detail.slice(prefix.length).replace(/^[\s:：/·]+/, '');
      }
    }
  } while (detail !== previous);
  if (['order', 'nested', 'schedule'].includes(semantic)) {
    detail = detail.replace(/^(?:after|before)\((.+)\)$/, '$1').replace(/\s*→\s*$/, '').trim();
  }
  return detail;
}

export function displayLabelOf(link, semantic, registry, details = edgeLabelDetailsOf(link, semantic)) {
  if (!Object.hasOwn(EDGE_STYLES, semantic)) throw new Error(`Unknown architecture edge semantic: ${semantic}`);
  const style = EDGE_STYLES[semantic];
  const dataId = semantic === 'read' ? link.from : link.to;
  const data = registry?.[dataId];
  const message = data && ['message', 'message_buffer'].includes(visualTypeOf(data));
  const label = message && style.messageLabel ? style.messageLabel : style.label;
  return details ? label + ' · ' + details : label;
}

export function scheduleLinksFor(groups) {
  const ids = new Set();
  for (const group of groups) {
    if (ids.has(group.id)) throw new Error(`Duplicate Schedule group: ${group.id}`);
    ids.add(group.id);
  }
  const mainTracks = new Set(['startup', 'frame', 'conditional', 'fixed']);
  const main = groups.filter(group => mainTracks.has(group.track) || group.id === 'RunFixedMainLoop.AfterFixedMainLoop').toSorted((a, b) => a.order - b.order);
  const links = main.slice(1).map((group, index) => ({ id: `schedule-${main[index].id}-${group.id}`, from: main[index].id, to: group.id, edgeSemantic: 'schedule', displayLabel: EDGE_STYLES.schedule.label }));
  if (ids.has('PostUpdate') && ids.has('EguiPrimaryContextPass')) links.push({ id: 'nested-PostUpdate-EguiPrimaryContextPass', from: 'PostUpdate', to: 'EguiPrimaryContextPass', edgeSemantic: 'nested', displayLabel: EDGE_STYLES.nested.label });
  return links;
}

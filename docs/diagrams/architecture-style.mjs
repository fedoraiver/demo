// 节点、连线、图例与导出共同使用这份视觉语义，不修改清单中的 Rust 类型或关系身份。
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
  plugin: nodeStyle('插件与装配', 'Plugin / App', 'fr-rect', '#4A6389', 2.2),
  contract: nodeStyle('集合与公开契约', 'Contract', 'lin-rect', '#6A778C'),
  external_io: nodeStyle('外部 I/O', 'External I/O / Platform API', 'lean-l', '#526A78'),
  note: nodeStyle('说明与结果摘要', 'Note', 'doc', '#9A9B88', 1.2),
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
  observe: { label: '触发：事件 → Observer', legendLabel: 'Observer invocation', stroke: '#B66B2D', width: 1.8, dash: '2 4' },
  transition: { label: '状态转换', legendLabel: 'State transition', stroke: '#A64E76', width: 2, dash: '10 4 2 4' },
  reference: { label: '普通引用：持有者 → 目标', legendLabel: 'Reference', stroke: '#7B4DB2', width: 1.5, dash: '6 4' },
  relationship: { label: 'Bevy 关系：关系源 → 目标', legendLabel: 'Relationship', stroke: '#7B4DB2', width: 1.8, dash: null },
  membership: { label: '集合 → 成员系统', legendLabel: 'SystemSet / group membership', stroke: '#6A778C', width: 1.4, dash: '2 4' },
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

const visualTypes = new Map([
  ['system', 'system'], ['engine', 'system'], ['Engine', 'system'], ['Engine system', 'system'], ['sync', 'contract'],
  ['observer', 'observer'], ['Engine observers', 'observer'],
  ['Entity', 'entity'], ['Component', 'component'], ['Resource', 'resource'], ['Local', 'local'], ['NonSend', 'non_send'],
  ['Message', 'message'], ['EntityEvent', 'event'], ['Native platform event', 'external_io'],
  ['Plugin', 'plugin'], ['PluginGroup', 'plugin'], ['App', 'plugin'], ['Registration helper', 'plugin'],
  ['SystemSet', 'contract'], ['Engine SystemSet', 'contract'], ['Engine system set', 'contract'],
  ['SystemParam', 'contract'], ['Shared data contract', 'contract'], ['System group', 'contract'], ['Scheduling contract', 'contract'],
  ['Relationship', 'contract'], ['External I/O', 'external_io'], ['Native platform bridge', 'external_io'],
  ['Note', 'note'], ['Lifecycle note', 'note'], ['BSN layout', 'note'], ['Component write', 'note'], ['Data write', 'note'],
]);
// 旧清单中的概览条目共用 engine；按其已核对职责区分，不能把说明当成系统或资源。
const visualOverrides = new Map([
  ['ui-volume-set', 'contract'], ['ui-style-set', 'contract'],
  ['state-paused', 'note'], ['ui-next-state', 'note'], ['volume-request-source', 'note'],
  ['kira-output', 'external_io'],
  ...['time_update', 'input_update', 'enhanced_prepare', 'enhanced_evaluate', 'input_apply', 'transform_propagate',
    'egui_input', 'egui_begin', 'physics_prepare', 'physics_step', 'physics_writeback',
    'easing_reset', 'easing_start', 'easing_end', 'easing_apply', 'easing_tick', 'animation_engine', 'kira-play-typed',
    'render', 'audio-output'].map(id => [id, 'contract']),
]);

export function visualTypeOf(node) {
  const type = visualTypes.get(node?.kind);
  if (!type) throw new Error(`Unknown architecture node kind: ${node?.kind} (${node?.id || node?.name || 'unnamed'})`);
  if (node.kind === 'Resource' && /^Messages\s*</.test(node.name || '')) return 'message_buffer';
  return visualOverrides.get(node.id) || type;
}

const messageTypes = new Set(['message', 'message_buffer']);
const memberSources = new Set(['ui-volume-set', 'ui-style-set']);
const memberKinds = new Set(['SystemSet', 'Engine SystemSet', 'Engine system set']);
const directSemantics = new Set(['order', 'transition', 'reference', 'relationship', 'dependency']);

export function edgeSemanticOf(link, registry) {
  if (directSemantics.has(link.kind)) return link.kind;
  const from = registry[link.from], to = registry[link.to];
  if (!from || !to) throw new Error(`Architecture edge endpoint missing: ${link.id || `${link.from} → ${link.to}`}`);
  if (link.kind === 'read') return messageTypes.has(visualTypeOf(from)) ? 'consume' : 'read';
  if (link.kind === 'write') return messageTypes.has(visualTypeOf(to)) ? 'publish' : 'write';
  if (link.kind === 'trigger') {
    if (visualTypeOf(from) === 'event' && visualTypeOf(to) === 'observer') return 'observe';
    if (visualTypeOf(to) === 'event') return 'emit';
    throw new Error(`Architecture trigger has no event/Observer contract: ${link.id}`);
  }
  if (link.kind === 'registration') {
    if (from.kind === 'Scheduling contract') return 'constraint';
    if (memberKinds.has(from.kind) || memberSources.has(from.id)) return 'membership';
    if (visualTypeOf(from) === 'plugin') return 'registration';
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

// Mermaid 定义、业务身份和图例共用视觉语义；不手工重画编译后的图形。
import { NODE_STYLES, EDGE_STYLES, EXTERNAL_REFERENCE_STYLE, visualTypeOf, edgeSemanticOf, displayLabelOf, scheduleLinksFor, mermaidStyleDefinitions } from './architecture-style.mjs';
import { INFRASTRUCTURE_FEATURES } from './architecture-infrastructure.mjs';
import { buildAppSchedule } from './architecture-app-schedule.mjs';

export const DATA_GROUP_LABELS = { catalog: '数据与实体', relations: '数据流与关系' };
const displayEndpoint = (link, side) => link[side === 'from' ? 'displayFrom' : 'displayTo'] ?? link[side];

export function entityComponentColumns(components) {
  const count = Math.min(4, Math.ceil(components.length / 6));
  if (!count) return [];
  const size = Math.floor(components.length / count), extra = components.length % count;
  return Array.from({ length: count }, (_, index) => {
    const start = index * size + Math.min(index, extra);
    return components.slice(start, start + size + (index < extra ? 1 : 0));
  });
}

export function dataLayoutColumns(units) {
  const count = Math.min(8, Math.max(1, Math.ceil(Math.sqrt(units.length / 4))));
  const columns = Array.from({ length: count }, () => []), weights = columns.map(() => 0);
  for (const unit of units) {
    const index = weights.indexOf(Math.min(...weights));
    columns[index].push(unit);
    weights[index] += unit.components ? Math.max(...entityComponentColumns(unit.components).map(column => column.length)) + 2 : 1;
  }
  return columns.filter(column => column.length);
}

export function dataObserverLayoutPairs(nodes, links) {
  const observers = nodes.filter(node => node.visualType === 'observer');
  const targets = new Map(observers.map(node => [node.id, new Set(links.filter(link => displayEndpoint(link, 'from') === node.id).map(link => displayEndpoint(link, 'to')))]));
  const peers = new Map(observers.map(node => [node.id, new Set()]));
  for (const [index, node] of observers.entries()) for (const other of observers.slice(index + 1)) {
    if ([...targets.get(node.id)].some(target => targets.get(other.id).has(target))) {
      peers.get(node.id).add(other.id); peers.get(other.id).add(node.id);
    }
  }
  const downstream = new Map();
  function connect(from, to) {
    if (!downstream.has(from)) downstream.set(from, new Set());
    downstream.get(from).add(to);
  }
  for (const link of links) connect(displayEndpoint(link, 'from'), displayEndpoint(link, 'to'));
  function reaches(from, to) {
    const pending = [from], visited = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (id === to) return true;
      if (visited.has(id)) continue;
      visited.add(id); pending.push(...(downstream.get(id) || []));
    }
    return false;
  }
  const remaining = new Set(observers.map(node => node.id)), result = [];
  while (remaining.size) {
    const members = new Set(), pending = [remaining.values().next().value];
    while (pending.length) {
      const id = pending.pop();
      if (!remaining.delete(id)) continue;
      members.add(id); pending.push(...peers.get(id));
    }
    const ordered = observers.filter(node => members.has(node.id));
    for (let index = 1; index < ordered.length; index++) {
      const from = ordered[index - 1].id, to = ordered[index].id;
      if (reaches(from, to) || reaches(to, from)) continue;
      result.push([from, to]); connect(from, to);
    }
  }
  return result;
}

function dataRelationGroups(units, links) {
  const owner = new Map(units.flatMap(unit => (unit.components ? [unit.entity, ...unit.components] : [unit.id]).map(id => [id, unit])));
  const neighbors = new Map(units.map(unit => [unit, new Set()]));
  for (const link of links) {
    const from = owner.get(displayEndpoint(link, 'from')), to = owner.get(displayEndpoint(link, 'to'));
    neighbors.get(from).add(to); neighbors.get(to).add(from);
  }
  const remaining = new Set(units), groups = [];
  while (remaining.size) {
    const members = new Set(), pending = [remaining.values().next().value];
    while (pending.length) {
      const unit = pending.pop();
      if (!remaining.delete(unit)) continue;
      members.add(unit); pending.push(...neighbors.get(unit));
    }
    groups.push({ units: units.filter(unit => members.has(unit)), links: links.filter(link => members.has(owner.get(displayEndpoint(link, 'from')))) });
  }
  return groups;
}

const escape = value => String(value ?? '').replace(/[&<>"#`]/g, character => ({ '&': '#amp;', '<': '#lt;', '>': '#gt;', '"': '#quot;', '#': '#35;', '`': '#96;' }[character]));
const length = value => [...String(value)].reduce((sum, character) => sum + (character.charCodeAt(0) > 255 ? 1.8 : 1), 0);
function wrap(value, limit = 36) {
  const lines = []; let line = '';
  // 保留完整名称，优先在标识符和自然语言边界换行。
  const tokens = String(value ?? '').replace(/\s+/g, ' ').trim().split(/(?<=_|::|\/|\s)|(?=[\u3400-\u9fff])/u);
  for (const token of tokens) {
    if (line && length(line + token) > limit) { lines.push(line.trim()); line = ''; }
    for (const character of token) {
      if (line && length(line + character) > limit) { lines.push(line.trim()); line = ''; }
      line += character;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}
const text = values => values.filter(Boolean).flatMap(value => wrap(value)).map(escape).join('<br/>');
function nodeText(name, context) {
  return [...wrap(name).map(line => `**${escape(line)}**`),
    ...context.filter(Boolean).flatMap(value => wrap(value)).map(escape)].join('<br/>');
}

export function mermaidConfiguration(aspect) {
  return { theme: 'base', look: 'classic', layout: 'dagre', maxTextSize: 200000, htmlLabels: false, fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
    themeVariables: { primaryTextColor: '#1F3340', lineColor: '#64748B', clusterBkg: '#F8FAFC', clusterBorder: '#DDE4ED', edgeLabelBackground: '#FFFFFF', fontSize: '14px' },
    flowchart: { htmlLabels: false, nodeSpacing: 32, rankSpacing: aspect === 'data' ? 8 : 56, padding: 16, wrappingWidth: 280, minNodeWidth: 180, useMaxWidth: false, curve: 'linear' },
  };
}

function definition(view, graph, registry, features, scheduleGroups = []) {
  const base = { ...view, engine: 'mermaid', diagramType: 'flowchart', width: 0, height: 0, svg: null, filename: null, mermaid: null, mermaidFilename: null, nodes: [], links: [], scheduleLinks: [], layoutLinks: [], scheduleGroups: [], entityGroups: [], sections: [] };
  if (graph.empty || !graph.nodes.length) return base;
  const names = new Map([...features, ...INFRASTRUCTURE_FEATURES].map(feature => [feature.id, feature.label]));
  const entityGroups = [];
  const nodes = graph.nodes.flatMap((node, index) => {
    const data = { ...registry[node.id], ...(view.aspect === 'component' && node.id === (view.componentNodeId || graph.componentNodeId) ? view.componentDetails : {}) }, visualType = visualTypeOf(data);
    if (data.display_summary !== undefined && (typeof data.display_summary !== 'string' || !data.display_summary.trim())) throw new Error(`架构节点用途简介必须是非空文本：${node.id}`);
    const feature = node.role === 'plugin' && features.find(item => `plugin-${item.plugin}` === node.id);
    const infrastructure = node.role === 'plugin' && INFRASTRUCTURE_FEATURES.find(item => item.overviewNode === node.id);
    const name = feature ? `${feature.label} · ${feature.plugin}` : infrastructure ? infrastructure.label + (data.name === infrastructure.label ? '' : ` · ${data.name}`) : data.name || node.id;
    const description = node.role === 'plugin' ? feature?.description || data.description : data.description;
    const summary = String(data.display_summary ?? description ?? '').replace(/\s+/g, ' ').trim();
    if (!summary) throw new Error(`架构节点缺少用途简介：${node.id}`);
    const scope = node.role === 'external' ? `来自${names.get(data.feature)} ↗` : null;
    const contents = [scope ? `${scope}：${summary}` : summary];
    return [{ ...node, instance: `${view.id}--n${index}`, mermaidId: `n${index}`, visualType, shape: NODE_STYLES[visualType].shape, displayLabel: [name, ...contents].join('\n'), nameLabel: name, contextLabel: contents }];
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length) throw new Error(`同一视图重复声明节点：${view.id}`);
  const links = graph.links.map((link, index) => {
    const edgeSemantic = edgeSemanticOf(link, registry);
    const nativeReverse = view.aspect === 'component' && displayEndpoint(link, 'from') === (view.componentNodeId || graph.componentNodeId)
      && byId.get(displayEndpoint(link, 'to'))?.visualType !== 'entity';
    return { ...link, ...(nativeReverse ? { nativeReverse: true } : {}), mermaidId: `e${index}`, edgeSemantic, displayLabel: displayLabelOf(link, edgeSemantic, registry) };
  });
  const groups = scheduleGroups.map((group, index) => ({ ...group, mermaidId: `sg${index}`, nodes: group.nodes.map(node => node.id) }));
  const scheduleLinks = (view.layout === 'app-schedule' ? view.phaseLinks : scheduleLinksFor(groups)).map((link, index) => ({ ...link, mermaidId: `sc${index}` }));
  const types = { nodeTypes: Object.keys(NODE_STYLES).filter(type => nodes.some(node => node.visualType === type)), edgeTypes: Object.keys(EDGE_STYLES).filter(type => [...links, ...scheduleLinks].some(link => link.edgeSemantic === type)) };
  const configuration = mermaidConfiguration(view.aspect);
  if (view.aspect === 'component') Object.assign(configuration.flowchart, { nodeSpacing: 16, rankSpacing: 32 });
  if (links.some(link => link.nativeReverse)) {
    // Mermaid 12 不支持单向左箭头。源配置复用本图真实关系生成的原生 pointStart；不改编译后的路径或 marker。
    const marker = `${view.id}_flowchart-v2-pointStart`;
    configuration.themeCSS = links.filter(link => link.nativeReverse).map(link => `#${view.id}-${link.mermaidId}{marker-start:url(#${marker})!important}`).join('\n')
      + `\n#${marker} path{fill:context-stroke!important;stroke:context-stroke!important}`;
  }
  const lines = ['---', JSON.stringify({ config: configuration }, null, 2), '---', `flowchart ${view.aspect === 'component' ? 'RL' : ['overview', 'events'].includes(view.aspect) ? 'LR' : 'TB'}`, `  accTitle: ${view.label}`, `  accDescr: ${view.summary}`, '  %% n*/e* 是业务节点/关系，sc* 是阶段关系；layout_* 仅用于排版。'];
  lines.push(...mermaidStyleDefinitions(types.nodeTypes, types.edgeTypes).map(line => '  ' + line));
  const layoutLinks = [];
  function layout(from, to) {
    const mermaidId = `layout_${layoutLinks.length}`;
    layoutLinks.push({ mermaidId, from, to }); lines.push(`  ${from} ${mermaidId}@~~~ ${to}`);
  }
  function declare(node) {
    lines.push(`  ${node.mermaidId}@{ shape: ${node.shape}, label: "${nodeText(node.nameLabel, node.contextLabel)}" }`, `  class ${node.mermaidId} node_${node.visualType}`);
    if (node.role === 'external') lines.push(`  class ${node.mermaidId} external_node`);
  }
  function edge(link, from, to) {
    lines.push(`  ${link.nativeReverse ? to : from} ${link.mermaidId}@${link.nativeReverse ? '---' : '-->'}${link.displayLabel ? `|"${text([link.displayLabel])}"|` : ''} ${link.nativeReverse ? from : to}`, `  class ${link.mermaidId} edge_${link.edgeSemantic}`);
  }
  function declareLinks(selected = links) {
    for (const link of selected) {
      const from = displayEndpoint(link, 'from'), to = displayEndpoint(link, 'to');
      if (!byId.has(from) || !byId.has(to)) throw new Error(`Mermaid 关系端点不存在：${link.id}`);
      edge(link, byId.get(from).mermaidId, byId.get(to).mermaidId);
    }
  }
  const declareUnit = declare;
  if (!['data', 'component'].includes(view.aspect)) lines.push('  subgraph diagram_main[" "]', '  direction LR', '  style diagram_main fill:none,stroke:none');
  if (view.aspect === 'component') {
    nodes.forEach(declare);
    const center = byId.get(view.componentNodeId || graph.componentNodeId);
    if (!center) throw new Error(`组件类型图缺少中心节点：${view.id}`);
    // 真实读写方向可互逆；独立不可见边只固定三栏，不表达执行先后。
    for (const node of nodes) if (node.id !== center.id) {
      if (node.visualType === 'entity') layout(center.mermaidId, node.mermaidId);
      else layout(node.mermaidId, center.mermaidId);
    }
    declareLinks([...links.filter(link => displayEndpoint(link, 'from') !== center.id), ...links.filter(link => displayEndpoint(link, 'from') === center.id)]);
  } else if (view.aspect === 'systems' || view.layout === 'app-schedule') {
    for (const group of groups) {
      lines.push(`  subgraph ${group.mermaidId}["${text(group.label.split('\n'))}"]`, '  direction TB');
      for (const id of group.nodes) declare(byId.get(id));
      if (!group.nodes.length) lines.push(`  phase_anchor_${group.mermaidId}@{ shape: anchor, label: " " }`, `  style phase_anchor_${group.mermaidId} opacity:0`);
      for (let index = 1; index < group.nodes.length; index++) layout(byId.get(group.nodes[index - 1]).mermaidId, byId.get(group.nodes[index]).mermaidId);
      lines.push('  end');
    }
    if (groups.flatMap(group => group.nodes).length !== nodes.length) throw new Error(`Schedule 分组没有覆盖全部节点：${view.id}`);
    const groupById = new Map(groups.map(group => [group.id, group]));
    for (let index = 1; index < groups.length; index++) if (!scheduleLinks.some(link => link.from === groups[index - 1].id && link.to === groups[index].id)) layout(groups[index - 1].mermaidId, groups[index].mermaidId);
    for (const link of scheduleLinks) edge(link, groupById.get(link.from).mermaidId, groupById.get(link.to).mermaidId);
    declareLinks();
  } else {
    const connectedIds = new Set(links.flatMap(link => [displayEndpoint(link, 'from'), displayEndpoint(link, 'to')]));
    const memberGroup = new Map(entityGroups.filter(group => group.expanded).flatMap(group => [group.entity, ...group.components].map(id => [id, group])));
    const emitted = new Set(), units = nodes.flatMap(node => {
      const unit = memberGroup.get(node.id) || node;
      if (emitted.has(unit.id)) return [];
      emitted.add(unit.id); return [unit];
    });
    const connected = unit => (unit.components ? [unit.entity, ...unit.components] : [unit.id]).some(id => connectedIds.has(id));
    const related = units.filter(connected), isolated = units.filter(unit => !connected(unit));
    if (view.aspect === 'data') {
      if (related.length) {
        lines.push(`  subgraph relations["${DATA_GROUP_LABELS.relations}"]`, '  direction LR');
        for (const [index, group] of dataRelationGroups(related, links).entries()) {
          lines.push(`  subgraph relation_${index}[" "]`, '  direction TB');
          group.units.forEach(declareUnit);
          for (const [from, to] of dataObserverLayoutPairs(group.units, group.links)) layout(byId.get(from).mermaidId, byId.get(to).mermaidId);
          declareLinks(group.links);
          lines.push('  end', `  style relation_${index} fill:none,stroke:none`);
        }
        lines.push('  end');
      }
      if (isolated.length) {
        lines.push(`  subgraph catalog["${DATA_GROUP_LABELS.catalog}"]`, '  direction LR');
        const columns = dataLayoutColumns(isolated);
        for (const [index, column] of columns.entries()) {
          lines.push(`  subgraph column_${index}[" "]`, '  direction TB');
          column.forEach(declareUnit);
          for (let row = 1; row < column.length; row++) layout(column[row - 1].mermaidId, column[row].mermaidId);
          lines.push('  end', `  style column_${index} fill:none,stroke:none`);
        }
        for (let index = 1; index < columns.length; index++) layout(`column_${index - 1}`, `column_${index}`);
        lines.push('  end');
      }
    } else { nodes.forEach(declare); declareLinks(); }
  }
  if (!['data', 'component'].includes(view.aspect)) lines.push('  end');
  return { ...base, nodes, links, scheduleLinks, layoutLinks, scheduleGroups: groups, entityGroups, mermaid: lines.join('\n') + '\n', mermaidFilename: `ecs-${view.id}.mmd`, filename: `ecs-${view.id}.svg` };
}

export function renderGraphView(view, graph, registry, features, scheduleGroups) {
  return definition(view, graph, registry, features, scheduleGroups);
}

export function renderOverview(model, registry, features) {
  const app = buildAppSchedule(model, registry);
  const view = { id: 'overview', feature: null, aspect: 'overview', layout: 'app-schedule', label: 'App 系统调度总览', summary: '启动流程只执行一次；每帧依次处理输入、状态、固定循环与呈现。固定循环可执行零到多步；Observer、原生回调和渲染子应用分别展示。组内仅显式连线表示顺序。', phaseLinks: app.phaseLinks };
  return definition(view, app.graph, registry, features, app.groups);
}

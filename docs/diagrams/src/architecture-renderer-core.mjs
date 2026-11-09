// Mermaid 定义、业务身份和图例共用视觉语义；不手工重画编译后的图形。
import { NODE_STYLES, EDGE_STYLES, EXTERNAL_REFERENCE_STYLE, ARCHITECTURE_TEXT_STYLE, visualTypeOf, scheduleLinksFor, mermaidStyleDefinitions } from './architecture-style.mjs';
import { INFRASTRUCTURE_FEATURES } from './architecture-infrastructure.mjs';
import { architectureDisplayName } from './architecture-labels.mjs';

import { VIEWER_BACKGROUND } from './viewer-theme.mjs';
import { createVisualEdgeGroups, isVisibleRelation } from './architecture-visual-edges.mjs';

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

export function observerBranchLayoutPairs(nodes, links, groups) {
  const downstream = new Map(), pairs = [];
  const connect = (from, to) => {
    if (!downstream.has(from)) downstream.set(from, new Set());
    downstream.get(from).add(to);
  };
  for (const link of links) connect(link.from, link.to);
  for (const group of groups) for (let index = 1; index < group.nodes.length; index++) connect(group.nodes[index - 1], group.nodes[index]);
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
  for (const group of groups) {
    const attachments = new Set(group.visualAttachments || []), members = new Set([...group.nodes, ...attachments]);
    for (const source of nodes.filter(node => members.has(node.id))) {
      const targets = nodes.filter(node => attachments.has(node.id) && links.some(link => link.projection === 'observer-trigger' && link.from === source.id && link.to === node.id));
      const ordered = [];
      while (ordered.length < targets.length) {
        const next = targets.find(node => !ordered.includes(node) && targets.filter(other => other !== node && !ordered.includes(other)).every(other => !reaches(other.id, node.id)));
        if (!next) break;
        ordered.push(next);
      }
      for (let index = 1; index < ordered.length; index++) {
        const from = ordered[index - 1].id, to = ordered[index].id;
        if (reaches(from, to) || reaches(to, from)) continue;
        pairs.push([from, to]); connect(from, to);
      }
    }
  }
  return pairs;
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

const mermaidEntities = value => String(value ?? '').replace(/[&<>"#`]/g, character => ({ '&': '#amp;', '<': '#lt;', '>': '#gt;', '"': '#quot;', '#': '#35;', '`': '#96;' }[character]));
// 防止 Mermaid 将 Rust 名称中的下划线和指针星号解析为 Markdown 强调符。
const escape = value => mermaidEntities(value).replace(/[_*]/g, character => character === '_' ? '\u200B_\u200B' : '\u200B\uFEFF*\uFEFF\u200B');
const length = value => [...String(value)].reduce((sum, character) => sum + (character.charCodeAt(0) > 255 ? 1.8 : 1), 0);
function wrap(value, limit = 36) {
  const lines = []; let line = '';
  // 保留完整显示标题，优先在标识符和自然语言边界换行。
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
// 原生边标签先经 HTML 清洗器还原引号与 #，再交给 Mermaid 测量和排版。
const edgeText = value => text([value]).replaceAll('#quot;', '&quot;').replaceAll('#35;', '&num;');
function nodeText(name, context) {
  return [...wrap(name).map(line => `**${escape(line)}**`),
    ...context.filter(Boolean).flatMap(value => wrap(value)).map(escape)].join('<br/>');
}
function nodeLabel(name, context) {
  // YAML 先还原引号和 #，避免原生 SVG 保留 &quot; 或 &#35;；零宽字符阻止 Markdown 吞掉原文反斜杠。
  return nodeText(name, context).replaceAll('\\', '\\u005c\u200B').replaceAll('#quot;', '\\u0022').replaceAll('#35;', '\\u0023');
}

function distinguishNodeLabels(nodes, registry) {
  const fullName = record => record.name;
  const packageName = record => {
    const dependency = record.typeIdentity?.package;
    return dependency && [dependency.name, dependency.version].filter(Boolean).join(' ');
  };
  const definition = record => {
    const source = record.sourceEntries?.find(entry => entry.role === 'definition');
    return source && `${source.path}:${source.line}`;
  };
  const identity = (record, node) => record.declarationId || record.typeIdentity?.declarationId || node.id;
  const objectIdentity = (_record, node) => node.id;
  for (const contextOf of [fullName, packageName, definition, identity, objectIdentity]) {
    const collisions = Map.groupBy(nodes, node => node.displayLabel);
    for (const peers of collisions.values()) {
      if (peers.length < 2) continue;
      const contexts = peers.map(node => contextOf(registry[node.id] || {}, node));
      if (!contexts.every(Boolean) || new Set(contexts).size < 2) continue;
      for (const [index, node] of peers.entries()) {
        const context = contexts[index];
        if (context === node.nameLabel || node.contextLabel.includes(context)) continue;
        node.contextLabel = [...node.contextLabel, context];
        node.displayLabel = [node.nameLabel, ...node.contextLabel].join('\n');
      }
    }
  }
}

export function mermaidConfiguration(aspect) {
  return { theme: 'base', look: 'classic', layout: 'dagre', maxTextSize: 200000, htmlLabels: false, fontFamily: ARCHITECTURE_TEXT_STYLE.fontFamily,
    themeVariables: { primaryTextColor: ARCHITECTURE_TEXT_STYLE.color, lineColor: '#64748B', clusterBkg: '#F8FAFC', clusterBorder: '#DDE4ED', edgeLabelBackground: '#FFFFFF', fontSize: ARCHITECTURE_TEXT_STYLE.fontSize + 'px' },
    flowchart: { htmlLabels: false, nodeSpacing: 32, rankSpacing: aspect === 'data' ? 8 : 56, padding: 16, wrappingWidth: 280, minNodeWidth: 180, useMaxWidth: false, curve: 'linear' },
  };
}

function definition(view, graph, registry, features, scheduleGroups = [], buildObserverPlacement) {
  const base = { ...view, engine: 'mermaid', diagramType: 'flowchart', width: 0, height: 0, svg: null, filename: null, mermaid: null, mermaidFilename: null, nodes: [], links: [], visualEdgeGroups: [], scheduleLinks: [], layoutLinks: [], scheduleGroups: [], observerBranches: [], entityGroups: [], sections: [] };
  if (graph.empty || !graph.nodes.length) return base;
  const names = new Map([...features, ...INFRASTRUCTURE_FEATURES].map(feature => [feature.id, feature.label]));
  const entityGroups = [];
  const nodes = graph.nodes.flatMap((node, index) => {
    const data = { ...registry[node.id], ...(view.aspect === 'component' && node.id === (view.componentNodeId || graph.componentNodeId) ? view.componentDetails : {}) }, visualType = visualTypeOf(data);
    const feature = node.role === 'plugin' && features.find(item => item.overviewNode === node.id);
    const shortName = architectureDisplayName(data.name || node.id, { kind: data.kind });
    const name = feature ? `${feature.label} · ${shortName}` : shortName;
    const scope = node.role === 'external' ? `来自${names.get(data.feature)} ↗` : null;
    const contents = scope ? [scope] : [];
    return [{ ...node, instance: `${view.id}--n${index}`, mermaidId: `n${index}`, visualType, shape: NODE_STYLES[visualType].shape, displayLabel: [name, ...contents].join('\n'), nameLabel: name, contextLabel: contents }];
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length) throw new Error(`同一视图重复声明节点：${view.id}`);
  distinguishNodeLabels(nodes, registry);
  const objectCenter = view.centerNodeId || graph.centerNodeId;
  const canonicalLinks = graph.links.filter(isVisibleRelation);
  const visualGroups = graph.visualEdgeGroups ?? createVisualEdgeGroups(canonicalLinks, registry);
  // 双向访问放在同一侧，使用原生起点箭头保留真实方向，避免把一跳图排成有向环。
  const objectIncoming = new Set(view.aspect === 'object' ? visualGroups.filter(link => displayEndpoint(link, 'to') === objectCenter && displayEndpoint(link, 'from') !== objectCenter).map(link => displayEndpoint(link, 'from')) : []);
  const links = visualGroups.map((link, index) => {
    const edgeSemantic = link.edgeSemantic;
    const bidirectional = link.forwardIds.length > 0 && link.backwardIds.length > 0;
    const nativeReverse = !bidirectional && ((view.aspect === 'component' && displayEndpoint(link, 'from') === (view.componentNodeId || graph.componentNodeId)
      && byId.get(displayEndpoint(link, 'to'))?.visualType !== 'entity')
      || (view.aspect === 'object' && displayEndpoint(link, 'from') === objectCenter && objectIncoming.has(displayEndpoint(link, 'to'))));
    const rendered = { ...link, mermaidId: `e${index}`, edgeSemantic, displayLabel: link.displayLabel };
    delete rendered.nativeReverse;
    if (nativeReverse) rendered.nativeReverse = true;
    return rendered;
  });
  const placement = view.aspect === 'systems' || view.layout === 'app-schedule' ? buildObserverPlacement(graph, registry, scheduleGroups) : { groups: scheduleGroups, branches: [] };
  const groups = placement.groups.map((group, index) => ({ ...group, mermaidId: `sg${index}`, nodes: group.nodes.map(node => typeof node === 'string' ? node : node.id) }));
  const observerBranches = placement.branches.map((branch, index) => ({ ...branch, mermaidId: `ob${index}` }));
  const scheduleLinks = (view.layout === 'app-schedule' ? view.phaseLinks : scheduleLinksFor(groups)).map((link, index) => ({ ...link, mermaidId: `sc${index}` }));
  const types = { nodeTypes: Object.keys(NODE_STYLES).filter(type => nodes.some(node => node.visualType === type)), edgeTypes: Object.keys(EDGE_STYLES).filter(type => [...links, ...scheduleLinks].some(link => link.edgeSemantic === type)) };
  const configuration = mermaidConfiguration(view.aspect);
  if (view.aspect === 'component') Object.assign(configuration.flowchart, { nodeSpacing: 16, rankSpacing: 32 });
  if (view.aspect === 'object') Object.assign(configuration.flowchart, { nodeSpacing: 16, rankSpacing: 48 });
  if (links.some(link => link.nativeReverse)) {
    // Mermaid 12 不支持单向左箭头。源配置复用本图真实关系生成的原生 pointStart；不改编译后的路径或 marker。
    const marker = `${view.id}_flowchart-v2-pointStart`;
    configuration.themeCSS = links.filter(link => link.nativeReverse).map(link => `#${view.id}-${link.mermaidId}{marker-start:url(#${marker})!important}`).join('\n')
      + `\n#${marker} path{fill:context-stroke!important;stroke:context-stroke!important}`;
  }
  if (links.some(link => link.displayLabel)) {
    configuration.themeCSS = [configuration.themeCSS, `.edgeLabel rect { opacity:1!important; fill:${VIEWER_BACKGROUND}!important; }`].filter(Boolean).join('\n');
  }
  const lines = ['---', JSON.stringify({ config: configuration }, null, 2), '---', `flowchart ${view.aspect === 'component' ? 'RL' : ['overview', 'events', 'object'].includes(view.aspect) ? 'LR' : 'TB'}`, `  accTitle: ${mermaidEntities(view.label)}`, `  accDescr: ${mermaidEntities(view.summary)}`, '  %% n*/e* 是业务节点/关系，sc* 是阶段关系；layout_* 仅用于排版。'];
  lines.push(...mermaidStyleDefinitions(types.nodeTypes, types.edgeTypes).map(line => '  ' + line));
  const layoutLinks = [];
  function layout(from, to) {
    const mermaidId = `layout_${layoutLinks.length}`;
    layoutLinks.push({ mermaidId, from, to }); lines.push(`  ${from} ${mermaidId}@~~~ ${to}`);
  }
  function declare(node) {
    lines.push(`  ${node.mermaidId}@{ shape: ${node.shape}, label: "${nodeLabel(node.nameLabel, node.contextLabel)}" }`, `  class ${node.mermaidId} node_${node.visualType}`);
    if (node.role === 'external') lines.push(`  class ${node.mermaidId} external_node`);
  }
  function edge(link, from, to) {
    const bidirectional = link.forwardIds?.length > 0 && link.backwardIds?.length > 0;
    lines.push(`  ${link.nativeReverse ? to : from} ${link.mermaidId}@${bidirectional ? '<-->' : link.nativeReverse ? '---' : '-->'}${link.displayLabel ? `|"${edgeText(link.displayLabel)}"|` : ''} ${link.nativeReverse ? from : to}`, `  class ${link.mermaidId} edge_${link.edgeSemantic}`);
  }
  function declareLinks(selected = links) {
    for (const link of selected) {
      const from = displayEndpoint(link, 'from'), to = displayEndpoint(link, 'to');
      if (!byId.has(from) || !byId.has(to)) throw new Error(`Mermaid 关系端点不存在：${link.id}`);
      edge(link, byId.get(from).mermaidId, byId.get(to).mermaidId);
    }
  }
  const declareUnit = declare;
  if (!['data', 'component', 'object'].includes(view.aspect)) lines.push('  subgraph diagram_main[" "]', '  direction LR', '  style diagram_main fill:none,stroke:none');
  if (view.aspect === 'object') {
    if (!byId.has(objectCenter)) throw new Error(`对象图缺少中心节点：${view.id}`);
    nodes.forEach(declare);
    declareLinks();
  } else if (view.aspect === 'component') {
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
    const grouped = new Set(groups.flatMap(group => [...group.nodes, ...(group.visualAttachments || [])]));
    const branchPairs = observerBranchLayoutPairs(nodes, links, groups);
    for (const group of groups) {
      lines.push(`  subgraph ${group.mermaidId}["${text(group.label.split('\n'))}"]`, '  direction TB');
      for (const id of [...group.nodes, ...(group.visualAttachments || [])]) declare(byId.get(id));
      if (!group.nodes.length && !group.visualAttachments?.length) lines.push(`  phase_anchor_${group.mermaidId}@{ shape: anchor, label: " " }`, `  style phase_anchor_${group.mermaidId} opacity:0`);
      for (let index = 1; index < group.nodes.length; index++) layout(byId.get(group.nodes[index - 1]).mermaidId, byId.get(group.nodes[index]).mermaidId);
      for (const [from, to] of branchPairs.filter(([from]) => group.visualAttachments?.includes(from))) layout(byId.get(from).mermaidId, byId.get(to).mermaidId);
      lines.push('  end');
    }
    // 来源旁的附属节点只表达事件关系；真实 Schedule 成员与注册仍独立保留。
    for (const branch of observerBranches) {
      lines.push(`  subgraph ${branch.mermaidId}[" "]`, '  direction TB');
      for (const id of branch.nodes) { declare(byId.get(id)); grouped.add(id); }
      lines.push('  end', `  style ${branch.mermaidId} fill:none,stroke:none`);
    }
    if (grouped.size !== nodes.length) throw new Error(`Schedule 与事件来源分支没有覆盖全部节点：${view.id}`);
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
  if (!['data', 'component', 'object'].includes(view.aspect)) lines.push('  end');
  return { ...base, nodes, links: canonicalLinks, visualEdgeGroups: links, scheduleLinks, layoutLinks, scheduleGroups: groups, observerBranches, entityGroups, mermaid: lines.join('\n') + '\n', mermaidFilename: `ecs-${view.id}.mmd`, filename: `ecs-${view.id}.svg` };
}

export function renderGraphView(view, graph, registry, features, scheduleGroups, { buildObserverPlacement } = {}) {
  return definition(view, graph, registry, features, scheduleGroups, buildObserverPlacement);
}

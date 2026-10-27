// 结构化模型只保存原始 DOT 的有效属性与成员关系；主题和筛选均作用于副本。
import { SCHEDULE_THEME } from './schedule-theme.mjs';

export const SCHEDULE_MODEL_VERSION = 1;
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };
const metadata = new Set(['name', '_gvid', '_subgraph_cnt', 'nodes', 'edges', 'subgraphs', 'objects', 'directed', 'strict', 'tail', 'head']);
const attributesOf = (object, root = false) => Object.fromEntries(Object.entries(object).filter(([key]) => !metadata.has(key) && !(root && key === 'bb')).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
  requireCondition(typeof value === 'string', 'Unsupported Graphviz attribute: ' + key);
  return [key, value];
}));
const invisible = node => (node.attributes.style || '').split(',').map(value => value.trim()).includes('invis');
export const scheduleNodeKind = node => invisible(node) ? 'marker' : node.attributes.tooltip ? 'system' : 'context';

/** dot_json 不保留 HTML 标签类型，拒绝此类输入以免往返时悄悄改变标签。 */
export function assertScheduleDotProfile(dot) {
  requireCondition(typeof dot === 'string', 'Invalid Schedule DOT');
  let quote = false, comment = '';
  for (let index = 0; index < dot.length; index++) {
    const char = dot[index], next = dot[index + 1];
    if (comment === 'line') { if (char === '\n') comment = ''; continue; }
    if (comment === 'block') { if (char === '*' && next === '/') { comment = ''; index++; } continue; }
    if (quote) { if (char === '\\') index++; else if (char === '"') quote = false; continue; }
    if (char === '"') quote = true;
    else if (char === '/' && next === '/') { comment = 'line'; index++; }
    else if (char === '/' && next === '*') { comment = 'block'; index++; }
    else if (char === '#' && (index === 0 || dot[index - 1] === '\n')) comment = 'line';
    else requireCondition(char !== '<', 'Unsupported Schedule DOT HTML label');
  }
  requireCondition(!quote && comment !== 'block', 'Unterminated Schedule DOT token');
}

export function scheduleGraphFromJson(json) {
  requireCondition(json && json.directed === true && Array.isArray(json.objects || []), 'Invalid Schedule Graphviz JSON');
  const objects = json.objects || [], groups = objects.slice(0, json._subgraph_cnt || 0), nodes = objects.slice(json._subgraph_cnt || 0);
  const byId = new Map(objects.map(object => [object._gvid, object]));
  const edgeIndices = new Map((json.edges || []).map((edge, index) => [edge._gvid, index]));
  const nodeName = id => { const node = byId.get(id); requireCondition(nodes.includes(node), 'Invalid Schedule node reference: ' + id); return node.name; };
  const groupName = id => { const group = byId.get(id); requireCondition(groups.includes(group), 'Invalid Schedule cluster reference: ' + id); return group.name; };
  const model = {
    schemaVersion: SCHEDULE_MODEL_VERSION, name: json.name, directed: true, strict: !!json.strict, attributes: attributesOf(json, true),
    nodes: nodes.map(node => ({ name: node.name, attributes: attributesOf(node) })),
    edges: (json.edges || []).map(edge => ({ tail: nodeName(edge.tail), head: nodeName(edge.head), attributes: attributesOf(edge) })),
    subgraphs: groups.map(group => ({ name: group.name, attributes: attributesOf(group), nodes: (group.nodes || []).map(nodeName),
      edges: (group.edges || []).map(id => edgeIndices.get(id)), subgraphs: (group.subgraphs || []).map(groupName) })),
  };
  validateScheduleGraph(model);
  return model;
}

/** nop 只用于读取解析后的结构；缺少坐标是预期诊断，正式排版仍使用 dot。 */
export function parseScheduleGraph(viz, input) {
  if (typeof input === 'string') assertScheduleDotProfile(input);
  const result = viz.render(input, { engine: 'nop', format: 'dot_json' });
  const unexpected = result.errors.filter(error => error.level === 'error'
    && !/^node .+ in graph .* has no position$/.test(error.message) && error.message !== 'as required by the -n flag');
  requireCondition(result.status === 'success' && !unexpected.length, 'Schedule graph parsing failed: ' + unexpected.map(error => error.message).join('; '));
  // 先检查布局前成员，避免 dot 静默删除交叠 cluster 中的节点；dot 随后补齐其布局所需的 cluster 边成员。
  scheduleGraphFromJson(JSON.parse(result.output));
  const canonical = viz.render(input, { engine: 'dot', format: 'dot_json' });
  requireCondition(canonical.status === 'success' && !canonical.errors.some(error => error.level === 'error'), 'Schedule graph canonicalization failed');
  return scheduleGraphFromJson(JSON.parse(canonical.output));
}

export function validateScheduleGraph(model) {
  requireCondition(model?.schemaVersion === SCHEDULE_MODEL_VERSION && model.directed === true && typeof model.name === 'string'
    && Array.isArray(model.nodes) && Array.isArray(model.edges) && Array.isArray(model.subgraphs), 'Invalid Schedule graph model');
  const nodes = new Map(model.nodes.map(node => [node.name, node])), groups = new Map(model.subgraphs.map(group => [group.name, group]));
  requireCondition(nodes.size === model.nodes.length && groups.size === model.subgraphs.length, 'Duplicate Schedule graph identity');
  const validateAttributes = attrs => {
    requireCondition(attrs && !Array.isArray(attrs) && Object.values(attrs).every(value => typeof value === 'string'), 'Invalid Schedule graph attributes');
    requireCondition(!Object.keys(attrs).some(key => ['URL', 'href', 'image', 'shapefile', 'stylesheet'].includes(key)), 'Unsupported Schedule graph external attribute');
  };
  validateAttributes(model.attributes);
  for (const node of model.nodes) {
    requireCondition(typeof node.name === 'string' && node.name.length > 0, 'Invalid Schedule node identity');
    validateAttributes(node.attributes);
    requireCondition(!node.name.startsWith('node_System(') || typeof node.attributes.tooltip === 'string' && node.attributes.tooltip.length > 0, 'Schedule system full name is missing: ' + node.name);
  }
  for (const edge of model.edges) {
    requireCondition(nodes.has(edge.tail) && nodes.has(edge.head), 'Invalid Schedule edge endpoint');
    validateAttributes(edge.attributes);
  }
  const parents = new Map(), directOwners = new Map();
  for (const group of model.subgraphs) {
    requireCondition(typeof group.name === 'string' && group.name.startsWith('cluster') && Array.isArray(group.nodes)
      && Array.isArray(group.edges) && Array.isArray(group.subgraphs), 'Unsupported Schedule cluster');
    validateAttributes(group.attributes);
    requireCondition(group.nodes.every(name => nodes.has(name)) && new Set(group.nodes).size === group.nodes.length, 'Invalid Schedule cluster members');
    requireCondition(group.edges.every(index => Number.isSafeInteger(index) && model.edges[index]), 'Invalid Schedule cluster edge');
    for (const name of group.subgraphs) {
      requireCondition(groups.has(name) && !parents.has(name), 'Overlapping or missing Schedule cluster');
      parents.set(name, group.name);
      requireCondition(groups.get(name).nodes.every(node => group.nodes.includes(node)), 'Invalid nested Schedule cluster members');
    }
    const childNodes = new Set(group.subgraphs.flatMap(name => groups.get(name).nodes));
    for (const name of group.nodes.filter(name => !childNodes.has(name))) {
      requireCondition(!directOwners.has(name), 'Overlapping Schedule cluster node: ' + name);
      directOwners.set(name, group.name);
    }
  }
  for (const group of model.subgraphs) {
    const visited = new Set([group.name]);
    let parent = parents.get(group.name);
    while (parent) { requireCondition(!visited.has(parent), 'Cyclic Schedule clusters'); visited.add(parent); parent = parents.get(parent); }
  }
  return { nodes, groups, parents, directOwners };
}

export function scheduleFilterTerms(value = '') {
  requireCondition(typeof value === 'string', 'Schedule filter must be text');
  return [...new Set(value.split(',').map(term => term.trim()).filter(Boolean))];
}

export function scheduleFilterNames(value = []) {
  requireCondition(Array.isArray(value) && value.every(name => typeof name === 'string' && name.length > 0), 'Schedule system names must be an array of nonempty strings');
  return [...new Set(value)];
}

/** 严格筛选不加回依赖邻居、不穿透被删节点补边；集合仅保留命中系统所需的容器和 marker。 */
export function filterScheduleGraph(model, { includeNames = [], excludeNames = [], include = '', exclude = '', includeRestricted = false } = {}) {
  const { nodes, groups, parents, directOwners } = validateScheduleGraph(model);
  const includes = scheduleFilterTerms(include), excludes = scheduleFilterTerms(exclude);
  const exactIncludes = new Set(scheduleFilterNames(includeNames)), exactExcludes = new Set(scheduleFilterNames(excludeNames));
  if (!includes.length && !excludes.length && !exactIncludes.size && !exactExcludes.size && !includeRestricted) return structuredClone(model);
  const selected = new Set(model.nodes.filter(node => scheduleNodeKind(node) === 'system'
    && !exactExcludes.has(node.attributes.tooltip) && !excludes.some(term => node.attributes.tooltip.includes(term))
    && (!includes.length && !exactIncludes.size && !includeRestricted || exactIncludes.has(node.attributes.tooltip) || includes.some(term => node.attributes.tooltip.includes(term)))).map(node => node.name));
  const keptGroups = new Set();
  const keepGroup = name => { while (name && !keptGroups.has(name)) { keptGroups.add(name); name = parents.get(name); } };
  for (const name of selected) keepGroup(directOwners.get(name));
  const membership = model.edges.filter(edge => edge.attributes.dir === 'none');
  for (const edge of membership) if (selected.has(edge.tail) && invisible(nodes.get(edge.head))) keepGroup(directOwners.get(edge.head));
  let previousSize = -1;
  while (previousSize !== keptGroups.size) {
    previousSize = keptGroups.size;
    for (const edge of membership) {
      if (invisible(nodes.get(edge.head)) && keptGroups.has(directOwners.get(edge.head)) && invisible(nodes.get(edge.tail))) keepGroup(directOwners.get(edge.tail));
    }
  }
  for (const node of model.nodes) if (invisible(node) && keptGroups.has(directOwners.get(node.name))) selected.add(node.name);
  // 上游可用没有函数名的隐式集合端点表示同步约束；保留相接上下文，但不将它冒充系统或匹配目标。
  let previousNodes = -1;
  while (previousNodes !== selected.size) {
    previousNodes = selected.size;
    for (const edge of model.edges) {
      if (selected.has(edge.tail) && scheduleNodeKind(nodes.get(edge.head)) === 'context') selected.add(edge.head);
      if (selected.has(edge.head) && scheduleNodeKind(nodes.get(edge.tail)) === 'context') selected.add(edge.tail);
    }
  }
  const edgeIndices = new Map();
  const edges = model.edges.flatMap((edge, index) => {
    if (!selected.has(edge.tail) || !selected.has(edge.head)) return [];
    edgeIndices.set(index, edgeIndices.size);
    return [structuredClone(edge)];
  });
  return { ...structuredClone(model), nodes: model.nodes.filter(node => selected.has(node.name)).map(node => structuredClone(node)), edges,
    subgraphs: model.subgraphs.filter(group => keptGroups.has(group.name)).map(group => ({ ...structuredClone(group),
      nodes: group.nodes.filter(name => selected.has(name)), edges: group.edges.filter(index => edgeIndices.has(index)).map(index => edgeIndices.get(index)),
      subgraphs: group.subgraphs.filter(name => keptGroups.has(name)) })) };
}

export const scheduleSystemCount = model => model.nodes.filter(node => scheduleNodeKind(node) === 'system').length;

function scheduleLabelLines(node) {
  const label = node.attributes.label ?? node.name;
  let line = '';
  const lines = [];
  for (let index = 0; index < label.length; index++) {
    const char = label[index];
    if (char === '\\' && index + 1 < label.length) {
      const next = label[++index];
      if ('nlr'.includes(next)) { lines.push(line); line = ''; }
      else line += next === 'N' ? node.name : next;
    } else if (char === '\n' || char === '\r') { lines.push(line); line = ''; }
    else line += char;
  }
  return [...lines, line];
}

export const scheduleLabelLongestLine = node => Math.max(...scheduleLabelLines(node).map(line => line.length));

function clusterLabel(group, theme) {
  const label = { name: group.name, attributes: { label: group.attributes.label || '' } };
  const padding = Math.ceil(theme.clusterLabelMargin + scheduleLabelLongestLine(label) * theme.fontSize * theme.fontMetricMarginPerCharacter);
  const escaped = scheduleLabelLines(label).map(line => line.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])).join('<BR/>');
  // cluster.margin 不撑宽由标题决定的最小边界；透明侧单元格只在布局前增加水平余量，原模型文字不变。
  return { html: '<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="0" BGCOLOR="' + theme.systemSet.fill + '"><TR><TD WIDTH="' + padding + '"></TD><TD>' + escaped + '</TD><TD WIDTH="' + padding + '"></TD></TR></TABLE>' };
}

export function scheduleGraphInput(model, theme = null) {
  const { nodes, groups, parents } = validateScheduleGraph(model);
  const common = theme ? { fontname: theme.fontFamily, fontsize: String(theme.fontSize), fontcolor: theme.textColor } : {};
  const nodeInput = node => ({ name: node.name, attributes: { ...node.attributes, ...(!theme || invisible(node) ? {} : {
    ...common, shape: 'box', style: 'rounded,filled', fillcolor: theme.system.fill, color: theme.system.stroke, penwidth: String(theme.system.width),
    // Viz 的共享字体回退到 Times 度量；布局前预留保守字宽，避免输出字体替换后文字越框。
    margin: (theme.nodeMargin + scheduleLabelLongestLine(node) * theme.fontSize * theme.fontMetricMarginPerCharacter) / 72 + ',0.055556',
  }) } });
  const subgraphInput = group => ({
    name: group.name, graphAttributes: { ...group.attributes, ...(!theme ? {} : {
      ...common, style: 'rounded,filled', fillcolor: theme.systemSet.fill, color: theme.systemSet.stroke, penwidth: String(theme.systemSet.width),
      label: clusterLabel(group, theme),
    }) },
    nodes: group.nodes.map(name => nodeInput(nodes.get(name))), subgraphs: group.subgraphs.map(name => subgraphInput(groups.get(name))),
  });
  return { name: model.name, directed: model.directed, strict: model.strict, graphAttributes: { ...model.attributes, ...common, ...(theme ? { bgcolor: theme.background } : {}) },
    nodes: model.nodes.map(nodeInput), edges: model.edges.map(edge => ({ tail: edge.tail, head: edge.head, attributes: {
      ...edge.attributes, ...(theme ? { ...common, color: theme.edge.stroke, penwidth: String(theme.edge.width) } : {}),
    } })), subgraphs: model.subgraphs.filter(group => !parents.has(group.name)).map(subgraphInput) };
}

export function scheduleGraphFacts(model) {
  validateScheduleGraph(model);
  const sorted = values => [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const edges = model.edges.map(edge => ({ ...edge, attributes: Object.fromEntries(Object.entries(edge.attributes).sort()) }));
  return JSON.stringify({ name: model.name, directed: model.directed, strict: model.strict, attributes: model.attributes,
    nodes: sorted(model.nodes), edges: sorted(edges), subgraphs: sorted(model.subgraphs.map(group => ({ ...group,
      nodes: sorted(group.nodes), edges: sorted(group.edges.map(index => edges[index])), subgraphs: sorted(group.subgraphs) }))) });
}

export function themedScheduleInput(model, filter) {
  return scheduleGraphInput(filterScheduleGraph(model, filter), SCHEDULE_THEME);
}

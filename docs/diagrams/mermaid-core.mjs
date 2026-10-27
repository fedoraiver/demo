import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { VIEWER_BACKGROUND } from './viewer-theme.mjs';
import { measureMermaidNodes } from './svg-shape-geometry.mjs';
import { NODE_STYLES, EDGE_STYLES } from './architecture-style.mjs';
import { DATA_GROUP_LABELS, entityComponentColumns } from './architecture-renderer.mjs';
import { inspectViewRoutes, ROUTING_STYLE } from './architecture-routing.mjs';
import { checkMermaidGeometry } from './diagram-geometry.mjs';

// 该函数也直接传入 Puppeteer evaluate，因此仅依赖页面原生 DOM。
export function measureNativeLabelBounds() {
  const svg = document.querySelector('svg[data-architecture-measurement]') || document.querySelector('svg');
  if (!svg) return {};
  const inverse = svg.getCTM().inverse();
  return Object.fromEntries([...svg.querySelectorAll('g.cluster,g.node')].flatMap(cluster => {
    const headerId = /(?:^|-)flowchart-(eh\d+)-/.exec(cluster.id)?.[1];
    if (!cluster.classList.contains('cluster') && !headerId) return [];
    const label = [...cluster.children].find(item => item.classList.contains('cluster-label') || item.classList.contains('label'));
    if (!label) return [];
    const box = label.getBBox(), transform = inverse.multiply(label.getCTM());
    const points = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]
      .map(([x, y]) => new DOMPoint(x, y).matrixTransform(transform));
    const x = Math.min(...points.map(point => point.x)), y = Math.min(...points.map(point => point.y));
    return [[headerId || cluster.id, { x, y, width: Math.max(...points.map(point => point.x)) - x, height: Math.max(...points.map(point => point.y)) - y }]];
  }));
}

const elements = node => [...node.getElementsByTagName('*')];
const hasClass = (node, value) => (node.getAttribute('class') || '').split(/\s+/).includes(value);
const number = (node, name) => Number(node.getAttribute(name) || 0);
function boxInRoot(rect) {
  let x = number(rect, 'x'), y = number(rect, 'y');
  for (let node = rect; node?.nodeType === 1; node = node.parentNode) {
    const transform = node.getAttribute('transform') || '';
    for (const match of transform.matchAll(/translate\(\s*([-\d.e+]+)(?:[,\s]+([-\d.e+]+))?\s*\)/g)) { x += Number(match[1]); y += Number(match[2] || 0); }
    if (transform.replace(/translate\([^)]*\)/g, '').trim()) throw new Error(`Unsupported Mermaid node transform: ${transform}`);
  }
  return { x, y, width: number(rect, 'width'), height: number(rect, 'height') };
}

// 只添加交互/校验元数据；节点、文字、路径与箭头保持 Mermaid 编译器的输出。
export function normalizeMermaidSvg(view, source, registry, { clusterLabelBounds = {} } = {}) {
  const document = new DOMParser({ onError: level => { if (level === 'fatalError') throw new Error('Invalid Mermaid SVG'); } }).parseFromString(source, 'image/svg+xml');
  const svg = document.documentElement, all = elements(svg);
  const bounds = svg.getAttribute('viewBox').trim().split(/\s+/).map(Number);
  if (bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[2] <= 0 || bounds[3] <= 0) throw new Error(`Invalid Mermaid viewBox: ${view.id}`);
  const findEdge = id => all.find(node => node.localName === 'path' && node.getAttribute('data-id') === id);
  function labelGeometry(element) {
    const label = [...element.childNodes].find(item => item.nodeType === 1 && hasClass(item, 'cluster-label'));
    const bounds = clusterLabelBounds[element.getAttribute('id')];
    if (bounds) {
      if (!label || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key])) || bounds.width <= 0 || bounds.height <= 0) throw new Error(`Invalid Mermaid cluster label bounds: ${view.id}/${element.getAttribute('id')}`);
      label.setAttribute('data-label-bounds', JSON.stringify(bounds));
    }
    return { label, bounds };
  }
  const edgeElements = new Map([...view.links, ...view.scheduleLinks, ...view.layoutLinks].map(link => [link.mermaidId, findEdge(link.mermaidId)]));
  for (const node of all) if (node.hasAttribute('data-id')) { node.setAttribute('data-mermaid-native-id', node.getAttribute('data-id')); node.removeAttribute('data-id'); }
  const nodeElements = new Map();
  for (const node of view.nodes) {
    const record = { ...registry[node.id], ...(view.aspect === 'component' && node.id === view.componentNodeId ? view.componentDetails : {}) };
    const container = node.presentation === 'entity-container';
    const element = all.find(item => container
      ? hasClass(item, 'cluster') && item.getAttribute('id') === `${view.id}-${node.mermaidId}`
      : hasClass(item, 'node') && item.getAttribute('id').includes(`flowchart-${node.mermaidId}-`));
    if (!element) throw new Error(`Mermaid node missing: ${view.id}/${node.id}`);
    const attributes = { 'data-id': node.id, 'data-instance': node.instance, 'data-role': node.role, 'data-feature': record.feature, 'data-mermaid-id': node.mermaidId, 'data-visual-type': node.visualType, 'data-shape': node.shape, tabindex: 0, role: 'button', 'aria-pressed': 'false', 'aria-label': `${record.name || node.id} · ${NODE_STYLES[node.visualType].label}` };
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    element.setAttribute('class', `${element.getAttribute('class')} ${node.role}${container ? ' node entity-container' : ''}`);
    if (node.presentation) {
      element.setAttribute('data-presentation', node.presentation);
    }
    const primitives = container ? [...element.childNodes].filter(item => item.nodeType === 1 && item.localName === 'rect') : elements(element).filter(item => {
      if (!['rect', 'path', 'polygon', 'polyline', 'ellipse', 'circle', 'line'].includes(item.localName)) return false;
      for (let parent = item.parentNode; parent && parent !== element; parent = parent.parentNode) if (hasClass(parent, 'label') || ['defs', 'clipPath', 'marker', 'text'].includes(parent.localName)) return false;
      return true;
    });
    if (!primitives.length || (container && primitives.length !== 1)) throw new Error(`Mermaid native outline missing: ${view.id}/${node.id}`);
    for (const primitive of primitives) primitive.setAttribute('data-shape-part', node.instance);
    const title = document.createElementNS(svg.namespaceURI, 'title');
    title.textContent = [record.name || node.id, record.description].filter(Boolean).join(' · ');
    element.insertBefore(title, element.firstChild);
    nodeElements.set(node.id, element);
  }
  const measured = measureMermaidNodes(new XMLSerializer().serializeToString(svg));
  const nodes = view.nodes.map(node => {
    const position = measured.get(node.id), element = nodeElements.get(node.id);
    element.setAttribute('data-center-x', String(position.x + position.width / 2)); element.setAttribute('data-center-y', String(position.y + position.height / 2));
    return { ...node, position };
  });
  for (const link of [...view.links, ...view.scheduleLinks]) {
    const element = edgeElements.get(link.mermaidId);
    if (!element) throw new Error(`Mermaid semantic edge missing: ${view.id}/${link.id}`);
    const schedule = view.scheduleLinks.includes(link);
    element.setAttribute('class', `${element.getAttribute('class')} edge ${schedule ? 'schedule-edge' : link.kind}`);
    element.setAttribute(schedule ? 'data-schedule-link-id' : 'data-link-id', link.id);
    element.setAttribute(schedule ? 'data-schedule-connect' : 'data-connect', `${link.displayFrom ?? link.from}|${link.displayTo ?? link.to}`);
    if (!schedule) element.setAttribute('data-canonical-connect', `${link.from}|${link.to}`);
    element.setAttribute('data-mermaid-id', link.mermaidId);
    element.setAttribute('data-edge-semantic', link.edgeSemantic);
    if (link.nativeReverse) element.setAttribute('data-native-reverse', 'true');
    element.setAttribute('tabindex', '0'); element.setAttribute('role', 'button'); element.setAttribute('aria-label', `${link.displayLabel || EDGE_STYLES[link.edgeSemantic].label} · ${link.from} → ${link.to}`);
    element.setAttribute('style', `${element.getAttribute('style') || ''};--edge-width:${EDGE_STYLES[link.edgeSemantic].width}px`);
  }
  for (const link of view.layoutLinks) {
    const element = edgeElements.get(link.mermaidId);
    if (!element) throw new Error(`Mermaid layout edge missing: ${view.id}/${link.mermaidId}`);
    element.setAttribute('data-layout-link', link.mermaidId);
  }
  const sections = [];
  const scheduleGroups = [];
  for (const group of view.scheduleGroups) {
    const element = all.find(item => hasClass(item, 'cluster') && item.getAttribute('id') === `${view.id}-${group.mermaidId}`);
    const rect = element && elements(element).find(item => item.localName === 'rect');
    if (!rect) throw new Error(`Mermaid Schedule container missing: ${view.id}/${group.id}`);
    element.setAttribute('data-schedule-id', group.id);
    element.setAttribute('data-mermaid-id', group.mermaidId);
    const title = document.createElementNS(svg.namespaceURI, 'title');
    title.textContent = [group.label, ...(group.notes || [])].join('\n');
    element.insertBefore(title, element.firstChild);
    const { bounds: labelBounds } = labelGeometry(element);
    scheduleGroups.push({ ...group, ...(labelBounds ? { labelBounds } : {}) });
    sections.push({ label: group.label, ...boxInRoot(rect), schedule: group.id });
  }
  const entityGroups = (view.entityGroups || []).map(group => {
    if (group.expanded === false) {
      const element = nodeElements.get(group.entity), bounds = nodes.find(node => node.id === group.entity).position;
      element.setAttribute('data-entity-group', group.id);
      sections.push({ label: registry[group.entity].name, ...bounds, entityGroup: group.id });
      return { ...group, bounds };
    }
    const element = all.find(item => hasClass(item, 'cluster') && item.getAttribute('id') === `${view.id}-${group.mermaidId}`);
    const rect = element && [...element.childNodes].find(item => item.nodeType === 1 && item.localName === 'rect');
    if (!rect) throw new Error(`Mermaid Entity container missing: ${view.id}/${group.id}`);
    element.setAttribute('data-entity-group', group.id);
    element.setAttribute('data-mermaid-id', group.mermaidId);
    const header = all.find(item => hasClass(item, 'node') && item.getAttribute('id').includes(`flowchart-${group.headerMermaidId}-`));
    if (!header) throw new Error(`Mermaid Entity header missing: ${view.id}/${group.id}`);
    const instance = view.nodes.find(node => node.id === group.entity).instance;
    header.setAttribute('data-entity-header', instance);
    header.setAttribute('data-entity-owner', group.entity);
    header.setAttribute('aria-hidden', 'true');
    header.removeAttribute('role'); header.removeAttribute('tabindex');
    const headerBounds = clusterLabelBounds[group.headerMermaidId];
    if (headerBounds) {
      if (!['x', 'y', 'width', 'height'].every(key => Number.isFinite(headerBounds[key])) || headerBounds.width <= 0 || headerBounds.height <= 0) throw new Error(`Invalid Mermaid Entity header bounds: ${view.id}/${group.id}`);
      header.setAttribute('data-label-bounds', JSON.stringify(headerBounds));
    }
    const bounds = boxInRoot(rect);
    sections.push({ label: registry[group.entity].name, ...bounds, entityGroup: group.id });
    return { ...group, bounds, ...(headerBounds ? { headerBounds } : {}) };
  });
  if (!view.scheduleGroups.length) for (const [label, group] of Map.groupBy(nodes.filter(node => !entityGroups.some(group => group.entity === node.id || group.components.includes(node.id))), node => node.group || (node.role === 'plugin' ? '功能插件' : '节点'))) {
    const left = Math.min(...group.map(node => node.position.x)), top = Math.min(...group.map(node => node.position.y));
    sections.push({ label, x: left, y: top });
  }
  if (view.aspect === 'data') {
    const dataSections = Object.entries(DATA_GROUP_LABELS).flatMap(([id, label]) => {
      const element = all.find(item => hasClass(item, 'cluster') && item.getAttribute('id') === `${view.id}-${id}`);
      if (!element) return [];
      const rect = [...element.childNodes].find(item => item.nodeType === 1 && item.localName === 'rect');
      if (!rect) throw new Error(`Mermaid data container missing: ${view.id}/${id}`);
      return [{ label, ...boxInRoot(rect) }];
    });
    sections.unshift(...dataSections);
    for (let index = sections.length - 1; index >= dataSections.length; index--) if (dataSections.some(section => section.label === sections[index].label)) sections.splice(index, 1);
  }
  svg.setAttribute('width', String(bounds[2])); svg.setAttribute('height', String(bounds[3]));
  svg.setAttribute('style', 'background-color:' + VIEWER_BACKGROUND);
  svg.setAttribute('data-diagram-engine', 'mermaid');
  const style = document.createElementNS(svg.namespaceURI, 'style');
  style.textContent = '[data-id],[data-entity-owner],.edge{cursor:pointer}[data-id]:focus{outline:none}[data-id]:focus-visible:not(.selected):not(.entity-container),.entity-container:focus-visible:not(.selected)>[data-shape-part]{outline:2px solid #2563EB;outline-offset:4px}.node.dim:not(.entity-container),[data-entity-header].dim{opacity:.22}.entity-container.dim>[data-shape-part]{opacity:.22}.edge.dim{opacity:.16}.edge.focused{stroke-width:calc(var(--edge-width) + 1.2px)!important}';
  svg.appendChild(style);
  return { ...view, nodes, scheduleGroups, entityGroups, sections, bounds: { x: bounds[0], y: bounds[1], width: bounds[2], height: bounds[3] }, width: bounds[2], height: bounds[3], svg: new XMLSerializer().serializeToString(svg) };
}

export function routedMermaid(view, { curves = new Map(), spacing = 0, spans = new Map(), reverseRelationEdges = false, cardContainers = false, entityContainers = [], entityOrder, padding } = {}) {
  let source = view.mermaid.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_, json) => {
    const configuration = JSON.parse(json);
    configuration.config.flowchart.nodeSpacing += spacing;
    configuration.config.flowchart.rankSpacing += spacing;
    if (padding !== undefined) configuration.config.flowchart.padding = padding;
    return `---\n${JSON.stringify(configuration, null, 2)}\n---`;
  });
  if (reverseRelationEdges) source = source.replace(/(  subgraph relation_\d+\[" "\]\n  direction TB\n)([\s\S]*?)(\n  end\n  style relation_\d+ fill:none,stroke:none)/g, (_, start, body, end) => {
    const edges = /  n\d+ e\d+@[^\n]+\n  class e\d+ edge_\w+(?:\n|$)/g;
    const declarations = [...body.matchAll(edges)].map(match => match[0].trimEnd()).reverse();
    return start + body.replace(edges, match => declarations.shift() + (match.endsWith('\n') ? '\n' : '')) + end;
  });
  if (entityOrder) {
    const ids = new Set(entityContainers), lines = source.split('\n'), units = [], parents = [];
    for (let index = 0; index < lines.length; index++) {
      const subgraph = /^\s*subgraph (\w+)\[/.exec(lines[index]);
      const leaf = /^\s*(n\d+)@\{/.exec(lines[index]);
      const entity = subgraph?.[1] ?? leaf?.[1];
      if (entity && ids.has(entity)) {
        const start = index, id = entity, parent = parents.join('|');
        if (subgraph) {
          let depth = 1;
          while (++index < lines.length) {
            if (/^\s*subgraph\s/.test(lines[index])) depth++;
            if (/^\s*end\s*$/.test(lines[index]) && !--depth) break;
          }
        }
        while (new RegExp(`^  (?:class|style) ${id} `).test(lines[index + 1] || '')) index++;
        units.push({ start, end: index, id, parent, lines: lines.slice(start, index + 1) });
      } else if (subgraph) parents.push(subgraph[1]);
      else if (/^\s*end\s*$/.test(lines[index])) parents.pop();
    }
    const replacements = [];
    for (const members of Map.groupBy(units, unit => unit.parent).values()) {
      const ordered = entityOrder === 'reverse' ? [...members].reverse()
        : entityOrder === 'rotate' ? [...members.slice(1), members[0]]
          : [members[0], ...members.slice(1).reverse()];
      for (let index = 0; index < members.length; index++) replacements.push({ ...members[index], lines: ordered[index].lines });
    }
    for (const unit of replacements.sort((a, b) => b.start - a.start)) lines.splice(unit.start, unit.end - unit.start + 1, ...unit.lines);
    source = lines.join('\n');
  }
  if (cardContainers) {
    let selected = null;
    if (cardContainers === 'related') {
      const members = new Set((view.entityGroups || []).flatMap(group => group.components));
      const linked = new Set(view.links.flatMap(link => [link.displayFrom ?? link.from, link.displayTo ?? link.to]));
      selected = new Set(view.nodes.filter(node => members.has(node.id) ? linked.has(node.id) : ['system', 'observer'].includes(node.visualType)).map(node => node.mermaidId));
    }
    source = source.replace(/  (n\d+)@\{[^\n]+\n  class \1 node_\w+(?:\n  class \1 external_node)?/g, (declaration, id) => selected && !selected.has(id) ? declaration : `  subgraph layout_card_${id}[" "]\n${declaration}\n  end\n  style layout_card_${id} fill:none,stroke:none`);
  }
  for (const id of entityContainers) {
    if (source.includes(`  subgraph layout_entity_${id}[" "]`)) continue;
    const lines = source.split('\n');
    let start = lines.indexOf(`  subgraph ${id}[" "]`);
    const container = start >= 0;
    if (!container) start = lines.findIndex(line => line.startsWith(`  ${id}@{`));
    if (start < 0) throw new Error(`Missing native Entity container: ${view.id}/${id}`);
    let end = start, depth = container ? 1 : 0;
    if (container) for (end++; end < lines.length; end++) {
      if (/^\s*subgraph\s/.test(lines[end])) depth++;
      if (/^\s*end\s*$/.test(lines[end]) && !--depth) break;
    }
    if (depth) throw new Error(`Unclosed native Entity container: ${view.id}/${id}`);
    if (!container) while (new RegExp(`^  (?:class|style) ${id} `).test(lines[end + 1] || '')) end++;
    lines.splice(end + 1, 0, '  end', `  style layout_entity_${id} fill:none,stroke:none`);
    lines.splice(start, 0, `  subgraph layout_entity_${id}[" "]`, '  direction TB');
    source = lines.join('\n');
  }
  for (const [id, span] of spans) source = source.replace(new RegExp(`(\\b${id}@)(-{2,}>|-{3,})(?=\\||\\s)`), (_, prefix, arrow) => prefix + '-'.repeat((arrow.endsWith('>') ? 2 : 3) + span) + (arrow.endsWith('>') ? '>' : ''));
  for (const [id, curve] of curves) source += `  ${id}@{ curve: ${curve} }\n`;
  return source;
}

function entityHeaderContext(view) {
  const byId = new Map(view.nodes.map(node => [node.id, node])), added = [];
  const pairs = new Set(view.layoutLinks.map(link => `${link.from}|${link.to}`));
  for (const group of (view.entityGroups || []).filter(group => group.expanded !== false)) {
    const members = new Set(group.components);
    for (const link of view.links) {
      const from = link.displayFrom ?? link.from, to = link.displayTo ?? link.to;
      const incoming = members.has(to) && !members.has(from), outgoing = members.has(from) && !members.has(to);
      if (!incoming && !outgoing) continue;
      const external = byId.get(incoming ? from : to);
      if (!external || external.id === group.entity) continue;
      const source = incoming ? external.mermaidId : group.headerMermaidId, target = incoming ? group.headerMermaidId : external.mermaidId;
      const pair = `${source}|${target}`;
      if (pairs.has(pair)) continue;
      pairs.add(pair);
      added.push({ mermaidId: `layout_context_${view.layoutLinks.length + added.length}`, from: source, to: target });
    }
  }
  if (!added.length) return view;
  // 约束沿已有数据关系的方向对齐容器标题；只在布局失败后尝试，不表示系统执行顺序。
  return { ...view, layoutLinks: [...view.layoutLinks, ...added], mermaid: view.mermaid + added.map(link => `  ${link.from} ${link.mermaidId}@~~~ ${link.to}\n`).join('') };
}

export async function compileRoutedView(view, registry, compileNative, { onAttempt = () => {}, onFailure = () => {} } = {}) {
  const configuration = JSON.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(view.mermaid)[1]).config;
  const dagre = (configuration.layout ?? 'dagre') === 'dagre';
  const invalidRoute = edge => edge.collisions.length || edge.arrowIssues.length || (edge.axis ? edge.curved : !edge.curved);
  let profiles = dagre ? [0, 16, 32].flatMap(spacing => Array.from({ length: 9 }, (_, span) => ({ spacing, span }))) : [{ spacing: 0, span: 0 }];
  const context = dagre && view.aspect === 'data' ? entityHeaderContext(view) : view;
  const preferredContext = context !== view ? { spacing: 32, span: 8, headerContext: true } : null;
  if (context !== view) {
    const remaining = profiles.slice(1);
    profiles = [profiles[0], { spacing: 0, span: 0, headerContext: true }, { spacing: 0, span: 0, headerContext: true, cardContainers: 'related' },
      preferredContext,
      ...remaining.map(profile => ({ ...profile, headerContext: true })), ...remaining.map(profile => ({ ...profile, headerContext: true, cardContainers: 'related' })), ...remaining];
  }
  const layoutContainers = dagre && ['overview', 'events', 'component', 'object'].includes(view.aspect);
  // 原生透明容器为复杂协作图预留绕行空间，不添加业务身份或执行顺序。
  if (layoutContainers) profiles.splice(1, 0, { spacing: 0, span: 0, cardContainers: true });
  // 多实体的组件图需要在容器内边距与列间距共同变化后重新布线；每个候选仍走完整几何检查。
  if (dagre && ['component', 'object'].includes(view.aspect)) profiles.splice(2, 0,
    ...[16, 32, 64].flatMap(spacing => [0, 2, 4, 8].map(span => ({ spacing, span, cardContainers: true }))));
  // 复合节点可能遮住 Dagre 的原生曲线；最后尝试同一网络的另一声明顺序，不改变任何关系或排版链。
  if (dagre && view.aspect === 'data') profiles.push({ spacing: 0, span: 0, reverseRelationEdges: true });
  let final, inspection, layoutError, contextualLabelProfiles = false, entityWrapperCandidates = false, componentCurveProfiles = false;
  const labelVariants = new Set();
  for (const [attempt, { spacing, span, labelEdges, labelSpan, reverseRelationEdges, cardContainers, headerContext, entityContainers, entityOrder, padding }] of profiles.entries()) {
    try {
      const spans = new Map(span ? [...view.links, ...view.scheduleLinks].map(edge => [edge.mermaidId, span]) : []);
      for (const id of labelEdges ?? []) spans.set(id, labelSpan);
      const base = headerContext ? context : view;
      const route = curves => ({ ...base, mermaid: routedMermaid(base, { spacing, spans, curves, reverseRelationEdges, cardContainers, entityContainers, entityOrder, padding }) });
      const candidate = route();
      const probe = await compileNative(candidate, registry);
      final = probe;
      const probeInspection = inspectViewRoutes(probe);
      const curves = new Map(probeInspection.edges.filter(edge => !edge.axis).map(edge => [edge.mermaidId, ROUTING_STYLE.curve]));
      final = dagre && curves.size
        ? await compileNative(route(curves), registry) : probe;
      inspection = inspectViewRoutes(final);
      if (dagre) for (const curve of ROUTING_STYLE.curveFallbacks) {
        const unresolved = inspection.edges.filter(edge => !edge.axis && invalidRoute(edge));
        if (!unresolved.length) break;
        const trialCurves = new Map(curves);
        for (const edge of unresolved) trialCurves.set(edge.mermaidId, curve);
        const trial = await compileNative(route(trialCurves), registry);
        let trialInspection;
        try { trialInspection = inspectViewRoutes(trial); }
        catch (error) { if (error.message === 'Native Mermaid arrow has no terminal tangent') continue; throw error; }
        const accepted = unresolved.filter(edge => {
          const candidate = trialInspection.edges.find(item => item.id === edge.id);
          return !candidate.axis && !invalidRoute(candidate);
        });
        if (!accepted.length) continue;
        for (const edge of accepted) curves.set(edge.mermaidId, curve);
        final = accepted.length === unresolved.length ? trial : await compileNative(route(curves), registry);
        inspection = inspectViewRoutes(final);
      }
      const axisOverrides = inspection.edges.filter(edge => edge.axis && curves.has(edge.mermaidId));
      if (axisOverrides.length) {
        for (const edge of axisOverrides) curves.delete(edge.mermaidId);
        final = await compileNative(route(curves), registry);
        inspection = inspectViewRoutes(final);
      }
      const invalid = inspection.edges.filter(invalidRoute);
      // 单条近共线关系可能被 Dagre 压直。只延长该关系的原生 rank span，避免同时拉长包含边穿过左栏。
      if (dagre && ['component', 'object'].includes(view.aspect) && cardContainers && !componentCurveProfiles) {
        const straight = invalid.filter(edge => !edge.axis && !edge.curved && !edge.collisions.length && !edge.arrowIssues.length).map(edge => edge.mermaidId);
        if (straight.length) {
          componentCurveProfiles = true;
          profiles.splice(attempt + 1, 0, ...Array.from({ length: 8 }, (_, index) => ({ spacing, span, cardContainers, labelEdges: straight, labelSpan: index + 1 })));
        }
      }
      let wrapperProfiles = 0;
      if (dagre && !attempt && view.aspect === 'data') {
        const containers = new Map((view.entityGroups || []).map(group => [group.entity, group.mermaidId]));
        const bad = new Set(invalid.map(edge => edge.id));
        const entityContainers = [...new Set(view.links.filter(link => bad.has(link.id)).flatMap(link => [link.displayFrom ?? link.from, link.displayTo ?? link.to]).filter(id => containers.has(id)).map(id => containers.get(id)))];
        if (entityContainers.length) {
          entityWrapperCandidates = true;
          wrapperProfiles = context === view ? 1 : 3;
          profiles.splice(context === view ? 1 : 4, 0,
            { spacing: 0, span: 0, entityContainers },
            ...(context === view ? [] : [{ spacing: 0, span: 0, entityContainers, headerContext: true }, { spacing: 0, span: 0, entityContainers, headerContext: true, cardContainers: 'related' }]));
          if (entityContainers.length > 2) profiles.splice((context === view ? 1 : 4) + wrapperProfiles, 0,
            ...['rotate', 'reverse-rest', 'reverse'].flatMap(entityOrder => [
              { spacing: 0, span: 0, entityContainers, entityOrder },
              ...(context === view ? [] : [{ spacing: 0, span: 0, entityContainers, entityOrder, headerContext: true }, { spacing: 0, span: 0, entityContainers, entityOrder, headerContext: true, cardContainers: 'related' }]),
            ]));
        }
      }
      const labelVariant = `${headerContext || false}|${cardContainers || false}|${(entityContainers || []).join(',')}|${entityOrder || ''}`;
      if (dagre && ((!attempt && context === view) || (headerContext && !contextualLabelProfiles) || (entityContainers && !labelVariants.has(labelVariant)))) {
        const labelEdges = invalid.filter(edge => edge.collisions.some(item => item.kind === 'edge-label')).map(edge => edge.mermaidId);
        if (headerContext) contextualLabelProfiles = true;
        labelVariants.add(labelVariant);
        if (labelEdges.length) {
          let position = !attempt && wrapperProfiles ? wrapperProfiles + 1 : layoutContainers && !attempt ? 2 : headerContext && !cardContainers && !entityContainers ? attempt + 2 : attempt + 1;
          if (entityWrapperCandidates && headerContext && !entityContainers) {
            const nextLayout = profiles.findIndex((profile, index) => index >= attempt + 2 && !profile.entityContainers && profile !== preferredContext);
            if (nextLayout >= 0) position = nextLayout;
          }
          if (entityContainers && (invalid.some(edge => edge.arrowIssues.length) || (!entityOrder && entityContainers.length > 2))) {
            const nextLayout = profiles.findIndex((profile, index) => index > attempt && !profile.entityContainers);
            if (nextLayout >= 0) position = nextLayout;
          }
          const preferredIndex = profiles.indexOf(preferredContext);
          if (preferredIndex > attempt) position = Math.max(position, preferredIndex + 1);
          const labelSets = [labelEdges];
          if (entityContainers) {
            const containers = new Set(entityContainers);
            const nodes = new Map(view.nodes.map(node => [node.id, node.mermaidId]));
            const network = view.links.filter(link => containers.has(nodes.get(link.displayFrom ?? link.from)) && containers.has(nodes.get(link.displayTo ?? link.to)));
            const networkEdges = network.map(link => link.mermaidId);
            if (networkEdges.some(id => !labelEdges.includes(id))) {
              const reaches = (id, target, seen = new Set()) => {
                if (id === target) return true;
                if (seen.has(id)) return false;
                seen.add(id);
                return network.filter(link => (link.displayFrom ?? link.from) === id).some(link => reaches(link.displayTo ?? link.to, target, seen));
              };
              const cyclic = network.some(link => reaches(link.displayTo ?? link.to, link.displayFrom ?? link.from));
              if (cyclic) labelSets.unshift(networkEdges); else labelSets.push(networkEdges);
            }
          }
          profiles.splice(position, 0, ...labelSets.flatMap(labelEdges => Array.from({ length: 8 }, (_, index) => ({ spacing, span: 0, labelEdges, labelSpan: index + 1, headerContext, cardContainers, entityContainers, entityOrder }))));
        }
      }
      layoutError = null;
      try {
        checkMermaidGeometry(final.svg, final);
        for (const group of final.entityGroups.filter(group => group.expanded !== false)) {
          if (!group.headerBounds?.width || !group.headerBounds?.height) throw new Error(`Missing native Entity title bounds: ${group.id}`);
          const columns = entityComponentColumns(group.components).map(column => column.map(id => final.nodes.find(node => node.id === id).position));
          for (const column of columns) {
            if (column[0].y < group.headerBounds.y + group.headerBounds.height - .05) throw new Error(`Entity title overlaps Component: ${group.id}`);
            for (let index = 1; index < column.length; index++) if (column[index].y < column[index - 1].y + column[index - 1].height - .05) throw new Error(`Entity component row order mismatch: ${group.id}`);
          }
          const lefts = columns.map(column => Math.min(...column.map(box => box.x)));
          if (lefts.some((left, index) => index && left <= lefts[index - 1] + .05)) throw new Error(`Entity component column order mismatch: ${group.id}`);
        }
      } catch (error) { layoutError = error.message; }
      // 透明复合容器可能使原生源端裁切停在外框；缩小原生内边距后重新编译并完整复核，不修补路径。
      if (dagre && padding === undefined && !layoutError && invalid.length && invalid.every(edge => !edge.collisions.length
        && edge.arrowIssues.length && edge.arrowIssues.every(issue => issue.startsWith('path-source-')) && (edge.axis ? !edge.curved : edge.curved))) {
        profiles.splice(attempt + 1, 0, { ...profiles[attempt], padding: 4 });
      }
      if (!invalid.length && !layoutError) return { ...final, routing: { rule: 'axis-or-curve' } };
      onAttempt({ view: view.id, attempt: attempt + 1, layoutError, invalid });
    } catch (error) {
      if (error.message !== 'Native Mermaid arrow has no terminal tangent') throw error;
      layoutError = error.message;
      inspection = { edges: [] };
      onAttempt({ view: view.id, attempt: attempt + 1, layoutError, invalid: [] });
    }
  }
  if (final?.svg) await onFailure({ view: final, inspection });
  throw new Error(`Mermaid routing failed: ${view.id}: ${[layoutError, ...inspection.edges.filter(invalidRoute).map(edge => `${edge.id} → ${edge.collisions.map(item => `${item.id} (${item.kind})`).concat(edge.arrowIssues).join(',') || 'line/curve mismatch'}`)].filter(Boolean).join('; ')}`);
}

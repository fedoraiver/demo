// 只读核对已维护的架构清单与交付产物；不分析 Rust 调度语义，也不运行游戏。
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { checkMermaidGeometry } from './diagram-geometry.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, EXTERNAL_REFERENCE_STYLE, visualTypeOf, edgeSemanticOf, displayLabelOf, scheduleLinksFor } from './architecture-style.mjs';
import { nodeKindOf, NODE_KINDS } from './architecture-kinds.mjs';
import { shapeBounds, svgElements } from './svg-shape-geometry.mjs';
import { isMainPluginRegistration, scheduleGroupLabel, isUnscheduledTriggerNode, buildObserverPlacement } from './architecture-model.mjs';


import { validateCompilerModel, checkCompilerRegistry, createCompilerObjectCatalog, bindCompilerSchedules, SOURCE_ROLE_LABELS, sourceKey } from './rustc-model.mjs';
import { DATA_GROUP_LABELS, entityComponentColumns } from './architecture-renderer.mjs';
import { displayEndpoints, inspectViewRoutes, ROUTING_STYLE, nativeSvgProperty, nativeMarkerProperty } from './architecture-routing.mjs';
import { INFRASTRUCTURE_FEATURES, infrastructureFeature, architectureViewId } from './architecture-infrastructure.mjs';


import { checkDebugdumpViews, normalizeScheduleSvg } from './debugdump.mjs';


import { SCHEDULE_THEME } from './schedule-theme.mjs';
import { SCHEDULE_LEGEND_LABELS } from './schedule-legend.mjs';
import { artifactFile, pathsForRepository, repositoryRoot } from './paths.mjs';
import { readArchitectureData } from './architecture-artifacts.mjs';

const legacyAspects = ['systems', 'data', 'events'];
const linkKinds = new Set(['order', 'read', 'write', 'trigger', 'transition', 'reference', 'relationship', 'registration', 'dependency']);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function embeddedJson(html, id) {
  // 只读取生成器约定的 JSON 容器，不执行 HTML 内的脚本。
  const match = html.match(new RegExp(`<script\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/script>`));
  requireCondition(match, `Missing embedded JSON: ${id}`);
  return JSON.parse(match[1]);
}

function attributeValues(svg, name) {
  return [...svg.matchAll(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'g'))].map(match =>
    match[2].replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, entity) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[entity]));
}

function elementAttributes(svg, required) {
  return [...svg.matchAll(/<[A-Za-z][\w:-]*\b([^>]*?)>/g)].map(match => Object.fromEntries(
    [...match[1].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(attribute => [attribute[1], attribute[3]
      .replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[entity])]),
  )).filter(attributes => Object.hasOwn(attributes, required));
}

function decodeMermaidText(value) {
  return value.replace(/\*\*(.+?)\*\*/g, '$1').replace(/<br\s*\/?\s*>/gi, '\n').replace(/#(amp|lt|gt|quot|apos|\d+);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity] ?? String.fromCodePoint(Number(entity)));
}

const normalizedText = value => String(value).replace(/[\s\u200B]+/g, ' ').trim();
const compactText = value => String(value).replace(/[\s\u200B]+/g, '');
const renderedNodeLabel = node => node.displayLabel;
const styledView = view => view.nodes.some(node => node.visualType || node.shape || node.displayLabel != null)
  || /@\{\s*shape:/.test(view.mermaid || '') || /\bdata-(?:visual-type|shape-part)=/.test(view.svg || '');
function effectiveStyle(element) {
  const ancestors = [];
  for (let current = element; current; current = current.parent) ancestors.unshift(current);
  const result = {};
  for (const item of ancestors) {
    for (const name of ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'fill-opacity', 'stroke-opacity']) if (item.attrs[name] != null) result[name] = item.attrs[name];
    for (const entry of (item.attrs.style || '').split(';')) {
      const colon = entry.indexOf(':');
      if (colon >= 0) result[entry.slice(0, colon).trim()] = entry.slice(colon + 1).replace(/\s*!important\s*$/, '').trim();
    }
  }
  return result;
}
const dashValue = value => value == null || /^(none|0(?:px)?(?:[ ,]+0(?:px)?)*)$/.test(value) ? null : value.trim().replace(/[,\s]+/g, ' ');
const descendantsOf = (elements, ancestor) => elements.filter(item => { for (let current = item.parent; current; current = current.parent) if (current === ancestor) return true; return false; });

function checkActualEdgeStyle(element, semantic, elements, id) {
  const expected = EDGE_STYLES[semantic], actual = effectiveStyle(element);
  requireCondition(expected && actual.stroke?.toLowerCase() === expected.stroke.toLowerCase()
    && Math.abs(parseFloat(actual['stroke-width']) - expected.width) < .01 && dashValue(actual['stroke-dasharray']) === dashValue(expected.dash), `Mermaid edge style mismatch: ${id}`);
  const reverse = element.attrs['data-native-reverse'] === 'true';
  const markerId = nativeMarkerProperty(element, reverse ? 'marker-start' : 'marker-end')?.match(/^url\([^#]*#([^)]*)\)$/)?.[1];
  const marker = elements.find(item => item.tag === 'marker' && item.attrs.id === markerId);
  requireCondition(marker && ['auto', 'auto-start-reverse'].includes(marker.attrs.orient), `Missing Mermaid target arrow: ${id}`);
  requireCondition(descendantsOf(elements, marker).some(item => ['path', 'polygon'].includes(item.tag)
    && (nativeSvgProperty(item, 'fill')?.toLowerCase() === expected.stroke.toLowerCase() || reverse && nativeSvgProperty(item, 'fill') === 'context-stroke')), `Mermaid arrow color mismatch: ${id}`);
}

function checkNodeAppearance(parts, expected, external, id) {
  requireCondition(parts.length && parts.every(item => ['rect', 'path', 'polygon', 'polyline', 'circle', 'ellipse', 'line'].includes(item.tag)), `Missing native Mermaid node outline: ${id}`);
  const styles = parts.map(effectiveStyle), filled = styles.filter(style => style.fill && style.fill !== 'none'), stroked = styles.filter(style => style.stroke && style.stroke !== 'none' && parseFloat(style['stroke-width'] || 1) > 0);
  requireCondition(filled.length && filled.every(style => style.fill.toLowerCase() === expected.fill.toLowerCase())
    && stroked.length && stroked.every(style => style.stroke.toLowerCase() === expected.stroke.toLowerCase() && Math.abs(parseFloat(style['stroke-width']) - expected.width) < .01
      && dashValue(style['stroke-dasharray']) === (external ? dashValue(EXTERNAL_REFERENCE_STYLE.dash) : null))
    && styles.every(style => Number(style.opacity ?? 1) > 0 && !(style.fill === 'none' && style.stroke === 'none')), `Mermaid node appearance mismatch: ${id}`);
}

/** 侧栏样例独立于业务图；核对真实 Mermaid 图元，不把图例样例当作业务身份。 */
export function checkGuideSamples(samples, styles) {
  requireCondition(isDeepStrictEqual(styles, { nodes: NODE_STYLES, edges: EDGE_STYLES, selection: SELECTION_STYLE, externalReference: EXTERNAL_REFERENCE_STYLE }), 'Read guide styles do not match the shared catalog');
  requireCondition(samples && typeof samples === 'object' && !Array.isArray(samples)
    && isDeepStrictEqual(Object.keys(samples).filter(key => key !== 'schedule').sort(), ['edges', 'nodes'])
    && samples.nodes && samples.edges && isDeepStrictEqual(Object.keys(samples.nodes).sort(), Object.keys(NODE_STYLES).sort())
    && isDeepStrictEqual(Object.keys(samples.edges).sort(), Object.keys(EDGE_STYLES).sort()), 'Read guide sample catalog mismatch');
  const sampleIds = new Set();
  function parseSample(source, kind, type) {
    const id = `${kind}/${type}`;
    requireCondition(typeof source === 'string' && source.length > 0, `Missing read guide sample: ${id}`);
    const elements = svgElements(source), root = elements.find(element => element.tag === 'svg');
    const bounds = root?.attrs.viewBox?.trim().split(/[\s,]+/).map(Number);
    requireCondition(root?.attrs['data-diagram-engine'] === 'mermaid' && root.attrs['data-guide-kind'] === kind
      && root.attrs[kind === 'node' ? 'data-visual-type' : 'data-edge-semantic'] === type
      && !Object.hasOwn(root.attrs, 'data-guide-variant')
      && (kind !== 'node' || root.attrs['data-shape'] === NODE_STYLES[type].shape), `Read guide sample identity mismatch: ${id}`);
    requireCondition(root.attrs['aria-label'] === (kind === 'node' ? NODE_STYLES[type] : EDGE_STYLES[type]).legendLabel, `Read guide accessible label mismatch: ${id}`);
    requireCondition(bounds?.length === 4 && bounds.every(Number.isFinite) && bounds[2] > 0 && bounds[3] > 0, `Invalid read guide viewBox: ${id}`);
    requireCondition(elements.every(element => !Object.keys(element.attrs).some(name => /^data-(?:id|instance|feature|role|shape-part|link-id|connect|schedule-.+|layout-link)$/.test(name))), `Business identity leaked into read guide: ${id}`);
    for (const element of elements.filter(item => item.attrs.id)) {
      requireCondition(!sampleIds.has(element.attrs.id), `Duplicate read guide SVG ID: ${element.attrs.id}`);
      sampleIds.add(element.attrs.id);
    }
    return { id, elements, bounds };
  }
  function checkBounds(parts, bounds, id) {
    requireCondition(parts.length, `Missing read guide native geometry: ${id}`);
    for (const part of parts) {
      const box = shapeBounds(part);
      requireCondition(box.x >= bounds[0] - .05 && box.y >= bounds[1] - .05
        && box.x + box.width <= bounds[0] + bounds[2] + .05 && box.y + box.height <= bounds[1] + bounds[3] + .05, `Read guide geometry is outside its viewBox: ${id}`);
    }
  }
  for (const [type, expected] of Object.entries(NODE_STYLES)) {
    const { id, elements, bounds } = parseSample(samples.nodes[type], 'node', type);
    const parts = elements.filter(element => Object.hasOwn(element.attrs, 'data-guide-shape-part'));
    requireCondition(!elements.some(element => Object.hasOwn(element.attrs, 'data-guide-edge')), `Unexpected edge in node guide sample: ${id}`);
    checkNodeAppearance(parts, expected, false, `guide/${id}`);
    checkBounds(parts, bounds, id);
  }
  for (const type of Object.keys(EDGE_STYLES)) {
    const { id, elements, bounds } = parseSample(samples.edges[type], 'edge', type);
    const parts = elements.filter(element => Object.hasOwn(element.attrs, 'data-guide-edge'));
    requireCondition(parts.length === 1 && parts[0].tag === 'path', `Read guide edge geometry mismatch: ${id}`);
    requireCondition(!elements.some(element => Object.hasOwn(element.attrs, 'data-guide-shape-part')), `Unexpected node in edge guide sample: ${id}`);
    checkActualEdgeStyle(parts[0], type, elements, `guide/${id}`);
    checkBounds(parts, bounds, id);
  }
  if (samples.schedule !== undefined) checkScheduleGuideSamples(samples.schedule, sampleIds);
}

/** 调度图例使用透明底、无字的 Graphviz 自有轮廓，不套用 Mermaid 的形状或箭头规则。 */
export function checkScheduleGuideSamples(samples, sampleIds = new Set()) {
  requireCondition(samples && isDeepStrictEqual(Object.keys(samples).sort(), ['edges', 'nodes'])
    && samples.nodes && isDeepStrictEqual(Object.keys(samples.nodes).sort(), ['context', 'system', 'system_set'])
    && samples.edges && isDeepStrictEqual(Object.keys(samples.edges).sort(), ['order', 'set_membership']), 'Schedule guide sample catalog mismatch');
  for (const [kind, source] of [...Object.entries(samples.nodes), ...Object.entries(samples.edges)]) {
    const id = 'guide-schedule-' + kind;
    requireCondition(typeof source === 'string', `Missing Schedule guide sample: ${kind}`);
    normalizeScheduleSvg(source, id);
    const elements = svgElements(source), root = elements.find(element => element.tag === 'svg');
    const bounds = root?.attrs.viewBox?.trim().split(/[\s,]+/).map(Number);
    requireCondition(root?.attrs.id === id && root.attrs['data-diagram-engine'] === 'graphviz'
      && root.attrs['aria-label'] === SCHEDULE_LEGEND_LABELS[kind], `Schedule guide identity mismatch: ${kind}`);
    requireCondition(bounds?.length === 4 && bounds.every(Number.isFinite) && bounds[2] > 0 && bounds[3] > 0
      && Number(root.attrs.width) === bounds[2] && Number(root.attrs.height) === bounds[3], `Schedule guide dimensions mismatch: ${kind}`);
    requireCondition(!elements.some(element => ['text', 'tspan'].includes(element.tag)), `Unexpected visible text in Schedule guide: ${kind}`);
    for (const element of elements) {
      requireCondition(!Object.keys(element.attrs).some(name => /^data-(?:id|instance|feature|role|shape-part|link-id|connect|schedule-.+|layout-link)$/.test(name)), `Business identity leaked into Schedule guide: ${kind}`);
      if (element.attrs.id) { requireCondition(!sampleIds.has(element.attrs.id), `Duplicate read guide SVG ID: ${element.attrs.id}`); sampleIds.add(element.attrs.id); }
    }
    const edge = kind === 'order' || kind === 'set_membership', className = edge ? 'edge' : kind === 'system_set' ? 'cluster' : 'node';
    const subjects = elements.filter(element => element.tag === 'g' && (element.attrs.class || '').split(/\s+/).includes(className));
    requireCondition(subjects.length === 1, `Schedule guide native subject mismatch: ${kind}`);
    const parts = descendantsOf(elements, subjects[0]).filter(element => ['path', 'polygon', 'rect', 'ellipse', 'circle', 'line', 'polyline'].includes(element.tag));
    const graphs = elements.filter(element => element.tag === 'g' && (element.attrs.class || '').split(/\s+/).includes('graph'));
    const backgrounds = elements.filter(element => ['path', 'polygon', 'rect', 'ellipse', 'circle', 'line', 'polyline'].includes(element.tag) && !parts.includes(element));
    requireCondition(graphs.length === 1 && backgrounds.length <= 1 && backgrounds.every(background => background.tag === 'polygon' && background.parent === graphs[0]
      && ['none', 'transparent'].includes(effectiveStyle(background).fill?.toLowerCase())
      && ['none', 'transparent'].includes(effectiveStyle(background).stroke?.toLowerCase())), `Schedule guide background is not transparent: ${kind}`);
    const expected = edge ? SCHEDULE_THEME.edge : kind === 'system_set' ? SCHEDULE_THEME.systemSet : SCHEDULE_THEME.system;
    if (edge) {
      const paths = parts.filter(element => element.tag === 'path'), arrows = parts.filter(element => element.tag === 'polygon');
      requireCondition(paths.length === 1 && arrows.length === (kind === 'order' ? 1 : 0), `Schedule guide arrow mismatch: ${kind}`);
      requireCondition(parts.every(element => { const style = effectiveStyle(element); return style.stroke?.toLowerCase() === expected.stroke.toLowerCase()
        && dashValue(style['stroke-dasharray']) === null && Math.abs(parseFloat(style['stroke-width'] || 1) - expected.width) < .01; })
        && arrows.every(element => effectiveStyle(element).fill?.toLowerCase() === expected.stroke.toLowerCase()), `Schedule guide edge style mismatch: ${kind}`);
    } else {
      checkNodeAppearance(parts, expected, false, id);
      requireCondition(parts.some(element => element.tag === 'path' && /[CQ]/i.test(element.attrs.d || '')), `Schedule guide rounded outline mismatch: ${kind}`);
    }
    const boxes = parts.map(shapeBounds);
    const left = Math.min(...boxes.map(box => box.x)), top = Math.min(...boxes.map(box => box.y));
    const right = Math.max(...boxes.map(box => box.x + box.width)), bottom = Math.max(...boxes.map(box => box.y + box.height));
    requireCondition(edge || bottom > top && (right - left) / (bottom - top) >= 3, `Schedule guide node is not horizontal: ${kind}`);
    for (const box of boxes) {
      requireCondition(box.x >= bounds[0] - .05 && box.y >= bounds[1] - .05 && box.x + box.width <= bounds[0] + bounds[2] + .05
        && box.y + box.height <= bounds[1] + bounds[3] + .05, `Schedule guide geometry is outside its viewBox: ${kind}`);
    }
    requireCondition([left - bounds[0], top - bounds[1], bounds[0] + bounds[2] - right, bounds[1] + bounds[3] - bottom]
      .every(padding => Math.abs(padding - 5) < .05), `Schedule guide padding mismatch: ${kind}`);
  }
}

export function checkMermaidStyles(view, registry) {
  if (!styledView(view)) return;
  const elements = svgElements(view.svg);
  if (view.layout === 'app-schedule') for (const group of view.scheduleGroups.filter(group => !group.nodes.length && !(group.visualAttachments || []).length)) {
    const anchor = elements.find(item => item.attrs.id?.startsWith(`${view.id}-flowchart-phase_anchor_${group.mermaidId}-`));
    const parts = anchor && descendantsOf(elements, anchor).filter(item => ['rect', 'path', 'polygon', 'circle', 'ellipse'].includes(item.tag));
    requireCondition(parts?.length && parts.every(part => Number(effectiveStyle(part).opacity) === 0), `Visible empty Schedule layout anchor: ${group.id}`);
  }
  for (const node of view.nodes) {
    const element = elements.find(item => item.attrs['data-id'] === node.id), expected = NODE_STYLES[node.visualType];
    requireCondition(expected && element?.attrs['data-visual-type'] === node.visualType && (!element.attrs['data-shape'] || element.attrs['data-shape'] === node.shape), `Visual node type mismatch: ${node.id}`);
    const descendants = descendantsOf(elements, element), parts = descendants.filter(item => item.attrs['data-shape-part'] === node.instance);
    checkNodeAppearance(parts, expected, node.role === 'external', node.id);
    const label = node.presentation === 'entity-container'
      ? elements.find(item => item.attrs['data-entity-header'] === node.instance)
      : descendants.find(item => (item.attrs.class || '').split(/\s+/).includes('label'));
    const rows = label && descendantsOf(elements, label).filter(item => item.tag === 'tspan' && (item.attrs.class || '').split(/\s+/).includes('row'));
    const visibleText = rows?.length ? rows.map(row => row.text).join('\n') : label?.text;
    requireCondition(label && compactText(visibleText) && compactText(visibleText) === compactText(renderedNodeLabel(node)), `Mermaid rendered node label mismatch: ${node.id}`);
  }
  for (const link of view.links) {
    requireCondition(link.edgeSemantic === edgeSemanticOf(link, registry) && link.displayLabel === displayLabelOf(link, link.edgeSemantic, registry), `Visual edge semantic mismatch: ${link.id}`);
    const element = elements.find(item => item.attrs['data-link-id'] === link.id);
    requireCondition(element?.attrs['data-edge-semantic'] === link.edgeSemantic, `Visual edge semantic metadata mismatch: ${link.id}`);
    requireCondition((element?.attrs['data-native-reverse'] === 'true') === Boolean(link.nativeReverse), `Visual native edge direction mismatch: ${link.id}`);
    checkActualEdgeStyle(element, link.edgeSemantic, elements, link.id);
  }
  for (const link of view.scheduleLinks || []) checkActualEdgeStyle(elements.find(item => item.attrs['data-schedule-link-id'] === link.id), link.edgeSemantic, elements, link.id);
}

export function checkDataSections(view) {
  if (view.aspect !== 'data') return;
  const elements = svgElements(view.svg);
  for (const [id, label] of Object.entries(DATA_GROUP_LABELS)) {
    const cluster = elements.find(element => element.attrs.id === `${view.id}-${id}` && (element.attrs.class || '').split(/\s+/).includes('cluster'));
    if (!cluster) continue;
    const rect = cluster.children.find(element => element.tag === 'rect');
    requireCondition(rect, `Missing Mermaid data container: ${view.id}/${id}`);
    const title = descendantsOf(elements, cluster).find(element => (element.attrs.class || '').split(/\s+/).includes('cluster-label'));
    requireCondition(normalizedText(title?.text) === label, `Mermaid data container title mismatch: ${view.id}/${id}`);
    const sections = (view.sections || []).filter(section => section.label === label), box = shapeBounds(rect);
    requireCondition(sections.length === 1 && Object.keys(box).every(key => Number.isFinite(sections[0][key]) && Math.abs(sections[0][key] - box[key]) < .05), `Mermaid data locator mismatch: ${view.id}/${id}`);
  }
}

/** Entity 保持普通卡片，组件在详情和各自的对象图中浏览。 */
export function checkEntityViewProjections(view) {
  requireCondition(!Object.hasOwn(view, 'entityViews') && !Object.hasOwn(view, 'entityExpansion') && !view.parentViewId, `Obsolete Entity expansion metadata: ${view.id}`);
  requireCondition(!(view.nodes || []).some(node => node.entityToggle || /^entity-(?:container|collapsed)$/.test(node.presentation || '')), `Obsolete Entity expansion controls: ${view.id}`);
  return [];
}

export function checkEntityGroups(view) {
  requireCondition(!(view.entityGroups || []).length, `Obsolete nested Entity groups: ${view.id}`);
  const elements = svgElements(view.svg);
  requireCondition(!elements.some(element => Object.keys(element.attrs).some(name => /^data-entity-(?:group|header|toggle|owner)(?:-|$)/.test(name))
    || (element.attrs.class || '').split(/\s+/).includes('entity-container')), `Obsolete nested Entity geometry: ${view.id}`);
}

export function checkViewRouting(view) {
  const result = inspectViewRoutes(view);
  for (const edge of result.edges) {
    requireCondition(!edge.collisions.length, `Mermaid edge obstructed: ${view.id}/${edge.id}/${edge.collisions.map(item => item.id).join(',')}`);
    requireCondition(!edge.arrowIssues.length, `Mermaid arrow mismatch: ${view.id}/${edge.id}/${edge.arrowIssues.join(',')}`);
    requireCondition(edge.axis ? !edge.curved : edge.curved, `Mermaid edge must be ${edge.axis ? 'straight' : 'curved'}: ${view.id}/${edge.id}`);
    if (view.routing) {
      const curve = new RegExp(`^\\s*${edge.mermaidId}@\\{\\s*curve:\\s*(\\w+)\\s*\\}`, 'm').exec(view.mermaid)?.[1] || 'linear';
      requireCondition(edge.axis ? curve === 'linear' : [ROUTING_STYLE.curve, ...ROUTING_STYLE.curveFallbacks].includes(curve), `Mermaid source curve mismatch: ${view.id}/${edge.id}`);
    }
  }
  return result;
}

/** 所有视图保留统一原生 Dagre 布局，不能通过元数据跳过方向和几何检查。 */
export function checkMermaidLayout(view) {
  requireCondition(view.scheduleOrientation === undefined, `Obsolete Schedule orientation metadata: ${view.id}`);
  const configuration = /^---\r?\n([\s\S]*?)\r?\n---/.exec(view.mermaid);
  const layout = configuration && JSON.parse(configuration[1]).config?.layout;
  requireCondition(layout === 'dagre', `Expected shared Dagre layout: ${view.id}`);
  return layout;
}

export function checkMermaidSource(view, registry, scheduleDefinitions) {
  const appSchedule = view.layout === 'app-schedule';
  requireCondition(view.scheduleOrientation === undefined, `Obsolete Schedule orientation metadata: ${view.id}`);
  requireCondition(!appSchedule, `Retired manual App schedule view: ${view.id}`);
  requireCondition(view.diagramType === 'flowchart' && /^\s*flowchart\s+(LR|RL|TB)\s*$/m.test(view.mermaid), `Expected Mermaid flowchart LR, RL or TB: ${view.id}`);
  if (view.routing) checkMermaidLayout(view);
  requireCondition(!/^\s*(?:subgraph\s+)?legend(?:_\w*)?\b/m.test(view.mermaid), `Legend declaration remains in business Mermaid: ${view.id}`);
  const nodes = new Map(), links = new Map(), layout = new Map(), groups = new Map(), stack = [];
  const entityContainers = new Map((view.entityGroups || []).filter(group => group.expanded !== false).map(group => [group.mermaidId, group]));
  const entityHeaders = new Map((view.entityGroups || []).filter(group => group.expanded !== false).map(group => [group.headerMermaidId, group]));
  for (const original of view.mermaid.split(/\r?\n/)) {
    const line = original.trim();
    if (!line || line.startsWith('%%')) continue;
    const subgraph = /^subgraph\s+([A-Za-z]\w*)\s*\["((?:[^"\\]|\\.)*)"\]/.exec(line);
    if (subgraph) {
      requireCondition(!groups.has(subgraph[1]), `Duplicate Mermaid subgraph: ${subgraph[1]}`);
      const group = { id: subgraph[1], parent: stack.at(-1)?.id, nodes: [], descendants: [], direction: null, label: decodeMermaidText(subgraph[2]) };
      groups.set(subgraph[1], group);
      if (entityContainers.has(group.id)) {
        requireCondition(!nodes.has(group.id), `Duplicate Mermaid Entity declaration: ${group.id}`);
        nodes.set(group.id, { shape: 'rect', label: null });
        for (const parent of stack) parent.descendants.push(group.id);
      }
      stack.push(group);
      continue;
    }
    if (line === 'end') { requireCondition(stack.length > 0, `Unexpected Mermaid subgraph end: ${view.id}`); stack.pop(); continue; }
    const direction = /^direction\s+(TB|BT|LR|RL)$/.exec(line);
    if (direction && stack.length) { stack.at(-1).direction = direction[1]; continue; }
    const extended = /^([A-Za-z]\w*)@\{\s*shape:\s*([\w-]+),\s*label:\s*"((?:[^"\\]|\\.)*)"\s*\}\s*;?$/.exec(line);
    const node = extended || /^([A-Za-z]\w*)\["((?:[^"\\]|\\.)*)"\](?:::[A-Za-z]\w*)?\s*;?$/.exec(line);
    if (node) {
      requireCondition(!nodes.has(node[1]), `Duplicate Mermaid node declaration: ${node[1]}`);
      nodes.set(node[1], { shape: extended ? node[2] : 'rect', label: decodeMermaidText(extended ? node[3] : node[2]) });
      stack.at(-1)?.nodes.push(node[1]);
      for (const group of stack) group.descendants.push(node[1]);
      continue;
    }
    const invisible = /^([A-Za-z]\w*)\s+(layout_\w+)@(~{3,}|-->)\s+([A-Za-z]\w*)\s*;?$/.exec(line);
    if (invisible) {
      requireCondition(!layout.has(invisible[2]), `Duplicate Mermaid layout edge: ${invisible[2]}`);
      layout.set(invisible[2], { from: invisible[1], to: invisible[4], directed: invisible[3] === '-->' });
      continue;
    }
    const link = /^([A-Za-z]\w*)\s+([A-Za-z]\w*)@(-{2,}>|-\.->|-{3,})\s*(?:\|"((?:[^"\\]|\\.)*)"\|\s*)?([A-Za-z]\w*)\s*;?$/.exec(line);
    if (link) {
      requireCondition(!links.has(link[2]), `Duplicate Mermaid edge declaration: ${link[2]}`);
      links.set(link[2], { from: link[1], to: link[5], arrow: link[3], label: decodeMermaidText(link[4] || '') });
      continue;
    }
    requireCondition(!/@(?:-->|-\.->|~~~)|\s(?:-->|-\.->|~~~)\s/.test(line), `Unidentified Mermaid edge declaration in ${view.id}: ${line}`);
  }
  requireCondition(stack.length === 0, `Unclosed Mermaid subgraph: ${view.id}`);
  const canonicalToMermaid = new Map();
  for (const node of view.nodes) {
    requireCondition(typeof node.mermaidId === 'string' && /^[A-Za-z]\w*$/.test(node.mermaidId) && nodes.has(node.mermaidId)
      && ![...canonicalToMermaid.values()].includes(node.mermaidId), `Mermaid node declaration mismatch: ${node.id}`);
    canonicalToMermaid.set(node.id, node.mermaidId);
    if (styledView(view)) {
      const definition = nodes.get(node.mermaidId);
      const display = node.presentation === 'entity-container'
        ? nodes.get(entityContainers.get(node.mermaidId)?.headerMermaidId)
        : definition;
      requireCondition(node.visualType === visualTypeOf(registry[node.id]) && (node.presentation === 'entity-container' ? node.visualType === 'entity' && node.shape === 'rect' && entityContainers.has(node.mermaidId) : NODE_STYLES[node.visualType]?.shape === node.shape)
        && definition.shape === node.shape && compactText(display?.label) === compactText(renderedNodeLabel(node)), `Mermaid node style or label mismatch: ${node.id}`);
    }
  }
  const phaseAnchors = appSchedule ? view.scheduleGroups.filter(group => !group.nodes.length && !(group.visualAttachments || []).length).map(group => `phase_anchor_${group.mermaidId}`) : [];
  for (const id of phaseAnchors) requireCondition(nodes.get(id)?.shape === 'anchor' && !nodes.get(id).label.trim(), `Invalid empty Schedule anchor: ${view.id}/${id}`);
  requireCondition(nodes.size === view.nodes.length + entityHeaders.size + phaseAnchors.length, `Mermaid node declaration count mismatch: ${view.id}`);
  for (const [id] of entityHeaders) requireCondition(nodes.get(id)?.shape === 'text', `Invalid Entity header declaration: ${view.id}/${id}`);
  const ids = new Set();
  for (const link of view.links) {
    const declaration = links.get(link.mermaidId);
    const logical = displayEndpoints(link), [from, to] = link.nativeReverse ? [...logical].reverse() : logical;
    requireCondition(declaration && !ids.has(link.mermaidId) && declaration.from === canonicalToMermaid.get(from)
      && declaration.to === canonicalToMermaid.get(to), `Mermaid edge declaration mismatch: ${link.id}`);
    requireCondition(link.nativeReverse ? ['component', 'object'].includes(view.aspect) && /^-{3,}$/.test(declaration.arrow) : /^(?:-{2,}>|-\.->)$/.test(declaration.arrow), `Mermaid edge arrow declaration mismatch: ${link.id}`);
    if (styledView(view)) requireCondition(compactText(declaration.label) === compactText(link.displayLabel), `Mermaid edge display label mismatch: ${link.id}`);
    ids.add(link.mermaidId);
  }
  const scheduleIds = new Set();
  for (const link of view.scheduleLinks || []) {
    const declaration = links.get(link.mermaidId), from = view.scheduleGroups.find(group => group.id === link.from), to = view.scheduleGroups.find(group => group.id === link.to);
    requireCondition(declaration && from && to && !scheduleIds.has(link.mermaidId) && !ids.has(link.mermaidId)
      && declaration.from === from.mermaidId && declaration.to === to.mermaidId, `Mermaid Schedule edge declaration mismatch: ${link.id}`);
    if (styledView(view)) requireCondition(compactText(declaration.label) === compactText(link.displayLabel), `Mermaid Schedule edge display label mismatch: ${link.id}`);
    scheduleIds.add(link.mermaidId);
  }
  requireCondition(links.size === view.links.length + scheduleIds.size, `Mermaid edge declaration count mismatch: ${view.id}`);
  requireCondition(Array.isArray(view.layoutLinks) && layout.size === view.layoutLinks.length, `Mermaid layout edge declaration count mismatch: ${view.id}`);
  const layoutIds = new Set();
  for (const link of view.layoutLinks) {
    const declaration = layout.get(link.mermaidId);
    requireCondition(declaration && !layoutIds.has(link.mermaidId) && declaration.from === link.from && declaration.to === link.to
      && declaration.directed === Boolean(link.directed) && [link.from, link.to].every(id => nodes.has(id) || groups.has(id)), `Mermaid layout edge declaration mismatch: ${link.mermaidId}`);
    layoutIds.add(link.mermaidId);
  }
  requireCondition(Array.isArray(view.scheduleGroups), `Missing Mermaid Schedule groups: ${view.id}`);
  const grouped = new Set(), attached = new Set(), branched = new Set(), groupIds = new Set();
  let previousOrder = -Infinity;
  for (const group of view.scheduleGroups) {
    const definition = scheduleDefinitions.get(group.id), declaration = groups.get(group.mermaidId);
    requireCondition((view.aspect === 'systems' || appSchedule) && group.id !== 'EventTriggered' && definition && Array.isArray(group.nodes) && group.label === (appSchedule ? definition.label : scheduleGroupLabel({ ...definition, nodes: group.nodes }, registry)) && group.order === definition.order
      && group.order > previousOrder && !groupIds.has(group.id), `Invalid or unordered Schedule group in ${view.id}: ${group.id}`);
    const attachments = group.visualAttachments || [];
    requireCondition(Array.isArray(attachments), `Invalid visual Schedule attachments: ${group.id}`);
    const physicalIds = [...group.nodes, ...attachments], expectedDeclarations = physicalIds.length ? physicalIds.map(id => canonicalToMermaid.get(id)) : [`phase_anchor_${group.mermaidId}`];
    requireCondition(declaration?.direction === 'TB' && Array.isArray(group.nodes) && (physicalIds.length > 0 || appSchedule)
      && isDeepStrictEqual([...declaration.descendants].sort(), expectedDeclarations.sort()), `Mermaid Schedule declaration mismatch: ${group.id}`);
    if (styledView(view)) requireCondition(group.track === definition.track && group.parent === definition.parent && normalizedText(declaration.label) === normalizedText(group.label), `Mermaid Schedule contract mismatch: ${group.id}`);
    previousOrder = group.order;
    groupIds.add(group.id);
    for (const id of group.nodes) {
      requireCondition(canonicalToMermaid.has(id) && !grouped.has(id) && !attached.has(id) && !isUnscheduledTriggerNode(registry[id])
        && (registry[id].schedule_group || 'Explanatory') === group.id, `Invalid Schedule node membership: ${id}`);
      grouped.add(id);
    }
    for (const id of attachments) {
      requireCondition(canonicalToMermaid.has(id) && !grouped.has(id) && !attached.has(id) && isUnscheduledTriggerNode(registry[id]), `Invalid visual Schedule attachment: ${id}`);
      attached.add(id);
    }
  }
  const branches = view.observerBranches || [], branchIds = new Set();
  requireCondition(Array.isArray(branches) && (!branches.length || view.aspect === 'systems' || appSchedule), `Invalid Observer source branches: ${view.id}`);
  for (const branch of branches) {
    requireCondition(typeof branch.id === 'string' && !branchIds.has(branch.id) && Array.isArray(branch.nodes)
      && branch.nodes.length > 0 && Array.isArray(branch.anchorSourceIds), `Invalid Observer source branch: ${branch.id}`);
    branchIds.add(branch.id);
    const declaration = groups.get(branch.mermaidId);
    requireCondition(declaration?.direction === 'TB' && !declaration.label.trim()
      && isDeepStrictEqual([...declaration.descendants].sort(), branch.nodes.map(id => canonicalToMermaid.get(id)).sort()), `Mermaid Observer source branch declaration mismatch: ${branch.id}`);
    requireCondition(view.mermaid.split(/\r?\n/).some(line => line.trim() === `style ${branch.mermaidId} fill:none,stroke:none`), `Visible Observer source branch container: ${branch.id}`);
    for (const id of branch.nodes) {
      requireCondition(canonicalToMermaid.has(id) && !grouped.has(id) && !attached.has(id) && !branched.has(id)
        && isUnscheduledTriggerNode(registry[id]), `Invalid Observer source branch member: ${id}`);
      branched.add(id);
    }
    const identity = `observer-branch-${crypto.createHash('sha256').update([...branch.nodes].sort().join('|')).digest('hex').slice(0, 16)}`;
    const sources = [...new Set(view.links.filter(link => link.projection === 'observer-trigger' && branch.nodes.includes(link.from)).map(link => link.from))];
    requireCondition(branch.id === identity && isDeepStrictEqual(branch.anchorSourceIds, sources), `Observer source branch identity or anchor mismatch: ${branch.id}`);
  }
  if (view.aspect === 'systems' || appSchedule) for (const node of view.nodes) {
    const unscheduled = isUnscheduledTriggerNode(registry[node.id]);
    requireCondition(unscheduled ? attached.has(node.id) || branched.has(node.id) : grouped.has(node.id), `Schedule groups and Observer placements do not cover all nodes: ${view.id}/${node.id}`);
  }
  for (const group of view.entityGroups || []) {
    if (group.expanded === false) {
      requireCondition(!groups.has(group.mermaidId) && nodes.get(group.mermaidId)?.shape === 'rect', `Mermaid collapsed Entity declaration mismatch: ${view.id}/${group.id}`);
      const connected = view.links.some(link => displayEndpoints(link).includes(group.entity));
      requireCondition(groups.get(connected ? 'relations' : 'catalog')?.descendants.includes(group.mermaidId), `Split collapsed Entity layout unit: ${view.id}/${group.id}`);
      continue;
    }
    const declaration = groups.get(group.mermaidId), members = [group.headerMermaidId, ...group.components.map(id => canonicalToMermaid.get(id))];
    requireCondition(view.aspect === 'data' && declaration?.direction === 'TB'
      && !declaration.label.trim()
      && isDeepStrictEqual(declaration.descendants, members), `Mermaid Entity declaration mismatch: ${view.id}/${group.id}`);
    const entity = view.nodes.find(node => node.id === group.entity), style = NODE_STYLES.entity;
    const containerStyle = `style ${group.mermaidId} fill:${style.fill},stroke:${style.stroke},stroke-width:${style.width}px,color:#1F3340${entity.role === 'external' ? `,stroke-dasharray:${EXTERNAL_REFERENCE_STYLE.dash}` : ''}`;
    requireCondition(view.mermaid.split(/\r?\n/).some(line => line.trim() === containerStyle), `Mermaid Entity container style mismatch: ${view.id}/${group.id}`);
    for (const column of entityComponentColumns(group.components)) {
      const sequence = [group.headerMermaidId, ...column.map(id => canonicalToMermaid.get(id))];
      for (let index = 1; index < sequence.length; index++) requireCondition(view.layoutLinks.some(link => link.from === sequence[index - 1] && link.to === sequence[index]), `Mermaid Entity column mismatch: ${view.id}/${group.id}`);
    }
    const connected = view.links.some(link => [link.from, link.to].some(id => id === group.entity || group.components.includes(id)));
    let region = declaration;
    while (region && !['catalog', 'relations'].includes(region.id)) region = groups.get(region.parent);
    requireCondition(region?.id === (connected ? 'relations' : 'catalog'), `Split Entity layout unit: ${view.id}/${group.id}`);
  }
  if (view.aspect === 'data') requireCondition(!groups.has('diagram_main') && /^\s*flowchart\s+TB\s*$/m.test(view.mermaid), `Invalid compact Mermaid data direction: ${view.id}`);
  else if (view.aspect === 'systems' || appSchedule) requireCondition(groups.get('diagram_main')?.direction === 'LR', `Invalid horizontal Mermaid Schedule direction: ${view.id}`);
  else if (/^\s*flowchart\s+TB\s*$/m.test(view.mermaid)) requireCondition(groups.get('diagram_main')?.direction === 'LR', `Invalid Mermaid main direction: ${view.id}`);
}

/** 系统图的直连只投影精确事件上的两条原关系；对象图仍保留原始一跳。 */
export function checkObserverTriggerProjections(view, model, registry, sourceLinks = model.system_links || []) {
  const projections = view.links.filter(link => link.projection === 'observer-trigger');
  const systemView = view.aspect === 'systems' || view.layout === 'app-schedule';
  requireCondition(systemView || projections.length === 0, `Observer trigger projection outside a system view: ${view.id}`);
  if (!systemView) return 0;
  requireCondition(projections.every(link => link.kind === 'trigger'), `Invalid Observer trigger projection kind: ${view.id}`);
  const originals = new Map((model.system_links || []).map(link => [link.id, link]));
  const evidence = new Map();
  for (const link of sourceLinks) {
    if (!evidence.has(link.id)) evidence.set(link.id, []);
    evidence.get(link.id).push(link);
  }
  const sourceKey = source => JSON.stringify([source.role === 'call' ? 'operation' : source.role, source.path, source.line, source.column || 1, source.dependency?.name, source.dependency?.version]);
  for (const link of view.links.filter(link => link.kind === 'trigger')) {
    requireCondition(link.projection === 'observer-trigger', `Unprojected Observer trigger in system view: ${view.id}/${link.id}`);
    requireCondition(registry[link.eventId] && nodeKindOf(registry[link.eventId]) === 'EntityEvent'
      && registry[link.to] && nodeKindOf(registry[link.to]) === 'Observer'
      && Array.isArray(link.originalLinkIds) && link.originalLinkIds.length === 2, `Invalid Observer trigger projection: ${link.id}`);
    const [emission, subscription] = link.originalLinkIds.map(id => originals.get(id));
    requireCondition(emission?.kind === 'trigger' && subscription?.kind === 'trigger'
      && emission.from === link.from && emission.to === link.eventId
      && subscription.from === link.eventId && subscription.to === link.to, `Observer trigger original chain mismatch: ${link.id}`);
    const id = `observer-trigger-${crypto.createHash('sha256').update(`${emission.id}|${subscription.id}`).digest('hex').slice(0, 16)}`;
    requireCondition(link.id === id && link.label === (subscription.label || registry[link.eventId].name), `Observer trigger projection identity mismatch: ${link.id}`);
    const chain = [emission, subscription].flatMap(original => [original, ...(evidence.get(original.id) || [])]);
    const actualSources = new Set((link.sourceEntries || []).map(sourceKey));
    requireCondition(chain.flatMap(original => original.sourceEntries || []).every(source => actualSources.has(sourceKey(source))), `Observer trigger source evidence was removed: ${link.id}`);
    requireCondition(chain.flatMap(original => original.sourceGaps || []).every(gap => link.sourceGaps?.includes(gap)), `Observer trigger evidence gap was removed: ${link.id}`);
    const notes = [emission.label, ...(emission.notes || []), ...(subscription.notes || [])].filter(note => note && note !== '触发');
    requireCondition(notes.every(note => link.notes?.includes(note)), `Observer trigger condition was removed: ${link.id}`);
  }
  for (const node of view.nodes) if (node.role !== 'external' && nodeKindOf(registry[node.id]) === 'Observer') {
    requireCondition(projections.some(link => link.to === node.id), `Observer source is missing from system view: ${view.id}/${node.id}`);
  }
  return projections.length;
}

const systemLinkKey = ({ id, from, to, kind, label, projection, eventId, originalLinkIds }) => ({ id, from, to, kind, label, projection, eventId, originalLinkIds });
const placementNodeIds = nodes => nodes.map(node => typeof node === 'string' ? node : node.id);
const observerBranchKey = ({ id, nodes, anchorSourceIds }) => ({ id, nodes: placementNodeIds(nodes), anchorSourceIds });
const visualPlacementKey = groups => groups.map(({ id, nodes, visualAttachments = [] }) => ({ id, nodes: placementNodeIds(nodes), visualAttachments: placementNodeIds(visualAttachments) }));

/** 对象图只展开中心的一跳；投影和注册身份不因同名、同函数而合并。 */
export function checkObjectViews(views, catalog) {
  requireCondition(Array.isArray(views), 'Invalid architecture view list');
  requireCondition(Array.isArray(catalog.objects), 'Missing object catalog');
  const objects = new Map(), viewIds = new Set();
  for (const object of catalog.objects) {
    requireCondition(typeof object.id === 'string' && object.id && !objects.has(object.id)
      && typeof object.viewId === 'string' && /^object-[a-z0-9-]+$/.test(object.viewId) && !viewIds.has(object.viewId), `Invalid or duplicate object identity: ${object.id}`);
    objects.set(object.id, object);
    viewIds.add(object.viewId);
  }
  const objectViews = views.filter(view => view.aspect === 'object');
  requireCondition(objectViews.length === objects.size, `Expected ${objects.size} object views`);
  const seen = new Set();
  const nodeKeys = nodes => nodes.map(({ id, role }) => [id, role]).sort(([a], [b]) => a.localeCompare(b));
  for (const view of objectViews) {
    const object = objects.get(view.objectId);
    requireCondition(object && !seen.has(object.id) && view.id === object.viewId && view.feature === object.feature, `Object view identity mismatch: ${view.id}`);
    seen.add(object.id);
    requireCondition(view.centerNodeId === object.id && view.nodes.filter(node => node.id === object.id).length === 1, `Object view center mismatch: ${view.id}`);
    requireCondition(!view.links.some(link => link.projection === 'observer-trigger'), `Observer trigger projection outside a system view: ${view.id}`);
    // 插件专属图为单卡，关系仍保留在目录和其他对象图；实体中心隐藏组件几何。
    if (['Plugin', 'PluginGroup'].includes(object.kind)) {
      requireCondition(view.nodes.length === 1 && view.links.length === 0 && (view.scheduleLinks || []).length === 0,
        `Plugin object view must contain only its own card: ${view.id}`);
    }
    if (object.kind === 'Entity') {
      const isComponent = id => objects.get(id)?.kind === 'Component';
      requireCondition(!view.nodes.some(node => isComponent(node.id))
        && !view.links.some(link => isComponent(link.from) || isComponent(link.to)), `Entity object view contains Component geometry: ${view.id}`);
    }
    const graph = catalog.graphFor(object.id);
    requireCondition(isDeepStrictEqual(nodeKeys(view.nodes), nodeKeys(graph.nodes)), `Object view direct-neighbor coverage mismatch: ${view.id}`);
    const actual = new Map(view.links.map(link => [link.id, link]));
    requireCondition(actual.size === view.links.length && actual.size === graph.links.length
      && graph.links.every(link => actual.has(link.id)), `Object view incident-link coverage mismatch: ${view.id}`);
    for (const expected of graph.links) {
      const link = actual.get(expected.id);
      requireCondition(link.from === object.id || link.to === object.id, `Object view contains a nonincident link: ${view.id}/${link.id}`);
      const fields = Object.keys(expected).filter(key => !['sourceEntries', 'sourceGaps'].includes(key));
      requireCondition(fields.every(key => isDeepStrictEqual(link[key], expected[key])), `Object view relation metadata mismatch: ${view.id}/${link.id}`);
      requireCondition((expected.sourceGaps || []).every(gap => link.sourceGaps?.includes(gap)), `Object view relation evidence gap was removed: ${view.id}/${link.id}`);
      const sourceKey = source => JSON.stringify([source.role === 'call' ? 'operation' : source.role, source.path, source.line, source.column || 1, source.dependency?.name, source.dependency?.version]);
      const actualSources = new Set((link.sourceEntries || []).map(sourceKey));
      requireCondition((expected.sourceEntries || []).every(source => actualSources.has(sourceKey(source))), `Object view relation source evidence was removed: ${view.id}/${link.id}`);
    }
  }
  return objects.size;
}

/** 核对编译器模型与呈现产物，不重新推断 Rust 语义。 */
export function checkArchitecture(root) {
  requireCondition(typeof root === 'string' && path.isAbsolute(root), 'Repository root must be an absolute path');
  const repository = fs.realpathSync(root), paths = pathsForRepository(repository);
  const artifact = readArchitectureData(repository), model = artifact.model;
  validateCompilerModel(model, { workspace: repository, modelDirectory: paths.dataDirectory });
  checkCompilerRegistry(artifact.registry, model);
  const registry = artifact.registry, catalog = createCompilerObjectCatalog(model, registry);
  requireCondition(isDeepStrictEqual(artifact.objects, catalog.objects), 'Distributed object index differs from compiler model');
  requireCondition(isDeepStrictEqual(artifact.scheduleInteractions, model.scheduleInteractions), 'Distributed Schedule bindings differ from compiler model');
  requireCondition(isDeepStrictEqual(artifact.sourceRoleLabels, SOURCE_ROLE_LABELS), 'Source role labels differ from distribution contract');
  checkObjectViews(artifact.views, catalog);
  const scheduleViews = artifact.views.filter(view => view.aspect === 'schedule');
  bindCompilerSchedules(model, scheduleViews);
  checkDebugdumpViews(paths.dotDirectory, repository, scheduleViews);
  const filenames = new Set(), mermaidFilenames = new Set(), instances = new Set();
  for (const view of artifact.views) {
    requireCondition(typeof view.svg === 'string' && Number.isFinite(view.width) && view.width > 0 && Number.isFinite(view.height) && view.height > 0,
      'Missing or invalid rendered view: ' + view.id);
    requireCondition(!filenames.has(view.filename), 'Duplicate rendered SVG filename: ' + view.filename); filenames.add(view.filename);
    requireCondition(fs.readFileSync(artifactFile(paths, view), 'utf8') === view.svg, 'SVG artifact mismatch: ' + view.id);
    if (view.engine === 'graphviz') continue;
    requireCondition(view.aspect === 'object' && view.engine === 'mermaid' && view.filename === `ecs-${view.id}.svg`
      && view.mermaidFilename === `ecs-${view.id}.mmd`, 'Invalid compiler object render descriptor: ' + view.id);
    requireCondition(fs.readFileSync(artifactFile(paths, view, 'mermaid'), 'utf8') === view.mermaid, 'Mermaid artifact mismatch: ' + view.id);
    mermaidFilenames.add(view.mermaidFilename);
    const nodes = elementAttributes(view.svg, 'data-id'), links = elementAttributes(view.svg, 'data-link-id');
    requireCondition(nodes.length === view.nodes.length && links.length === view.links.length, 'Rendered graph element coverage mismatch: ' + view.id);
    for (const node of view.nodes) {
      const rendered = nodes.find(value => value['data-instance'] === node.instance);
      requireCondition(rendered && !instances.has(node.instance) && rendered['data-id'] === node.id && rendered['data-role'] === node.role
        && rendered['data-feature'] === registry[node.id].feature, 'Rendered object identity mismatch: ' + node.id);
      instances.add(node.instance);
    }
    for (const link of view.links) {
      const rendered = links.find(value => value['data-link-id'] === link.id);
      requireCondition(rendered && rendered['data-connect'] === displayEndpoints(link).join('|'), 'Rendered relation endpoint mismatch: ' + link.id);
    }
    checkMermaidSource(view, registry, new Map());
    checkMermaidGeometry(view.svg, view);
    checkMermaidStyles(view, registry);
    checkDataSections(view);
    checkEntityGroups(view);
    if (view.routing) checkViewRouting(view);
  }
  checkGuideSamples(artifact.guideSamples, artifact.styles);
  requireCondition(isDeepStrictEqual(artifact.scheduleLegendLabels, SCHEDULE_LEGEND_LABELS), 'Schedule guide labels mismatch');
  const actualSvgs = [paths.objectSvgDirectory, paths.scheduleSvgDirectory].flatMap(directory => fs.readdirSync(directory)).filter(name => /^ecs-.*\.svg$/.test(name)).sort();
  requireCondition(isDeepStrictEqual(actualSvgs, [...filenames].sort()), 'Architecture SVG file set does not match compiler view manifest');
  requireCondition(isDeepStrictEqual(fs.readdirSync(paths.mermaidDirectory).filter(name => /^ecs-.*\.mmd$/.test(name)).sort(), [...mermaidFilenames].sort()), 'Architecture Mermaid file set mismatch');
  const snapshots = embeddedJson(fs.readFileSync(path.join(paths.pagesDirectory, 'ecs-source.html'), 'utf8'), 'sources');
  const expectedSources = model.sourceFiles.map(source => ({ path: sourceKey(source), text: source.content,
    ...(source.dependency ? { source: { path: source.path, line: 1, dependency: source.dependency } } : {}) }));
  const normalizedSources = list => list.map(source => ({ ...source, text: source.text.replace(/\r\n/g, '\n') })).sort((a, b) => a.path.localeCompare(b.path));
  requireCondition(isDeepStrictEqual(normalizedSources(snapshots), normalizedSources(expectedSources)), 'Distributed source snapshots differ from compiler evidence');
  return { systems: model.objects.filter(object => ['System', 'Observer'].includes(object.kind)).length,
    objects: catalog.objects.length, views: artifact.views.length, sources: snapshots.length };
}
const filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  try {
    console.log(JSON.stringify(checkArchitecture(repositoryRoot)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

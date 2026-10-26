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
import { isMainPluginRegistration, scheduleGroupLabel, buildArchitectureModel, isUnscheduledTriggerNode, buildObserverPlacement } from './architecture-model.mjs';
import { buildComponentCatalog } from './architecture-components.mjs';
import { buildObjectCatalog } from './architecture-objects.mjs';
import { sourceEntriesFor, sourcePolicyKindFor, sourcePolicyFor, auditProductionEcsCoverage } from './architecture-source-policy.mjs';
import { DATA_GROUP_LABELS, entityComponentColumns } from './architecture-renderer.mjs';
import { buildAppSchedule, APP_SCHEDULE_GROUPS } from './architecture-app-schedule.mjs';
import { displayEndpoints, inspectViewRoutes, ROUTING_STYLE, nativeSvgProperty, nativeMarkerProperty } from './architecture-routing.mjs';
import { INFRASTRUCTURE_FEATURES, infrastructureFeature, architectureViewId } from './architecture-infrastructure.mjs';
import { DEPENDENCY_SOURCE_DEFINITIONS } from './architecture-source-definitions.mjs';
import { readCargoMetadata, createDependencySourceResolver, dependencySourceKey, checkDependencySources } from './dependency-sources.mjs';

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
    && isDeepStrictEqual(Object.keys(samples).sort(), ['edges', 'nodes'])
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

function checkMermaidSource(view, registry, scheduleDefinitions) {
  const appSchedule = view.layout === 'app-schedule';
  requireCondition(view.scheduleOrientation === undefined, `Obsolete Schedule orientation metadata: ${view.id}`);
  if (appSchedule) scheduleDefinitions = new Map(APP_SCHEDULE_GROUPS.map(group => [group.id, group]));
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

export function checkAppSchedule(view, model, registry) {
  requireCondition(view.id === 'overview' && view.feature === null && view.aspect === 'overview' && view.layout === 'app-schedule', 'Overview must show the App system schedule');
  requireCondition(view.scheduleOrientation === undefined, 'Obsolete Schedule orientation metadata: overview');
  const expected = buildAppSchedule(model, registry);
  const nodeKeys = nodes => nodes.map(node => [node.id, node.role]).sort(([a], [b]) => a.localeCompare(b));
  requireCondition(isDeepStrictEqual(nodeKeys(view.nodes), nodeKeys(expected.graph.nodes)), 'App schedule node coverage mismatch');
  const linkKeys = links => links.map(systemLinkKey).sort((a, b) => a.id.localeCompare(b.id));
  requireCondition(isDeepStrictEqual(linkKeys(view.links), linkKeys(expected.graph.links)), 'App schedule dependency coverage mismatch');
  const groupKeys = groups => groups.map(({ id, label, order, track, parent, schedule, notes, nodes, visualAttachments = [] }) => ({ id, label, order, track, parent, schedule, notes, nodes: nodes.map(node => typeof node === 'string' ? node : node.id), visualAttachments: visualAttachments.map(node => typeof node === 'string' ? node : node.id) }));
  requireCondition(isDeepStrictEqual(groupKeys(view.scheduleGroups), groupKeys(expected.groups)), 'App schedule phase or registration mismatch');
  requireCondition(isDeepStrictEqual((view.observerBranches || []).map(observerBranchKey), expected.branches.map(observerBranchKey)), 'App Observer source branch coverage mismatch');
  const phaseKeys = links => links.map(({ id, from, to, edgeSemantic, displayLabel, notes }) => ({ id, from, to, edgeSemantic, displayLabel, notes }));
  requireCondition(isDeepStrictEqual(phaseKeys(view.scheduleLinks), phaseKeys(expected.phaseLinks)), 'App schedule execution path mismatch');
}

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
    // 实体中心只隐藏组件几何；其它关系仍逐项核对，组件自身图继续保留包含关系。
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

/** 核对清单、图、源码入口和快照；成功返回数量摘要，失败抛出英文错误。 */
export function checkArchitecture(root, { dependencyDefinitions = DEPENDENCY_SOURCE_DEFINITIONS, cargoMetadata, requireDependencyDefinitions = true } = {}) {
  requireCondition(typeof root === 'string' && path.isAbsolute(root), 'Repository root must be an absolute path');
  const repository = fs.realpathSync(root);
  const directory = path.join(repository, 'docs', 'diagrams');
  const requiredFiles = ['ecs-data.json', 'ecs-architecture.html', 'ecs-source.html'];
  for (const file of requiredFiles) {
    requireCondition(fs.existsSync(path.join(directory, file)), `Missing architecture artifact: ${file}`);
  }
  const model = JSON.parse(fs.readFileSync(path.join(directory, 'ecs-data.json'), 'utf8'));
  const artifact = embeddedJson(fs.readFileSync(path.join(directory, 'ecs-architecture.html'), 'utf8'), 'architecture-data');
  requireCondition(isDeepStrictEqual(model, artifact.model), 'Embedded architecture model does not match ecs-data.json');
  requireCondition(isDeepStrictEqual(artifact.infrastructureFeatures, INFRASTRUCTURE_FEATURES), 'Embedded infrastructure catalog does not match the shared catalog');
  requireCondition(Array.isArray(model.systems) && Array.isArray(model.observers), 'Invalid architecture system or observer list');
  requireCondition(artifact.registry && typeof artifact.registry === 'object' && !Array.isArray(artifact.registry), 'Invalid architecture registry');
  requireCondition(Array.isArray(model.features) && model.features.length > 0, 'Invalid architecture feature list');
  const features = new Map();
  for (const feature of model.features) {
    requireCondition(typeof feature.id === 'string' && /^[a-z][a-z0-9_]*$/.test(feature.id)
      && !['overview', 'third_party'].includes(feature.id) && !infrastructureFeature(feature.id) && !features.has(feature.id), `Invalid or duplicate architecture feature: ${feature.id}`);
    requireCondition(typeof feature.plugin === 'string' && feature.plugin.length > 0, `Missing feature plugin: ${feature.id}`);
    requireCondition(![...features.values()].some(item => item.plugin === feature.plugin), `Duplicate architecture plugin: ${feature.plugin}`);
    features.set(feature.id, feature);
  }
  const featureIds = new Set([...features.keys(), ...INFRASTRUCTURE_FEATURES.map(feature => feature.id)]);
  const expectedViews = new Map([['overview', { feature: null, aspect: 'overview' }]]);
  for (const feature of featureIds) for (const aspect of artifact.schemaVersion === 3 ? ['systems'] : legacyAspects) {
    expectedViews.set(architectureViewId(feature, aspect), { feature, aspect });
  }
  const registry = artifact.registry;
  const dependencyResolver = createDependencySourceResolver(cargoMetadata ?? readCargoMetadata(repository));
  checkDependencySources(registry, dependencyResolver, dependencyDefinitions, requireDependencyDefinitions);
  let componentTypes = [];
  let objectCatalog;
  if ([2, 3].includes(artifact.schemaVersion)) {
    if (artifact.schemaVersion === 2) requireCondition(Array.isArray(artifact.componentTypes), 'Missing component type catalog');
    const fresh = buildArchitectureModel(model);
    if (requireDependencyDefinitions) {
      for (const [id, node] of Object.entries(fresh.registry)) if (registry[id]?.definition_source) node.definition_source = registry[id].definition_source;
    }
    const catalog = buildComponentCatalog(model, fresh.registry, { readSource: filename => fs.readFileSync(path.join(repository, filename), 'utf8'), mergeSystems: artifact.schemaVersion !== 3 });
    componentTypes = catalog.types;
    if (artifact.schemaVersion === 3) {
      for (const [id, node] of Object.entries(fresh.registry)) {
        node.sourceEntries = registry[id]?.sourceEntries;
        node.sourceGaps = registry[id]?.sourceGaps;
      }
      objectCatalog = buildObjectCatalog(model, fresh.registry, { components: catalog });
      requireCondition(isDeepStrictEqual(artifact.objects, objectCatalog.objects), 'Object catalog differs from original projections and registrations');
      requireCondition(isDeepStrictEqual(artifact.objectAliases, model.object_aliases || {}), 'Object alias catalog differs from maintained compatibility targets');
      checkObjectViews(artifact.views, objectCatalog);
      for (const object of objectCatalog.objects) expectedViews.set(object.viewId, { feature: object.feature, aspect: 'object', object });
      for (const feature of featureIds) {
        const expected = expectedViews.get(architectureViewId(feature, 'systems'));
        expected.graph = fresh.graphFor(feature, 'systems');
        expected.placement = buildObserverPlacement(expected.graph, registry, fresh.scheduleGroups(expected.graph));
      }
    } else {
      requireCondition(isDeepStrictEqual(artifact.componentTypes, componentTypes), 'Component catalog differs from Rust type identities and original projections');
      for (const type of componentTypes) expectedViews.set(type.viewId, { feature: type.feature, aspect: 'component', type, graph: catalog.graphFor(type.id) });
    }
    const roleLabels = Object.fromEntries(sourcePolicyFor('edge').groups.map(group => [group.role, group.label]));
    requireCondition(isDeepStrictEqual(artifact.sourceRoleLabels, roleLabels), 'Source role labels differ from the semantic source policy');
    for (const node of Object.values(registry)) {
      requireCondition(Array.isArray(node.sourceEntries) && Array.isArray(node.sourceGaps), `Missing semantic source policy: ${node.id}`);
      const filtered = sourceEntriesFor(node, { kind: sourcePolicyKindFor(node), reviewedEntries: node.sourceEntries });
      requireCondition(isDeepStrictEqual(filtered, node.sourceEntries), `Source entry outside the card policy: ${node.id}`);
      if (node.kind === 'Component') requireCondition(node.sourceEntries.length > 0 || node.sourceGaps.length > 0, `Component has no definition evidence or pending explanation: ${node.id}`);
    }
    if (artifact.schemaVersion === 3) {
      const coverage = auditProductionEcsCoverage(registry, { model, repository, registry, dependencyContext: { metadata: cargoMetadata, resolver: dependencyResolver } });
      requireCondition(!coverage.gaps.length, `Production ECS source coverage mismatch: ${coverage.gaps.join('; ')}`);
    }
  }
  requireCondition(Array.isArray(artifact.views) && artifact.views.length === expectedViews.size, `Expected ${expectedViews.size} architecture views`);
  const scheduleDefinitions = new Map();
  for (const group of model.schedule_groups || []) {
    requireCondition(typeof group.id === 'string' && group.id && !scheduleDefinitions.has(group.id) && Number.isFinite(group.order), `Invalid or duplicate Schedule definition: ${group.id}`);
    scheduleDefinitions.set(group.id, group);
  }
  for (const [id, node] of Object.entries(registry)) {
    requireCondition(node && node.id === id, `Registry node ID mismatch: ${id}`);
    const kind = nodeKindOf(node);
    if ([2, 3].includes(artifact.schemaVersion)) requireCondition(node.kind === kind, `Noncanonical node category: ${id}/${node.kind}`);
    requireCondition(NODE_KINDS[kind], `Unclassified architecture node: ${id}`);
    requireCondition(featureIds.has(node.feature), `Invalid node feature: ${id}`);
  }
  const aliases = model.node_aliases || {};
  requireCondition(typeof aliases === 'object' && !Array.isArray(aliases), 'Invalid architecture node alias map');
  const registrationIds = new Set([
    ...model.systems.map(system => system.id),
    ...(model.entities || []).flatMap(entity => [`entity-${entity.id}`, ...entity.components.map(component => component.id)]),
  ]);
  function resolveNode(id) {
    const seen = new Set();
    while (Object.hasOwn(aliases, id)) {
      requireCondition(!seen.has(id), `Cyclic architecture node alias: ${id}`);
      seen.add(id);
      const target = aliases[id];
      requireCondition(typeof target === 'string' && Object.hasOwn(registry, target), `Unknown node alias target: ${id}`);
      id = target;
    }
    return id;
  }
  const explanatoryNodes = new Map((model.nodes || []).map(node => [node.id, node]));
  for (const [id, node] of Object.entries(registry)) {
    if (node.alias_of === undefined || Object.hasOwn(aliases, id)) continue;
    // 既有解释入口记录数据投影来源，不属于本次合并可见方框的别名映射。
    requireCondition(explanatoryNodes.get(id)?.alias_of === node.alias_of && Object.hasOwn(registry, node.alias_of), `Node alias metadata mismatch: ${id}`);
  }
  for (const [id, target] of Object.entries(aliases)) {
    requireCondition(Object.hasOwn(registry, id) && registry[id].alias_of === target, `Node alias metadata mismatch: ${id}`);
    const canonical = resolveNode(id);
    requireCondition(registry[id].feature === registry[canonical].feature, `Node alias crosses feature boundaries: ${id}`);
    requireCondition(!registrationIds.has(id) && !registrationIds.has(canonical), `System or entity identity cannot be aliased: ${id}`);
  }
  requireCondition(model.node_features && typeof model.node_features === 'object' && !Array.isArray(model.node_features), 'Invalid architecture node feature map');
  for (const [id, feature] of Object.entries(model.node_features)) {
    requireCondition(Object.hasOwn(registry, id), `Unknown owned node: ${id}`);
    requireCondition(featureIds.has(feature) && registry[id].feature === feature, `Node feature mismatch: ${id}`);
  }
  for (const type of [...(model.resources || []), ...(model.entities || []).flatMap(entity => entity.components || [])]) {
    if (type.defined_in == null) continue;
    requireCondition(featureIds.has(type.defined_in) && registry[type.id]?.defined_in === type.defined_in, `Type definition ownership mismatch: ${type.id}`);
  }
  // 实体组合可投影到参与功能，但不改变其组件类型的定义归属。
  const projections = new Map();
  for (const entity of model.entities || []) {
    if (entity.features == null) continue;
    requireCondition(Array.isArray(entity.features) && entity.features.length > 0 && new Set(entity.features).size === entity.features.length
      && entity.features.every(feature => featureIds.has(feature)), `Invalid entity feature projection: ${entity.id}`);
    for (const id of [`entity-${entity.id}`, ...(entity.components || []).map(component => component.id)]) projections.set(id, new Set(entity.features));
  }
  const visibleIds = new Set();
  const internalIds = new Set();
  const seenViews = new Set();
  const filenames = new Set();
  const mermaidFilenames = new Set();
  const visualInstances = new Set();
  const visibleLinks = new Map();
  const entries = [], artifactViewIds = new Set();
  for (const view of artifact.views) {
    const expected = expectedViews.get(view.id);
    requireCondition(expected && !seenViews.has(view.id), `Invalid or duplicate architecture view: ${view.id}`);
    seenViews.add(view.id);
    requireCondition(view.feature === expected.feature && view.aspect === expected.aspect, `Architecture view metadata mismatch: ${view.id}`);
    if (artifact.schemaVersion === 3 && expected.aspect === 'systems') {
      const nodes = graph => graph.nodes.map(({ id, role }) => [id, role]).sort(([a], [b]) => a.localeCompare(b));
      const links = graph => graph.links.map(systemLinkKey).sort((a, b) => a.id.localeCompare(b.id));
      requireCondition(isDeepStrictEqual(nodes(view), nodes(expected.graph)), `Plugin system and Observer coverage mismatch: ${view.id}`);
      requireCondition(isDeepStrictEqual(links(view), links(expected.graph)), `Plugin scheduling relation coverage mismatch: ${view.id}`);
      requireCondition(isDeepStrictEqual(visualPlacementKey(view.scheduleGroups), visualPlacementKey(expected.placement.groups))
        && isDeepStrictEqual((view.observerBranches || []).map(observerBranchKey), expected.placement.branches.map(observerBranchKey)), `Plugin Observer source placement mismatch: ${view.id}`);
    }
    if (expected.type) {
      const type = expected.type;
      for (const key of ['componentNodeId', 'projectionIds', 'ownerEntityIds']) requireCondition(isDeepStrictEqual(view[key], type[key]), `Component view ${key} mismatch: ${view.id}`);
      requireCondition(isDeepStrictEqual(view.componentDetails, type.details), `Component view full type details mismatch: ${view.id}`);
      requireCondition(view.componentTypeId === type.id && view.nodes.filter(node => node.id === type.componentNodeId).length === 1, `Component view center mismatch: ${view.id}`);
      requireCondition(isDeepStrictEqual(view.nodes.map(node => [node.id, node.role]), expected.graph.nodes.map(node => [node.id, node.role])), `Component view Entity/System coverage mismatch: ${view.id}`);
      const coreLink = ({ id, from, to, kind, operation, label, projectionIds, registrationIds, originalLinkIds, sourceLinkIds }) => ({ id, from, to, kind, operation, label, projectionIds, registrationIds, originalLinkIds, sourceLinkIds });
      requireCondition(isDeepStrictEqual(view.links.map(coreLink), expected.graph.links.map(coreLink)), `Component view operation coverage mismatch: ${view.id}`);
      const functions = view.nodes.map(node => registry[node.id]).filter(node => ['System', 'Observer'].includes(nodeKindOf(node)));
      const identities = functions.map(node => JSON.stringify([node.definition_source?.dependency?.name || '', node.source?.path, node.source?.line, node.name]));
      requireCondition(new Set(identities).size === identities.length, `Duplicate system function in component view: ${view.id}`);
    }
    requireCondition(Array.isArray(view.nodes) && Array.isArray(view.links), `Invalid view graph: ${view.id}`);
    entries.push({ view });
    for (const child of checkEntityViewProjections(view)) entries.push({ view: child, parentView: view });
  }
  const originalLinkEvidence = artifact.views.filter(view => view.aspect === 'object').flatMap(view => view.links);
  for (const { view, parentView } of entries) {
    requireCondition(!artifactViewIds.has(view.id) && (!parentView || !expectedViews.has(view.id)), `Invalid or duplicate architecture view: ${view.id}`);
    artifactViewIds.add(view.id);
    requireCondition(view.engine === 'mermaid', `Architecture view must use Mermaid: ${view.id}`);
    requireCondition(Array.isArray(view.nodes) && Array.isArray(view.links), `Invalid view graph: ${view.id}`);
    requireCondition(!Object.hasOwn(view, 'legend') && !(view.sections || []).some(section => section.kind === 'legend'), `Legend metadata remains in business view: ${view.id}`);
    if (view.svg === null) {
      requireCondition(view.id !== 'overview' && view.filename === null && view.mermaid === null && view.mermaidFilename === null
        && view.nodes.length === 0 && view.links.length === 0 && view.layoutLinks?.length === 0 && view.scheduleGroups?.length === 0
        && !(view.scheduleLinks?.length), `Invalid empty architecture view: ${view.id}`);
      continue;
    }
    requireCondition(typeof view.svg === 'string' && view.nodes.length > 0, `Missing SVG in architecture view: ${view.id}`);
    requireCondition(!svgElements(view.svg).some(element => Object.keys(element.attrs).some(name => /^data-(?:legend(?:-.+)?|guide-.+)$/.test(name))
      || /(?:^|-)legend(?:_|$)/.test(element.attrs.id || '')), `Legend geometry remains in business SVG: ${view.id}`);
    requireCondition(view.filename === `ecs-${view.id}.svg` && !filenames.has(view.filename), `Invalid architecture SVG filename: ${view.id}`);
    requireCondition(Number.isFinite(view.width) && view.width > 0 && Number.isFinite(view.height) && view.height > 0, `Invalid view dimensions: ${view.id}`);
    filenames.add(view.filename);
    const svgPath = path.join(directory, view.filename);
    requireCondition(fs.existsSync(svgPath), `Missing architecture artifact: ${view.filename}`);
    requireCondition(fs.readFileSync(svgPath, 'utf8') === view.svg, `SVG artifact mismatch: ${view.id}`);
    requireCondition(view.mermaidFilename === `ecs-${view.id}.mmd` && typeof view.mermaid === 'string', `Invalid Mermaid source artifact: ${view.id}`);
    mermaidFilenames.add(view.mermaidFilename);
    const mermaidPath = path.join(directory, view.mermaidFilename);
    requireCondition(fs.existsSync(mermaidPath), `Missing architecture artifact: ${view.mermaidFilename}`);
    requireCondition(fs.readFileSync(mermaidPath, 'utf8') === view.mermaid, `Mermaid source artifact mismatch: ${view.id}`);
    const renderedNodes = elementAttributes(view.svg, 'data-id');
    const renderedInstances = new Map();
    for (const node of renderedNodes) {
      const instance = node['data-instance'];
      requireCondition(typeof instance === 'string' && instance && !renderedInstances.has(instance), `Invalid or duplicate visual instance in ${view.id}: ${instance}`);
      renderedInstances.set(instance, node);
    }
    requireCondition(renderedNodes.length === view.nodes.length, `View node manifest mismatch: ${view.id}`);
    const boxes = new Set([...attributeValues(view.svg, 'data-box-id'), ...attributeValues(view.svg, 'data-shape-part')]);
    const pageIds = new Set();
    for (const node of view.nodes) {
      const { id, instance, role } = node;
      requireCondition(Object.hasOwn(registry, id), `Unknown node reference in ${view.id}: ${id}`);
      requireCondition(resolveNode(id) === id, `Alias must render its canonical node in ${view.id}: ${id}`);
      requireCondition(!pageIds.has(id), `Duplicate canonical node in ${view.id}: ${id}`);
      requireCondition(typeof instance === 'string' && instance && !visualInstances.has(instance), `Invalid or duplicate visual instance: ${instance}`);
      visualInstances.add(instance);
      requireCondition(['internal', 'external', 'plugin'].includes(role), `Invalid visual node role: ${instance}`);
      const rendered = renderedInstances.get(instance);
      requireCondition(rendered && rendered['data-id'] === id && rendered['data-role'] === role && rendered['data-feature'] === registry[id].feature
        && boxes.has(instance), `Visual node metadata mismatch in ${view.id}: ${instance}`);
      requireCondition(role !== 'plugin' || view.id === 'overview', `Plugin node outside overview: ${instance}`);
      requireCondition(role !== 'internal' || view.id === 'overview' && view.layout === 'app-schedule' || registry[id].feature === view.feature || projections.get(id)?.has(view.feature), `Foreign internal node in ${view.id}: ${id}`);
      if (role === 'internal') internalIds.add(id);
      pageIds.add(id);
      visibleIds.add(id);
    }
    for (const connection of attributeValues(view.svg, 'data-connect')) {
      // 未声明数据端点的概览顺序箭头使用空值；非空端点没有特殊豁免。
      if (!connection) continue;
      for (const id of connection.split('|')) {
        requireCondition(Object.hasOwn(registry, id), `Unknown connection reference in ${view.id}: ${id}`);
      }
    }
    const renderedLinks = elementAttributes(view.svg, 'data-link-id');
    const renderedLinkIds = new Map();
    for (const link of renderedLinks) {
      requireCondition(!renderedLinkIds.has(link['data-link-id']), `Duplicate visual link in ${view.id}: ${link['data-link-id']}`);
      renderedLinkIds.set(link['data-link-id'], link);
    }
    requireCondition(renderedLinks.length === view.links.length, `View link manifest mismatch: ${view.id}`);
    const pageLinks = new Set();
    for (const link of view.links) {
      requireCondition(typeof link.id === 'string' && link.id && !pageLinks.has(link.id), `Invalid or duplicate view link in ${view.id}: ${link.id}`);
      pageLinks.add(link.id);
      requireCondition(linkKinds.has(link.kind), `Invalid architecture link kind: ${link.id}`);
      requireCondition(view.aspect === 'object' || !isMainPluginRegistration(link, registry), `Redundant main plugin registration remains in ${view.id}: ${link.id}`);
      const endpoints = displayEndpoints(link);
      requireCondition(Object.hasOwn(registry, link.from) && Object.hasOwn(registry, link.to) && endpoints.every(id => pageIds.has(id)), `Link endpoint is missing from ${view.id}: ${link.id}`);
      const rendered = renderedLinkIds.get(link.id);
      requireCondition(rendered && rendered['data-connect'] === endpoints.join('|')
        && (!(parentView || Object.hasOwn(rendered, 'data-canonical-connect')) || rendered['data-canonical-connect'] === `${link.from}|${link.to}`)
        && (rendered.class || '').split(/\s+/).includes(link.kind), `Visual link metadata mismatch in ${view.id}: ${link.id}`);
      if (!visibleLinks.has(link.id)) visibleLinks.set(link.id, []);
      visibleLinks.get(link.id).push(link);
    }
    if (artifact.schemaVersion === 3) checkObserverTriggerProjections(view, model, registry, originalLinkEvidence);
    if (styledView(view)) {
      requireCondition(Array.isArray(view.scheduleLinks), `Missing Schedule link manifest: ${view.id}`);
      const expectedScheduleLinks = (view.layout === 'app-schedule' ? buildAppSchedule(model, registry).phaseLinks : scheduleLinksFor(view.scheduleGroups)).map(({ id, from, to, edgeSemantic, displayLabel }) => ({ id, from, to, edgeSemantic, displayLabel }));
      const actualScheduleLinks = view.scheduleLinks.map(({ id, from, to, edgeSemantic, displayLabel }) => ({ id, from, to, edgeSemantic, displayLabel }));
      requireCondition(isDeepStrictEqual(actualScheduleLinks, expectedScheduleLinks), `Schedule relation manifest mismatch: ${view.id}`);
    }
    checkMermaidSource(view, registry, scheduleDefinitions);
    try { checkMermaidGeometry(view.svg, view); } catch (error) { throw new Error(`Invalid Mermaid geometry in ${view.id}: ${error.message}`); }
    if (view.aspect === 'component') {
      const center = view.nodes.find(node => node.id === view.componentNodeId).position;
      for (const node of view.nodes.filter(node => node.id !== view.componentNodeId)) {
        const owner = view.ownerEntityIds.includes(node.id);
        requireCondition(owner ? node.position.x + node.position.width <= center.x + .05 : node.position.x >= center.x + center.width - .05, `Component view column mismatch: ${view.id}/${node.id}`);
      }
    }
    checkMermaidStyles(view, registry);
    checkDataSections(view);
    if (styledView(view) || view.entityGroups) checkEntityGroups(view, model, registry, parentView);
    if (Object.hasOwn(view, 'entityGroups')) requireCondition(view.routing?.rule === 'axis-or-curve', `Missing shared routing rule: ${view.id}`);
    if (view.routing) checkViewRouting(view);
  }
  if (artifact.views.some(styledView) || artifact.guideSamples !== undefined) checkGuideSamples(artifact.guideSamples, artifact.styles);
  const actualFilenames = fs.readdirSync(directory).filter(filename => /^ecs-.*\.svg$/.test(filename)).sort();
  requireCondition(isDeepStrictEqual(actualFilenames, [...filenames].sort()), 'Architecture SVG file set does not match view manifest');
  const actualMermaidFilenames = fs.readdirSync(directory).filter(filename => /^ecs-.*\.mmd$/.test(filename)).sort();
  requireCondition(isDeepStrictEqual(actualMermaidFilenames, [...mermaidFilenames].sort()), 'Architecture Mermaid file set does not match view manifest');
  const overview = artifact.views.find(view => view.id === 'overview');
  if ([2, 3].includes(artifact.schemaVersion)) checkAppSchedule(overview, model, registry);
  for (const feature of INFRASTRUCTURE_FEATURES) {
    requireCondition(registry[feature.overviewNode]?.feature === feature.id && ['Plugin', 'PluginGroup'].includes(registry[feature.overviewNode]?.kind)
      && (overview.layout === 'app-schedule' || overview.nodes.some(node => node.id === feature.overviewNode && node.role === 'plugin')), `Infrastructure entrance is missing from overview: ${feature.id}`);
  }
  for (const feature of features.values()) {
    const id = `plugin-${feature.plugin}`;
    requireCondition(registry[id]?.feature === feature.id && (overview.layout === 'app-schedule' || overview.nodes.some(node => node.id === id && node.role === 'plugin')), `Plugin is missing from overview: ${feature.plugin}`);
    const pluginIdentities = new Set(Object.values(registry).filter(node => String(node.kind).toLowerCase() === 'plugin' && node.name === feature.plugin && node.feature === feature.id).map(node => resolveNode(node.id)));
    requireCondition(pluginIdentities.size === 1 && pluginIdentities.has(id), `Duplicate semantic project plugin: ${feature.plugin}`);
  }
  if (model.required_nodes != null) {
    requireCondition(Array.isArray(model.required_nodes) && model.required_nodes.length > 0, 'Invalid required architecture node list');
    for (const id of model.required_nodes) {
      requireCondition(Object.hasOwn(registry, id), `Missing required architecture node: ${id}`);
      requireCondition(visibleIds.has(resolveNode(id)) || artifact.schemaVersion === 2 && componentTypes.some(type => type.projectionIds.includes(resolveNode(id))), `Required architecture node is missing from views: ${id}`);
    }
  }
  const systems = new Map();
  for (const system of model.systems) {
    requireCondition(typeof system.id === 'string' && system.id && !systems.has(system.id), `Invalid or duplicate system ID: ${system.id}`);
    systems.set(system.id, system);
    requireCondition(visibleIds.has(system.id), `System is missing from views: ${system.id}`);
    const feature = system.feature || (features.has(system.module) ? system.module : 'infrastructure');
    requireCondition(featureIds.has(feature) && registry[system.id]?.feature === feature, `System feature mismatch: ${system.id}`);
    requireCondition(internalIds.has(system.id), `System has no internal view: ${system.id}`);
  }
  const requiredData = [
    ...(model.resources || []).map(resource => resource.id),
    ...(model.entities || []).flatMap(entity => [`entity-${entity.id}`, ...(entity.components || []).map(component => component.id)]),
  ];
  for (const id of requiredData) {
    requireCondition(Object.hasOwn(registry, id), `Data node is missing from registry: ${id}`);
    requireCondition(internalIds.has(resolveNode(id)) || artifact.schemaVersion === 2 && componentTypes.some(type => type.projectionIds.includes(id)), `Data node has no internal view or component type projection: ${id}`);
  }
  function requireLink(expected, label) {
    const links = visibleLinks.get(expected.id) || [];
    requireCondition(links.length > 0, `${label} is missing from views: ${expected.id}`);
    requireCondition(links.every(link => link.from === resolveNode(expected.from) && link.to === resolveNode(expected.to) && link.kind === expected.kind), `${label} metadata mismatch: ${expected.id}`);
  }
  const systemLinkIds = new Set();
  for (const link of model.system_links || []) {
    requireCondition(typeof link.id === 'string' && link.id && !systemLinkIds.has(link.id) && linkKinds.has(link.kind), `Invalid or duplicate system link: ${link.id}`);
    systemLinkIds.add(link.id);
    requireCondition(Object.hasOwn(registry, link.from) && Object.hasOwn(registry, link.to), `Unknown system link endpoint: ${link.id}`);
    if (artifact.schemaVersion === 3) {
      const refined = objectCatalog.links.find(candidate => candidate.id === link.id);
      requireCondition(refined && refined.from === resolveNode(link.from) && refined.to === resolveNode(link.to), `Original system link identity was lost: ${link.id}`);
      requireLink(refined, 'System link');
    } else if (!isMainPluginRegistration({ ...link, from: resolveNode(link.from), to: resolveNode(link.to) }, registry)) requireLink(link, 'System link');
  }
  for (const relation of model.relationships || []) {
    requireLink({ ...relation, from: `entity-${relation.from}`, to: `entity-${relation.to}` }, 'Entity relationship');
  }
  for (const observer of model.observers) {
    const system = systems.get(observer.system);
    requireCondition(system && nodeKindOf(system) === 'Observer' && registry[observer.system] && nodeKindOf(registry[observer.system]) === 'Observer', `Invalid observer system: ${observer.system}`);
    // 清单现有 events 使用“响应 EntityEvent：”前缀；移除该前缀后精确匹配。
    const matchesEvent = item => typeof observer.event === 'string' && Array.isArray(item.events)
      && item.events.some(event => typeof event === 'string' && event.replace(/^响应 EntityEvent[：:]\s*/, '') === observer.event);
    requireCondition(matchesEvent(system) && matchesEvent(registry[observer.system]), `Observer event mismatch: ${observer.system}`);
    const trigger = visibleLinks.get(`observer-${observer.system}`) || [];
    requireCondition(trigger.some(link => link.kind === 'trigger' && link.to === observer.system && registry[link.from]?.name === observer.event), `Observer trigger is missing from views: ${observer.system}`);
  }

  const files = new Map();
  function readSource(sourcePath) {
    requireCondition(typeof sourcePath === 'string' && sourcePath && !sourcePath.includes('\0')
      && !path.isAbsolute(sourcePath) && !path.win32.isAbsolute(sourcePath), `Unsafe source path: ${sourcePath}`);
    const absolute = path.resolve(repository, sourcePath);
    const isInside = candidate => {
      const relative = path.relative(repository, candidate);
      return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    requireCondition(isInside(absolute), `Unsafe source path: ${sourcePath}`);
    if (files.has(sourcePath)) return files.get(sourcePath);
    requireCondition(fs.existsSync(absolute), `Missing source file: ${sourcePath}`);
    requireCondition(isInside(fs.realpathSync(absolute)) && fs.statSync(absolute).isFile(), `Unsafe source file: ${sourcePath}`);
    const text = fs.readFileSync(absolute, 'utf8');
    const source = { text, lines: text.replace(/\r\n?/g, '\n').split('\n') };
    files.set(sourcePath, source);
    return source;
  }
  const referencedPaths = new Set();
  function readReference(source) {
    const key = source.dependency ? dependencySourceKey(source) : source.path;
    const file = source.dependency ? dependencyResolver.read(source) : readSource(source.path);
    referencedPaths.add(key);
    requireCondition(Number.isSafeInteger(source.line) && source.line >= 1 && source.line <= file.lines.length,
      `Invalid source line: ${key}:${source.line}`);
    return file;
  }
  function visitSources(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.path === 'string' && Number.isSafeInteger(value.line)) { readReference(value); return; }
    if (value.source != null) readReference(value.source);
    if (['System', 'Observer', 'system', 'observer'].includes(value.kind) && !value.alias_of) {
      const dependencyDefinition = registry[value.id]?.definition_source;
      if (value.definition_source?.dependency) {
        requireCondition(isDeepStrictEqual(value.definition_source, dependencyDefinition), `Unverified dependency function definition: ${value.name}`);
      }
      // 依赖定义已由 checkDependencySources 校验包、版本和唯一声明；原 source 仍只保留使用语义。
      const source = dependencyDefinition?.dependency ? dependencyDefinition : value.source;
      requireCondition(source, `Missing function source: ${value.name}`);
      const file = readReference(source);
      // 只核对真实定义行的函数名，不能据此推断函数行为或注册完整性。
      const declaration = file.lines[source.line - 1].match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|const|unsafe)\s+)*fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|<)/);
      const reviewedDefinition = dependencyDefinition?.dependency && dependencyDefinitions[value.id]?.kind === 'fn' ? dependencyDefinitions[value.id] : null;
      const symbol = reviewedDefinition?.symbol || value.name;
      // 同函数的泛型注册保留完整显示名，定义行仍按已审核依赖映射中的真实标识符验证。
      const displayMatches = value.name === symbol || reviewedDefinition && value.name.startsWith(`${symbol}<`) && value.name.endsWith('>');
      requireCondition(declaration?.[1] === symbol && displayMatches, `Function source mismatch: ${value.name} at ${source.path}:${source.line}`);
    }
    if (value.definition_source != null) readReference(value.definition_source);
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'source' && key !== 'definition_source') visitSources(child);
    }
  }
  visitSources(model);
  visitSources(registry);
  visitSources(artifact.views);

  const snapshots = embeddedJson(fs.readFileSync(path.join(directory, 'ecs-source.html'), 'utf8'), 'sources');
  requireCondition(Array.isArray(snapshots), 'Invalid source snapshot list');
  const snapshotPaths = new Set();
  for (const snapshot of snapshots) {
    requireCondition(!snapshotPaths.has(snapshot.path), `Duplicate source snapshot: ${snapshot.path}`);
    snapshotPaths.add(snapshot.path);
    let source;
    if (snapshot.source != null) {
      requireCondition(snapshot.source.dependency && snapshot.source.line === 1 && dependencySourceKey(snapshot.source) === snapshot.path,
        `Dependency snapshot source mismatch: ${snapshot.path}`);
      source = dependencyResolver.read(snapshot.source);
    } else source = readSource(snapshot.path);
    // Git 提交快照与 Windows 工作区可能分别使用 LF、CRLF；仅统一换行，不忽略其他内容差异。
    requireCondition(typeof snapshot.text === 'string'
      && snapshot.text.replace(/\r\n/g, '\n') === source.text.replace(/\r\n/g, '\n'),
      `Source snapshot mismatch: ${snapshot.path}`);
  }
  for (const sourcePath of referencedPaths) {
    requireCondition(snapshotPaths.has(sourcePath), `Missing source snapshot: ${sourcePath}`);
  }
  return { systems: systems.size, sources: snapshotPaths.size, views: artifactViewIds.size, ...(objectCatalog ? { objects: objectCatalog.objects.length } : {}) };
}

const filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  try {
    console.log(JSON.stringify(checkArchitecture(path.resolve(path.dirname(filename), '../..'))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

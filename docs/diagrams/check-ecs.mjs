// 只读核对已维护的架构清单与交付产物；不分析 Rust 调度语义，也不运行游戏。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { checkMermaidGeometry } from './diagram-geometry.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, EXTERNAL_REFERENCE_STYLE, ENTITY_TOGGLE_STYLE, visualTypeOf, edgeSemanticOf, displayLabelOf, scheduleLinksFor } from './architecture-style.mjs';
import { shapeBounds, svgElements } from './svg-shape-geometry.mjs';
import { isMainPluginRegistration, scheduleGroupLabel } from './architecture-model.mjs';
import { DATA_GROUP_LABELS, entityComponentColumns } from './architecture-renderer.mjs';
import { displayEndpoints, inspectViewRoutes, ROUTING_STYLE } from './architecture-routing.mjs';
import { INFRASTRUCTURE_FEATURES, infrastructureFeature, architectureViewId } from './architecture-infrastructure.mjs';
import { DEPENDENCY_SOURCE_DEFINITIONS } from './architecture-source-definitions.mjs';
import { readCargoMetadata, createDependencySourceResolver, dependencySourceKey, checkDependencySources } from './dependency-sources.mjs';

const aspects = ['systems', 'data', 'events'];
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
  const markerId = element.attrs['marker-end']?.match(/^url\([^#]*#([^)]*)\)$/)?.[1];
  const marker = elements.find(item => item.tag === 'marker' && item.attrs.id === markerId);
  requireCondition(marker && ['auto', 'auto-start-reverse'].includes(marker.attrs.orient), `Missing Mermaid target arrow: ${id}`);
  requireCondition(descendantsOf(elements, marker).some(item => ['path', 'polygon'].includes(item.tag)
    && effectiveStyle(item).fill?.toLowerCase() === expected.stroke.toLowerCase()), `Mermaid arrow color mismatch: ${id}`);
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
  requireCondition(isDeepStrictEqual(styles, { nodes: NODE_STYLES, edges: EDGE_STYLES, selection: SELECTION_STYLE, externalReference: EXTERNAL_REFERENCE_STYLE, entityToggle: ENTITY_TOGGLE_STYLE }), 'Read guide styles do not match the shared catalog');
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

/** 折叠只投影画面端点；规范节点、关系及每个实体的组件清单始终来自完整视图。 */
export function checkEntityViewProjections(view) {
  const groups = view.entityGroups || [];
  requireCondition((view.links || []).every(link => isDeepStrictEqual(displayEndpoints(link), [link.from, link.to])), `Complete view endpoint projection mismatch: ${view.id}`);
  if (!groups.length) {
    requireCondition(!Object.hasOwn(view, 'entityViews'), `Unexpected Entity view variants: ${view.id}`);
    return [];
  }
  requireCondition(view.aspect === 'data' && view.entityExpansion === 'all' && !view.parentViewId
    && groups.every(group => group.expanded === true), `Invalid complete Entity view: ${view.id}`);
  const variants = view.entityViews;
  requireCondition(variants && typeof variants === 'object' && !Array.isArray(variants)
    && isDeepStrictEqual(Object.keys(variants).sort(), ['collapsed', ...groups.map(group => group.entity)].sort()), `Entity view variant catalog mismatch: ${view.id}`);
  const memberships = value => value.map(({ id, entity, components }) => ({ id, entity, components }));
  const semanticLink = ({ mermaidId, displayFrom, displayTo, ...link }) => link;
  const nodeIdentity = node => Object.fromEntries(['id', 'role', 'group', 'visualType', 'shape', 'displayLabel', 'nameLabel', 'contextLabel'].filter(key => Object.hasOwn(node, key)).map(key => [key, node[key]]));
  const ids = new Set([view.id]);
  const checkToggles = candidate => {
    for (const group of candidate.entityGroups) {
      const node = candidate.nodes.find(node => node.id === group.entity), label = `${group.expanded ? '收起' : '展开'}组件（${group.components.length}）`;
      requireCondition(isDeepStrictEqual(node?.entityToggle, { entity: group.entity, expanded: group.expanded, count: group.components.length, label }), `Entity view toggle mismatch: ${candidate.id}/${group.entity}`);
    }
  };
  checkToggles(view);
  for (const [key, child] of Object.entries(variants)) {
    requireCondition(child && typeof child === 'object' && !Array.isArray(child) && typeof child.id === 'string' && /^[A-Za-z0-9_-]+$/.test(child.id)
      && !ids.has(child.id) && child.parentViewId === view.id && child.entityExpansion === key && child.feature === view.feature && child.aspect === view.aspect
      && !Object.hasOwn(child, 'entityViews'), `Entity view variant identity mismatch: ${view.id}/${key}`);
    ids.add(child.id);
    requireCondition(Array.isArray(child.entityGroups) && isDeepStrictEqual(memberships(child.entityGroups), memberships(groups))
      && child.entityGroups.every(group => group.expanded === (key === group.entity)), `Entity view variant membership mismatch: ${child.id}`);
    const closed = groups.filter(group => key !== group.entity), hidden = new Set(closed.flatMap(group => group.components));
    const expectedNodes = view.nodes.filter(node => !hidden.has(node.id));
    requireCondition(Array.isArray(child.nodes) && isDeepStrictEqual(child.nodes.map(nodeIdentity), expectedNodes.map(nodeIdentity)), `Entity view visible node projection mismatch: ${child.id}`);
    for (const group of child.entityGroups) {
      const entity = child.nodes.find(node => node.id === group.entity);
      requireCondition(entity?.presentation === (group.expanded ? 'entity-container' : 'entity-collapsed') && entity.shape === 'rect', `Entity view presentation mismatch: ${child.id}/${group.entity}`);
    }
    checkToggles(child);
    requireCondition(Array.isArray(child.links) && isDeepStrictEqual(child.links.map(semanticLink), view.links.map(semanticLink)), `Entity view canonical relation mismatch: ${child.id}`);
    const project = id => closed.find(group => group.components.includes(id))?.entity || id;
    for (const link of child.links) requireCondition(link.displayFrom === project(link.from) && link.displayTo === project(link.to), `Entity view endpoint projection mismatch: ${child.id}/${link.id}`);
  }
  return Object.values(variants);
}

export function checkEntityGroups(view, model, registry, parentView) {
  const groups = view.entityGroups || [], visible = new Set(view.nodes.map(node => node.id));
  const expected = parentView ? parentView.entityGroups.map(({ id, entity, components }) => ({ id, entity, components })) : view.aspect === 'data' ? (model.entities || []).flatMap(entity => {
    const entityId = `entity-${entity.id}`, components = entity.components.map(component => component.id);
    return components.length && (visible.has(entityId) || components.some(id => visible.has(id))) ? [{ id: `entity-group-${entity.id}`, entity: entityId, components }] : [];
  }) : [];
  requireCondition(Array.isArray(groups) && isDeepStrictEqual(groups.map(({ id, entity, components }) => ({ id, entity, components })), expected), `Entity group membership mismatch: ${view.id}`);
  const elements = svgElements(view.svg), containers = elements.filter(element => Object.hasOwn(element.attrs, 'data-entity-group'));
  requireCondition(containers.length === groups.length, `Entity group container count mismatch: ${view.id}`);
  for (const group of groups) {
    const cluster = containers.find(element => element.attrs['data-entity-group'] === group.id);
    const entity = view.nodes.find(node => node.id === group.entity);
    if (entity?.entityToggle) {
      const labels = elements.filter(element => element.attrs['data-entity-toggle-label'] === group.entity);
      requireCondition(labels.length === 0, `Obsolete Entity group toggle label: ${view.id}/${group.id}`);
    }
    if (group.expanded === false) {
      const semantic = elements.find(element => element.attrs['data-id'] === group.entity);
      const rect = semantic?.children.find(element => element.tag === 'rect' && element.attrs['data-shape-part'] === entity?.instance);
      requireCondition(cluster === semantic && (semantic.attrs.class || '').split(/\s+/).includes('node') && semantic.attrs['data-presentation'] === 'entity-collapsed'
        && entity?.presentation === 'entity-collapsed' && entity.shape === 'rect' && registry[group.entity]?.kind === 'Entity'
        && semantic.attrs.role === 'button' && semantic.attrs.tabindex === '0' && !Object.hasOwn(semantic.attrs, 'filter')
        && rect && !Object.hasOwn(group, 'headerMermaidId') && !Object.hasOwn(group, 'headerBounds')
        && group.components.every(id => !visible.has(id)) && !elements.some(element => element.attrs['data-entity-header'] === entity.instance), `Invalid collapsed Entity group: ${view.id}/${group.id}`);
      const box = shapeBounds(rect), sections = (view.sections || []).filter(section => section.entityGroup === group.id);
      requireCondition(!Object.hasOwn(rect.attrs, 'filter') && sections.length === 1 && sections[0].label === registry[group.entity].name
        && Object.keys(box).every(key => Number.isFinite(group.bounds?.[key]) && Math.abs(group.bounds[key] - box[key]) < .05
          && Number.isFinite(sections[0][key]) && Math.abs(sections[0][key] - box[key]) < .05), `Collapsed Entity bounds mismatch: ${view.id}/${group.id}`);
      continue;
    }
    requireCondition(cluster && (cluster.attrs.class || '').split(/\s+/).includes('cluster')
      && cluster.attrs.id === `${view.id}-${group.mermaidId}`
      && entity?.presentation === 'entity-container' && entity.mermaidId === group.mermaidId
      && cluster.attrs['data-id'] === group.entity && cluster.attrs['data-instance'] === entity.instance
      && cluster.attrs['data-presentation'] === 'entity-container' && cluster.attrs.role === 'button' && cluster.attrs.tabindex === '0'
      && !['data-shape-part', 'filter'].some(name => Object.hasOwn(cluster.attrs, name)), `Invalid Entity group container: ${view.id}/${group.id}`);
    const rect = cluster.children.find(element => element.tag === 'rect');
    requireCondition(rect && rect.attrs['data-shape-part'] === entity.instance && !['data-id', 'filter'].some(name => Object.hasOwn(rect.attrs, name)), `Invalid Entity group outline: ${group.id}`);
    const box = shapeBounds(rect), sections = (view.sections || []).filter(section => section.entityGroup === group.id);
    requireCondition(sections.length === 1 && sections[0].label === registry[group.entity]?.name
      && Object.keys(box).every(key => Number.isFinite(group.bounds?.[key]) && Math.abs(group.bounds[key] - box[key]) < .05
        && Number.isFinite(sections[0][key]) && Math.abs(sections[0][key] - box[key]) < .05), `Entity group bounds mismatch: ${view.id}/${group.id}`);
    const members = [group.entity, ...group.components];
    // Mermaid 的 cluster 与 node 可以是 SVG 兄弟，按真实根坐标核对包含关系。
    const contained = view.nodes.filter(({ position }) => position && position.x >= box.x - .05 && position.y >= box.y - .05
      && position.x + position.width <= box.x + box.width + .05 && position.y + position.height <= box.y + box.height + .05);
    requireCondition(isDeepStrictEqual(contained.map(node => node.id).sort(), [...members].sort()), `Entity group SVG membership mismatch: ${view.id}/${group.id}`);
    requireCondition(entity && registry[group.entity]?.kind === 'Entity', `Missing Entity group identity: ${group.id}`);
    const header = elements.find(element => element.attrs['data-entity-header'] === entity.instance);
    requireCondition(header && !['data-id', 'tabindex'].some(name => Object.hasOwn(header.attrs, name)) && header.attrs['data-entity-owner'] === entity.id
      && group.headerBounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(group.headerBounds[key]))
      && group.headerBounds.width > 0 && group.headerBounds.height > 0
      && isDeepStrictEqual(JSON.parse(header.attrs['data-label-bounds'] || 'null'), group.headerBounds)
      && group.headerBounds.x >= box.x - .05 && group.headerBounds.y >= box.y - .05
      && group.headerBounds.x + group.headerBounds.width <= box.x + box.width + .05, `Entity group header bounds mismatch: ${group.id}`);
    for (const id of members) {
      const node = view.nodes.find(node => node.id === id), position = node?.position;
      requireCondition(position && position.x >= box.x - .05 && position.y >= box.y - .05
        && position.x + position.width <= box.x + box.width + .05 && position.y + position.height <= box.y + box.height + .05, `Entity group does not contain member: ${view.id}/${id}`);
      if (id !== group.entity) requireCondition(position.y >= group.headerBounds.y + group.headerBounds.height - .05, `Entity card header must precede its components: ${view.id}/${id}`);
    }
    const columns = entityComponentColumns(group.components).map(column => column.map(id => view.nodes.find(node => node.id === id).position));
    for (const column of columns) for (let index = 1; index < column.length; index++) requireCondition(column[index].y >= column[index - 1].y + column[index - 1].height - .05, `Entity component row order mismatch: ${view.id}/${group.id}`);
    const lefts = columns.map(column => Math.min(...column.map(position => position.x)));
    requireCondition(lefts.every((left, index) => !index || left > lefts[index - 1] + .05), `Entity component column order mismatch: ${view.id}/${group.id}`);
  }
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

function checkMermaidSource(view, registry, scheduleDefinitions) {
  requireCondition(view.diagramType === 'flowchart' && /^\s*flowchart\s+(LR|TB)\s*$/m.test(view.mermaid), `Expected Mermaid flowchart LR or TB: ${view.id}`);
  if (view.routing) {
    const configuration = /^---\r?\n([\s\S]*?)\r?\n---/.exec(view.mermaid);
    requireCondition(configuration && JSON.parse(configuration[1]).config?.layout === 'dagre', `Expected shared Dagre layout: ${view.id}`);
  }
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
    const invisible = /^([A-Za-z]\w*)\s+(layout_\w+)@(~~~|-->)\s+([A-Za-z]\w*)\s*;?$/.exec(line);
    if (invisible) {
      requireCondition(!layout.has(invisible[2]), `Duplicate Mermaid layout edge: ${invisible[2]}`);
      layout.set(invisible[2], { from: invisible[1], to: invisible[4], directed: invisible[3] === '-->' });
      continue;
    }
    const link = /^([A-Za-z]\w*)\s+([A-Za-z]\w*)@(-{2,}>|-\.->)\s*(?:\|"((?:[^"\\]|\\.)*)"\|\s*)?([A-Za-z]\w*)\s*;?$/.exec(line);
    if (link) {
      requireCondition(!links.has(link[2]), `Duplicate Mermaid edge declaration: ${link[2]}`);
      links.set(link[2], { from: link[1], to: link[5], label: decodeMermaidText(link[4] || '') });
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
  requireCondition(nodes.size === view.nodes.length + entityHeaders.size, `Mermaid node declaration count mismatch: ${view.id}`);
  for (const [id] of entityHeaders) requireCondition(nodes.get(id)?.shape === 'text', `Invalid Entity header declaration: ${view.id}/${id}`);
  const ids = new Set();
  for (const link of view.links) {
    const declaration = links.get(link.mermaidId);
    const [from, to] = displayEndpoints(link);
    requireCondition(declaration && !ids.has(link.mermaidId) && declaration.from === canonicalToMermaid.get(from)
      && declaration.to === canonicalToMermaid.get(to), `Mermaid edge declaration mismatch: ${link.id}`);
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
  const grouped = new Set(), groupIds = new Set();
  let previousOrder = -Infinity;
  for (const group of view.scheduleGroups) {
    const definition = scheduleDefinitions.get(group.id), declaration = groups.get(group.mermaidId);
    requireCondition(view.aspect === 'systems' && definition && Array.isArray(group.nodes) && group.label === scheduleGroupLabel({ ...definition, nodes: group.nodes }, registry) && group.order === definition.order
      && group.order > previousOrder && !groupIds.has(group.id), `Invalid or unordered Schedule group in ${view.id}: ${group.id}`);
    requireCondition(declaration?.direction === 'TB' && Array.isArray(group.nodes) && group.nodes.length > 0
      && isDeepStrictEqual(declaration.nodes, group.nodes.map(id => canonicalToMermaid.get(id))), `Mermaid Schedule declaration mismatch: ${group.id}`);
    if (styledView(view)) requireCondition(group.track === definition.track && group.parent === definition.parent && normalizedText(declaration.label) === normalizedText(group.label), `Mermaid Schedule contract mismatch: ${group.id}`);
    previousOrder = group.order;
    groupIds.add(group.id);
    for (const id of group.nodes) {
      requireCondition(canonicalToMermaid.has(id) && !grouped.has(id) && (registry[id].schedule_group || 'Explanatory') === group.id, `Invalid Schedule node membership: ${id}`);
      grouped.add(id);
    }
  }
  if (view.aspect === 'systems') requireCondition(grouped.size === view.nodes.length, `Schedule groups do not cover all nodes: ${view.id}`);
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
  else if (/^\s*flowchart\s+TB\s*$/m.test(view.mermaid)) requireCondition(groups.get('diagram_main')?.direction === 'LR', `Invalid Mermaid main direction: ${view.id}`);
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
  for (const feature of featureIds) for (const aspect of aspects) {
    expectedViews.set(architectureViewId(feature, aspect), { feature, aspect });
  }
  requireCondition(Array.isArray(artifact.views) && artifact.views.length === expectedViews.size, `Expected ${expectedViews.size} architecture views`);
  const registry = artifact.registry;
  const dependencyResolver = createDependencySourceResolver(cargoMetadata ?? readCargoMetadata(repository));
  checkDependencySources(registry, dependencyResolver, dependencyDefinitions, requireDependencyDefinitions);
  const scheduleDefinitions = new Map();
  for (const group of model.schedule_groups || []) {
    requireCondition(typeof group.id === 'string' && group.id && !scheduleDefinitions.has(group.id) && Number.isFinite(group.order), `Invalid or duplicate Schedule definition: ${group.id}`);
    scheduleDefinitions.set(group.id, group);
  }
  for (const [id, node] of Object.entries(registry)) {
    requireCondition(node && node.id === id, `Registry node ID mismatch: ${id}`);
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
    requireCondition(Array.isArray(view.nodes) && Array.isArray(view.links), `Invalid view graph: ${view.id}`);
    entries.push({ view });
    for (const child of checkEntityViewProjections(view)) entries.push({ view: child, parentView: view });
  }
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
      requireCondition(role !== 'internal' || registry[id].feature === view.feature || projections.get(id)?.has(view.feature), `Foreign internal node in ${view.id}: ${id}`);
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
      requireCondition(!isMainPluginRegistration(link, registry), `Redundant main plugin registration remains in ${view.id}: ${link.id}`);
      const endpoints = displayEndpoints(link);
      requireCondition(Object.hasOwn(registry, link.from) && Object.hasOwn(registry, link.to) && endpoints.every(id => pageIds.has(id)), `Link endpoint is missing from ${view.id}: ${link.id}`);
      const rendered = renderedLinkIds.get(link.id);
      requireCondition(rendered && rendered['data-connect'] === endpoints.join('|')
        && (!(parentView || Object.hasOwn(rendered, 'data-canonical-connect')) || rendered['data-canonical-connect'] === `${link.from}|${link.to}`)
        && (rendered.class || '').split(/\s+/).includes(link.kind), `Visual link metadata mismatch in ${view.id}: ${link.id}`);
      if (!visibleLinks.has(link.id)) visibleLinks.set(link.id, []);
      visibleLinks.get(link.id).push(link);
    }
    if (styledView(view)) {
      requireCondition(Array.isArray(view.scheduleLinks), `Missing Schedule link manifest: ${view.id}`);
      const expectedScheduleLinks = scheduleLinksFor(view.scheduleGroups).map(({ id, from, to, edgeSemantic, displayLabel }) => ({ id, from, to, edgeSemantic, displayLabel }));
      const actualScheduleLinks = view.scheduleLinks.map(({ id, from, to, edgeSemantic, displayLabel }) => ({ id, from, to, edgeSemantic, displayLabel }));
      requireCondition(isDeepStrictEqual(actualScheduleLinks, expectedScheduleLinks), `Schedule relation manifest mismatch: ${view.id}`);
    }
    checkMermaidSource(view, registry, scheduleDefinitions);
    try { checkMermaidGeometry(view.svg, view); } catch (error) { throw new Error(`Invalid Mermaid geometry in ${view.id}: ${error.message}`); }
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
  for (const feature of INFRASTRUCTURE_FEATURES) {
    requireCondition(registry[feature.overviewNode]?.feature === feature.id && registry[feature.overviewNode]?.kind === 'Plugin'
      && overview.nodes.some(node => node.id === feature.overviewNode && node.role === 'plugin'), `Infrastructure entrance is missing from overview: ${feature.id}`);
  }
  for (const feature of features.values()) {
    const id = `plugin-${feature.plugin}`;
    requireCondition(registry[id]?.feature === feature.id && overview.nodes.some(node => node.id === id && node.role === 'plugin'), `Plugin is missing from overview: ${feature.plugin}`);
    const pluginIdentities = new Set(Object.values(registry).filter(node => String(node.kind).toLowerCase() === 'plugin' && node.name === feature.plugin && node.feature === feature.id).map(node => resolveNode(node.id)));
    requireCondition(pluginIdentities.size === 1 && pluginIdentities.has(id), `Duplicate semantic project plugin: ${feature.plugin}`);
  }
  if (model.required_nodes != null) {
    requireCondition(Array.isArray(model.required_nodes) && model.required_nodes.length > 0, 'Invalid required architecture node list');
    for (const id of model.required_nodes) {
      requireCondition(Object.hasOwn(registry, id), `Missing required architecture node: ${id}`);
      requireCondition(visibleIds.has(resolveNode(id)), `Required architecture node is missing from views: ${id}`);
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
    requireCondition(internalIds.has(resolveNode(id)), `Data node has no internal view: ${id}`);
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
    if (!isMainPluginRegistration({ ...link, from: resolveNode(link.from), to: resolveNode(link.to) }, registry)) requireLink(link, 'System link');
  }
  for (const relation of model.relationships || []) {
    requireLink({ ...relation, from: `entity-${relation.from}`, to: `entity-${relation.to}` }, 'Entity relationship');
  }
  for (const observer of model.observers) {
    const system = systems.get(observer.system);
    requireCondition(system?.kind === 'observer' && registry[observer.system]?.kind === 'observer', `Invalid observer system: ${observer.system}`);
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
    if (value.source != null) {
      const source = value.source;
      const file = readReference(source);
      if (value.kind === 'system' || value.kind === 'observer') {
        // 只核对源码入口行的函数名，不能据此推断函数行为或注册完整性。
        const declaration = file.lines[source.line - 1].match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|const|unsafe)\s+)*fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|<)/);
        requireCondition(declaration?.[1] === value.name, `Function source mismatch: ${value.name} at ${source.path}:${source.line}`);
      }
    } else if (value.kind === 'system' || value.kind === 'observer') {
      throw new Error(`Missing function source: ${value.name}`);
    }
    if (value.definition_source != null) readReference(value.definition_source);
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'source' && key !== 'definition_source') visitSources(child);
    }
  }
  visitSources(model);
  visitSources(registry);

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
  return { systems: systems.size, sources: snapshotPaths.size, views: artifactViewIds.size };
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

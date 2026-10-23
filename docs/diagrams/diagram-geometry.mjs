// 直接核对交付 SVG 的矩形和折线；端点声明只描述意图，不能替代真实几何。
import { measureMermaidNodes, shapeBounds, svgElements } from './svg-shape-geometry.mjs';
const epsilon = 1e-6;
const close = (a, b) => Math.abs(a - b) <= epsilon;
const samePoint = (a, b) => close(a[0], b[0]) && close(a[1], b[1]);
const normals = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function attributes(text) {
  return Object.fromEntries([...text.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(match => [match[1],
    match[3].replace(/&(amp|lt|gt|quot|apos|#39|#\d+|#x[\da-f]+);/gi, (_, entity) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
      return named[entity] ?? String.fromCodePoint(entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
    })]));
}

function number(value, label) {
  const result = Number(value);
  requireCondition(value != null && String(value).trim() !== '' && Number.isFinite(result), `Invalid SVG number: ${label}`);
  return result;
}

function translation(value) {
  if (value == null) return [0, 0];
  const match = value.match(/^translate\(\s*([-+\d.eE]+)(?:[\s,]+([-+\d.eE]+))?\s*\)$/);
  requireCondition(match, `Unsupported SVG transform: ${value}`);
  return [number(match[1], 'translate x'), match[2] == null ? 0 : number(match[2], 'translate y')];
}

function polyline(d, offset) {
  requireCondition(typeof d === 'string' && !d.replace(/[MLHVmlhv]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?|[\s,]/gi, ''), 'Unsupported connection path');
  const tokens = d.match(/[MLHVmlhv]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi) ?? [];
  const points = [];
  let command;
  let point = [0, 0];
  for (let index = 0; index < tokens.length;) {
    if (/^[a-z]$/i.test(tokens[index])) command = tokens[index++];
    requireCondition(command && (points.length || command.toUpperCase() === 'M'), 'Connection path must start with M');
    const kind = command.toUpperCase();
    requireCondition(!(kind === 'M' && points.length), 'Connection path must be continuous');
    const relative = command !== kind;
    const x = number(tokens[index++], 'connection coordinate');
    if (kind === 'H') point = [relative ? point[0] + x : x, point[1]];
    else if (kind === 'V') point = [point[0], relative ? point[1] + x : x];
    else {
      const y = number(tokens[index++], 'connection coordinate');
      point = relative ? [point[0] + x, point[1] + y] : [x, y];
    }
    points.push([point[0] + offset[0], point[1] + offset[1]]);
    if (kind === 'M') command = relative ? 'l' : 'L';
  }
  requireCondition(points.length >= 2, 'Connection path needs at least two points');
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const current = points[index];
    requireCondition(!samePoint(previous, current), 'Connection path contains a zero-length segment');
    requireCondition(close(previous[0], current[0]) || close(previous[1], current[1]), 'Connection path contains a non-orthogonal segment');
  }
  return points;
}

function onSegment(point, first, last) {
  return (close(first[0], last[0]) && close(point[0], first[0])
    && point[1] >= Math.min(first[1], last[1]) - epsilon && point[1] <= Math.max(first[1], last[1]) + epsilon)
    || (close(first[1], last[1]) && close(point[1], first[1])
    && point[0] >= Math.min(first[0], last[0]) - epsilon && point[0] <= Math.max(first[0], last[0]) + epsilon);
}

function onBoundary(point, box) {
  const { x, y, width, height } = box;
  return onSegment(point, [x, y], [x + width, y]) || onSegment(point, [x, y + height], [x + width, y + height])
    || onSegment(point, [x, y], [x, y + height]) || onSegment(point, [x + width, y], [x + width, y + height]);
}

function anchor(value, label) {
  requireCondition(value != null, `Missing connection anchor metadata: ${label}`);
  let result;
  try { result = JSON.parse(value); } catch { throw new Error(`Invalid connection anchor metadata: ${label}`); }
  requireCondition(result === null || (result && typeof result === 'object' && !Array.isArray(result)
    && typeof result.box === 'string' && Object.hasOwn(normals, result.side)
    && Number.isSafeInteger(result.slot) && Number.isSafeInteger(result.count)
    && result.count >= 1 && result.slot >= 1 && result.slot <= result.count), `Invalid connection anchor metadata: ${label}`);
  return result;
}

/** 核对实际矩形、所有连接折线、端口等分、箭头与框外汇合点，不执行页面脚本。 */
export function checkSvgGeometry(svg) {
  const boxes = new Map();
  const markers = new Map();
  const edges = [];
  const stack = [];
  // 生成器使用平移与绝对折线；不接受曲线或其他变换悄悄绕过端点检查。
  for (const match of svg.matchAll(/<(\/?)([A-Za-z][\w:-]*)\b([^>]*?)>/g)) {
    const [, closing, tag, contents] = match;
    if (closing) { stack.pop(); continue; }
    const attrs = attributes(contents);
    const parent = stack.at(-1);
    const shift = translation(attrs.transform);
    const offset = [shift[0] + (parent?.offset[0] ?? 0), shift[1] + (parent?.offset[1] ?? 0)];
    let edge = parent?.edge;
    if (tag === 'g' && (attrs.class ?? '').split(/\s+/).includes('edge')) {
      requireCondition(!edge, 'Nested connection groups are not supported');
      edge = { index: edges.length, source: anchor(attrs['data-source-anchor'], 'source'),
        target: anchor(attrs['data-target-anchor'], 'target'), paths: [] };
      edges.push(edge);
    }
    if (attrs['data-box-id'] != null) {
      const id = attrs['data-box-id'];
      requireCondition(tag === 'rect' && id && !boxes.has(id), `Invalid or duplicate SVG box: ${id}`);
      const box = { x: number(attrs.x ?? '0', `${id} x`) + offset[0], y: number(attrs.y ?? '0', `${id} y`) + offset[1],
        width: number(attrs.width, `${id} width`), height: number(attrs.height, `${id} height`), container: attrs['data-box-container'] === 'true' };
      requireCondition(box.width > 0 && box.height > 0, `Invalid SVG box dimensions: ${id}`);
      boxes.set(id, box);
    }
    if (tag === 'marker') {
      requireCondition(attrs.id && !markers.has(attrs.id), `Invalid or duplicate SVG marker: ${attrs.id}`);
      markers.set(attrs.id, attrs);
    }
    if (tag === 'path') {
      if (edge) edge.paths.push({ attrs, offset });
      else {
        requireCondition(!stack.some(item => item.connection), 'Connection path is missing an edge group');
        requireCondition(!attrs['marker-end'] && !attrs['marker-start'] && !attrs['marker-mid'], 'Arrow path is missing connection metadata');
      }
    }
    if (!contents.trimEnd().endsWith('/')) stack.push({ tag, offset, edge, connection: Object.hasOwn(attrs, 'data-connect') });
  }
  const ports = new Map();
  const junctions = [];
  for (const edge of edges) {
    requireCondition(edge.paths.length === 1, `Connection must contain exactly one path: ${edge.index}`);
    const { attrs, offset } = edge.paths[0];
    edge.points = polyline(attrs.d, offset);
    requireCondition(!attrs['marker-start'] && !attrs['marker-mid'], `Arrow is only allowed at the target: ${edge.index}`);
    if (attrs['marker-end']) {
      requireCondition(edge.target !== null, `Arrow cannot target a junction: ${edge.index}`);
      const markerId = attrs['marker-end'].match(/^url\(#([^)]*)\)$/)?.[1];
      const marker = markers.get(markerId);
      requireCondition(marker, `Unknown arrow marker: ${markerId}`);
      // 图只在末端使用箭头；SVG 1.1 的 auto 也能旋转，避免旧渲染器把 SVG 2 值画成固定向右。
      requireCondition(marker.orient === 'auto', `Arrow marker must follow the terminal segment with orient="auto": ${markerId}`);
      const stroke = number(attrs['stroke-width'] ?? '1', 'connection stroke-width');
      const units = marker.markerUnits ?? 'strokeWidth';
      requireCondition(units === 'strokeWidth' || units === 'userSpaceOnUse', `Unsupported marker units: ${units}`);
      const headLength = number(marker.markerWidth ?? '3', 'marker width') * (units === 'strokeWidth' ? stroke : 1);
      requireCondition(stroke > 0 && headLength > 0, `Invalid arrow dimensions: ${markerId}`);
      const last = edge.points.at(-1), previous = edge.points.at(-2);
      requireCondition(Math.hypot(last[0] - previous[0], last[1] - previous[1]) > headLength + epsilon,
        `Arrow terminal segment is too short: ${edge.index}`);
    }
    for (const [end, declaration] of [['source', edge.source], ['target', edge.target]]) {
      const point = end === 'source' ? edge.points[0] : edge.points.at(-1);
      const neighbour = end === 'source' ? edge.points[1] : edge.points.at(-2);
      if (declaration === null) { junctions.push({ edge, point }); continue; }
      const box = boxes.get(declaration.box);
      requireCondition(box, `Unknown anchor box: ${declaration.box}`);
      const fraction = declaration.slot / (declaration.count + 1);
      const expected = { left: [box.x, box.y + box.height * fraction], right: [box.x + box.width, box.y + box.height * fraction],
        top: [box.x + box.width * fraction, box.y], bottom: [box.x + box.width * fraction, box.y + box.height] }[declaration.side];
      requireCondition(samePoint(point, expected), `Anchor position mismatch: ${declaration.box}.${declaration.side}`);
      const normal = normals[declaration.side];
      const delta = [neighbour[0] - point[0], neighbour[1] - point[1]];
      requireCondition(close(delta[0] * normal[1] - delta[1] * normal[0], 0)
        && delta[0] * normal[0] + delta[1] * normal[1] > epsilon, `Anchor normal mismatch: ${declaration.box}.${declaration.side}`);
      const key = `${declaration.box}\0${declaration.side}`;
      if (!ports.has(key)) ports.set(key, []);
      ports.get(key).push(declaration);
    }
  }
  for (const [key, declarations] of ports) {
    const label = key.replace('\0', '.');
    requireCondition(declarations.every(item => item.count === declarations.length), `Anchor count mismatch: ${label}`);
    requireCondition(new Set(declarations.map(item => item.slot)).size === declarations.length, `Duplicate anchor slot: ${label}`);
  }
  const neighbours = new Map(edges.map(edge => [edge, new Set()]));
  for (const { edge, point } of junctions) {
    for (const [id, box] of boxes) {
      requireCondition(!onBoundary(point, box), `Junction disguises a box anchor: ${id}`);
      requireCondition(box.container || !(point[0] > box.x && point[0] < box.x + box.width
        && point[1] > box.y && point[1] < box.y + box.height), `Junction is inside a node: ${id}`);
    }
    const touching = edges.filter(other => other !== edge
      && other.points.slice(1).some((last, index) => onSegment(point, other.points[index], last)));
    requireCondition(touching.length > 0, `Disconnected junction: ${edge.index}`);
    for (const other of touching) {
      neighbours.get(edge).add(other);
      neighbours.get(other).add(edge);
    }
  }
  // 框外分段必须归属于真实节点连线，不能由全空端点的孤立环互相证明连续性。
  const visited = new Set();
  for (const edge of edges) {
    if (visited.has(edge)) continue;
    const pending = [edge];
    let anchored = false;
    while (pending.length) {
      const current = pending.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      anchored ||= current.source !== null || current.target !== null;
      pending.push(...neighbours.get(current));
    }
    requireCondition(anchored, `Connection group has no box anchor: ${edge.index}`);
  }
  return { boxes: boxes.size, edges: edges.length, ports: [...ports.values()].reduce((count, declarations) => count + declarations.length, 0), junctions: junctions.length };
}

function rectangle(element) {
  requireCondition(element?.tag === 'rect', 'Missing Mermaid node rectangle');
  return shapeBounds(element);
}

const descendant = (element, predicate) => element.children.find(predicate) || element.children.map(child => descendant(child, predicate)).find(Boolean);
const near = (a, b) => Math.abs(a - b) < .05;

function validMermaidPath(value, id) {
  const tokenPattern = /[AaCcHhLlMmQqSsTtVvZz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi;
  requireCondition(typeof value === 'string' && !value.replace(tokenPattern, '').replace(/[\s,]/g, ''), `Invalid Mermaid edge path: ${id}`);
  const tokens = value.match(tokenPattern) || [], arity = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  requireCondition(tokens[0]?.toUpperCase() === 'M', `Invalid Mermaid edge path: ${id}`);
  let index = 0, segment = false;
  while (index < tokens.length) {
    const command = tokens[index++].toUpperCase(), count = arity[command];
    requireCondition(count !== undefined, `Invalid Mermaid edge command: ${id}`);
    const start = index;
    while (index < tokens.length && !/^[A-Za-z]$/.test(tokens[index])) {
      requireCondition(Number.isFinite(Number(tokens[index++])), `Invalid Mermaid edge coordinate: ${id}`);
    }
    requireCondition(count === 0 ? start === index : index > start && (index - start) % count === 0, `Invalid Mermaid edge coordinates: ${id}`);
    segment ||= command !== 'M' || index - start > 2;
  }
  requireCondition(segment, `Mermaid edge has no segment: ${id}`);
}

/** 核对 Mermaid 的真实轮廓、列布局和路径；曲线不适用手工正交图的端口槽位规则。 */
export function checkMermaidGeometry(svg, view) {
  const elements = svgElements(svg), root = elements.find(element => element.tag === 'svg');
  const viewport = root?.attrs.viewBox?.trim().split(/[\s,]+/).map(Number);
  requireCondition(viewport?.length === 4 && viewport.every(Number.isFinite) && viewport[2] > 0 && viewport[3] > 0, 'Invalid Mermaid SVG viewBox');
  requireCondition(view.bounds && ['x', 'y', 'width', 'height'].every((key, index) => Number.isFinite(view.bounds[key]) && near(view.bounds[key], viewport[index]))
    && near(view.width, viewport[2]) && near(view.height, viewport[3]), 'Mermaid viewport metadata mismatch');
  const nodes = new Map(), instances = new Set(), measured = measureMermaidNodes(svg);
  for (const element of elements.filter(item => item.attrs['data-id'] !== undefined)) {
    const id = element.attrs['data-id'], instance = element.attrs['data-instance'];
    const classes = (element.attrs.class || '').split(/\s+/);
    requireCondition(element.tag === 'g' && (classes.includes('node') || (element.attrs['data-presentation'] === 'entity-container' && classes.includes('cluster'))), `Mermaid data-id is not a node: ${id}`);
    requireCondition(!nodes.has(id) && instance && !instances.has(instance), `Duplicate Mermaid semantic node or instance: ${id}`);
    const bounds = measured.get(id);
    requireCondition(near(number(element.attrs['data-center-x'], `${id} center x`), bounds.x + bounds.width / 2)
      && near(number(element.attrs['data-center-y'], `${id} center y`), bounds.y + bounds.height / 2), `Mermaid node center mismatch: ${id}`);
    nodes.set(id, { element, bounds });
    instances.add(instance);
  }
  for (const node of view.nodes) {
    const actual = nodes.get(node.id);
    requireCondition(actual && actual.element.attrs['data-mermaid-id'] === node.mermaidId, `Mermaid node identity mismatch: ${node.id}`);
    requireCondition(node.position && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(node.position[key]) && near(node.position[key], actual.bounds[key])), `Mermaid node position mismatch: ${node.id}`);
  }
  requireCondition(nodes.size === view.nodes.length, 'Mermaid node count mismatch');
  const markers = new Set(elements.filter(element => element.tag === 'marker').map(element => element.attrs.id));
  const semantic = new Map(), layout = new Map(), schedule = new Map();
  for (const element of elements.filter(item => item.tag === 'path' && (item.attrs['data-link-id'] !== undefined || item.attrs['data-schedule-link-id'] !== undefined || item.attrs['data-layout-link'] !== undefined || item.attrs['data-edge'] === 'true'))) {
    const attrs = element.attrs;
    const ids = [attrs['data-link-id'], attrs['data-layout-link'], attrs['data-schedule-link-id']].filter(value => value !== undefined), id = ids[0];
    requireCondition(ids.length === 1 && id, 'Unidentified Mermaid edge path');
    validMermaidPath(attrs.d, id);
    requireCondition(!attrs['marker-start'] && !attrs['marker-mid'], `Mermaid arrow is only allowed at the target: ${id}`);
    if (attrs['marker-end']) {
      const markerId = attrs['marker-end'].match(/^url\([^#]*#([^)]*)\)$/)?.[1];
      requireCondition(markers.has(markerId), `Unknown Mermaid arrow marker: ${id}`);
    }
    const target = attrs['data-link-id'] !== undefined ? semantic : attrs['data-schedule-link-id'] !== undefined ? schedule : layout;
    requireCondition(!target.has(id), `Duplicate Mermaid edge path: ${id}`);
    target.set(id, element);
  }
  requireCondition(semantic.size === view.links.length && layout.size === (view.layoutLinks || []).length && schedule.size === (view.scheduleLinks || []).length, 'Mermaid edge count mismatch');
  for (const link of view.links) requireCondition(semantic.get(link.id)?.attrs['data-mermaid-id'] === link.mermaidId, `Mermaid edge identity mismatch: ${link.id}`);
  for (const link of view.layoutLinks || []) {
    const element = layout.get(link.mermaidId);
    requireCondition(element, `Missing Mermaid layout edge: ${link.mermaidId}`);
    if (link.directed) {
      const style = Object.fromEntries((element.attrs.style || '').split(';').map(entry => entry.split(':').map(value => value.trim().replace(/\s*!important$/, ''))).filter(entry => entry.length === 2));
      requireCondition(Number(style.opacity ?? element.attrs.opacity ?? 1) === 0 || parseFloat(style['stroke-width'] ?? element.attrs['stroke-width']) === 0
        || ['transparent', 'none'].includes(style.stroke ?? element.attrs.stroke), `Directed Mermaid layout edge must be invisible: ${link.mermaidId}`);
    }
  }
  for (const link of view.scheduleLinks || []) {
    const attrs = schedule.get(link.id)?.attrs;
    requireCondition(attrs && attrs['data-mermaid-id'] === link.mermaidId && attrs['data-schedule-connect'] === `${link.from}|${link.to}`
      && attrs['data-edge-semantic'] === link.edgeSemantic && attrs['marker-end'], `Mermaid Schedule edge identity mismatch: ${link.id}`);
  }
  const groups = new Map();
  for (const element of elements.filter(item => item.attrs['data-schedule-id'] !== undefined)) {
    const id = element.attrs['data-schedule-id'];
    requireCondition(element.tag === 'g' && (element.attrs.class || '').split(/\s+/).includes('cluster') && !groups.has(id), `Invalid or duplicate Mermaid Schedule cluster: ${id}`);
    groups.set(id, { element, bounds: rectangle(descendant(element, item => item.tag === 'rect')) });
  }
  requireCondition(groups.size === (view.scheduleGroups || []).length, 'Mermaid Schedule cluster count mismatch');
  let previous;
  for (const group of view.scheduleGroups || []) {
    const actual = groups.get(group.id);
    requireCondition(actual?.element.attrs['data-mermaid-id'] === group.mermaidId, `Mermaid Schedule cluster identity mismatch: ${group.id}`);
    if (previous) requireCondition(actual.bounds.x > previous.x + previous.width - .05, `Mermaid Schedule columns are not left to right: ${group.id}`);
    previous = actual.bounds;
    let previousNode;
    for (const id of group.nodes) {
      const bounds = nodes.get(id)?.bounds;
      requireCondition(bounds && bounds.x >= actual.bounds.x - .05 && bounds.y >= actual.bounds.y - .05
        && bounds.x + bounds.width <= actual.bounds.x + actual.bounds.width + .05 && bounds.y + bounds.height <= actual.bounds.y + actual.bounds.height + .05, `Mermaid node is outside its Schedule column: ${id}`);
      if (previousNode) requireCondition(bounds.y > previousNode.y + previousNode.height - .05, `Mermaid Schedule nodes are not top to bottom: ${group.id}`);
      previousNode = bounds;
    }
  }
  const nodeEntries = [...nodes];
  for (let index = 0; index < nodeEntries.length; index++) {
    const [id, { bounds }] = nodeEntries[index];
    requireCondition(bounds.x >= viewport[0] - .05 && bounds.y >= viewport[1] - .05
      && bounds.x + bounds.width <= viewport[0] + viewport[2] + .05
      && bounds.y + bounds.height <= viewport[1] + viewport[3] + .05, `Mermaid node is outside the SVG viewport: ${id}`);
    for (const [otherId, { bounds: other }] of nodeEntries.slice(index + 1)) {
      const overlapX = Math.min(bounds.x + bounds.width, other.x + other.width) - Math.max(bounds.x, other.x);
      const overlapY = Math.min(bounds.y + bounds.height, other.y + other.height) - Math.max(bounds.y, other.y);
      const composition = (view.entityGroups || []).find(group => group.expanded !== false && ((group.entity === id && group.components.includes(otherId)) || (group.entity === otherId && group.components.includes(id))));
      const entityId = composition?.entity, entity = entityId && view.nodes.find(node => node.id === entityId);
      if (entity?.presentation === 'entity-container') {
        const outer = entityId === id ? bounds : other, inner = entityId === id ? other : bounds;
        requireCondition(inner.x >= outer.x - .05 && inner.y >= outer.y - .05 && inner.x + inner.width <= outer.x + outer.width + .05
          && inner.y + inner.height <= outer.y + outer.height + .05, `Mermaid Component is outside its Entity card: ${entityId}`);
      } else requireCondition(overlapX <= .05 || overlapY <= .05, `Mermaid node rectangles overlap: ${id} / ${otherId}`);
    }
  }
  return { nodes: nodes.size, edges: semantic.size, layoutEdges: layout.size, scheduleEdges: schedule.size, scheduleGroups: groups.size };
}

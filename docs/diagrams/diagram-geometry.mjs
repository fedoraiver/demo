// 直接核对交付 SVG 的矩形和折线；端点声明只描述意图，不能替代真实几何。
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
      requireCondition(marker.orient === 'auto' || marker.orient === 'auto-start-reverse', `Arrow marker must follow the terminal segment: ${markerId}`);
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

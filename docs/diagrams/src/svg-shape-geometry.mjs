import { DOMParser } from '@xmldom/xmldom';
import SvgPath from 'svgpath';
import { svgPathBbox } from 'svg-path-bbox';

const requireCondition = (value, message) => { if (!value) throw new Error(message); };
const identity = [1, 0, 0, 1, 0, 0];
const multiply = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const number = (value, name) => {
  requireCondition(value != null && String(value).trim() !== '' && Number.isFinite(Number(value)), `Invalid Mermaid shape coordinate: ${name}`);
  return Number(value);
};

function transformMatrix(value = '') {
  let matrix = identity;
  for (const match of value.matchAll(/([A-Za-z]+)\(([^)]*)\)/g)) {
    const values = match[2].trim().split(/[\s,]+/).map(Number);
    requireCondition(values.every(Number.isFinite), 'Invalid Mermaid transform');
    let operation;
    if (match[1] === 'translate' && [1, 2].includes(values.length)) operation = [1, 0, 0, 1, values[0], values[1] || 0];
    else if (match[1] === 'scale' && [1, 2].includes(values.length)) operation = [values[0], 0, 0, values[1] ?? values[0], 0, 0];
    else if (match[1] === 'matrix' && values.length === 6) operation = values;
    else if (match[1] === 'rotate' && [1, 3].includes(values.length)) {
      const angle = values[0] * Math.PI / 180, rotation = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0];
      operation = values.length === 1 ? rotation : multiply(multiply([1, 0, 0, 1, values[1], values[2]], rotation), [1, 0, 0, 1, -values[1], -values[2]]);
    } else if (['skewX', 'skewY'].includes(match[1]) && values.length === 1) {
      const tangent = Math.tan(values[0] * Math.PI / 180);
      operation = match[1] === 'skewX' ? [1, 0, tangent, 1, 0, 0] : [1, tangent, 0, 1, 0, 0];
    } else throw new Error(`Unsupported Mermaid transform: ${match[0]}`);
    matrix = multiply(matrix, operation);
  }
  requireCondition(!value.replace(/[A-Za-z]+\([^)]*\)/g, '').trim(), `Unsupported Mermaid transform: ${value}`);
  return matrix;
}

/** 保留 SVG 元素及祖先关系，供编译器与独立校验器读取同一份真实图元。 */
export function svgElements(svg) {
  const document = new DOMParser({ onError: (level, message) => { if (level !== 'warning') throw new Error(`Invalid Mermaid SVG: ${message}`); } }).parseFromString(svg, 'image/svg+xml');
  const elements = [];
  function visit(node, parent) {
    if (node.nodeType !== 1) return;
    const element = { tag: node.localName, attrs: Object.fromEntries([...node.attributes].map(attribute => [attribute.name, attribute.value])), text: node.textContent, parent, children: [] };
    parent?.children.push(element);
    elements.push(element);
    for (const child of node.childNodes) visit(child, element);
  }
  visit(document.documentElement);
  return elements;
}

function primitivePath(element) {
  const a = element.attrs, n = (name, fallback) => number(a[name] ?? fallback, name);
  if (element.tag === 'path') return a.d;
  if (element.tag === 'rect') {
    const x = n('x', 0), y = n('y', 0), width = n('width'), height = n('height');
    requireCondition(width > 0 && height > 0, 'Invalid Mermaid rectangle dimensions');
    const rx = Math.min(width / 2, Math.max(0, n('rx', a.ry ?? 0))), ry = Math.min(height / 2, Math.max(0, n('ry', a.rx ?? 0)));
    if (rx && ry) return `M${x + rx},${y}H${x + width - rx}A${rx},${ry} 0 0 1 ${x + width},${y + ry}V${y + height - ry}A${rx},${ry} 0 0 1 ${x + width - rx},${y + height}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + height - ry}V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`;
    return `M${x},${y}h${width}v${height}h${-width}z`;
  }
  if (element.tag === 'circle' || element.tag === 'ellipse') {
    const x = n('cx', 0), y = n('cy', 0), rx = n(element.tag === 'circle' ? 'r' : 'rx'), ry = element.tag === 'circle' ? rx : n('ry');
    requireCondition(rx > 0 && ry > 0, 'Invalid Mermaid ellipse dimensions');
    return `M${x - rx},${y}a${rx},${ry} 0 1 0 ${2 * rx},0a${rx},${ry} 0 1 0 ${-2 * rx},0z`;
  }
  if (element.tag === 'line') return `M${n('x1', 0)},${n('y1', 0)}L${n('x2', 0)},${n('y2', 0)}`;
  if (element.tag === 'polygon' || element.tag === 'polyline') {
    const values = a.points?.trim().split(/[\s,]+/).map(value => number(value, 'polygon point'));
    requireCondition(values?.length >= 4 && values.length % 2 === 0, 'Invalid Mermaid polygon points');
    return values.map((value, index) => `${index % 2 ? ',' : index ? 'L' : 'M'}${value}`).join('') + (element.tag === 'polygon' ? 'z' : '');
  }
  throw new Error(`Unsupported Mermaid shape primitive: ${element.tag}`);
}

function elementTransform(element, relativeTo) {
  const ancestors = [];
  for (let current = element; current && current !== relativeTo; current = current.parent) ancestors.unshift(current);
  return ancestors.reduce((result, item) => multiply(result, transformMatrix(item.attrs.transform)), identity);
}

/** 原生路径及其全部祖先变换，用于检查真实连线与节点的相交。 */
export function shapePath(element, { relativeTo } = {}) {
  requireCondition(element, 'Missing Mermaid shape primitive');
  const path = new SvgPath(primitivePath(element));
  requireCondition(!path.err, `Invalid Mermaid shape path: ${path.err}`);
  return path.matrix(elementTransform(element, relativeTo));
}

const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
export function pointSegmentDistance(point, first, last) {
  const dx = last[0] - first[0], dy = last[1] - first[1], length = dx * dx + dy * dy;
  const fraction = length ? Math.max(0, Math.min(1, ((point[0] - first[0]) * dx + (point[1] - first[1]) * dy) / length)) : 0;
  return Math.hypot(point[0] - first[0] - fraction * dx, point[1] - first[1] - fraction * dy);
}

function flattenBezier(points, output, tolerance, depth = 0) {
  if (points.slice(1, -1).every(point => pointSegmentDistance(point, points[0], points.at(-1)) <= tolerance)) { output.push(points.at(-1)); return; }
  requireCondition(depth < 32, 'Mermaid curve exceeds geometry subdivision limit');
  const left = [points[0]], right = [points.at(-1)];
  let row = points;
  while (row.length > 1) { row = row.slice(1).map((point, index) => midpoint(row[index], point)); left.push(row[0]); right.unshift(row.at(-1)); }
  flattenBezier(left, output, tolerance, depth + 1); flattenBezier(right, output, tolerance, depth + 1);
}

function arcGeometry(start, segment) {
  let [, rx, ry, rotation, large, sweep, x, y] = segment;
  const end = [x, y]; rx = Math.abs(rx); ry = Math.abs(ry);
  if (!rx || !ry || (start[0] === x && start[1] === y)) return null;
  const phi = rotation * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const halfX = (start[0] - x) / 2, halfY = (start[1] - y) / 2;
  const localX = cos * halfX + sin * halfY, localY = -sin * halfX + cos * halfY;
  const scale = Math.sqrt(localX * localX / (rx * rx) + localY * localY / (ry * ry));
  if (scale > 1) { rx *= scale; ry *= scale; }
  const numerator = rx * rx * ry * ry - rx * rx * localY * localY - ry * ry * localX * localX;
  const denominator = rx * rx * localY * localY + ry * ry * localX * localX;
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
  const centerLocalX = factor * rx * localY / ry, centerLocalY = -factor * ry * localX / rx;
  const centerX = cos * centerLocalX - sin * centerLocalY + (start[0] + x) / 2;
  const centerY = sin * centerLocalX + cos * centerLocalY + (start[1] + y) / 2;
  const from = [(localX - centerLocalX) / rx, (localY - centerLocalY) / ry];
  const to = [(-localX - centerLocalX) / rx, (-localY - centerLocalY) / ry];
  const theta = Math.atan2(from[1], from[0]);
  let delta = Math.atan2(from[0] * to[1] - from[1] * to[0], from[0] * to[0] + from[1] * to[1]);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  return { end, rx, ry, cos, sin, centerX, centerY, theta, delta };
}

function flattenArc(start, segment, output, tolerance) {
  const geometry = arcGeometry(start, segment);
  if (!geometry) { output.push(segment.slice(-2)); return; }
  const { end, rx, ry, cos, sin, centerX, centerY, theta, delta } = geometry;
  const radius = Math.max(rx, ry), step = 2 * Math.acos(Math.max(-1, 1 - tolerance / radius));
  const count = Math.max(1, Math.ceil(Math.abs(delta) / Math.min(Math.PI / 2, step || Math.sqrt(8 * tolerance / radius))));
  requireCondition(count <= 1000000, 'Mermaid arc exceeds geometry subdivision limit');
  for (let index = 1; index <= count; index++) {
    const angle = theta + delta * index / count, px = rx * Math.cos(angle), py = ry * Math.sin(angle);
    output.push(index === count ? end : [centerX + cos * px - sin * py, centerY + sin * px + cos * py]);
  }
}

/** 每段折线与真实曲线的距离不超过 tolerance；保留子路径，避免跨 Move 命令连线。 */
export function flattenPath(value, { tolerance = .25 } = {}) {
  requireCondition(Number.isFinite(tolerance) && tolerance > 0, 'Invalid Mermaid flattening tolerance');
  const path = value instanceof SvgPath ? new SvgPath(value.toString()) : new SvgPath(value);
  requireCondition(!path.err, `Invalid Mermaid shape path: ${path.err}`);
  const result = []; let current, previous;
  for (const segment of path.abs().unshort().round(12).segments) {
    const kind = segment[0];
    if (kind === 'M') { previous = [segment[1], segment[2]]; current = { points: [previous], closed: false }; result.push(current); continue; }
    requireCondition(current, 'Mermaid path must begin with Move');
    if (kind === 'Z') { current.closed = true; if (pointSegmentDistance(current.points[0], previous, previous) > 1e-10) current.points.push(current.points[0]); }
    else if (kind === 'L') current.points.push([segment[1], segment[2]]);
    else if (kind === 'H') current.points.push([segment[1], previous[1]]);
    else if (kind === 'V') current.points.push([previous[0], segment[1]]);
    else if (kind === 'C') flattenBezier([previous, [segment[1], segment[2]], [segment[3], segment[4]], [segment[5], segment[6]]], current.points, tolerance);
    else if (kind === 'Q') flattenBezier([previous, [segment[1], segment[2]], [segment[3], segment[4]]], current.points, tolerance);
    else if (kind === 'A') flattenArc(previous, segment, current.points, tolerance);
    else throw new Error(`Unsupported Mermaid path segment: ${kind}`);
    previous = current.points.at(-1);
  }
  return result;
}

export const flattenShape = (element, { relativeTo, ...options } = {}) => flattenPath(shapePath(element, { relativeTo }), options);

/** 原生箭头使用曲线端点的切线，不能用较远的折线采样段替代。 */
export function pathTerminals(element) {
  const segments = shapePath(element).abs().unshort().round(12).segments;
  let first, previous, subpath, startTangent, endTangent;
  const nonzero = vectors => vectors.find(vector => Math.hypot(...vector) > 1e-10);
  const difference = (a, b) => [a[0] - b[0], a[1] - b[1]];
  for (const segment of segments) {
    const kind = segment[0];
    if (kind === 'M') { previous = [segment[1], segment[2]]; subpath = previous; first ??= previous; continue; }
    let end, controls = [];
    if (kind === 'L') end = [segment[1], segment[2]];
    else if (kind === 'H') end = [segment[1], previous[1]];
    else if (kind === 'V') end = [previous[0], segment[1]];
    else if (kind === 'Q') { controls = [[segment[1], segment[2]]]; end = [segment[3], segment[4]]; }
    else if (kind === 'C') { controls = [[segment[1], segment[2]], [segment[3], segment[4]]]; end = [segment[5], segment[6]]; }
    else if (kind === 'Z') end = subpath;
    else if (kind === 'A') {
      const sampled = [previous]; flattenArc(previous, segment, sampled, .00001);
      controls = sampled.slice(1, -1); end = sampled.at(-1);
    } else throw new Error(`Unsupported Mermaid path segment: ${kind}`);
    startTangent ??= nonzero([...controls, end].map(point => difference(point, previous)));
    endTangent = nonzero([...controls].reverse().concat([previous]).map(point => difference(end, point))) || endTangent;
    previous = end;
  }
  const unit = vector => vector && vector.map(value => value / Math.hypot(...vector));
  return { start: first, end: previous, startTangent: unit(startTangent), endTangent: unit(endTangent) };
}

/** 只有整条路径共线才算直线；正交折线不算水平或竖直直线。 */
export function pathAxis(element, tolerance = .5) {
  const subpaths = flattenShape(element, { tolerance: Math.min(.25, tolerance / 4) });
  if (subpaths.length !== 1 || subpaths[0].closed || subpaths[0].points.length < 2) return null;
  const points = subpaths[0].points, xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  if (Math.max(...xs) - Math.min(...xs) <= tolerance && Math.max(...ys) - Math.min(...ys) > tolerance) return 'vertical';
  if (Math.max(...ys) - Math.min(...ys) <= tolerance && Math.max(...xs) - Math.min(...xs) > tolerance) return 'horizontal';
  return null;
}

function bezierDeviation(points) {
  const first = points[0], last = points.at(-1);
  let dx = last[0] - first[0], dy = last[1] - first[1], length = Math.hypot(dx, dy);
  if (length < 1e-10) {
    const control = points.slice(1, -1).reduce((best, point) => Math.hypot(point[0] - first[0], point[1] - first[1]) > Math.hypot(best[0] - first[0], best[1] - first[1]) ? point : best, first);
    dx = control[0] - first[0]; dy = control[1] - first[1]; length = Math.hypot(dx, dy);
  }
  if (!length) return 0;
  const distances = points.slice(1, -1).map(point => (dx * (point[1] - first[1]) - dy * (point[0] - first[0])) / length);
  if (points.length === 3) return Math.abs(distances[0]) / 2;
  const [firstDistance, lastDistance] = distances;
  const a = 9 * (firstDistance - lastDistance), b = 6 * (lastDistance - 2 * firstDistance), c = 3 * firstDistance;
  const scale = Math.max(1, Math.abs(a), Math.abs(b), Math.abs(c)), roots = [];
  if (Math.abs(a) <= 1e-12 * scale) {
    if (Math.abs(b) > 1e-12 * scale) roots.push(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const q = -.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(discriminant));
      roots.push(q / a); if (q) roots.push(c / q);
    }
  }
  return Math.max(0, ...roots.filter(t => t > 0 && t < 1).map(t => Math.abs(3 * (1 - t) ** 2 * t * firstDistance + 3 * (1 - t) * t ** 2 * lastDistance)));
}

function arcDeviation(start, segment) {
  const geometry = arcGeometry(start, segment);
  if (!geometry) return 0;
  const { end, rx, ry, cos, sin, centerX, centerY, theta, delta } = geometry;
  const dx = end[0] - start[0], dy = end[1] - start[1], length = Math.hypot(dx, dy);
  const a = rx * (dx * sin - dy * cos) / length, b = ry * (dx * cos + dy * sin) / length;
  const c = (dx * (centerY - start[1]) - dy * (centerX - start[0])) / length;
  const lower = Math.min(theta, theta + delta), upper = Math.max(theta, theta + delta), extremum = Math.atan2(b, a), angles = [theta, theta + delta];
  for (let turn = Math.ceil((lower - extremum) / Math.PI); turn <= Math.floor((upper - extremum) / Math.PI); turn++) angles.push(extremum + turn * Math.PI);
  return Math.max(...angles.map(angle => Math.abs(a * Math.cos(angle) + b * Math.sin(angle) + c)));
}

/** 逐曲线段求实际轨迹偏离其弦的极值；共线 C/Q 或折线不能冒充曲线。 */
export function pathCurveDeviation(element) {
  let previous, subpath, deviation = 0;
  for (const segment of shapePath(element).abs().unshort().round(12).segments) {
    const kind = segment[0];
    if (kind === 'M') { previous = segment.slice(1); subpath = previous; continue; }
    if (kind === 'C') deviation = Math.max(deviation, bezierDeviation([previous, segment.slice(1, 3), segment.slice(3, 5), segment.slice(5, 7)]));
    else if (kind === 'Q') deviation = Math.max(deviation, bezierDeviation([previous, segment.slice(1, 3), segment.slice(3, 5)]));
    else if (kind === 'A') deviation = Math.max(deviation, arcDeviation(previous, segment));
    else requireCondition(['H', 'V', 'L', 'Z'].includes(kind), `Unsupported Mermaid path segment: ${kind}`);
    previous = kind === 'Z' ? subpath : kind === 'H' ? [segment[1], previous[1]] : kind === 'V' ? [previous[0], segment[1]] : segment.slice(-2);
  }
  return deviation;
}

/** 原生图元的真实轴向边界，包含所有祖先变换及曲线路径的极值。 */
export function shapeBounds(element) {
  requireCondition(element, 'Missing Mermaid shape primitive');
  const path = new SvgPath(primitivePath(element));
  requireCondition(!path.err, `Invalid Mermaid shape path: ${path.err}`);
  const matrix = elementTransform(element);
  // 先求局部曲线极值，再加平移；大画布坐标参与近似退化三次式会放大消减误差。
  const [a, b, c, d, shiftX, shiftY] = matrix;
  const [left, top, localRight, localBottom] = svgPathBbox(path.matrix([a, b, c, d, 0, 0]).round(9));
  const x = left + shiftX, y = top + shiftY, right = localRight + shiftX, bottom = localBottom + shiftY;
  requireCondition([x, y, right, bottom].every(Number.isFinite), 'Invalid Mermaid shape bounds');
  return { x, y, width: right - x, height: bottom - y };
}

/** 节点由多个真实轮廓组成时合并图元；不使用替代矩形或标签包围框。 */
export function measureMermaidNodes(svg) {
  const elements = svgElements(svg), result = new Map();
  for (const node of elements.filter(item => item.attrs['data-id'] !== undefined)) {
    const id = node.attrs['data-id'], instance = node.attrs['data-instance'];
    const classes = (node.attrs.class || '').split(/\s+/), entityContainer = node.attrs['data-presentation'] === 'entity-container';
    requireCondition(node.tag === 'g' && (classes.includes('node') || (entityContainer && classes.includes('cluster'))) && id && instance && !result.has(id), `Invalid or duplicate Mermaid semantic node: ${id}`);
    const descendants = elements.filter(item => { for (let parent = item.parent; parent; parent = parent.parent) if (parent === node) return true; return false; });
    const ownerOf = item => { for (let parent = item.parent; parent; parent = parent.parent) if (parent.attrs['data-id'] !== undefined) return parent; };
    let parts = descendants.filter(item => item.attrs['data-shape-part'] === instance && ownerOf(item) === node);
    // 旧矩形测试与既有离线图仍可被读取；新样式节点必须提供原生轮廓。
    if (!parts.length && !node.attrs['data-visual-type']) parts = descendants.filter(item => item.attrs['data-box-id'] === instance);
    requireCondition(parts.length, `Missing Mermaid node shape: ${id}`);
    requireCondition(descendants.every(item => {
      if (!item.attrs['data-shape-part']) return true;
      const owner = ownerOf(item);
      return owner === node ? item.attrs['data-shape-part'] === instance : entityContainer && owner?.attrs['data-instance'] === item.attrs['data-shape-part'];
    }), `Mermaid node shape instance mismatch: ${id}`);
    const bounds = parts.map(shapeBounds), x = Math.min(...bounds.map(box => box.x)), y = Math.min(...bounds.map(box => box.y));
    const right = Math.max(...bounds.map(box => box.x + box.width)), bottom = Math.max(...bounds.map(box => box.y + box.height));
    requireCondition(right > x && bottom > y, `Invalid Mermaid node dimensions: ${id}`);
    result.set(id, { x, y, width: right - x, height: bottom - y });
  }
  return result;
}

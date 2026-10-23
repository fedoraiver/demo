import { flattenShape, pathAxis, pathCurveDeviation, pathTerminals, pointSegmentDistance, shapeBounds, svgElements } from './svg-shape-geometry.mjs';

export const ROUTING_STYLE = Object.freeze({ axisTolerance: .5, geometryTolerance: .25, curve: 'basis', curveFallbacks: ['bumpX', 'bumpY'] });
export const ROUTING_GEOMETRY = Object.freeze({ tolerance: ROUTING_STYLE.geometryTolerance, axisTolerance: ROUTING_STYLE.axisTolerance });
export const displayEndpoints = link => [link.displayFrom ?? link.from, link.displayTo ?? link.to];
const epsilon = 1e-8;
const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
const overlaps = (first, last, box, pad) => Math.max(first[0], last[0]) >= box.x - pad && Math.min(first[0], last[0]) <= box.x + box.width + pad
  && Math.max(first[1], last[1]) >= box.y - pad && Math.min(first[1], last[1]) <= box.y + box.height + pad;

function segmentsIntersect(a, b, c, d) {
  const values = [cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b)];
  if (((values[0] > epsilon && values[1] < -epsilon) || (values[0] < -epsilon && values[1] > epsilon))
    && ((values[2] > epsilon && values[3] < -epsilon) || (values[2] < -epsilon && values[3] > epsilon))) return true;
  return pointSegmentDistance(a, c, d) <= epsilon || pointSegmentDistance(b, c, d) <= epsilon
    || pointSegmentDistance(c, a, b) <= epsilon || pointSegmentDistance(d, a, b) <= epsilon;
}

function segmentDistance(a, b, c, d) {
  return segmentsIntersect(a, b, c, d) ? 0 : Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

function winding(point, contours) {
  let count = 0;
  for (const contour of contours.filter(contour => contour.closed)) for (let index = 1; index < contour.points.length; index++) {
    const first = contour.points[index - 1], last = contour.points[index];
    if (first[1] <= point[1] && last[1] > point[1] && cross(first, last, point) > 0) count++;
    if (first[1] > point[1] && last[1] <= point[1] && cross(first, last, point) < 0) count--;
  }
  return count;
}

const filledContains = (point, parts) => parts.some(part => part.fillRule === 'evenodd' ? Math.abs(winding(point, part.contours)) % 2 === 1 : winding(point, part.contours) !== 0);
const boundarySegments = parts => parts.flatMap(part => part.contours.flatMap(contour => contour.points.slice(1).map((last, index) => [contour.points[index], last])));

/** 按真实轮廓而非轴向包围框避让；误差带内采取保守判定。 */
export function pathIntersectsOutline(path, obstacle, { tolerance = ROUTING_GEOMETRY.tolerance, clearance = 0 } = {}) {
  const band = clearance + 2 * tolerance + Math.max(0, ...obstacle.parts.map(part => part.strokeWidth || 0)) / 2;
  for (const contour of path) for (let index = 1; index < contour.points.length; index++) {
    const first = contour.points[index - 1], last = contour.points[index];
    if (!overlaps(first, last, obstacle.bounds, band)) continue;
    for (const part of obstacle.parts) {
      const isInside = point => part.fillRule === 'evenodd' ? Math.abs(winding(point, part.contours)) % 2 === 1 : winding(point, part.contours) !== 0;
      if (isInside(first) || isInside(last) || isInside([(first[0] + last[0]) / 2, (first[1] + last[1]) / 2])) return true;
      for (const boundary of part.contours) for (let at = 1; at < boundary.points.length; at++) {
        if (segmentDistance(first, last, boundary.points[at - 1], boundary.points[at]) <= band) return true;
      }
    }
  }
  return false;
}

function outlinesIntersect(first, last, options) {
  const strokePadding = Math.max(0, ...first.parts.map(part => part.strokeWidth || 0)) / 2 + Math.max(0, ...last.parts.map(part => part.strokeWidth || 0)) / 2;
  if (!overlaps([first.bounds.x, first.bounds.y], [first.bounds.x + first.bounds.width, first.bounds.y + first.bounds.height], last.bounds, (options.clearance || 0) + 2 * options.tolerance + strokePadding)) return false;
  return first.parts.some(part => pathIntersectsOutline(part.contours, last, { ...options, clearance: (options.clearance || 0) + (part.strokeWidth || 0) / 2 }))
    || last.parts.some(part => pathIntersectsOutline(part.contours, first, { ...options, clearance: (options.clearance || 0) + (part.strokeWidth || 0) / 2 }));
}

function nativeProperty(element, name) {
  for (let current = element; current; current = current.parent) {
    const inline = Object.fromEntries((current.attrs.style || '').split(';').flatMap(entry => {
      const separator = entry.indexOf(':'); return separator < 0 ? [] : [[entry.slice(0, separator).trim(), entry.slice(separator + 1).trim().replace(/\s*!important$/, '')]];
    }));
    const value = inline[name] ?? current.attrs[name];
    if (value !== undefined) return value;
  }
}

const markerRules = new WeakMap();
/** 读取原生 SVG 的级联，包含 Mermaid themeCSS 输出的 ID/类/标签后代选择器。 */
export function nativeSvgProperty(element, name) {
  let root = element;
  while (root.parent) root = root.parent;
  if (!markerRules.has(root)) {
    const styles = [], visit = item => { if (item.tag === 'style') styles.push(item.text); item.children.forEach(visit); };
    visit(root);
    markerRules.set(root, styles.flatMap(css => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(match => {
      const declarations = match[2].split(';').flatMap(entry => {
        const separator = entry.indexOf(':');
        if (separator < 0) return [];
        return [{ name: entry.slice(0, separator).trim(), value: entry.slice(separator + 1).trim().replace(/\s*!important$/, ''), important: /!important\s*$/.test(entry) }];
      });
      return match[1].split(',').map(selector => ({ selector: selector.trim(), declarations }));
    })));
  }
  const matches = (item, selector) => {
    if (!/^[\w#.*\s-]+$/.test(selector)) return false;
    const tokens = selector.split(/\s+/), simple = (node, token) => {
      const tag = /^[\w*-]+/.exec(token)?.[0], id = /#([\w-]+)/.exec(token)?.[1], classes = [...token.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
      return (!tag || tag === '*' || tag === node.tag) && (!id || id === node.attrs.id) && classes.every(value => (node.attrs.class || '').split(/\s+/).includes(value));
    };
    if (!simple(item, tokens.pop())) return false;
    for (let parent = item.parent; tokens.length; parent = parent?.parent) {
      if (!parent) return false;
      if (simple(parent, tokens.at(-1))) tokens.pop();
    }
    return true;
  };
  for (let current = element; current; current = current.parent) {
    const candidates = current.attrs[name] === undefined ? [] : [{ value: current.attrs[name], score: 0 }];
    for (const rule of markerRules.get(root)) if (matches(current, rule.selector)) {
      const specificity = (rule.selector.match(/#/g)?.length || 0) * 100 + (rule.selector.match(/\./g)?.length || 0) * 10 + (rule.selector.match(/(?:^|\s)[a-z]/gi)?.length || 0);
      for (const declaration of rule.declarations) if (declaration.name === name) candidates.push({ value: declaration.value, score: specificity + (declaration.important ? 10000 : 0) });
    }
    for (const entry of (current.attrs.style || '').split(';')) {
      const separator = entry.indexOf(':');
      if (entry.slice(0, separator).trim() === name) candidates.push({ value: entry.slice(separator + 1).trim().replace(/\s*!important$/, ''), score: 1000 + (/!important\s*$/.test(entry) ? 10000 : 0) });
    }
    if (candidates.length) return candidates.reduce((best, item) => item.score >= best.score ? item : best).value;
  }
}
export function nativeMarkerProperty(element, name) {
  const value = nativeSvgProperty(element, name);
  return value?.replace(/^url\(["']?([^"')]+)["']?\)$/, 'url($1)');
}

function strokeWidth(element) {
  const stroke = nativeProperty(element, 'stroke'), width = nativeProperty(element, 'stroke-width');
  const result = parseFloat(width ?? (stroke && stroke !== 'none' ? '1' : '0'));
  if (!Number.isFinite(result) || result < 0) throw new Error('Invalid native Mermaid stroke width');
  return stroke === 'none' ? 0 : result;
}

function nativeContours(element, options) {
  const contours = flattenShape(element, options);
  // SVG fill 会隐式闭合开放子路径；例如 Mermaid 原生圆柱轮廓并不总以 Z 结束。
  if (nativeProperty(element, 'fill') !== 'none') for (const contour of contours) if (!contour.closed && contour.points.length > 2) {
    contour.closed = true;
    if (pointSegmentDistance(contour.points[0], contour.points.at(-1), contour.points.at(-1)) > epsilon) contour.points.push(contour.points[0]);
  }
  return contours;
}

function rectanglePart(bounds) {
  const { x, y, width, height } = bounds;
  return { fillRule: 'nonzero', contours: [{ closed: true, points: [[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]] }] };
}

function unionBounds(boxes) {
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  return { x, y, width: Math.max(...boxes.map(box => box.x + box.width)) - x, height: Math.max(...boxes.map(box => box.y + box.height)) - y };
}

const nativeLabelBounds = element => {
  const value = element?.attrs['data-label-bounds'];
  if (!value) return null;
  const bounds = JSON.parse(value);
  if (!['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key])) || bounds.width < 0 || bounds.height < 0) throw new Error('Invalid native Mermaid label bounds');
  return bounds;
};

/** 业务节点和容器标题分开建障碍，允许成员连线穿过所属容器正文。 */
export function routingObstacles(view, { tolerance = ROUTING_GEOMETRY.tolerance } = {}) {
  const elements = svgElements(view.svg), obstacles = [];
  const add = (id, kind, shapes, members = [], headerBounds = null) => {
    if (shapes.length) obstacles.push({ id, kind, members, bounds: unionBounds(shapes.map(shapeBounds)), parts: shapes.map(shape => ({
      fillRule: shape.attrs['fill-rule'] || (/fill-rule\s*:\s*evenodd/.test(shape.attrs.style || '') ? 'evenodd' : 'nonzero'), strokeWidth: strokeWidth(shape), contours: nativeContours(shape, { tolerance })
    })) });
    if (headerBounds?.width && headerBounds?.height) obstacles.push({ id, kind: `${kind}-header`, members, bounds: headerBounds, parts: [rectanglePart(headerBounds)] });
  };
  for (const node of view.nodes) {
    const group = (view.entityGroups || []).find(group => group.entity === node.id);
    const semantic = elements.find(element => element.attrs['data-id'] === node.id), instance = semantic?.attrs['data-instance'];
    const own = elements.filter(element => instance && element.attrs['data-shape-part'] === instance);
    if (!own.length) throw new Error(`Missing native route obstacle: ${view.id}/${node.id}`);
    const header = elements.find(element => element.attrs['data-entity-header'] === instance);
    add(node.id, group && node.presentation === 'entity-container' ? 'entity-container' : 'node', own,
      group ? [group.entity, ...group.components] : [node.id], nativeLabelBounds(header) || group?.headerBounds);
  }
  for (const group of view.scheduleGroups || []) {
    const cluster = elements.find(element => element.attrs['data-schedule-id'] === group.id);
    const rect = cluster?.children.find(element => element.tag === 'rect');
    if (!rect) throw new Error(`Missing native Schedule route obstacle: ${view.id}/${group.id}`);
    const label = cluster.children.find(element => element.attrs['data-label-bounds']);
    add(group.id, 'schedule-container', [rect], [group.id, ...group.nodes], nativeLabelBounds(label) || group.labelBounds);
  }
  return obstacles;
}

/** SVG marker 的原生图形映射到路径终点，包含 viewBox、refX/Y、单位与切线方向。 */
export function arrowGeometry(element, elements, { tolerance = ROUTING_GEOMETRY.tolerance, nativeReverse = false } = {}) {
  const side = nativeReverse ? 'start' : 'end', reference = nativeMarkerProperty(element, `marker-${side}`);
  if (!reference || reference === 'none') return null;
  const id = reference.match(/^url\([^#]*#([^)]*)\)$/)?.[1], marker = elements.find(item => item.tag === 'marker' && item.attrs.id === id);
  if (!marker) throw new Error(`Unknown native Mermaid arrow marker: ${id}`);
  const terminal = pathTerminals(element), nativeTangent = nativeReverse ? terminal.startTangent : terminal.endTangent;
  const anchor = nativeReverse ? terminal.start : terminal.end, tangent = nativeReverse ? nativeTangent?.map(value => -value) : nativeTangent;
  if (!anchor || !tangent) throw new Error('Native Mermaid arrow has no terminal tangent');
  const viewport = marker.attrs.viewBox?.trim().split(/[\s,]+/).map(Number), markerWidth = Number(marker.attrs.markerWidth ?? 3), markerHeight = Number(marker.attrs.markerHeight ?? 3);
  const box = viewport || [0, 0, markerWidth, markerHeight];
  if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0 || markerWidth <= 0 || markerHeight <= 0) throw new Error('Invalid native Mermaid marker viewport');
  const ref = [Number(marker.attrs.refX ?? 0), Number(marker.attrs.refY ?? 0)];
  if (!ref.every(Number.isFinite)) throw new Error('Invalid native Mermaid marker reference point');
  const units = marker.attrs.markerUnits ?? 'strokeWidth';
  if (!['strokeWidth', 'userSpaceOnUse'].includes(units)) throw new Error(`Unsupported native Mermaid marker units: ${units}`);
  const unitScale = units === 'strokeWidth' ? strokeWidth(element) || 1 : 1;
  let sx = markerWidth / box[2], sy = markerHeight / box[3];
  if ((marker.attrs.preserveAspectRatio || 'xMidYMid meet') !== 'none') sx = sy = (marker.attrs.preserveAspectRatio || '').includes('slice') ? Math.max(sx, sy) : Math.min(sx, sy);
  const orient = marker.attrs.orient ?? '0', followsPath = ['auto', 'auto-start-reverse'].includes(orient);
  const angle = followsPath ? Math.atan2(nativeTangent[1], nativeTangent[0]) + (nativeReverse && orient === 'auto-start-reverse' ? Math.PI : 0) : parseFloat(orient) * Math.PI / 180;
  if (!Number.isFinite(angle)) throw new Error('Invalid native Mermaid marker orientation');
  const cos = Math.cos(angle), sin = Math.sin(angle), map = point => {
    const x = (point[0] - ref[0]) * sx * unitScale, y = (point[1] - ref[1]) * sy * unitScale;
    return [anchor[0] + cos * x - sin * y, anchor[1] + sin * x + cos * y];
  };
  const descendants = elements.filter(item => { for (let current = item.parent; current; current = current.parent) if (current === marker) return true; return false; });
  const parts = descendants.filter(item => ['path', 'polygon', 'polyline', 'rect', 'circle', 'ellipse', 'line'].includes(item.tag)).map(item => ({
    fillRule: nativeProperty(item, 'fill-rule') || 'nonzero', strokeWidth: strokeWidth(item) * Math.max(sx, sy) * unitScale,
    contours: nativeContours(item, { relativeTo: marker, tolerance: tolerance / Math.max(sx * unitScale, sy * unitScale, 1) }).map(contour => ({ ...contour, points: contour.points.map(map) }))
  }));
  if (!parts.length) throw new Error('Native Mermaid marker has no outline');
  const points = parts.flatMap(part => part.contours.flatMap(contour => contour.points)), projection = point => (point[0] - anchor[0]) * tangent[0] + (point[1] - anchor[1]) * tangent[1];
  const tip = points.reduce((best, point) => projection(point) > projection(best) ? point : best, points[0]);
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  return { parts, bounds: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
    tip, tangent, followsPath, terminal };
}

function arrowTargetIssues(arrow, target, tolerance) {
  if (!arrow || !target) return [];
  const issues = [];
  if (!arrow.followsPath) issues.push('marker-orientation');
  const boundary = boundarySegments(target.parts);
  const boundaryDistance = Math.min(...boundary.map(([first, last]) => pointSegmentDistance(arrow.tip, first, last)));
  const stroke = Math.max(0, ...target.parts.map(part => part.strokeWidth || 0));
  const threshold = 2 * tolerance + stroke / 2 + .5, tipInside = filledContains(arrow.tip, target.parts);
  const boundaryContact = boundarySegments(arrow.parts).some(([first, last]) => boundary.some(([start, end]) => segmentDistance(first, last, start, end) <= threshold));
  if (tipInside ? !boundaryContact : boundaryDistance > threshold) issues.push('marker-target-gap');
  const enters = [1, 2, 4].some(distance => {
    const point = arrow.tip.map((value, axis) => value + arrow.tangent[axis] * distance);
    return filledContains(point, target.parts);
  });
  if (!enters) issues.push('marker-target-direction');
  return issues;
}

function pathSourceIssues(element, source, tolerance, nativeReverse = false) {
  if (!source) return [];
  const terminal = pathTerminals(element), start = nativeReverse ? terminal.end : terminal.start;
  const startTangent = nativeReverse ? terminal.endTangent?.map(value => -value) : terminal.startTangent;
  if (!start || !startTangent) return ['path-source-direction'];
  const boundary = boundarySegments(source.parts);
  const boundaryDistance = point => Math.min(...boundary.map(([first, last]) => pointSegmentDistance(point, first, last)));
  const stroke = Math.max(0, ...source.parts.map(part => part.strokeWidth || 0));
  const threshold = 2 * tolerance + (stroke + strokeWidth(element)) / 2;
  const issues = boundaryDistance(start) > threshold ? ['path-source-gap'] : [];
  // 原生曲线可以沿轮廓相切后离开；检查实际初段是否钻入源节点，不能要求反向切线进入填充。
  const contours = flattenShape(element, { tolerance }), points = nativeReverse ? [...(contours.at(-1)?.points || [])].reverse() : contours[0]?.points || [];
  let remaining = Math.max(8, 2 * threshold), enters = false;
  for (let index = 1; index < points.length && remaining > 0 && !enters; index++) {
    const first = points[index - 1], last = points[index], length = Math.hypot(last[0] - first[0], last[1] - first[1]);
    const checked = Math.min(length, remaining), steps = Math.max(1, Math.ceil(checked / tolerance));
    for (let step = 1; step <= steps && !enters; step++) {
      const ratio = length ? checked * step / steps / length : 0;
      const point = first.map((value, axis) => value + (last[axis] - value) * ratio);
      enters = filledContains(point, source.parts) && boundaryDistance(point) > threshold;
    }
    remaining -= checked;
  }
  if (enters) issues.push('path-source-direction');
  return issues;
}

function permitted(obstacle, endpoints) {
  if (obstacle.kind.endsWith('-header')) return endpoints.includes(obstacle.id);
  if (obstacle.kind.endsWith('-container')) return endpoints.some(endpoint => obstacle.members.includes(endpoint));
  return endpoints.includes(obstacle.id);
}

function edgeLabelObstacles(elements, mermaidId, tolerance) {
  const labels = elements.filter(element => element.attrs['data-mermaid-native-id'] === mermaidId && (element.attrs.class || '').split(/\s+/).includes('label') && element.text.trim());
  return labels.flatMap(label => elements.filter(element => {
    if (element.tag !== 'rect' || !(element.attrs.class || '').split(/\s+/).includes('background')) return false;
    for (let parent = element.parent; parent; parent = parent.parent) if (parent === label) return true;
    return false;
  }).map(rect => ({ bounds: shapeBounds(rect), parts: [{ fillRule: 'nonzero', strokeWidth: strokeWidth(rect), contours: flattenShape(rect, { tolerance }) }] })));
}

function labelObstacle(obstacle, endpoints) {
  const ancestor = obstacle.kind.endsWith('-container') && !endpoints.includes(obstacle.id) && endpoints.some(endpoint => obstacle.members.includes(endpoint));
  if (!ancestor) return obstacle;
  // 成员连线可以在所属容器正文中标注，但标签不能盖住容器边框或标题。
  return { ...obstacle, parts: obstacle.parts.map(part => ({ ...part, contours: part.contours.map(contour => ({ ...contour, closed: false })) })) };
}

/** 编译器和独立校验器均读取最终 SVG；不存在按模型矩形重画连线的路径。 */
export function inspectViewRoutes(view, options = {}) {
  const tolerance = options.tolerance ?? ROUTING_GEOMETRY.tolerance;
  const elements = svgElements(view.svg), obstacles = routingObstacles(view, { tolerance }), edges = [];
  for (const [kind, links, attribute] of [['business', view.links || [], 'data-link-id'], ['schedule', view.scheduleLinks || [], 'data-schedule-link-id']]) for (const link of links) {
    const element = elements.find(element => element.attrs[attribute] === link.id);
    if (!element) throw new Error(`Missing native routing path: ${view.id}/${link.id}`);
    const path = flattenShape(element, { tolerance }), endpoints = displayEndpoints(link), arrow = arrowGeometry(element, elements, { tolerance, nativeReverse: link.nativeReverse === true });
    const collisions = obstacles.filter(obstacle => {
      if (permitted(obstacle, endpoints)) return false;
      return pathIntersectsOutline(path, obstacle, { ...options, tolerance, clearance: (options.clearance || 0) + strokeWidth(element) / 2 })
        || (arrow && outlinesIntersect(arrow, obstacle, { ...options, tolerance }));
    }).map(({ id, kind }) => ({ id, kind }));
    const labels = edgeLabelObstacles(elements, link.mermaidId, tolerance);
    for (const obstacle of obstacles) if (labels.some(label => outlinesIntersect(label, labelObstacle(obstacle, endpoints), { ...options, tolerance }))) {
      collisions.push({ id: obstacle.id, kind: 'edge-label', obstacleKind: obstacle.kind });
    }
    const first = path[0]?.points, last = path.at(-1)?.points;
    const axis = pathAxis(element, options.axisTolerance ?? ROUTING_GEOMETRY.axisTolerance), curveCommands = /[CQAST]/i.test(element.attrs.d);
    edges.push({ id: link.id, mermaidId: link.mermaidId, kind, axis, curved: !axis && pathCurveDeviation(element) > tolerance, curveCommands,
      collisions, arrowIssues: [...pathSourceIssues(element, obstacles.find(obstacle => obstacle.id === endpoints[0] && !obstacle.kind.endsWith('-header')), tolerance, link.nativeReverse === true),
        ...arrowTargetIssues(arrow, obstacles.find(obstacle => obstacle.id === endpoints[1] && !obstacle.kind.endsWith('-header')), tolerance)], start: link.nativeReverse ? last?.at(-1) : first?.[0], end: link.nativeReverse ? first?.[0] : last?.at(-1) });
  }
  return { edges, collisions: edges.flatMap(edge => edge.collisions.map(obstacle => ({ edge: edge.id, ...obstacle }))) };
}

// 静态构建与筛选 Worker 共用原生布局及真实 SVG 轮廓检查，不重写路径。
import { flattenShape, pathTerminals, shapeBounds, svgElements } from './svg-shape-geometry.mjs';
import { ROUTING_CLEARANCE, boundsSeparation, pathIntersectsOutline, visibleShaftLength } from './architecture-routing.mjs';

const geometryTags = new Set(['path', 'polygon', 'polyline', 'rect', 'circle', 'ellipse']);
const titleOf = group => group.children.find(child => child.tag === 'title')?.text;
const hidden = attributes => (attributes.style || '').split(',').includes('invis');
const tolerance = .25;

function rayEntry(point, direction, contours) {
  const distances = [];
  for (const contour of contours) for (let index = 1; index < contour.points.length; index++) {
    const first = contour.points[index - 1], last = contour.points[index], boundary = [last[0] - first[0], last[1] - first[1]];
    const denominator = direction[0] * boundary[1] - direction[1] * boundary[0];
    if (Math.abs(denominator) < 1e-9) continue;
    const offset = [first[0] - point[0], first[1] - point[1]];
    const along = (offset[0] * boundary[1] - offset[1] * boundary[0]) / denominator;
    const across = (offset[0] * direction[1] - offset[1] * direction[0]) / denominator;
    if (along >= -tolerance && across >= 0 && across <= 1) distances.push(Math.max(0, along));
  }
  return distances.length ? Math.min(...distances) : Infinity;
}

function arrowContact(tip, direction, destination) {
  const { x, y, width, height } = destination.bounds;
  const box = [{ closed: true, points: [[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]] }];
  const boxGap = boundsSeparation({ x: tip[0], y: tip[1], width: 0, height: 0 }, destination.bounds);
  const boxRayEntry = rayEntry(tip, direction, box), contourGap = rayEntry(tip, direction, destination.parts.flatMap(part => part.contours));
  const insideBox = tip[0] > x + tolerance && tip[0] < x + width - tolerance && tip[1] > y + tolerance && tip[1] < y + height - tolerance;
  // dot 按矩形裁剪 rounded box；圆角退距由同一前进射线实测，不增加定额容差。
  return { boxGap, boxRayEntry, contourGap, roundedSetback: contourGap - boxRayEntry,
    valid: !insideBox && boxGap <= 4 + tolerance && Number.isFinite(boxRayEntry) && Number.isFinite(contourGap) && contourGap + tolerance >= boxRayEntry };
}

function obstacleOf(shapes) {
  if (!shapes.length) return null;
  const boxes = shapes.map(shapeBounds);
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  return { bounds: { x, y, width: Math.max(...boxes.map(box => box.x + box.width)) - x,
    height: Math.max(...boxes.map(box => box.y + box.height)) - y },
  parts: shapes.map(shape => ({ contours: flattenShape(shape).map(contour => {
    if (shape.attrs.fill === 'none') return contour;
    const points = contour.points, first = points[0], last = points.at(-1);
    return { closed: true, points: first[0] === last[0] && first[1] === last[1] ? points : [...points, first] };
  }), fillRule: shape.attrs['fill-rule'] || 'nonzero', strokeWidth: Number(shape.attrs['stroke-width'] || 0) })) };
}

export function inspectScheduleRoutes(svg, input) {
  const elements = svgElements(svg), groups = elements.filter(element => element.tag === 'g');
  const owners = new Map();
  for (const element of elements) {
    let owner = element.parent;
    while (owner && !['node', 'cluster', 'edge', 'schedule-cluster-title'].includes(owner.attrs.class)) owner = owner.parent;
    owners.set(element, owner);
  }
  const shapesOf = group => elements.filter(element => owners.get(element) === group && geometryTags.has(element.tag));
  const nodes = new Map(), clusters = new Map(), membership = new Map(), ancestors = new Map();
  for (const group of groups.filter(group => ['node', 'cluster'].includes(group.attrs.class))) {
    const outline = obstacleOf(shapesOf(group).filter(shape => shape.attrs.stroke !== 'none'));
    if (outline) (group.attrs.class === 'node' ? nodes : clusters).set(titleOf(group), { ...outline, name: titleOf(group), kind: group.attrs.class });
  }
  const indexCluster = (group, parents = []) => {
    ancestors.set(group.name, parents);
    for (const node of group.nodes || []) membership.set(node.name, group.name);
    for (const child of group.subgraphs || []) indexCluster(child, [...parents, group.name]);
  };
  for (const group of input.subgraphs || []) indexCluster(group);
  const titles = groups.filter(group => ['cluster', 'schedule-cluster-title'].includes(group.attrs.class))
    .map(group => obstacleOf(shapesOf(group).filter(shape => shape.attrs.stroke === 'none' && shape.attrs.fill !== 'none'))).filter(Boolean);
  const endpoint = (edge, side) => clusters.get(edge.attributes?.[side === 'tail' ? 'ltail' : 'lhead'])
    ?? nodes.get(edge[side]) ?? clusters.get(membership.get(edge[side]));
  const contains = (first, last) => first.kind === 'cluster' && (first.name === last.name
    || (last.kind === 'node' ? membership.get(last.name) === first.name || ancestors.get(membership.get(last.name))?.includes(first.name) : ancestors.get(last.name)?.includes(first.name)));
  const edges = new Map(groups.filter(group => group.attrs.class === 'edge').map(group => [group.attrs.id, group]));
  const expectedEdges = new Set(input.edges.flatMap((edge, index) => hidden(edge.attributes || {}) ? [] : [edge.attributes?.id || 'schedule-edge-' + index]));
  for (const id of edges.keys()) if (!expectedEdges.has(id)) throw new Error('Unexpected native Schedule edge: ' + id);
  return input.edges.flatMap((edge, index) => {
    if (hidden(edge.attributes || {})) return [];
    const group = edges.get(edge.attributes?.id || 'schedule-edge-' + index), shapes = group && shapesOf(group), path = shapes?.find(shape => shape.tag === 'path');
    const issues = [], clearanceIssues = [], arrowGaps = {};
    if (!path) return [{ edgeIndex: index, issues: ['missing-path'], clearanceIssues }];
    const source = endpoint(edge, 'tail'), target = endpoint(edge, 'head'), contours = flattenShape(path);
    if (!source || !target) return [{ edgeIndex: index, issues: ['missing-visible-endpoint'], clearanceIssues }];
    const isNested = source.name === target.name || contains(source, target) || contains(target, source);
    const endpointGap = isNested ? null : boundsSeparation(source.bounds, target.bounds);
    const arrows = shapes.filter(shape => shape.tag === 'polygon').map(shape => obstacleOf([shape]));
    // 容器填充先于内部边绘制，祖先背景不遮挡内部箭杆；子轮廓、标题和箭头仍扣除。
    const endpointBlockers = [source, target].filter((endpoint, side) => !contains(endpoint, side === 0 ? target : source));
    const visibleShaft = visibleShaftLength(contours, [...endpointBlockers, ...arrows, ...titles]);
    if (endpointGap !== null && endpointGap < ROUTING_CLEARANCE.endpointGap) clearanceIssues.push('endpoint-gap');
    if (visibleShaft < ROUTING_CLEARANCE.visibleShaft) clearanceIssues.push('visible-shaft');
    const unrelated = [...nodes.values()].filter(node => node.name !== edge.tail && node.name !== edge.head);
    for (const node of unrelated) {
      if (pathIntersectsOutline(contours, node) || arrows.some(arrow => pathIntersectsOutline(arrow.parts[0].contours, node))) issues.push('node-intrusion:' + node.name);
    }
    const terminal = pathTerminals(path), direction = edge.attributes?.dir || 'forward';
    const arrowSides = direction === 'both' ? ['head', 'tail'] : direction === 'back' ? ['tail'] : direction === 'none' ? [] : ['head'];
    for (const side of arrowSides) {
      if (edge.attributes?.[side === 'head' ? 'arrowhead' : 'arrowtail'] === 'none') continue;
      const anchor = side === 'head' ? terminal.end : terminal.start;
      const tangent = (side === 'head' ? terminal.endTangent : terminal.startTangent)?.map(value => value * (side === 'head' ? 1 : -1));
      const ranked = arrows.map(arrow => ({ arrow, points: arrow.parts.flatMap(part => part.contours.flatMap(contour => contour.points)) }))
        .sort((a, b) => Math.min(...a.points.map(point => Math.hypot(point[0] - anchor[0], point[1] - anchor[1])))
          - Math.min(...b.points.map(point => Math.hypot(point[0] - anchor[0], point[1] - anchor[1]))));
      if (!ranked.length || !tangent) { issues.push('missing-arrow:' + side); continue; }
      const { arrow, points } = ranked[0];
      const vertices = [...new Map(points.map(point => [point.join(','), point])).values()];
      if (vertices.length !== 3) { issues.push('unsupported-arrow-outline:' + side); continue; }
      const base = vertices.map((point, at) => ({ at, length: Math.hypot(point[0] - vertices[(at + 1) % 3][0], point[1] - vertices[(at + 1) % 3][1]) }))
        .sort((a, b) => a.length - b.length)[0].at;
      const tip = vertices[(base + 2) % 3], midpoint = vertices[base].map((value, axis) => (value + vertices[(base + 1) % 3][axis]) / 2);
      const vector = tip.map((value, axis) => value - midpoint[axis]), length = Math.hypot(...vector), direction = vector.map(value => value / length);
      const destination = side === 'head' ? target : source, opposite = side === 'head' ? source : target;
      arrowGaps[side] = arrowContact(tip, direction, destination);
      if (direction[0] * tangent[0] + direction[1] * tangent[1] <= 0) issues.push('arrow-reversed:' + side);
      if (!arrowGaps[side].valid) issues.push('arrow-tip-gap:' + side);
      if (!isNested && pathIntersectsOutline(arrow.parts[0].contours, opposite)) issues.push('arrow-source-overlap:' + side);
    }
    return [{ edgeIndex: index, endpointGap, visibleShaft, arrowGaps, issues, clearanceIssues }];
  });
}

export function renderScheduleLayout(viz, input) {
  const graph = structuredClone(input);
  const clusters = new Map();
  const indexCluster = group => { clusters.set(group.name, group); for (const child of group.subgraphs || []) indexCluster(child); };
  for (const group of graph.subgraphs || []) indexCluster(group);
  const constrainClusterEdge = (index, minlen) => {
    const edge = graph.edges[index];
    if (!edge.attributes.ltail && !edge.attributes.lhead) return;
    const namesFor = side => clusters.get(edge.attributes[side === 'tail' ? 'ltail' : 'lhead'])?.nodes.map(node => node.name) ?? [edge[side]];
    // marker 的 rank 不能代表横跨多 rank 的容器，只有失败的 compound 端点补充不可见成员约束。
    for (const tail of namesFor('tail')) for (const head of namesFor('head')) {
      if (tail === head) continue;
      const existing = graph.edges.filter(candidate => candidate.tail === tail && candidate.head === head);
      if (existing.length) {
        for (const candidate of existing) candidate.attributes.minlen = String(Math.max(Number(candidate.attributes.minlen || 1), minlen));
      } else graph.edges.push({ tail, head, attributes: { style: 'invis', minlen: String(minlen) } });
    }
  };
  let svg, routes;
  for (const minlen of [1, 2, 3, 4]) {
    if (minlen > 1) for (const route of routes.filter(route => route.issues.length || route.clearanceIssues.length)) {
      const attributes = graph.edges[route.edgeIndex].attributes;
      attributes.minlen = String(Math.max(Number(attributes.minlen || 1), minlen));
      if (route.clearanceIssues.includes('endpoint-gap')) constrainClusterEdge(route.edgeIndex, minlen);
    }
    const result = viz.render(graph, { engine: 'dot', format: 'svg' });
    if (result.status !== 'success' || result.errors.some(error => error.level === 'error')) throw new Error('Schedule Graphviz layout failed: ' + result.errors.map(error => error.message).join('\n'));
    svg = result.output;
    routes = inspectScheduleRoutes(svg, graph);
    if (routes.every(route => !route.issues.length && !route.clearanceIssues.length)) return { svg, routes, minlen };
  }
  throw new Error('Schedule native routing validation failed: ' + JSON.stringify(routes.filter(route => route.issues.length || route.clearanceIssues.length)));
}

// 聚焦仅依赖当前对象图的可见端点；邻居的其他关系不参与扩张。
export function computeObjectFocus(view, selection = { kind: 'none' }) {
  const selectedNodes = new Set(), dimNodes = new Set(), focusedEdges = new Set(), dimEdges = new Set();
  const result = { selectedNodes, dimNodes, focusedEdges, dimEdges };
  if (view?.aspect !== 'object') return result;
  const visibleNodes = new Set(view.nodes.map(node => node.id));
  const edges = view.links.map(link => ({ id: link.id, from: link.displayFrom ?? link.from, to: link.displayTo ?? link.to }))
    .filter(link => visibleNodes.has(link.from) && visibleNodes.has(link.to));
  const relevant = new Set();
  if (selection.kind === 'node' && visibleNodes.has(selection.id)) {
    selectedNodes.add(selection.id); relevant.add(selection.id);
    for (const link of edges) if (link.from === selection.id || link.to === selection.id) {
      focusedEdges.add(link.id); relevant.add(link.from); relevant.add(link.to);
    }
  } else if (selection.kind === 'edge') {
    const link = edges.find(link => link.id === selection.id);
    if (!link) return result;
    focusedEdges.add(link.id);
    for (const id of [link.from, link.to]) { selectedNodes.add(id); relevant.add(id); }
  } else return result;
  for (const id of visibleNodes) if (!relevant.has(id)) dimNodes.add(id);
  for (const link of edges) if (!focusedEdges.has(link.id)) dimEdges.add(link.id);
  return result;
}

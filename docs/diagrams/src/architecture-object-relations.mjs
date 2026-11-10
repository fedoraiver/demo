// 高密度呈现只投影既有一跳关系；完整目录与编译器证据不随搜索或选择改变。
export const DENSE_OBJECT_RELATION_THRESHOLD = 64;

export function displayEdgesOf(view) {
  return view?.visualEdgeGroups ?? view?.links ?? [];
}

export function findVisualEdge(view, id) {
  const edges = displayEdgesOf(view);
  const exact = edges.find(edge => edge.id === id);
  if (exact) return exact;
  const memberId = typeof id === 'string' && id.startsWith('visual-edge-') ? id.slice('visual-edge-'.length) : id;
  return edges.find(edge => edge.forwardIds?.includes(memberId) || edge.backwardIds?.includes(memberId));
}

export function isDenseObjectView(view, threshold = DENSE_OBJECT_RELATION_THRESHOLD) {
  const count = view?.visualEdgeCount ?? view?.visualEdgeGroups?.length ?? view?.relationCount ?? view?.links?.length;
  return view?.aspect === 'object' && Number.isSafeInteger(count) && count >= threshold;
}

export function objectRelationRenderKey(buildId, viewId, relationId) {
  return JSON.stringify([buildId, viewId, relationId]);
}

export function relationRows(fullView, registry, query = '', edgeStyles = {}) {
  const words = String(query).trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const canonical = new Map(fullView.links.map(link => [link.id, link]));
  return displayEdgesOf(fullView).map(link => {
    const from = registry[link.from], to = registry[link.to];
    const row = {
      id: link.id, link, from: link.from, to: link.to,
      bidirectional: Boolean(link.forwardIds?.length && link.backwardIds?.length),
      fromName: from?.name || link.from, toName: to?.name || link.to,
      label: link.displayLabel || link.label || edgeStyles[link.edgeSemantic]?.label || link.edgeSemantic || link.kind,
    };
    const memberIds = new Set([...(link.forwardIds || []), ...(link.backwardIds || [])]);
    const members = memberIds.size ? [...memberIds].map(id => canonical.get(id)).filter(Boolean) : [link];
    const sources = members.flatMap(member => [...(member.sourceEvidence || []), ...(member.sourceEntries || [])]);
    const conditions = members.flatMap(member => (member.bodyOperations || []).flatMap(operation => (operation.conditions || []).map(condition => condition.expression)));
    const text = [
      row.id, row.fromName, row.toName, link.from, link.to, link.kind, link.edgeSemantic,
      row.label, link.displayLabel, link.label, link.description,
      ...members.flatMap(member => [member.id, member.kind, member.factKind, member.label, member.displayLabel,
        member.description, ...(member.notes || []), ...(member.sourceGaps || [])]), ...conditions,
      ...sources.flatMap(source => [source.path, source.line, source.column, source.label, source.expression]),
    ].filter(value => ['string', 'number', 'boolean'].includes(typeof value)).join(' ').toLocaleLowerCase();
    return { row, text };
  }).filter(({ text }) => words.every(word => text.includes(word))).map(({ row }) => row);
}

export function projectObjectRelation(fullView, relationId) {
  if (fullView?.aspect !== 'object' || !Array.isArray(fullView.nodes) || !Array.isArray(fullView.links)) throw new Error('Invalid object relation view');
  const group = findVisualEdge(fullView, relationId);
  if (!group) throw new Error('Unknown or duplicate object relation: ' + relationId);
  const memberIds = new Set([...(group.forwardIds || []), ...(group.backwardIds || [])]);
  const links = fullView.links.filter(link => memberIds.size ? memberIds.has(link.id) : link.id === group.id);
  if (links.length !== (memberIds.size || 1)) throw new Error('Unknown, duplicate or missing object relation group member: ' + relationId);
  const endpoints = new Set([group.displayFrom ?? group.from, group.displayTo ?? group.to]);
  const nodes = fullView.nodes.filter(node => endpoints.has(node.id));
  if (nodes.length !== endpoints.size || new Set(nodes.map(node => node.id)).size !== endpoints.size) throw new Error('Object relation display endpoint is missing');
  const centerNodeId = fullView.centerNodeId || fullView.objectId;
  if (!endpoints.has(centerNodeId)) throw new Error('Object relation is not incident to its center');
  return { centerNodeId, nodes, links, ...(fullView.visualEdgeGroups ? { visualEdgeGroups: [group] } : {}) };
}

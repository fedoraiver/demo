// 高密度呈现只投影既有一跳关系；完整目录与编译器证据不随搜索或选择改变。
export const DENSE_OBJECT_RELATION_THRESHOLD = 64;

export function isDenseObjectView(view, threshold = DENSE_OBJECT_RELATION_THRESHOLD) {
  const count = view?.relationCount ?? view?.links?.length;
  return view?.aspect === 'object' && Number.isSafeInteger(count) && count >= threshold;
}

export function objectRelationRenderKey(buildId, viewId, relationId) {
  return JSON.stringify([buildId, viewId, relationId]);
}

export function relationRows(fullView, registry, query = '', edgeStyles = {}) {
  const words = String(query).trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return fullView.links.map(link => {
    const from = registry[link.from], to = registry[link.to];
    const row = {
      id: link.id, link, from: link.from, to: link.to,
      fromName: from?.name || link.from, toName: to?.name || link.to,
      label: link.displayLabel || link.label || edgeStyles[link.edgeSemantic]?.label || link.edgeSemantic || link.kind,
    };
    const sources = [...(link.sourceEvidence || []), ...(link.sourceEntries || [])];
    const conditions = (link.bodyOperations || []).flatMap(operation => (operation.conditions || []).map(condition => condition.expression));
    const text = [
      row.id, row.fromName, row.toName, link.from, link.to, link.kind, link.edgeSemantic,
      row.label, link.displayLabel, link.label, link.description,
      ...(link.notes || []), ...(link.sourceGaps || []), ...conditions,
      ...sources.flatMap(source => [source.path, source.line, source.column, source.label, source.expression]),
    ].filter(value => ['string', 'number', 'boolean'].includes(typeof value)).join(' ').toLocaleLowerCase();
    return { row, text };
  }).filter(({ text }) => words.every(word => text.includes(word))).map(({ row }) => row);
}

export function projectObjectRelation(fullView, relationId) {
  if (fullView?.aspect !== 'object' || !Array.isArray(fullView.nodes) || !Array.isArray(fullView.links)) throw new Error('Invalid object relation view');
  const links = fullView.links.filter(link => link.id === relationId);
  if (links.length !== 1) throw new Error('Unknown or duplicate object relation: ' + relationId);
  const link = links[0], endpoints = new Set([link.displayFrom ?? link.from, link.displayTo ?? link.to]);
  const nodes = fullView.nodes.filter(node => endpoints.has(node.id));
  if (nodes.length !== endpoints.size || new Set(nodes.map(node => node.id)).size !== endpoints.size) throw new Error('Object relation display endpoint is missing');
  const centerNodeId = fullView.centerNodeId || fullView.objectId;
  if (!endpoints.has(centerNodeId)) throw new Error('Object relation is not incident to its center');
  return { centerNodeId, nodes, links };
}

import { scheduleNodeKind, validateScheduleGraph } from './schedule-graph.mjs';

export const SCHEDULE_LEGEND_LABELS = Object.freeze({
  system: 'System',
  system_set: 'SystemSet',
  context: 'Synchronization / scheduling context',
  order: 'Explicit ordering',
  set_membership: 'SystemSet membership',
});

const invisible = attributes => (attributes.style || '').split(',').some(value => value.trim() === 'invis');

/** 按实际保留的图元分类；marker 不单列，但与其相接的可见边仍保留语义。 */
export function scheduleLegendKinds(model) {
  validateScheduleGraph(model);
  const present = new Set();
  for (const node of model.nodes) {
    const kind = scheduleNodeKind(node);
    if (kind !== 'marker') present.add(kind);
  }
  if (model.subgraphs.some(group => group.nodes.length)) present.add('system_set');
  for (const edge of model.edges) {
    if (invisible(edge.attributes)) continue;
    const direction = edge.attributes.dir || 'forward';
    if (direction === 'none') present.add('set_membership');
    else if (direction === 'forward') present.add('order');
  }
  return Object.keys(SCHEDULE_LEGEND_LABELS).filter(kind => present.has(kind));
}

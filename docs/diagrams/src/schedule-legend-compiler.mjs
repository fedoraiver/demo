import { scheduleGraphInput, SCHEDULE_MODEL_VERSION } from './schedule-graph.mjs';
import { SCHEDULE_THEME } from './schedule-theme.mjs';
import { normalizeScheduleSvg } from './schedule-svg.mjs';
import { svgElements, shapeBounds } from './svg-shape-geometry.mjs';
import { SCHEDULE_LEGEND_LABELS } from './schedule-legend.mjs';

function sampleModel(kind) {
  const id = 'guide-schedule-' + kind;
  const model = { schemaVersion: SCHEDULE_MODEL_VERSION, name: id, directed: true, strict: false,
    attributes: { id: id + '-graph', rankdir: 'LR', margin: '0', pad: '0.06', ranksep: '0.8' },
    nodes: [], edges: [], subgraphs: [] };
  if (kind === 'system' || kind === 'context') {
    model.nodes.push({ name: 'sample', attributes: { id: id + '-node', label: '', width: '1.75', height: '0.416667', fixedsize: 'true',
      ...(kind === 'system' ? { tooltip: 'Legend sample: registered system' } : {}) } });
  } else if (kind === 'system_set') {
    model.nodes.push({ name: 'marker', attributes: { id: id + '-marker', style: 'invis', shape: 'box', label: '',
      width: '1.527778', height: '0.194444', fixedsize: 'true' } });
    model.subgraphs.push({ name: 'cluster_sample', attributes: { id: id + '-cluster', label: '', margin: '8' },
      nodes: ['marker'], edges: [], subgraphs: [] });
  } else {
    model.nodes.push(...['from', 'to'].map(name => ({ name, attributes: { id: id + '-' + name,
      style: 'invis', shape: 'point', label: '', width: '0', height: '0' } })));
    model.edges.push({ tail: 'from', head: 'to', attributes: { id: id + '-edge', dir: kind === 'order' ? 'forward' : 'none' } });
  }
  return { id, model };
}

/** 图例共用对象指南的透明底、无字横向样例，轮廓与连线仍由 Graphviz 生成。 */
export function compileScheduleGuideSamples(viz, dom = globalThis) {
  const samples = { nodes: {}, edges: {} };
  for (const kind of Object.keys(SCHEDULE_LEGEND_LABELS)) {
    const { id, model } = sampleModel(kind);
    const input = scheduleGraphInput(model, { ...SCHEDULE_THEME, background: 'transparent' });
    // 集合样例不需要正式图的标题 TABLE，也不保留标题的布局空间。
    for (const group of input.subgraphs) group.graphAttributes.label = '';
    const normalized = normalizeScheduleSvg(viz.renderString(input, { engine: 'dot', format: 'svg' }), id, dom);
    const document = new dom.DOMParser().parseFromString(normalized.svg, 'image/svg+xml');
    const root = document.documentElement, serializer = new dom.XMLSerializer();
    const parts = svgElements(normalized.svg).filter(element => ['path', 'polygon'].includes(element.tag)
      && element.parent?.attrs.class !== 'graph');
    const boxes = parts.map(shapeBounds);
    if (!boxes.length) throw new Error('Missing Schedule guide geometry: ' + kind);
    const x = Math.min(...boxes.map(box => box.x)) - 5, y = Math.min(...boxes.map(box => box.y)) - 5;
    const width = Math.max(...boxes.map(box => box.x + box.width)) - x + 5;
    const height = Math.max(...boxes.map(box => box.y + box.height)) - y + 5;
    root.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
    root.setAttribute('width', String(width)); root.setAttribute('height', String(height));
    root.setAttribute('aria-label', SCHEDULE_LEGEND_LABELS[kind]);
    samples[kind === 'order' || kind === 'set_membership' ? 'edges' : 'nodes'][kind] = serializer.serializeToString(root);
  }
  return samples;
}

import { scheduleNodeKind } from './schedule-graph.mjs';

const UNCLASSIFIED = Object.freeze({ id: 'source:unclassified', label: '未归类', description: '导出名称未提供可识别的系统来源' });

function splitTopLevel(value, separator = ',') {
  const stack = [], pairs = { ')': '(', ']': '[', '}': '{', '>': '<' }, parts = [];
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (!stack.length && value.startsWith(separator, index)) {
      parts.push(value.slice(start, index).trim());
      index += separator.length - 1;
      start = index + 1;
    } else if ('([{<'.includes(char)) stack.push(char);
    else if (Object.hasOwn(pairs, char) && !(char === '>' && value[index - 1] === '-')) {
      if (stack.pop() !== pairs[char]) return null;
    }
  }
  return stack.length ? null : [...parts, value.slice(start).trim()];
}

function qualifiedSource(name) {
  let depth = 0;
  for (let index = 0; index < name.length; index++) {
    if (name[index] === '<') depth++;
    else if (name[index] === '>' && name[index - 1] !== '-' && --depth === 0) {
      if (!name.slice(index + 1).startsWith('::')) return null;
      const parts = splitTopLevel(name.slice(1, index), ' as ');
      return parts && parts.length <= 2 ? parts.at(-1) : null;
    }
  }
  return null;
}

function sourceIds(name, projectByFeature) {
  if (name.startsWith('Pipe(') && name.endsWith(')')) {
    const stages = splitTopLevel(name.slice(5, -1));
    return stages?.length === 2 && stages.every(Boolean)
      ? [...new Set(stages.flatMap(stage => sourceIds(stage, projectByFeature)))] : [UNCLASSIFIED.id];
  }
  if (name.startsWith('<')) {
    const source = qualifiedSource(name);
    return source ? sourceIds(source, projectByFeature) : [UNCLASSIFIED.id];
  }
  const path = /^([A-Za-z_]\w*)::([A-Za-z_]\w*)/.exec(name);
  if (!path) return [UNCLASSIFIED.id];
  if (path[1] === 'demo') return [projectByFeature.get(path[2]) || UNCLASSIFIED.id];
  return ['crate:' + path[1]];
}

/** 分组表示系统名称中的定义来源，不声称恢复了导出时未记录的注册 Plugin。 */
export function buildSchedulePluginGroups({ model, views }) {
  const projectCatalog = (model.features || []).map(feature => ({ id: 'plugin-' + feature.plugin, label: feature.plugin,
    description: feature.label + ' · demo::' + feature.id }));
  const projectByFeature = new Map((model.features || []).map((feature, index) => [feature.id, projectCatalog[index].id]));
  const dependencies = new Set();
  let hasUnclassified = false;
  const groupedViews = views.map(view => {
    if (view.aspect !== 'schedule') return view;
    const groups = new Map();
    for (const node of view.scheduleGraph.nodes) {
      if (scheduleNodeKind(node) !== 'system') continue;
      const name = node.attributes.tooltip;
      for (const id of sourceIds(name, projectByFeature)) {
        if (id.startsWith('crate:')) dependencies.add(id.slice(6));
        if (id === UNCLASSIFIED.id) hasUnclassified = true;
        if (!groups.has(id)) groups.set(id, { names: new Set(), count: 0 });
        groups.get(id).names.add(name);
        groups.get(id).count++;
      }
    }
    return { ...view, schedulePluginGroups: [...groups].map(([id, group]) => ({ id, systemNames: [...group.names], systemCount: group.count })) };
  });
  const catalog = [...projectCatalog, ...[...dependencies].sort().map(crate => ({ id: 'crate:' + crate, label: crate, description: '依赖系统来源' })),
    ...(hasUnclassified ? [{ ...UNCLASSIFIED }] : [])];
  const order = new Map(catalog.map((entry, index) => [entry.id, index]));
  for (const view of groupedViews) if (view.aspect === 'schedule') view.schedulePluginGroups.sort((a, b) => order.get(a.id) - order.get(b.id));
  return { catalog, views: groupedViews };
}

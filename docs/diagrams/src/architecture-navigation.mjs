// 离线页面与测试共用导航；旧插件入口由查看器按真实对象目录迁移。
import { INFRASTRUCTURE_FEATURES } from './architecture-infrastructure.mjs';

const infrastructureIds = INFRASTRUCTURE_FEATURES.map(feature => feature.id);

export function defaultArchitectureSchedule(schedules) {
  return schedules.find(view => view.application === 'main' && view.scheduleLabel === 'Update' && view.systemCount > 0)?.id
    || schedules.find(view => view.systemCount > 0)?.id || schedules[0]?.id || null;
}

export function resolveArchitectureSelection(search, features, schedules = []) {
  const params = new URLSearchParams(search), requestedSchedule = params.get('schedule')?.trim();
  const schedule = schedules.some(view => view.id === requestedSchedule) ? requestedSchedule : defaultArchitectureSchedule(schedules);
  const ids = new Set(['overview', 'third_party', ...infrastructureIds, ...features.map(feature => typeof feature === 'string' ? feature : feature.id)]);
  const requestedFeature = params.get('feature'), legacyFeature = ids.has(requestedFeature) ? requestedFeature : null;
  const object = params.get('object')?.trim() || params.get('component')?.trim();
  const node = (!requestedFeature || legacyFeature || object) ? params.get('node')?.trim() || null : null;
  const scheduleNode = params.get('scheduleNode')?.trim();
  const legacyAspect = ['data', 'events'].includes(params.get('tab')) ? params.get('tab') : null;
  const filters = Object.fromEntries(['scheduleInclude', 'scheduleExclude'].map(key => [key, params.get(key)?.trim()]).filter(([, value]) => value));
  for (const [key, parameter] of [['scheduleIncludeSystems', 'scheduleIncludeSystem'], ['scheduleExcludeSystems', 'scheduleExcludeSystem'], ['scheduleIncludePlugins', 'scheduleIncludePlugin'], ['scheduleExcludePlugins', 'scheduleExcludePlugin']]) {
    const names = [...new Set(params.getAll(parameter).filter(Boolean))];
    if (names.length) filters[key] = names;
  }
  return { schedule, node, ...filters, ...(scheduleNode ? { scheduleNode } : {}), ...(object ? { object } : {}), ...(legacyFeature ? { legacyFeature } : {}), ...(legacyAspect ? { legacyAspect } : {}) };
}

/** 只更新架构导航参数，保留工作区、其他参数与片段，不触发实际页面导航。 */
export function architectureUrl(selection, href, features, schedules = []) {
  const params = new URLSearchParams();
  if (selection.schedule) params.set('schedule', selection.schedule);
  if (selection.node) params.set('node', selection.node);
  if (selection.scheduleNode) params.set('scheduleNode', selection.scheduleNode);
  if (selection.object || selection.component) params.set('object', selection.object || selection.component);
  if (selection.feature || selection.legacyFeature) params.set('feature', selection.feature || selection.legacyFeature);
  for (const key of ['scheduleInclude', 'scheduleExclude']) if (selection[key]?.trim()) params.set(key, selection[key].trim());
  for (const [key, parameter] of [['scheduleIncludeSystems', 'scheduleIncludeSystem'], ['scheduleExcludeSystems', 'scheduleExcludeSystem'], ['scheduleIncludePlugins', 'scheduleIncludePlugin'], ['scheduleExcludePlugins', 'scheduleExcludePlugin']]) {
    for (const name of selection[key] || []) if (name) params.append(parameter, name);
  }
  const normalized = resolveArchitectureSelection(params, features, schedules);
  const url = new URL(href);
  for (const key of ['schedule', 'object', 'node', 'scheduleNode', 'scheduleInclude', 'scheduleExclude']) {
    if (normalized[key]) url.searchParams.set(key, normalized[key]);
    else url.searchParams.delete(key);
  }
  for (const [key, parameter] of [['scheduleIncludeSystems', 'scheduleIncludeSystem'], ['scheduleExcludeSystems', 'scheduleExcludeSystem'], ['scheduleIncludePlugins', 'scheduleIncludePlugin'], ['scheduleExcludePlugins', 'scheduleExcludePlugin']]) {
    url.searchParams.delete(parameter);
    for (const name of normalized[key] || []) url.searchParams.append(parameter, name);
  }
  if (normalized.legacyFeature) url.searchParams.set('feature', normalized.legacyFeature);
  else url.searchParams.delete('feature');
  url.searchParams.delete('tab'); url.searchParams.delete('component');
  return url.href;
}

/** 为当前清单创建同一组可供构建工具和页面调用的导航函数。 */
export function createArchitectureNavigation(features, schedules = []) {
  return {
    resolve: search => resolveArchitectureSelection(search, features, schedules),
    url: (selection, href) => architectureUrl(selection, href, features, schedules),
  };
}

/** 返回完全内嵌的导航代码；功能名称作为安全 JSON 数据进入页面。 */
export function architectureNavigationAssets(features, schedules = []) {
  const ids = features.map(feature => typeof feature === 'string' ? feature : feature.id);
  const entries = schedules.map(({ id, application, scheduleLabel, systemCount }) => ({ id, application, scheduleLabel, systemCount }));
  const serialize = value => JSON.stringify(value).replace(/</g, '\\u003c');
  return { script: `const architectureNavigation=(()=>{\nconst infrastructureIds=${serialize(infrastructureIds)};\n${defaultArchitectureSchedule.toString()}\n${resolveArchitectureSelection.toString()}\n${architectureUrl.toString()}\n${createArchitectureNavigation.toString()}\nreturn createArchitectureNavigation(${serialize(ids)},${serialize(entries)});\n})();` };
}

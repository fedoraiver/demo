// 共享离线页面的导航规则；纯函数与内嵌脚本共用实现，避免 URL 状态分叉。
import { INFRASTRUCTURE_FEATURES } from './architecture-infrastructure.mjs';

const aspects = ['systems', 'data', 'events'];
const infrastructureIds = INFRASTRUCTURE_FEATURES.map(feature => feature.id);

/** 将查询参数解析为一个已知功能与页签；无效入口回到可见的默认页面。 */
export function resolveArchitectureSelection(search, features) {
  // 旧合并入口先保留 node，查看器再依据清单归属标准化到实际页面。
  const ids = new Set(['overview', 'third_party', ...infrastructureIds, ...features.map(feature => typeof feature === 'string' ? feature : feature.id)]);
  const params = new URLSearchParams(search);
  const requested = params.get('feature') || 'overview';
  const feature = ids.has(requested) ? requested : 'overview';
  const aspect = feature === 'overview' ? 'overview' : aspects.includes(params.get('tab')) ? params.get('tab') : 'systems';
  const node = feature === requested ? params.get('node')?.trim() || null : null;
  return { feature, aspect, node };
}

/** 只更新架构导航参数，保留工作区、其他参数与片段，不触发实际页面导航。 */
export function architectureUrl(selection, href, features) {
  const params = new URLSearchParams();
  params.set('feature', selection.feature || 'overview');
  if (selection.aspect) params.set('tab', selection.aspect);
  if (selection.node) params.set('node', selection.node);
  const normalized = resolveArchitectureSelection(params, features);
  const url = new URL(href);
  url.searchParams.set('feature', normalized.feature);
  if (normalized.aspect === 'overview') url.searchParams.delete('tab');
  else url.searchParams.set('tab', normalized.aspect);
  if (normalized.node) url.searchParams.set('node', normalized.node);
  else url.searchParams.delete('node');
  return url.href;
}

/** 为当前清单创建同一组可供构建工具和页面调用的导航函数。 */
export function createArchitectureNavigation(features) {
  return {
    resolve: search => resolveArchitectureSelection(search, features),
    url: (selection, href) => architectureUrl(selection, href, features),
  };
}

/** 返回完全内嵌的导航代码；功能名称作为安全 JSON 数据进入页面。 */
export function architectureNavigationAssets(features) {
  const ids = features.map(feature => typeof feature === 'string' ? feature : feature.id);
  const serialized = JSON.stringify(ids).replace(/</g, '\\u003c');
  return { script: `const architectureNavigation=(()=>{\nconst aspects=${JSON.stringify(aspects)};\nconst infrastructureIds=${JSON.stringify(infrastructureIds)};\n${resolveArchitectureSelection.toString()}\n${architectureUrl.toString()}\n${createArchitectureNavigation.toString()}\nreturn createArchitectureNavigation(${serialized});\n})();` };
}

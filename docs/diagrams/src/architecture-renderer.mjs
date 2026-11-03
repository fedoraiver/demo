// Node 构建入口注入需要哈希的 Observer 分支装配；对象原生渲染共用无 Node 依赖的核心。
import { renderGraphView as renderCoreGraphView } from './architecture-renderer-core.mjs';
import { buildObserverPlacement } from './architecture-model.mjs';
export * from './architecture-renderer-core.mjs';

export function renderGraphView(view, graph, registry, features, scheduleGroups) {
  return renderCoreGraphView(view, graph, registry, features, scheduleGroups, { buildObserverPlacement });
}

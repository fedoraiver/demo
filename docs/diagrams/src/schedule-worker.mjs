// 仅在提交非空筛选时创建；WASM 与 Graphviz 都随 Worker 源码内嵌。
import { instance } from '@viz-js/viz';
import { renderScheduleLayout } from './schedule-layout.mjs';

let renderer;
globalThis.onmessage = async event => {
  const { id, graph } = event.data;
  try {
    const viz = await (renderer ??= instance());
    const { svg } = renderScheduleLayout(viz, graph);
    globalThis.postMessage({ id, svg });
  } catch (error) {
    globalThis.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};

// 仅在提交非空筛选时创建；WASM 与 Graphviz 都随 Worker 源码内嵌。
import { instance } from '@viz-js/viz';

let renderer;
globalThis.onmessage = async event => {
  const { id, graph } = event.data;
  try {
    const viz = await (renderer ??= instance());
    const result = viz.render(graph, { format: 'svg', engine: 'dot' });
    if (result.status !== 'success' || result.errors.some(error => error.level === 'error')) throw new Error(result.errors.map(error => error.message).join('\n') || 'Graphviz rendering failed');
    globalThis.postMessage({ id, svg: result.output });
  } catch (error) {
    globalThis.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};

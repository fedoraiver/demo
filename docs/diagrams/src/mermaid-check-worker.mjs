// Node 专用线程只执行既有纯 SVG 检查，不导入浏览器编译器或创建 Chrome。
import { parentPort } from 'node:worker_threads';
import { nativeLabelMismatches } from './mermaid-core.mjs';
import { inspectViewRoutes } from './architecture-routing.mjs';
import { checkMermaidGeometry } from './diagram-geometry.mjs';

const checks = {
  labels: nativeLabelMismatches,
  routes: inspectViewRoutes,
  geometry: view => checkMermaidGeometry(view.svg, view),
};

parentPort.on('message', ({ id, operation, view }) => {
  try {
    if (!Object.hasOwn(checks, operation)) throw new Error('Unknown Mermaid check operation: ' + operation);
    parentPort.postMessage({ id, result: checks[operation](view) });
  } catch (error) {
    parentPort.postMessage({ id, error });
  }
});

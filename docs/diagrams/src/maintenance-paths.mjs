import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { repositoryRoot } from './paths.mjs';

export { repositoryRoot };
export const maintenanceScripts = 'docs/diagrams/src';

// 导出阶段跟踪执行模块的新路径；阶段缓存失效不改变真实导出的来源契约。
export const exportProducerInputs = [
  ...['maintenance-runner.mjs', 'maintenance-inputs.mjs', 'maintenance-execution.mjs', 'maintenance-export-context.mjs',
    'maintenance-compiler-selection.mjs', 'maintenance-paths.mjs'].map(name => `${maintenanceScripts}/${name}`),
  'docs/diagrams/src/debugdump-input.mjs', 'docs/diagrams/src/paths.mjs',
  'docs/diagrams/package.json', 'docs/diagrams/package-lock.json',
];

// 维护入口复用图包的 npm 环境，仅在实际使用时加载依赖。
const diagramRequire = createRequire(path.join(repositoryRoot, 'docs/diagrams/package.json'));
export const importDiagramDependency = name => import(pathToFileURL(diagramRequire.resolve(name)).href);

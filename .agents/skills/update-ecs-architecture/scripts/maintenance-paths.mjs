import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { repositoryRoot } from '../../../../docs/diagrams/src/paths.mjs';

export { repositoryRoot };
export const maintenanceScripts = '.agents/skills/update-ecs-architecture/scripts';

// 导出阶段跟踪执行模块的新路径；阶段缓存失效不改变真实导出的来源契约。
export const exportProducerInputs = [
  ...['maintenance-runner.mjs', 'maintenance-inputs.mjs', 'maintenance-execution.mjs', 'maintenance-export-context.mjs',
    'maintenance-compiler-selection.mjs', 'maintenance-paths.mjs'].map(name => `${maintenanceScripts}/${name}`),
  'docs/diagrams/src/debugdump-input.mjs', 'docs/diagrams/src/paths.mjs',
  'docs/diagrams/package.json', 'docs/diagrams/package-lock.json',
];

// Skill 不拥有第二套 npm 环境；按工具所属仓库解析，且只在实际使用时加载依赖。
const diagramRequire = createRequire(path.join(repositoryRoot, 'docs/diagrams/package.json'));
export const importDiagramDependency = name => import(pathToFileURL(diagramRequire.resolve(name)).href);

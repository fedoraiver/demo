import { createRequire } from 'node:module';
import { readFileSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
export const defaultWorkspace = path.resolve(toolDirectory, '../..');
const digest = value => createHash('sha256').update(value).digest('hex');

// 依赖只能从当前检出专用的临时运行目录解析，避免误用其他工作树的安装。
export async function dependencies() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('review-docs 需要 Node.js >=22.13.0');
  const runtime = path.join(defaultWorkspace, 'tmp/review-docs/runtime');
  try {
    for (const relative of ['tmp', 'tmp/review-docs', 'tmp/review-docs/runtime']) if (lstatSync(path.join(defaultWorkspace, relative)).isSymbolicLink()) throw new Error('运行目录禁止链接');
    const verifyTree = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`运行依赖禁止链接: ${absolute}`);
        if (entry.isDirectory()) verifyTree(absolute);
      }
    };
    verifyTree(runtime);
    for (const name of ['package.json', 'package-lock.json']) {
      if (digest(readFileSync(path.join(toolDirectory, name))) !== digest(readFileSync(path.join(runtime, name)))) {
        throw new Error(`${name} 与受控版本不一致`);
      }
    }
    const require = createRequire(path.join(runtime, 'package.json'));
    const names = ['unified', 'remark-parse', 'remark-gfm', 'github-slugger', 'yaml', 'parse5'];
    const modules = await Promise.all(names.map(name => {
      const resolved = realpathSync(require.resolve(name));
      if (path.relative(runtime, resolved).startsWith('..')) throw new Error('运行依赖越界');
      return import(pathToFileURL(resolved).href);
    }));
    return { unified: modules[0].unified, remarkParse: modules[1].default, remarkGfm: modules[2].default,
      Slugger: modules[3].default, yaml: modules[4], html: modules[5] };
  } catch (error) {
    throw new Error(`依赖缺失或锁文件不匹配，请显式运行 scripts/check-docs.ps1 -InstallDependencies。${error.message}`);
  }
}

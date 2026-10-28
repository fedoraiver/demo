// 按维护清单中明确指定的声明定位源码，缺失或歧义必须中止，避免静默丢失节点。
import fs from 'node:fs';
import path from 'node:path';

export function createSourceLocator(root) {
  const sources = new Map();
  return function locateSource(sourcePath, pattern) {
    if (!sources.has(sourcePath)) {
      sources.set(sourcePath, fs.readFileSync(path.resolve(root, sourcePath), 'utf8').split(/\r?\n/));
    }
    const matches = [];
    sources.get(sourcePath).forEach((line, index) => {
      if (typeof pattern === 'string' ? line.includes(pattern) : pattern.test(line)) matches.push(index + 1);
    });
    if (matches.length !== 1) {
      throw new Error(`Expected one source match for ${sourcePath}: ${pattern}; found ${matches.length}`);
    }
    return { path: sourcePath, line: matches[0] };
  };
}

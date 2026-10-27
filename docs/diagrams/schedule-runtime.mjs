// 构建时打包一次本地依赖；输出脚本无需 CDN、fetch 或独立 WASM 文件。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
export { createScheduleRenderer } from './schedule-runtime-browser.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
let assets;

/** 返回可嵌入离线 HTML 的运行时；Worker 直到非空筛选提交才启动。 */
export function scheduleRuntimeAssets() {
  return assets ??= (async () => {
    const worker = await build({ entryPoints: [path.join(directory, 'schedule-worker.mjs')], bundle: true, write: false,
      format: 'iife', platform: 'browser', target: 'es2022', minify: true, legalComments: 'inline' });
    const workerSource = worker.outputFiles[0].text;
    const runtime = await build({ stdin: { contents: "import { createScheduleRenderer } from './schedule-runtime-browser.mjs';\n"
      + 'window.createScheduleRenderer = options => createScheduleRenderer({ workerSource: ' + JSON.stringify(workerSource) + ', ...options });',
    resolveDir: directory, sourcefile: 'schedule-runtime-inline.mjs' }, bundle: true, write: false,
    format: 'iife', platform: 'browser', target: 'es2022', minify: true, legalComments: 'inline', supported: { 'template-literal': false } });
    // JSON 中的用户标签由页面数据序列化器转义；此处也避免内嵌包意外提前关闭 script。
    const notices = fs.readFileSync(path.join(directory, 'SCHEDULE-RUNTIME-LICENSES.txt'), 'utf8');
    // 字符串保留许可证原文的换行及空白，同时避免生成 HTML 出现行尾空白。
    return { script: ('void ' + JSON.stringify(notices) + ';\n' + runtime.outputFiles[0].text).replace(/<\/script/gi, '<\\/script') };
  })();
}

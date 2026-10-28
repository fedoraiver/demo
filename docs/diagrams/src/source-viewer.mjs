// 将源码快照内嵌到离线查看页；源码只作为文本展示，不执行其中的标记或脚本。
import fs from 'node:fs';
import path from 'node:path';
import { sourceEditorAssets } from './source-editor.mjs';

/** 写入 ecs-source.html；快照使用逻辑路径，依赖文件可另带真实源码 source 定位。 */
export function writeSourceViewer({ outputDirectory, sources }) {
  const editorAssets = sourceEditorAssets();
  // 转义脚本容器的边界字符，避免源码中的 </script> 提前结束 JSON 数据块。
  const snapshot = JSON.stringify(sources).replace(/[<>&\u2028\u2029]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ECS 架构源码</title>
<style>
:root{font-family:'Segoe UI','Microsoft YaHei',sans-serif;color:var(--ui-text);background:var(--ui-bg)}
*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;flex-direction:column}
header{padding:20px 24px 16px;border-bottom:1px solid var(--ui-border);background:var(--ui-surface)}h1{font-size:21px;line-height:1.4;margin:0 0 14px}
.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}label{display:flex;align-items:center;gap:8px}
select{max-width:min(70vw,620px);padding:6px 10px}
p{font-size:13px;color:var(--ui-muted);margin:10px 0 0}#status{min-height:1.4em;color:var(--ui-accent)}#summary:empty,#status:empty{display:none}
main{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;outline-offset:-3px;background:#fff}
#code{position:relative;min-width:100%;width:max-content;font:14px/1.65 Consolas,'Cascadia Code',monospace;tab-size:4;padding:12px 0}
.code-line{display:flex;min-height:23.1px;padding-right:24px;white-space:pre}.line-number{flex:0 0 76px;padding-right:16px;text-align:right;text-decoration:none;color:#718092;user-select:none;border-right:1px solid #e3e9ed;margin-right:16px}
.line-number:hover{color:var(--ui-accent);background:var(--ui-active)}.code-line.selected{background:var(--ui-active);box-shadow:inset 3px 0 var(--ui-accent)}.code-line.selected .line-number{color:var(--ui-accent);font-weight:700}
#empty{padding:28px 24px;color:#576779}#empty[hidden]{display:none}code{font:inherit}
@media(max-width:600px){header{padding:14px 16px}.line-number{flex-basis:52px;margin-right:10px;padding-right:10px}#code{font-size:12px}}
${editorAssets.style}
</style>
</head>
<body>
<header>
<h1>ECS 架构源码</h1>
<div class="toolbar"><label for="file">文件 <select id="file" aria-label="选择源码文件"></select></label><a href="ecs-architecture.html">返回架构图</a><button type="button" data-workspace-config>配置工作区</button></div>
<div class="source-actions"><a id="editor-open" data-vscode-path="" data-vscode-line="1" hidden>在 VS Code 中打开</a></div>
<p id="summary"></p>
<p id="status" role="status" aria-live="polite"></p>
</header>
<main id="scroller" tabindex="0" aria-label="完整源码，可滚动"><div id="empty" hidden></div><div id="code"></div></main>
${editorAssets.markup}
<script id="sources" type="application/json">${snapshot}</script>
<script>${editorAssets.script}</script>
<script>
const sources = JSON.parse(document.getElementById('sources').textContent);
const files = new Map(sources.map(source => [source.path, source]));
const selector = document.getElementById('file');
const scroller = document.getElementById('scroller');
const code = document.getElementById('code');
const empty = document.getElementById('empty');
const summary = document.getElementById('summary');
const status = document.getElementById('status');
const editorLink = document.getElementById('editor-open');
let selectedLine;
const placeholder = document.createElement('option');
placeholder.value = '';
placeholder.textContent = '请选择源码文件';
selector.append(placeholder);
for (const file of files.keys()) {
  const option = document.createElement('option');
  option.value = file;
  option.textContent = file;
  selector.append(option);
}

function locateLine() {
  selectedLine?.classList.remove('selected');
  selectedLine = undefined;
  status.textContent = '';
  // 无定位或定位失效时仍可打开文件首行，不将无效行号交给编辑器。
  editorLink.dataset.vscodeLine = '1';
  sourceEditor.refreshLinks();
  if (!location.hash || !code.children.length) return;
  const match = /^#L([1-9][0-9]*)$/.exec(location.hash);
  const line = match ? Number(match[1]) : 0;
  const row = Number.isSafeInteger(line) ? code.children[line - 1] : undefined;
  if (!row) {
    status.textContent = '定位行不存在，请点击有效的行号。';
    return;
  }
  selectedLine = row;
  row.classList.add('selected');
  editorLink.dataset.vscodeLine = String(line);
  sourceEditor.refreshLinks();
  status.textContent = '已定位到第 ' + line + ' 行。';
  // 只滚动源码容器，保留顶部文件选择与定位提示。
  scroller.scrollTop = row.offsetTop - (scroller.clientHeight - row.offsetHeight) / 2;
}

function showFile() {
  const requested = new URLSearchParams(location.search).get('file');
  const file = requested === null ? sources[0]?.path : requested;
  const snapshot = files.get(file);
  const text = snapshot?.text;
  code.replaceChildren();
  scroller.scrollTop = 0;
  selector.value = files.has(file) ? file : '';
  editorLink.hidden = !files.has(file);
  const source = snapshot?.source || (snapshot ? { path: file, line: 1 } : null);
  editorLink.dataset.vscodePath = source?.path || '';
  editorLink.dataset.vscodeColumn = String(source?.column || 1);
  for (const key of ['Name', 'Version', 'Root']) delete editorLink.dataset['vscodeDependency' + key];
  if (source?.dependency) {
    editorLink.dataset.vscodeDependencyName = source.dependency.name;
    editorLink.dataset.vscodeDependencyVersion = source.dependency.version;
    editorLink.dataset.vscodeDependencyRoot = source.dependency.root;
  }
  empty.hidden = true;
  summary.textContent = '';
  if (text === undefined || text === '') {
    empty.hidden = false;
    empty.textContent = text === '' ? '此文件为空。' : !sources.length ? '此快照未包含源码文件。' : file ? '快照中找不到文件：' + file : '请选择一个源码文件。';
    if (files.has(file)) summary.textContent = file + ' · 空文件';
    locateLine();
    return;
  }
  // 统一换行以正确编号，保留空行与末尾空行；全部内容通过 textContent 写入。
  const lines = text.replace(/\\r\\n?/g, '\\n').split('\\n');
  const fragment = document.createDocumentFragment();
  lines.forEach((line, index) => {
    const number = index + 1;
    const row = document.createElement('div');
    row.className = 'code-line';
    row.id = 'L' + number;
    const anchor = document.createElement('a');
    anchor.className = 'line-number';
    anchor.href = '#L' + number;
    anchor.textContent = number;
    anchor.setAttribute('aria-label', '定位到第 ' + number + ' 行');
    const content = document.createElement('code');
    content.textContent = line;
    row.append(anchor, content);
    fragment.append(row);
  });
  code.append(fragment);
  summary.textContent = file + ' · ' + lines.length + ' 行';
  document.title = file + ' — ECS 架构源码';
  locateLine();
}

selector.addEventListener('change', () => {
  const url = new URL(location.href);
  url.searchParams.set('file', selector.value);
  url.hash = '';
  // 使用普通页面导航，避免本地 file:// 页面的 History API 权限差异。
  location.href = sourceEditor.withWorkspace(url.href);
});
code.addEventListener('click', event => {
  if (event.target.closest('.line-number')) requestAnimationFrame(locateLine);
});
addEventListener('hashchange', locateLine);
showFile();
</script>
</body>
</html>`;
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, 'ecs-source.html');
  fs.writeFileSync(outputPath, html, 'utf8');
  return outputPath;
}

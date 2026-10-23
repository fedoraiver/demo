// 两个离线页面共用源码入口；项目目录由浏览器配置，本机 Cargo 依赖根可由生成器写入 HTML。
// 维护代码与架构 JSON 只记录包身份和相对路径，不写入个人绝对目录。
import { viewerThemeStyle } from './viewer-theme.mjs';

/** 将 Windows、UNC 或 POSIX 绝对目录规范化为正斜杠路径。 */
export function normalizeWorkspaceRoot(value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid workspace root');
  }
  const root = value.trim().replaceAll('\\', '/');
  let prefix;
  let parts;
  if (/^[A-Za-z]:\//.test(root)) {
    prefix = root.slice(0, 2).toUpperCase() + '/';
    parts = root.slice(3).split('/');
  } else if (root.startsWith('//')) {
    const match = /^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(root);
    if (!match || ['.', '..'].includes(match[1]) || ['.', '..'].includes(match[2])
      || /[<>:"|?*]/.test(match[1] + match[2])) {
      throw new Error('Invalid UNC workspace root');
    }
    prefix = '//' + match[1] + '/' + match[2];
    parts = (match[3] || '').split('/');
  } else if (root.startsWith('/')) {
    prefix = '/';
    parts = root.slice(1).split('/');
  } else {
    throw new Error('Workspace root must be absolute');
  }
  const normalized = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!normalized.length) throw new Error('Workspace root escapes its volume');
      normalized.pop();
    } else {
      if (/[<>:"|?*]/.test(part)) throw new Error('Invalid workspace path segment');
      normalized.push(part);
    }
  }
  const result = prefix + (prefix.endsWith('/') || !normalized.length ? '' : '/') + normalized.join('/');
  // 提前检查不能编码的孤立代理项，保持所有公开错误消息为英文。
  try { encodeURIComponent(result); } catch { throw new Error('Invalid workspace root encoding'); }
  return result;
}

/** 从本地 file:// 架构页面推导目录，并排除临时快照。 */
export function inferWorkspaceRoot(pageUrl) {
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== 'file:') return null;
    let pathname = decodeURIComponent(url.pathname);
    if (!/\/docs\/diagrams\/(ecs-architecture|ecs-source)\.html$/.test(pathname)) return null;
    if (/(?:^|\/)tmp\/git-hooks\/architecture(?:\/|$)/i.test(pathname)) return null;
    pathname = pathname.replace(/\/docs\/diagrams\/(ecs-architecture|ecs-source)\.html$/, '') || '/';
    if (url.hostname && url.hostname !== 'localhost') pathname = '//' + url.hostname + pathname;
    else if (/^\/[A-Za-z]:(?:\/|$)/.test(pathname)) pathname = pathname.slice(1) + (pathname.length === 3 ? '/' : '');
    return normalizeWorkspaceRoot(pathname);
  } catch {
    return null;
  }
}

function validatedSource(source) {
  if (!source || typeof source.path !== 'string' || !source.path || /[\u0000-\u001f\u007f]/.test(source.path)) {
    throw new Error('Invalid source path');
  }
  const relative = source.path.replaceAll('\\', '/');
  if (relative.startsWith('/') || /[<>:"|?*]/.test(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Source path must be a safe relative path');
  }
  try { encodeURIComponent(relative); } catch { throw new Error('Invalid source path encoding'); }
  const line = source.line;
  const column = source.column === undefined ? 1 : source.column;
  if (!Number.isSafeInteger(line) || line <= 0 || !Number.isSafeInteger(column) || column <= 0) {
    throw new Error('Source line and column must be positive safe integers');
  }
  let dependency;
  if (source.dependency !== undefined) {
    const value = source.dependency;
    if (!value || typeof value.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.name)
      || typeof value.version !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value.version)) {
      throw new Error('Invalid dependency identity');
    }
    dependency = { name: value.name, version: value.version, root: normalizeWorkspaceRoot(value.root) };
  }
  return { path: relative, line, column, ...(dependency ? { dependency } : {}) };
}

function sourceLocation(root, source) {
  const relative = validatedSource(source);
  const base = relative.dependency?.root || root;
  const path = base ? normalizeWorkspaceRoot(base).replace(/\/$/, '') + '/' + relative.path : relative.path;
  return { path, line: relative.line, column: relative.column };
}

/** 创建 VS Code 文件协议；路径各段编码，行列始终显式保留。 */
export function vscodeUri(root, source) {
  const normalized = normalizeWorkspaceRoot(validatedSource(source).dependency?.root || root);
  const location = sourceLocation(normalized, source);
  const encoded = location.path.split('/').map((part, index) =>
    index === 0 && /^[A-Z]:$/.test(part) ? part : encodeURIComponent(part)).join('/');
  return 'vscode://file' + (encoded.startsWith('/') ? '' : '/') + encoded + ':' + location.line + ':' + location.column;
}

// 依赖通过参数传入；同一实现既运行在生成页面中，也可用最小 DOM 做无窗口回归。
function createSourceEditor({ document, pageUrl, getPageUrl, getStorage, navigator, history }) {
  let page = new URL(pageUrl);
  const directory = new URL('.', page).href;
  const storageKey = 'ecs-source-editor:v1:' + directory;
  const inferredRoot = inferWorkspaceRoot(page.href);
  const dialog = document.querySelector('[data-workspace-dialog]');
  const input = document.querySelector('[data-workspace-root]');
  const error = document.querySelector('[data-workspace-error]');
  const locations = new WeakMap();
  let root = null;
  let state = 'unconfigured';

  function readStoredRoot() {
    try { return getStorage()?.getItem(storageKey) || null; }
    catch { return null; }
  }
  function writeStoredRoot(value) {
    try {
      const storage = getStorage();
      if (!storage) return;
      if (value) storage.setItem(storageKey, value);
      else storage.removeItem(storageKey);
    } catch { /* 本页配置与链接传播不依赖浏览器存储。 */ }
  }
  const requested = page.searchParams.get('workspace');
  const saved = requested === null ? readStoredRoot() : null;
  try {
    if (requested !== null) { root = normalizeWorkspaceRoot(requested); state = 'configured'; }
    else if (saved) { root = normalizeWorkspaceRoot(saved); state = 'configured'; }
    else if (inferredRoot) { root = inferredRoot; state = 'inferred'; }
  } catch { state = 'invalid_workspace'; }

  function withWorkspace(value) {
    const url = new URL(value, page);
    if (root) url.searchParams.set('workspace', root);
    else url.searchParams.delete('workspace');
    return url.href;
  }
  function updatePageParameter() {
    // 行号点击可以改变 hash；保存目录必须保留当前定位，而不是恢复最初加载的行号。
    if (getPageUrl) page = new URL(getPageUrl());
    if (root && state === 'configured') page.searchParams.set('workspace', root);
    else page.searchParams.delete('workspace');
    // file:// 的 History API 在部分浏览器被禁用；链接传播和内存配置不依赖它。
    try { history?.replaceState(history.state ?? null, '', page.href); } catch { /* 保留本页配置。 */ }
  }
  function openConfiguration() {
    if (!dialog) return;
    input.value = root || '';
    error.textContent = '';
    if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    else dialog.setAttribute('open', '');
    input.focus();
    input.select();
  }
  function closeConfiguration() {
    if (typeof dialog?.close === 'function') dialog.close();
    else dialog?.removeAttribute('open');
  }
  function configure(value) {
    // 配置仅更新 href，不启动协议；用户仍须点击具体的源码入口。
    root = normalizeWorkspaceRoot(value);
    state = 'configured';
    writeStoredRoot(root);
    updatePageParameter();
    refreshLinks();
    return root;
  }
  function reset() {
    writeStoredRoot(null);
    root = inferredRoot;
    state = root ? 'inferred' : 'unconfigured';
    updatePageParameter();
    refreshLinks();
  }
  function sourceFor(anchor) {
    const { vscodeDependencyName: name, vscodeDependencyVersion: version, vscodeDependencyRoot: root } = anchor.dataset;
    const dependency = [name, version, root].some(value => value !== undefined) ? { name, version, root } : undefined;
    return validatedSource({ path: anchor.dataset.vscodePath, line: Number(anchor.dataset.vscodeLine),
      column: anchor.dataset.vscodeColumn === undefined ? undefined : Number(anchor.dataset.vscodeColumn), dependency });
  }
  function clearCopyFeedback(controls) {
    controls.version++;
    if (controls.timer !== null) clearTimeout(controls.timer);
    controls.timer = null;
    controls.button.textContent = '复制定位';
    controls.feedback.textContent = '';
  }
  function locationControls(anchor) {
    let controls = locations.get(anchor);
    if (controls) return controls;
    const container = document.createElement('span');
    container.className = 'source-editor-location';
    container.dataset.sourceLocation = '';
    const field = document.createElement('input');
    field.type = 'text';
    field.readOnly = true;
    field.setAttribute('aria-label', '源码定位，可选择复制');
    field.addEventListener('click', () => field.select());
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '复制定位';
    button.setAttribute('aria-live', 'polite');
    button.setAttribute('aria-atomic', 'true');
    const feedback = document.createElement('span');
    feedback.dataset.sourceCopyFeedback = '';
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    button.addEventListener('click', async () => {
      clearCopyFeedback(controls);
      const version = controls.version, value = field.value;
      // 定位可能在异步复制完成前切换；旧请求不得更新新位置或已移除的控件。
      const current = () => controls.version === version && field.value === value && !container.hidden
        && !anchor.hidden && !anchor.closest('[hidden]')
        && Array.from(document.querySelectorAll('[data-source-location]')).includes(container);
      try {
        if (!navigator?.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(value);
        if (!current()) return;
        button.textContent = '已复制';
        controls.timer = setTimeout(() => {
          if (controls.version === version) clearCopyFeedback(controls);
        }, 2000);
      } catch {
        if (!current()) return;
        field.focus();
        field.select();
        feedback.textContent = '浏览器无法自动复制；定位文本已选中，请手动复制。';
      }
    });
    container.append(field, button, feedback);
    anchor.insertAdjacentElement('afterend', container);
    controls = { container, field, button, feedback, version: 0, timer: null };
    locations.set(anchor, controls);
    return controls;
  }
  function refreshLinks(scope = document) {
    for (const anchor of scope.querySelectorAll('a[data-vscode-path]')) {
      let source;
      try { source = sourceFor(anchor); } catch { /* 无效文件不保留上一文件的位置。 */ }
      const controls = locations.get(anchor);
      if (!source || anchor.hidden || anchor.closest('[hidden]')) {
        anchor.removeAttribute('href');
        if (controls) { clearCopyFeedback(controls); controls.container.hidden = true; controls.field.value = ''; }
        continue;
      }
      const current = locationControls(anchor);
      current.container.hidden = false;
      const position = sourceLocation(root, source);
      const value = position.path + ':' + position.line + ':' + position.column;
      if (current.field.value !== value) clearCopyFeedback(current);
      current.field.value = value;
      const ready = source.dependency || root;
      anchor.href = ready ? vscodeUri(root, source) : '#workspace-config';
      anchor.dataset.workspaceState = ready ? 'ready' : 'unconfigured';
      anchor.title = ready
        ? '请求 VS Code 打开当前本机文件；浏览器可能要求允许协议，行号可能与快照不同。'
        : '先配置本机仓库根目录。';
    }
    // 仅向同目录的两个正式离线页面传播配置，保留 file 查询与行号 fragment。
    for (const anchor of scope.querySelectorAll('a[href]')) {
      if (anchor.dataset.vscodePath !== undefined) continue;
      // 行号仅修改本页 fragment；附加目录参数会使第一次点击重载整个源码快照。
      const href = anchor.getAttribute('href');
      if (href.startsWith('#')) continue;
      try {
        const url = new URL(href, page);
        if (new URL('.', url).href === directory && /\/(ecs-source|ecs-architecture)\.html$/.test(url.pathname)) {
          anchor.href = withWorkspace(url.href);
        }
      } catch { /* 忽略不属于本地页面导航的链接。 */ }
    }
  }
  document.addEventListener('click', event => {
    const configuration = event.target.closest('[data-workspace-config]');
    if (configuration) { event.preventDefault(); openConfiguration(); return; }
    const anchor = event.target.closest('a[data-vscode-path]');
    if (!anchor) return;
    let source;
    try { source = sourceFor(anchor); } catch { event.preventDefault(); return; }
    if (!source.dependency && !root) { event.preventDefault(); openConfiguration(); return; }
    anchor.href = vscodeUri(root, source);
  });
  document.querySelector('[data-workspace-form]')?.addEventListener('submit', event => {
    event.preventDefault();
    try { configure(input.value); closeConfiguration(); }
    catch { error.textContent = '请输入有效的本机绝对目录，例如 D:\\demo 或 /home/user/demo。'; }
  });
  document.querySelector('[data-workspace-cancel]')?.addEventListener('click', closeConfiguration);
  document.querySelector('[data-workspace-reset]')?.addEventListener('click', () => { reset(); closeConfiguration(); });
  refreshLinks();
  return { refreshLinks, configure, reset, withWorkspace, get root() { return root; }, get state() { return state; } };
}

/** 返回共享样式、配置框与脚本；依赖绝对根由生成数据提供，代码中不硬编码个人路径。 */
export function sourceEditorAssets() {
  const style = `${viewerThemeStyle}
.source-editor-location{display:flex;flex-wrap:wrap;gap:6px;align-items:center;max-width:100%;margin:8px 0 12px}.source-editor-location[hidden]{display:none}.source-editor-location input{flex:1 1 120px;min-width:0;width:auto;padding:7px 8px;color:var(--ui-text);font:12px/1.4 Consolas,monospace}.source-editor-location button{flex-shrink:0;font-size:12px;color:var(--ui-accent);background:var(--ui-active)}.source-editor-location button:hover{background:#DBEAFE}[data-source-copy-feedback]{flex:0 0 100%;font-size:12px;color:#9A462A}[data-source-copy-feedback]:empty{display:none}
[data-workspace-dialog]{width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;border:1px solid var(--ui-border);border-radius:12px;padding:24px;color:var(--ui-text);background:var(--ui-surface);box-shadow:0 18px 60px #0F172A1F;font:14px/1.6 'Segoe UI','Microsoft YaHei',sans-serif}[data-workspace-dialog]::backdrop{background:#0F172A38}[data-workspace-dialog] h2{margin:0 0 20px;font-size:20px;line-height:1.4}[data-workspace-dialog] p{margin:12px 0;color:var(--ui-muted)}[data-workspace-dialog] label{display:block;font-size:13px;font-weight:600}[data-workspace-root]{display:block;width:100%;margin-top:8px;padding:10px 12px;font:14px/1.5 Consolas,monospace}[data-workspace-error]{min-height:1.6em;color:#B42318!important}.source-editor-buttons{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}[data-workspace-dialog] button{padding:7px 12px}[data-workspace-dialog] button[type="submit"]{background:var(--ui-accent);color:#fff}[data-workspace-dialog] button[type="submit"]:hover{background:#1D4ED8}[data-workspace-config]{color:var(--ui-muted)}
`;
  const markup = `<dialog id="workspace-config" data-workspace-dialog aria-labelledby="workspace-config-title">
<form data-workspace-form>
<h2 id="workspace-config-title">配置本机源码目录</h2>
<label>仓库根目录<input data-workspace-root type="text" autocomplete="off" spellcheck="false" placeholder="D:\\demo 或 /home/user/demo"></label>
<p data-workspace-error role="alert"></p>
<div class="source-editor-buttons"><button type="submit">保存目录</button><button type="button" data-workspace-reset>恢复默认</button><button type="button" data-workspace-cancel>取消</button></div>
</form>
</dialog>`;
  const helpers = [normalizeWorkspaceRoot, inferWorkspaceRoot, validatedSource, sourceLocation, vscodeUri, createSourceEditor]
    .map(fn => fn.toString()).join('\n');
  const script = `const sourceEditor = (() => {\n${helpers}\nreturn createSourceEditor({ document, pageUrl: location.href, getPageUrl: () => location.href, getStorage: () => globalThis.localStorage, navigator: globalThis.navigator, history: globalThis.history });\n})();`;
  return { style, markup, script };
}

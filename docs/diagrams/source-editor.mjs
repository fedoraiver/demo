// 两个离线页面共用的本机源码入口；个人目录只在浏览器中配置，不进入生成产物。

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
  return { path: relative, line, column };
}

function sourceLocation(root, source) {
  const relative = validatedSource(source);
  const path = root ? normalizeWorkspaceRoot(root).replace(/\/$/, '') + '/' + relative.path : relative.path;
  return { path, line: relative.line, column: relative.column };
}

/** 创建 VS Code 文件协议；路径各段编码，行列始终显式保留。 */
export function vscodeUri(root, source) {
  const normalized = normalizeWorkspaceRoot(root);
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
  const status = document.querySelector('[data-workspace-status]');
  const dialog = document.querySelector('[data-workspace-dialog]');
  const input = document.querySelector('[data-workspace-root]');
  const error = document.querySelector('[data-workspace-error]');
  const locations = new WeakMap();
  let root = null;
  let state = 'unconfigured';
  let storageAvailable = true;

  function readStoredRoot() {
    try { return getStorage()?.getItem(storageKey) || null; }
    catch { storageAvailable = false; return null; }
  }
  function writeStoredRoot(value) {
    try {
      const storage = getStorage();
      if (!storage) { storageAvailable = false; return; }
      if (value) storage.setItem(storageKey, value);
      else storage.removeItem(storageKey);
    } catch { storageAvailable = false; }
  }
  function announce(code, message) {
    if (!status) return;
    status.dataset.state = code;
    status.textContent = message;
  }
  function describeRoot() {
    if (!root) {
      announce(state, state === 'invalid_workspace'
        ? '源码目录无效，请配置本机仓库根目录。离线源码快照仍可查看。'
        : '尚未配置本机源码目录；编辑器入口需先配置，离线源码快照仍可查看。');
      return;
    }
    announce(state, (state === 'inferred' ? '已从本地页面推导目录，可用“配置工作区”修正：' : '源码目录：')
      + root + (storageAvailable ? '' : '（浏览器未保存配置；本页与页面切换链接仍可使用。）'));
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
    try { history?.replaceState(null, '', page.href); } catch { /* 保留本页配置。 */ }
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
    describeRoot();
    return root;
  }
  function reset() {
    writeStoredRoot(null);
    root = inferredRoot;
    state = root ? 'inferred' : 'unconfigured';
    updatePageParameter();
    refreshLinks();
    describeRoot();
  }
  function sourceFor(anchor) {
    return validatedSource({ path: anchor.dataset.vscodePath, line: Number(anchor.dataset.vscodeLine),
      column: anchor.dataset.vscodeColumn === undefined ? undefined : Number(anchor.dataset.vscodeColumn) });
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
    button.addEventListener('click', async () => {
      try {
        if (!navigator?.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(field.value);
        announce('location_copied', '已复制源码定位；离线页显示生成时的快照，编辑器打开当前文件，行号可能随修改变化。');
      } catch {
        field.focus();
        field.select();
        announce('copy_unavailable', '浏览器无法自动复制；定位文本已选中，请手动复制。');
      }
    });
    container.append(field, button);
    anchor.insertAdjacentElement('afterend', container);
    controls = { container, field };
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
        if (controls) { controls.container.hidden = true; controls.field.value = ''; }
        continue;
      }
      const current = locationControls(anchor);
      current.container.hidden = false;
      const position = sourceLocation(root, source);
      current.field.value = position.path + ':' + position.line + ':' + position.column;
      anchor.href = root ? vscodeUri(root, source) : '#workspace-config';
      anchor.dataset.workspaceState = root ? 'ready' : 'unconfigured';
      anchor.title = root
        ? '请求 VS Code 打开当前本机文件；浏览器可能要求允许协议，行号可能与快照不同。'
        : '先配置本机仓库根目录；离线快照入口仍可使用。';
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
    if (!root) { event.preventDefault(); openConfiguration(); return; }
    anchor.href = vscodeUri(root, source);
    // 浏览器没有可靠的协议启动结果；只报告请求，不能声称 VS Code 已打开。
    announce('editor_requested', '已请求浏览器打开 VS Code；未安装或拒绝协议时，请使用离线源码快照或复制定位。编辑器打开当前文件，行号可能与生成快照不同。');
  });
  document.querySelector('[data-workspace-form]')?.addEventListener('submit', event => {
    event.preventDefault();
    try { configure(input.value); closeConfiguration(); }
    catch { error.textContent = '请输入有效的本机绝对目录，例如 D:\\demo 或 /home/user/demo。'; }
  });
  document.querySelector('[data-workspace-cancel]')?.addEventListener('click', closeConfiguration);
  document.querySelector('[data-workspace-reset]')?.addEventListener('click', () => { reset(); closeConfiguration(); });
  refreshLinks();
  describeRoot();
  return { refreshLinks, configure, reset, withWorkspace, get root() { return root; }, get state() { return state; } };
}

/** 返回可直接内嵌的样式、配置框和脚本，不请求外部 JavaScript 或硬编码个人路径。 */
export function sourceEditorAssets() {
  const style = `
.source-editor-status{flex:0 0 auto;padding:8px 12px;margin:0 20px 12px;border:1px solid #bac9d4;border-radius:7px;background:#f5f8fc;color:#3b5266;font:12px/1.5 'Segoe UI','Microsoft YaHei',sans-serif;overflow-wrap:anywhere}
.source-editor-location{display:flex;gap:6px;align-items:center;max-width:100%;margin:5px 0 9px}.source-editor-location[hidden]{display:none}.source-editor-location input{min-width:0;width:100%;padding:5px 6px;border:1px solid #bac9d4;border-radius:4px;background:#fff;color:#263648;font:12px/1.4 Consolas,monospace}.source-editor-location button{flex-shrink:0;font-size:12px}
[data-workspace-dialog]{width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;border:1px solid #aebdca;border-radius:10px;padding:22px;color:#263648;background:#fff;font:14px/1.6 'Segoe UI','Microsoft YaHei',sans-serif}[data-workspace-dialog]::backdrop{background:#14283a66}[data-workspace-dialog] h2{margin:0 0 12px;font-size:20px}[data-workspace-dialog] p{margin:12px 0;color:#526879}[data-workspace-dialog] label{display:block}[data-workspace-root]{display:block;width:100%;margin-top:6px;padding:8px;font:14px Consolas,monospace;border:1px solid #aebdca;border-radius:4px}[data-workspace-error]{min-height:1.6em;color:#aa2525!important}.source-editor-buttons{display:flex;gap:8px;flex-wrap:wrap}[data-workspace-dialog] button,[data-workspace-config],.source-editor-location button{padding:5px 9px;border:1px solid #aebdca;border-radius:4px;background:#f5f8fc;color:#235f92;cursor:pointer}
`;
  const markup = `<p class="source-editor-status" data-workspace-status role="status" aria-live="polite"></p>
<dialog id="workspace-config" data-workspace-dialog aria-labelledby="workspace-config-title">
<form data-workspace-form>
<h2 id="workspace-config-title">配置本机源码目录</h2>
<label>仓库根目录<input data-workspace-root type="text" autocomplete="off" spellcheck="false" placeholder="D:\\demo 或 /home/user/demo"></label>
<p>填写本机当前检出或 worktree 的绝对根目录。HTTP 页面无法自动得知本机目录；file 页面推导的目录可以修正。配置仅保存在当前页面目录的浏览器存储中，不写入 HTML。页面切换链接会携带 workspace 参数，请在分享前移除个人路径。</p>
<p>离线源码页显示生成时保存的快照；VS Code 打开的是配置目录中的当前文件，文件内容与行号可能已经变化。点击源码入口才会请求 vscode 协议；浏览器可能要求授权。未安装 VS Code 或拒绝协议时，仍可查看离线快照或选择、复制源码定位。</p>
<p data-workspace-error role="alert"></p>
<div class="source-editor-buttons"><button type="submit">保存目录</button><button type="button" data-workspace-reset>恢复默认</button><button type="button" data-workspace-cancel>取消</button></div>
</form>
</dialog>`;
  const helpers = [normalizeWorkspaceRoot, inferWorkspaceRoot, validatedSource, sourceLocation, vscodeUri, createSourceEditor]
    .map(fn => fn.toString()).join('\n');
  const script = `const sourceEditor = (() => {\n${helpers}\nreturn createSourceEditor({ document, pageUrl: location.href, getPageUrl: () => location.href, getStorage: () => globalThis.localStorage, navigator: globalThis.navigator, history: globalThis.history });\n})();`;
  return { style, markup, script };
}

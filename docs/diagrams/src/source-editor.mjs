// 两个离线页面共用源码入口；项目与 Cargo 源码目录均由浏览器配置。
// 编译机器的依赖根只用于构建校验，不作为用户机器的编辑器目标。
import { viewerThemeStyle } from './viewer-theme.mjs';

/** 将 Windows、UNC 或 POSIX 绝对目录规范化为正斜杠路径。 */
export function normalizeWorkspaceRoot(value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid workspace root');
  }
  let root = value.trim().replaceAll('\\', '/');
  // rustc / Cargo 在 Windows 上可返回扩展路径；只接受已知的盘符和 UNC 形式。
  if (root.startsWith('//?/')) {
    if (/^\/\/\?\/[A-Za-z]:\//.test(root)) root = root.slice(4);
    else if (/^\/\/\?\/UNC\//i.test(root)) root = '//' + root.slice(8);
    else throw new Error('Unsupported workspace device namespace');
  }
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
    if (!/\/docs\/diagrams\/(?:generated\/pages\/)?(ecs-architecture|ecs-source)\.html$/.test(pathname)) return null;
    if (/(?:^|\/)tmp\/git-hooks\/architecture(?:\/|$)/i.test(pathname)) return null;
    pathname = pathname.replace(/\/docs\/diagrams\/(?:generated\/pages\/)?(ecs-architecture|ecs-source)\.html$/, '') || '/';
    if (url.hostname && url.hostname !== 'localhost') pathname = '//' + url.hostname + pathname;
    else if (/^\/[A-Za-z]:(?:\/|$)/.test(pathname)) pathname = pathname.slice(1) + (pathname.length === 3 ? '/' : '');
    return normalizeWorkspaceRoot(pathname);
  } catch {
    return null;
  }
}

export function normalizeSourceEntry(source) {
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
    // 包身份和相对位置不依赖本机目录；目录不可用时仍须允许显示、复制定位。
    dependency = { name: value.name, version: value.version, ...(value.root !== undefined ? { root: value.root } : {}),
      ...(value.kind !== undefined ? { kind: value.kind } : {}) };
  }
  return { path: relative, line, column, ...(dependency ? { dependency } : {}) };
}

function dependencyKey(dependency) { return dependency.name + '@' + dependency.version; }

export function dependencyKind(dependency) {
  if (dependency?.root === undefined) return dependency?.kind === 'registry' ? 'registry' : 'package';
  if (typeof dependency.root !== 'string') return 'package';
  let root;
  try { root = normalizeWorkspaceRoot(dependency.root).replace(/\/$/, ''); }
  catch { return 'package'; }
  const packageName = dependency.name + '-' + dependency.version;
  return root.endsWith('/' + packageName) && /\/registry\/src\/[^/]+$/.test(root.slice(0, -packageName.length - 1)) ? 'registry' : 'package';
}

function normalizePackageRoots(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid dependency directory mappings');
  return Object.fromEntries(Object.entries(value).map(([key, root]) => {
    const match = /^([^@]+)@(.+)$/.exec(key);
    if (!match) throw new Error('Invalid dependency mapping identity');
    normalizeSourceEntry({ path: 'src/lib.rs', line: 1, dependency: { name: match[1], version: match[2] } });
    return [key, normalizeWorkspaceRoot(root)];
  }));
}

function localDependencyRoot(dependency, cargoRegistry, cargoPackages) {
  const override = cargoPackages?.[dependencyKey(dependency)];
  if (override) return normalizeWorkspaceRoot(override);
  if (cargoRegistry && dependencyKind(dependency) === 'registry') return normalizeWorkspaceRoot(cargoRegistry).replace(/\/$/, '') + '/' + dependency.name + '-' + dependency.version;
  throw new Error('Local dependency directory is not configured');
}

function sourceLocation(root, source, cargoRegistry, cargoPackages) {
  const relative = normalizeSourceEntry(source);
  const base = relative.dependency ? localDependencyRoot(relative.dependency, cargoRegistry, cargoPackages) : root;
  const path = base ? normalizeWorkspaceRoot(base).replace(/\/$/, '') + '/' + relative.path : relative.path;
  return { path, line: relative.line, column: relative.column };
}

/** 创建 VS Code 文件协议；路径各段编码，行列始终显式保留。 */
export function vscodeUri(root, source, cargoRegistry = null, cargoPackages = {}) {
  const relative = normalizeSourceEntry(source);
  if (!relative.dependency) normalizeWorkspaceRoot(root);
  const location = sourceLocation(root, source, cargoRegistry, cargoPackages);
  const encoded = location.path.split('/').map((part, index) =>
    index === 0 && /^[A-Z]:$/.test(part) ? part : encodeURIComponent(part)).join('/');
  return 'vscode://file' + (encoded.startsWith('/') ? '' : '/') + encoded + ':' + location.line + ':' + location.column;
}

// 依赖通过参数传入；同一实现既运行在生成页面中，也可用最小 DOM 做无窗口回归。
function createSourceEditor({ document, pageUrl, getPageUrl, getStorage, navigator, history }) {
  let page = new URL(pageUrl);
  const directory = new URL('.', page).href;
  const storageKey = 'ecs-source-editor:v1:' + directory;
  const cargoStorageKey = 'ecs-source-editor:cargo-registry:v1:' + directory;
  const packagesStorageKey = 'ecs-source-editor:cargo-packages:v1:' + directory;
  const inferredRoot = inferWorkspaceRoot(page.href);
  const dialog = document.querySelector('[data-workspace-dialog]');
  const input = document.querySelector('[data-workspace-root]');
  const cargoInput = document.querySelector('[data-cargo-registry-root]');
  const packageLabel = document.querySelector('[data-cargo-package-config]');
  const packageName = document.querySelector('[data-cargo-package-name]');
  const packageInput = document.querySelector('[data-cargo-package-root]');
  const error = document.querySelector('[data-workspace-error]');
  const locations = new WeakMap();
  let root = null;
  let cargoRegistry = null;
  let cargoPackages = {};
  let configuringDependency = null;
  let state = 'unconfigured';

  function readStoredRoot(key = storageKey) {
    try { return getStorage()?.getItem(key) || null; }
    catch { return null; }
  }
  function writeStoredRoot(value, key = storageKey) {
    try {
      const storage = getStorage();
      if (!storage) return;
      if (value) storage.setItem(key, value);
      else storage.removeItem(key);
    } catch { /* 本页配置与链接传播不依赖浏览器存储。 */ }
  }
  const requested = page.searchParams.get('workspace');
  const saved = requested === null ? readStoredRoot() : null;
  try {
    if (requested !== null) { root = normalizeWorkspaceRoot(requested); state = 'configured'; }
    else if (saved) { root = normalizeWorkspaceRoot(saved); state = 'configured'; }
    else if (inferredRoot) { root = inferredRoot; state = 'inferred'; }
  } catch { state = 'invalid_workspace'; }
  try {
    const requestedCargo = page.searchParams.get('cargoRegistry');
    const configuredCargo = requestedCargo === null ? readStoredRoot(cargoStorageKey) : requestedCargo;
    if (configuredCargo) cargoRegistry = normalizeWorkspaceRoot(configuredCargo);
  } catch { /* 无效的本机 Cargo 目录仍显示便携定位并要求重新配置。 */ }
  try {
    const requestedPackages = page.searchParams.get('cargoPackages');
    const savedPackages = requestedPackages === null ? readStoredRoot(packagesStorageKey) : requestedPackages;
    if (savedPackages) cargoPackages = normalizePackageRoots(JSON.parse(savedPackages));
  } catch { /* 无效映射不能回退到生成机器的目录。 */ }

  function withWorkspace(value) {
    const url = new URL(value, page);
    if (root) url.searchParams.set('workspace', root);
    else url.searchParams.delete('workspace');
    if (cargoRegistry) url.searchParams.set('cargoRegistry', cargoRegistry);
    else url.searchParams.delete('cargoRegistry');
    if (Object.keys(cargoPackages).length) url.searchParams.set('cargoPackages', JSON.stringify(cargoPackages));
    else url.searchParams.delete('cargoPackages');
    return url.href;
  }
  function updatePageParameter() {
    // 行号点击可以改变 hash；保存目录必须保留当前定位，而不是恢复最初加载的行号。
    if (getPageUrl) page = new URL(getPageUrl());
    if (root && state === 'configured') page.searchParams.set('workspace', root);
    else page.searchParams.delete('workspace');
    if (cargoRegistry) page.searchParams.set('cargoRegistry', cargoRegistry);
    else page.searchParams.delete('cargoRegistry');
    if (Object.keys(cargoPackages).length) page.searchParams.set('cargoPackages', JSON.stringify(cargoPackages));
    else page.searchParams.delete('cargoPackages');
    // file:// 的 History API 在部分浏览器被禁用；链接传播和内存配置不依赖它。
    try { history?.replaceState(history.state ?? null, '', page.href); } catch { /* 保留本页配置。 */ }
  }
  function openConfiguration(source) {
    if (!dialog) return;
    // 工具栏配置也能修正当前详情/文件的包映射，已可打开的依赖不必先清空全部配置。
    if (!source) {
      const anchor = Array.from(document.querySelectorAll('a[data-vscode-path]'))
        .find(item => !item.hidden && !item.closest('[hidden]') && item.dataset.vscodeDependencyName !== undefined);
      try { if (anchor) source = sourceFor(anchor); } catch { /* 无效证据不能成为配置目标。 */ }
    }
    input.value = root || '';
    cargoInput.value = cargoRegistry || '';
    configuringDependency = source?.dependency || null;
    packageLabel.hidden = !configuringDependency;
    if (configuringDependency) {
      packageName.textContent = dependencyKey(configuringDependency) + ' 本机包目录（可覆盖 registry 配置）';
      packageInput.value = cargoPackages[dependencyKey(configuringDependency)] || '';
    }
    error.textContent = '';
    if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    else dialog.setAttribute('open', '');
    const focus = source?.dependency ? dependencyKind(source.dependency) === 'registry' ? cargoInput : packageInput : input;
    focus.focus();
    focus.select();
  }
  function closeConfiguration() {
    if (typeof dialog?.close === 'function') dialog.close();
    else dialog?.removeAttribute('open');
  }
  function configure(value, cargoValue = cargoRegistry, packageValues = cargoPackages) {
    // 配置仅更新 href，不启动协议；用户仍须点击具体的源码入口。
    const nextRoot = value?.trim() ? normalizeWorkspaceRoot(value) : null;
    const nextCargo = cargoValue?.trim() ? normalizeWorkspaceRoot(cargoValue) : null;
    const nextPackages = normalizePackageRoots(packageValues);
    root = nextRoot;
    cargoRegistry = nextCargo;
    cargoPackages = nextPackages;
    state = root ? 'configured' : 'unconfigured';
    writeStoredRoot(root);
    writeStoredRoot(cargoRegistry, cargoStorageKey);
    writeStoredRoot(Object.keys(cargoPackages).length ? JSON.stringify(cargoPackages) : null, packagesStorageKey);
    updatePageParameter();
    refreshLinks();
    return root;
  }
  function reset() {
    writeStoredRoot(null);
    writeStoredRoot(null, cargoStorageKey);
    writeStoredRoot(null, packagesStorageKey);
    root = inferredRoot;
    cargoRegistry = null;
    cargoPackages = {};
    state = root ? 'inferred' : 'unconfigured';
    updatePageParameter();
    refreshLinks();
  }
  function sourceFor(anchor) {
    const { vscodeDependencyName: name, vscodeDependencyVersion: version, vscodeDependencyKind: kind } = anchor.dataset;
    const dependency = [name, version, kind].some(value => value !== undefined) ? { name, version, kind } : undefined;
    return normalizeSourceEntry({ path: anchor.dataset.vscodePath, line: Number(anchor.dataset.vscodeLine),
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
    const unavailable = document.createElement('span');
    unavailable.dataset.sourceUnavailable = '';
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
    container.append(field, button, feedback, unavailable);
    anchor.insertAdjacentElement('afterend', container);
    controls = { container, field, button, feedback, unavailable, version: 0, timer: null };
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
        anchor.dataset.workspaceState = 'unavailable';
        anchor.setAttribute('aria-disabled', 'true');
        anchor.title = '源码路径、包身份或行列无效，无法打开。';
        if (controls) { clearCopyFeedback(controls); controls.container.hidden = true; controls.field.value = ''; }
        continue;
      }
      const current = locationControls(anchor);
      current.container.hidden = false;
      let ready = root, unavailable = '';
      if (source.dependency) {
        try { localDependencyRoot(source.dependency, cargoRegistry, cargoPackages); ready = true; }
        catch {
          ready = false;
          unavailable = dependencyKind(source.dependency) === 'registry'
            ? '请配置本机 Cargo registry 源码目录或此包目录；不会使用生成机器的目录。'
            : '请配置此依赖包的本机目录；Git、路径依赖或未知来源不能使用 registry 目录。';
        }
      }
      const position = source.dependency
        ? { ...source, path: source.dependency.name + '-' + source.dependency.version + '/' + source.path }
        : sourceLocation(root, source, cargoRegistry, cargoPackages);
      const value = position.path + ':' + position.line + ':' + position.column;
      if (current.field.value !== value || current.unavailable.textContent !== unavailable) clearCopyFeedback(current);
      current.field.value = value;
      current.unavailable.textContent = unavailable;
      anchor.removeAttribute('aria-disabled');
      anchor.href = ready ? vscodeUri(root, source, cargoRegistry, cargoPackages) : '#workspace-config';
      anchor.dataset.workspaceState = ready ? 'ready' : 'unconfigured';
      anchor.title = ready
        ? '请求 VS Code 打开当前本机文件；浏览器可能要求允许协议，行号可能与快照不同。'
        : unavailable || '先配置本机仓库根目录。';
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
    try { anchor.href = vscodeUri(root, source, cargoRegistry, cargoPackages); }
    catch { event.preventDefault(); openConfiguration(source); refreshLinks(); }
  });
  document.querySelector('[data-workspace-form]')?.addEventListener('submit', event => {
    event.preventDefault();
    try {
      const mappings = { ...cargoPackages };
      if (configuringDependency) {
        const key = dependencyKey(configuringDependency);
        if (packageInput.value.trim()) mappings[key] = packageInput.value;
        else delete mappings[key];
      }
      configure(input.value, cargoInput.value, mappings); closeConfiguration();
    }
    catch { error.textContent = '请输入有效的本机绝对目录，例如 D:\\demo 或 /home/user/demo。'; }
  });
  document.querySelector('[data-workspace-cancel]')?.addEventListener('click', closeConfiguration);
  document.querySelector('[data-workspace-reset]')?.addEventListener('click', () => { reset(); closeConfiguration(); });
  refreshLinks();
  return { refreshLinks, configure, dependencyKind, configureCargoRegistry(value) { configure(root, value); },
    configureCargoPackage(dependency, value) {
      const entry = normalizeSourceEntry({ path: 'src/lib.rs', line: 1, dependency });
      const mappings = { ...cargoPackages }, key = dependencyKey(entry.dependency);
      if (value?.trim()) mappings[key] = value; else delete mappings[key];
      configure(root, cargoRegistry, mappings);
    }, reset, withWorkspace,
    get root() { return root; }, get cargoRegistry() { return cargoRegistry; }, get state() { return state; } };
}

/** 返回共享样式、配置框与脚本；本机目录不从生成数据推导。 */
export function sourceEditorAssets() {
  const style = `${viewerThemeStyle}
.source-editor-location{display:flex;flex-wrap:wrap;gap:6px;align-items:center;max-width:100%;margin:8px 0 12px}.source-editor-location[hidden]{display:none}.source-editor-location input{flex:1 1 120px;min-width:0;width:auto;padding:7px 8px;color:var(--ui-text);font:12px/1.4 Consolas,monospace}.source-editor-location button{flex-shrink:0;font-size:12px;color:var(--ui-accent);background:var(--ui-active)}.source-editor-location button:hover{background:#DBEAFE}[data-source-copy-feedback],[data-source-unavailable]{flex:0 0 100%;font-size:12px;color:#9A462A}[data-source-copy-feedback]:empty,[data-source-unavailable]:empty{display:none}[data-vscode-path][aria-disabled="true"]{color:var(--ui-muted);cursor:default}[data-vscode-path][aria-disabled="true"]:hover{background:var(--ui-bg)}
[data-workspace-dialog]{width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;border:1px solid var(--ui-border);border-radius:12px;padding:24px;color:var(--ui-text);background:var(--ui-surface);box-shadow:0 18px 60px #0F172A1F;font:14px/1.6 'Segoe UI','Microsoft YaHei',sans-serif}[data-workspace-dialog]::backdrop{background:#0F172A38}[data-workspace-dialog] h2{margin:0 0 20px;font-size:20px;line-height:1.4}[data-workspace-dialog] p{margin:12px 0;color:var(--ui-muted)}[data-workspace-dialog] label[hidden]{display:none}[data-workspace-dialog] label{display:block;font-size:13px;font-weight:600}[data-workspace-root],[data-cargo-registry-root],[data-cargo-package-root]{display:block;width:100%;margin-top:8px;padding:10px 12px;font:14px/1.5 Consolas,monospace}[data-workspace-error]{min-height:1.6em;color:#B42318!important}.source-editor-buttons{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}[data-workspace-dialog] button{padding:7px 12px}[data-workspace-dialog] button[type="submit"]{background:var(--ui-accent);color:#fff}[data-workspace-dialog] button[type="submit"]:hover{background:#1D4ED8}[data-workspace-config]{color:var(--ui-muted)}
`;
  const markup = `<dialog id="workspace-config" data-workspace-dialog aria-labelledby="workspace-config-title">
<form data-workspace-form>
<h2 id="workspace-config-title">配置本机源码目录</h2>
<label>仓库根目录<input data-workspace-root type="text" autocomplete="off" spellcheck="false" placeholder="D:\\demo 或 /home/user/demo"></label>
<label>Cargo registry 源码目录<input data-cargo-registry-root type="text" autocomplete="off" spellcheck="false" placeholder="本机 .cargo/registry/src/下的注册表目录"></label>
<p>填写直接包含 bevy_picking-0.20.0 等包目录的本机目录；registry 的目录名以本机为准，不能只填写 .cargo。两项可独立配置。</p>
<label data-cargo-package-config hidden><span data-cargo-package-name>当前依赖包目录</span><input data-cargo-package-root type="text" autocomplete="off" spellcheck="false" placeholder="此包在本机的目录，内含 Cargo.toml"></label>
<p data-workspace-error role="alert"></p>
<div class="source-editor-buttons"><button type="submit">保存目录</button><button type="button" data-workspace-reset>恢复默认</button><button type="button" data-workspace-cancel>取消</button></div>
</form>
</dialog>`;
  const helpers = [normalizeWorkspaceRoot, inferWorkspaceRoot, normalizeSourceEntry, dependencyKey, dependencyKind,
    normalizePackageRoots, localDependencyRoot, sourceLocation, vscodeUri, createSourceEditor]
    .map(fn => fn.toString()).join('\n');
  const script = `const sourceEditor = (() => {\n${helpers}\nreturn createSourceEditor({ document, pageUrl: location.href, getPageUrl: () => location.href, getStorage: () => globalThis.localStorage, navigator: globalThis.navigator, history: globalThis.history });\n})();`;
  return { style, markup, script };
}

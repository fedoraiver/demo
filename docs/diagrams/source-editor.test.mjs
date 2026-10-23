import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { inferWorkspaceRoot, normalizeWorkspaceRoot, sourceEditorAssets, vscodeUri } from './source-editor.mjs';
import { testDocument } from './test-dom.mjs';

test('normalizes Windows, UNC and POSIX absolute workspace roots without depending on the host OS', () => {
  assert.equal(normalizeWorkspaceRoot(' d:\\worktrees\\diagram\\demo\\ '), 'D:/worktrees/diagram/demo');
  assert.equal(normalizeWorkspaceRoot('D:/demo/./nested/../'), 'D:/demo');
  assert.equal(normalizeWorkspaceRoot('D:/'), 'D:/');
  assert.equal(normalizeWorkspaceRoot('\\\\server\\中文 共享\\demo\\'), '//server/中文 共享/demo');
  assert.equal(normalizeWorkspaceRoot('//server/share'), '//server/share');
  assert.equal(normalizeWorkspaceRoot('/home/user/project/'), '/home/user/project');
  assert.equal(normalizeWorkspaceRoot('/'), '/');
});

test('rejects ambiguous, relative and malformed workspace roots', () => {
  for (const root of ['', null, 'demo', 'D:demo', 'file:///D:/demo', '//server', '//server:port/share',
    '//server/../demo', '/../../demo', 'D:/../demo', 'D:/de\nmo', '/home/\ud800']) {
    assert.throws(() => normalizeWorkspaceRoot(root), /workspace|Workspace/);
  }
});

test('infers only the known local diagram pages and keeps each worktree root distinct', () => {
  assert.equal(inferWorkspaceRoot('file:///D:/demo/docs/diagrams/ecs-architecture.html'), 'D:/demo');
  assert.equal(inferWorkspaceRoot('file:///D:/worktrees/diagram/demo/docs/diagrams/ecs-source.html?file=src%2Fmain.rs#L8'), 'D:/worktrees/diagram/demo');
  assert.equal(inferWorkspaceRoot('file:///home/user/demo/docs/diagrams/ecs-source.html'), '/home/user/demo');
  assert.equal(inferWorkspaceRoot('file:///C:/docs/diagrams/ecs-source.html'), 'C:/');
  assert.equal(inferWorkspaceRoot('file:///docs/diagrams/ecs-source.html'), '/');
  assert.equal(inferWorkspaceRoot('file://server/share/demo/docs/diagrams/ecs-source.html'), '//server/share/demo');
  assert.equal(inferWorkspaceRoot('file:///D:/%E4%B8%AD%E6%96%87%20%23%25/docs/diagrams/ecs-source.html'), 'D:/中文 #%');
  for (const url of ['https://example.com/demo/docs/diagrams/ecs-source.html',
    'file:///D:/demo/docs/diagrams/other.html', 'file:///D:/demo/ecs-source.html', 'invalid',
    'file:///D:/demo/tmp/git-hooks/architecture/tree-run/docs/diagrams/ecs-source.html',
    'file:///D:/demo/TMP/git-hooks/architecture/tree-run/snapshot/docs/diagrams/ecs-architecture.html',
    'file:///D:/%FF/docs/diagrams/ecs-source.html']) {
    assert.equal(inferWorkspaceRoot(url), null, url);
  }
});

test('builds exact VS Code line and column URIs for Windows, UNC and POSIX paths', () => {
  assert.equal(vscodeUri('D:\\demo', { path: 'src/main.rs', line: 28 }), 'vscode://file/D:/demo/src/main.rs:28:1');
  assert.equal(vscodeUri('\\\\server\\share\\demo', { path: 'src/main.rs', line: 28, column: 7 }), 'vscode://file//server/share/demo/src/main.rs:28:7');
  assert.equal(vscodeUri('/home/user/demo', { path: 'src/main.rs', line: 28, column: 7 }), 'vscode://file/home/user/demo/src/main.rs:28:7');
  assert.equal(vscodeUri('/', { path: 'main.rs', line: 1 }), 'vscode://file/main.rs:1:1');
  assert.equal(vscodeUri('C:/', { path: 'main.rs', line: 1 }), 'vscode://file/C:/main.rs:1:1');
  assert.equal(vscodeUri('D:/工作 目录#%', { path: 'src/中文 #%.rs', line: 5, column: 9 }),
    'vscode://file/D:/%E5%B7%A5%E4%BD%9C%20%E7%9B%AE%E5%BD%95%23%25/src/%E4%B8%AD%E6%96%87%20%23%25.rs:5:9');
});

test('Cargo dependency locations use their validated root independently of the project workspace', () => {
  const source = { path: 'src/中文 #%.rs', line: 5, column: 9, dependency: { name: 'avian3d', version: '0.7.0', root: 'C:/Cargo 缓存 #%/avian3d-0.7.0' } };
  const expected = 'vscode://file/C:/Cargo%20%E7%BC%93%E5%AD%98%20%23%25/avian3d-0.7.0/src/%E4%B8%AD%E6%96%87%20%23%25.rs:5:9';
  for (const workspace of [null, undefined, 'relative', 'E:/other-project']) assert.equal(vscodeUri(workspace, source), expected);
  assert.equal(vscodeUri(null, { ...source, dependency: { ...source.dependency, root: '//server/share/cargo/avian3d-0.7.0' } }),
    'vscode://file//server/share/cargo/avian3d-0.7.0/src/%E4%B8%AD%E6%96%87%20%23%25.rs:5:9');
  assert.equal(vscodeUri(null, { ...source, dependency: { name: 'some-crate_name', version: '1.2.3-beta.1+build.2', root: '/home/user/cargo' } }),
    'vscode://file/home/user/cargo/src/%E4%B8%AD%E6%96%87%20%23%25.rs:5:9');
});

test('dependency identities, roots and relative paths cannot become arbitrary editor targets', () => {
  const dependency = { name: 'avian3d', version: '0.7.0', root: 'C:/cargo/avian3d-0.7.0' };
  const source = { path: 'src/lib.rs', line: 1, dependency };
  for (const value of [null, {}, { ...dependency, name: '../avian' }, { ...dependency, name: 'a b' },
    { ...dependency, version: '0.7' }, { ...dependency, version: '0.7.0/other' },
    { ...dependency, root: 'relative' }, { ...dependency, root: 'https://example.test/' },
    { ...dependency, root: 'C:/cargo\n/avian' }, { ...dependency, root: '/../../outside' }]) {
    assert.throws(() => vscodeUri('D:/demo', { ...source, dependency: value }));
  }
  for (const path of ['../lib.rs', '/absolute.rs', 'C:/absolute.rs', 'src/../lib.rs', 'src/\ud800.rs']) {
    assert.throws(() => vscodeUri(null, { ...source, path }), /source|Source/);
  }
  assert.throws(() => vscodeUri(null, { path: 'src/main.rs', line: 1 }), /workspace|Workspace/);
});

test('rejects path traversal, absolute source paths and invalid coordinates', () => {
  for (const path of ['', '../outside.rs', 'src/../outside.rs', 'src\\..\\outside.rs', './main.rs',
    '/src/main.rs', 'D:/src/main.rs', '\\\\server\\share\\main.rs', 'src//main.rs', 'src/main.rs/',
    'src/main.rs?line=1', 'src/ma\nin.rs', 'src/\ud800.rs']) {
    assert.throws(() => vscodeUri('D:/demo', { path, line: 1 }), /Source|source/);
  }
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    assert.throws(() => vscodeUri('D:/demo', { path: 'src/main.rs', line: value }), /positive safe integers/);
    assert.throws(() => vscodeUri('D:/demo', { path: 'src/main.rs', line: 1, column: value }), /positive safe integers/);
  }
});

// 最小 DOM 仅模拟目录配置、链接刷新与用户点击，不创建浏览器或游戏窗口。
class Element {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
    this.hidden = false;
    this.value = '';
    for (const [name, value] of Object.entries(attributes)) this.setAttribute(name, value);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    if (name === 'open') this.open = true;
    if (name === 'hidden') this.hidden = true;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'open') this.open = false;
  }
  set href(value) { this.setAttribute('href', value); }
  get href() { return this.getAttribute('href'); }
  matches(selector) {
    const match = /^(a)?\[([^\]]+)\]$/.exec(selector);
    if (!match || (match[1] && this.tagName !== 'a')) return false;
    if (match[2] === 'hidden') return this.hidden;
    if (match[2].startsWith('data-')) {
      const key = match[2].slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return this.dataset[key] !== undefined;
    }
    return this.attributes.has(match[2]);
  }
  closest(selector) {
    for (let element = this; element; element = element.parent) if (element.matches(selector)) return element;
    return null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  append(...elements) { for (const element of elements) { element.parent = this; this.children.push(element); } }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  insertAdjacentElement(position, element) {
    assert.equal(position, 'afterend');
    element.parent = this.parent;
    this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, element);
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  async dispatch(type, target = this) {
    const event = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const listener of this.listeners.get(type) || []) await listener(event);
    return event;
  }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function memoryStorage() {
  const values = new Map();
  return { values, getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

function browserFixture(pageUrl, { storage = memoryStorage(), clipboard, dependency, storageAccessBlocked = false, historyBlocked = false, historyState = null } = {}) {
  const document = new Element('document');
  document.createElement = name => new Element(name);
  const dialog = new Element('dialog', { 'data-workspace-dialog': '' });
  const input = new Element('input', { 'data-workspace-root': '' });
  const error = new Element('p', { 'data-workspace-error': '' });
  const form = new Element('form', { 'data-workspace-form': '' });
  const cancel = new Element('button', { 'data-workspace-cancel': '' });
  const reset = new Element('button', { 'data-workspace-reset': '' });
  form.append(input, error, cancel, reset);
  dialog.append(form);
  const config = new Element('button', { 'data-workspace-config': '' });
  const container = new Element('div');
  const editorLink = new Element('a', { 'data-vscode-path': 'src/中文 #%.rs', 'data-vscode-line': '8' });
  if (dependency) for (const [key, value] of Object.entries(dependency)) editorLink.dataset['vscodeDependency' + key[0].toUpperCase() + key.slice(1)] = value;
  const offlineLink = new Element('a', { href: 'ecs-source.html?file=src%2Fmain.rs#L8' });
  container.append(editorLink, offlineLink);
  document.append(dialog, config, container);
  const historyCalls = [];
  const timers = new Map();
  let now = 0, timerId = 0;
  const location = { href: pageUrl };
  const context = vm.createContext({ document, URL, location, localStorage: storage,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    navigator: { clipboard }, history: { state: historyState, replaceState: (...args) => {
      if (historyBlocked) throw new Error('History unavailable');
      historyCalls.push(args);
      location.href = args[2];
    } } });
  if (storageAccessBlocked) Object.defineProperty(context, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
  vm.runInContext(sourceEditorAssets().script + '\nglobalThis.editor = sourceEditor;', context);
  return { editor: context.editor, document, editorLink, offlineLink, dialog, input, error, form, config,
    container, reset, historyCalls, location, storage, field: () => container.querySelector('[data-source-location]')?.children[0],
    copy: () => container.querySelector('[data-source-location]')?.children[1],
    feedback: () => container.querySelector('[data-source-copy-feedback]'),
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
  };
}

test('workspace configuration preserves the current architecture expansion history state', () => {
  const historyState = { architectureEntityModes: { 'infrastructure-data': 'entity-camera' }, other: 12 };
  const page = browserFixture('https://example.com/docs/diagrams/ecs-architecture.html?feature=infrastructure&tab=data', { historyState });
  page.editor.configure('D:/demo');
  assert.equal(page.historyCalls.at(-1)[0], historyState);
  assert.equal(new URL(page.historyCalls.at(-1)[2]).searchParams.get('feature'), 'infrastructure');
});

test('HTTP pages require explicit configuration and configure only after a user action', async () => {
  const page = browserFixture('https://example.com/demo/docs/diagrams/ecs-architecture.html');
  assert.equal(page.editor.root, null);
  assert.equal(page.editor.state, 'unconfigured');
  assert.equal(page.field().value, 'src/中文 #%.rs:8:1');
  assert.equal(page.editorLink.href, '#workspace-config');
  assert.equal(page.editorLink.title, '先配置本机仓库根目录。');
  assert.equal(page.historyCalls.length, 0);
  const initialClick = await page.document.dispatch('click', page.editorLink);
  assert.equal(initialClick.defaultPrevented, true);
  assert.equal(page.dialog.open, true);
  page.input.value = 'relative';
  await page.form.dispatch('submit');
  assert.equal(page.editor.root, null);
  assert.equal(page.dialog.open, true);
  assert.ok(page.error.textContent);
  page.input.value = 'D:\\本机 副本';
  await page.form.dispatch('submit');
  assert.equal(page.editor.root, 'D:/本机 副本');
  assert.equal(page.dialog.open, false);
  assert.equal(page.field().value, 'D:/本机 副本/src/中文 #%.rs:8:1');
  assert.equal(page.editorLink.href, vscodeUri('D:/本机 副本', { path: 'src/中文 #%.rs', line: 8 }));
  assert.equal(page.editor.state, 'configured');
  const editorClick = await page.document.dispatch('click', page.editorLink);
  assert.equal(editorClick.defaultPrevented, false);
  assert.equal(page.editorLink.href, vscodeUri('D:/本机 副本', { path: 'src/中文 #%.rs', line: 8 }));
  assert.equal(page.document.querySelector('[data-workspace-status]'), null);
});

test('dependency editor links and copy locations work on HTTP without configuring a project', async () => {
  const dependency = { name: 'avian3d', version: '0.7.0', root: 'C:/Cargo & 中文 #%/avian3d-0.7.0' };
  const copied = [];
  for (const query of ['', '?workspace=relative', '?workspace=E%3A%2Fother']) {
    const page = browserFixture('https://example.test/docs/diagrams/ecs-source.html' + query,
      { dependency, clipboard: { writeText: async value => copied.push(value) } });
    assert.equal(page.editorLink.href, vscodeUri(null, { path: 'src/中文 #%.rs', line: 8, dependency }));
    assert.equal(page.editorLink.dataset.workspaceState, 'ready');
    assert.equal(page.field().value, dependency.root + '/src/中文 #%.rs:8:1');
    assert.equal((await page.document.dispatch('click', page.editorLink)).defaultPrevented, false);
    assert.notEqual(page.dialog.open, true);
    await page.copy().dispatch('click');
    assert.equal(page.copy().textContent, '已复制');
    page.editor.configure('F:/changed-project');
    assert.equal(page.field().value, dependency.root + '/src/中文 #%.rs:8:1');
    page.advance(2000);
    assert.equal(page.copy().textContent, '复制定位');
  }
  assert.deepEqual(copied, Array(3).fill(dependency.root + '/src/中文 #%.rs:8:1'));
  const invalid = browserFixture('https://example.test/docs/diagrams/ecs-source.html', { dependency: { name: 'avian3d', version: '0.7.0' } });
  assert.equal(invalid.editorLink.href, null);
  assert.equal(invalid.field(), undefined);
  assert.equal((await invalid.document.dispatch('click', invalid.editorLink)).defaultPrevented, true);
});

test('dependency copy feedback follows only the latest request and current dependency location', async () => {
  const pending = [], dependency = { name: 'avian3d', version: '0.7.0', root: 'C:/cargo/avian3d-0.7.0' };
  const page = browserFixture('https://example.test/docs/diagrams/ecs-source.html', {
    dependency, clipboard: { writeText() { const copy = deferred(); pending.push(copy); return copy.promise; } },
  });
  const earlier = page.copy().dispatch('click'), latest = page.copy().dispatch('click');
  pending[1].resolve(); await latest;
  pending[0].resolve(); await earlier;
  assert.equal(page.copy().textContent, '已复制');
  const moving = page.copy().dispatch('click');
  page.editorLink.dataset.vscodeDependencyRoot = 'D:/different-cargo/avian3d-0.7.0';
  page.editor.refreshLinks();
  pending[2].resolve(); await moving;
  assert.equal(page.copy().textContent, '复制定位');
  assert.equal(page.field().value, 'D:/different-cargo/avian3d-0.7.0/src/中文 #%.rs:8:1');
  const denied = page.copy().dispatch('click');
  pending[3].reject(new Error('Denied')); await denied;
  assert.equal(page.field().selected, true);
  assert.match(page.feedback().textContent, /请手动复制/);
});

test('file inference is editable and stored roots are isolated by page directory and worktree', () => {
  const storage = memoryStorage();
  const first = browserFixture('file:///D:/worktrees/first/demo/docs/diagrams/ecs-architecture.html', { storage });
  assert.equal(first.editor.root, 'D:/worktrees/first/demo');
  assert.equal(first.editor.state, 'inferred');
  first.editor.configure('E:/editable-first');
  const same = browserFixture('file:///D:/worktrees/first/demo/docs/diagrams/ecs-source.html?file=src/main.rs#L1', { storage });
  assert.equal(same.editor.root, 'E:/editable-first');
  assert.equal(same.editor.state, 'configured');
  const second = browserFixture('file:///D:/worktrees/second/demo/docs/diagrams/ecs-source.html', { storage });
  assert.equal(second.editor.root, 'D:/worktrees/second/demo');
  const hook = browserFixture('file:///D:/worktrees/first/demo/tmp/git-hooks/architecture/tree-run/docs/diagrams/ecs-source.html', { storage });
  assert.equal(hook.editor.root, null);
  first.editor.reset();
  assert.equal(first.editor.root, 'D:/worktrees/first/demo');
  assert.equal(storage.values.size, 0);
});

test('workspace URL parameters take precedence and cross-page links retain file and line', () => {
  const first = browserFixture('https://example.com/demo/docs/diagrams/ecs-architecture.html');
  first.editor.configure('D:/中文 #副本%');
  const link = new URL(first.offlineLink.href);
  assert.equal(link.searchParams.get('workspace'), 'D:/中文 #副本%');
  assert.equal(link.searchParams.get('file'), 'src/main.rs');
  assert.equal(link.hash, '#L8');
  const second = browserFixture(link.href);
  assert.equal(second.editor.root, 'D:/中文 #副本%');
  const stored = browserFixture('https://example.com/demo/docs/diagrams/ecs-architecture.html');
  stored.editor.configure('E:/saved');
  const requested = browserFixture('https://example.com/demo/docs/diagrams/ecs-source.html?workspace=F%3A%2Frequested', { storage: stored.storage });
  assert.equal(requested.editor.root, 'F:/requested');
  const invalid = browserFixture('https://example.com/demo/docs/diagrams/ecs-source.html?workspace=relative', { storage: stored.storage });
  assert.equal(invalid.editor.root, null);
  assert.equal(invalid.editor.state, 'invalid_workspace');
});

test('unavailable browser storage still permits in-memory configuration and page propagation', () => {
  const unavailable = { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); }, removeItem() { throw new Error('Blocked'); } };
  const page = browserFixture('https://example.com/demo/docs/diagrams/ecs-source.html', { storage: unavailable });
  page.editor.configure('/home/user/current');
  assert.equal(page.editor.root, '/home/user/current');
  assert.equal(page.editor.state, 'configured');
  assert.equal(new URL(page.offlineLink.href).searchParams.get('workspace'), '/home/user/current');
  const another = browserFixture(page.editor.withWorkspace('ecs-architecture.html'), { storage: unavailable });
  assert.equal(another.editor.root, '/home/user/current');
  page.editor.reset();
  assert.equal(page.editor.root, null);
  assert.equal(new URL(page.offlineLink.href).searchParams.get('workspace'), null);
});

test('saving workspace configuration retains live file and line navigation', () => {
  const page = browserFixture('file:///D:/demo/docs/diagrams/ecs-source.html?file=src/main.rs#L8');
  page.location.href = 'file:///D:/demo/docs/diagrams/ecs-source.html?file=src/changed.rs#L42';
  page.editor.configure('E:/current');
  const updated = new URL(page.location.href);
  assert.equal(updated.searchParams.get('file'), 'src/changed.rs');
  assert.equal(updated.hash, '#L42');
  assert.equal(updated.searchParams.get('workspace'), 'E:/current');
});

test('blocked storage access and file History API still allow page and file switches', () => {
  const page = browserFixture('file:///D:/demo/docs/diagrams/ecs-source.html?file=src/main.rs#L8',
    { storageAccessBlocked: true, historyBlocked: true });
  page.editor.configure('E:/editable');
  assert.equal(page.editor.root, 'E:/editable');
  assert.equal(page.historyCalls.length, 0);
  const requested = new URL(page.location.href);
  requested.searchParams.set('file', 'src/next.rs');
  requested.hash = '';
  const switched = new URL(page.editor.withWorkspace(requested.href));
  assert.equal(switched.searchParams.get('file'), 'src/next.rs');
  assert.equal(switched.searchParams.get('workspace'), 'E:/editable');
  const next = browserFixture(switched.href, { storageAccessBlocked: true, historyBlocked: true });
  assert.equal(next.editor.root, 'E:/editable');
  assert.equal(new URL(page.offlineLink.href).searchParams.get('workspace'), 'E:/editable');
});

test('link refresh reuses copy controls and clears stale locations when files become invalid or hidden', () => {
  const page = browserFixture('file:///D:/demo/docs/diagrams/ecs-source.html');
  const originalField = page.field();
  page.editorLink.dataset.vscodePath = 'src/another.rs';
  page.editorLink.dataset.vscodeLine = '42';
  page.editorLink.dataset.vscodeColumn = '4';
  page.editor.refreshLinks(page.container);
  assert.equal(page.field(), originalField);
  assert.equal(page.container.querySelectorAll('[data-source-location]').length, 1);
  assert.equal(page.field().value, 'D:/demo/src/another.rs:42:4');
  page.editorLink.hidden = true;
  page.editor.refreshLinks();
  assert.equal(page.container.querySelector('[data-source-location]').hidden, true);
  assert.equal(page.field().value, '');
  assert.equal(page.editorLink.href, null);
  page.editorLink.hidden = false;
  page.editorLink.dataset.vscodePath = '../outside.rs';
  page.editor.refreshLinks();
  assert.equal(page.field().value, '');
  assert.equal(page.editorLink.href, null);
});

test('copy fallback selects the complete location and does not depend on protocol success', async () => {
  const page = browserFixture('file:///D:/demo/docs/diagrams/ecs-source.html');
  await page.copy().dispatch('click');
  assert.equal(page.field().selected, true);
  assert.equal(page.field().focused, true);
  assert.match(page.feedback().textContent, /请手动复制/);
  assert.equal(page.feedback().getAttribute('role'), 'status');
  assert.equal(page.copy().textContent, '复制定位');
  const copied = [];
  const supported = browserFixture('file:///D:/demo/docs/diagrams/ecs-source.html', { clipboard: { writeText: async value => copied.push(value) } });
  await supported.copy().dispatch('click');
  assert.deepEqual(copied, ['D:/demo/src/中文 #%.rs:8:1']);
  assert.equal(supported.copy().textContent, '已复制');
  assert.equal(supported.copy().getAttribute('aria-live'), 'polite');
  assert.equal(supported.feedback().textContent, '');
  supported.advance(1999);
  assert.equal(supported.copy().textContent, '已复制');
  supported.advance(1);
  assert.equal(supported.copy().textContent, '复制定位');
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('copy success is announced only after the clipboard resolves and stays local to its control', async () => {
  const pending = deferred(), copied = [];
  const page = browserFixture('file:///D:/demo/docs/diagrams/ecs-source.html', {
    clipboard: { writeText(value) { copied.push(value); return pending.promise; } },
  });
  const other = new Element('a', { 'data-vscode-path': 'src/other.rs', 'data-vscode-line': '3' });
  page.container.append(other);
  page.editor.refreshLinks();
  page.editor.refreshLinks();
  const controls = page.container.querySelectorAll('[data-source-location]');
  assert.equal(controls.length, 2);
  const click = page.copy().dispatch('click');
  assert.equal(page.copy().textContent, '复制定位');
  assert.equal(page.feedback().textContent, '');
  pending.resolve();
  await click;
  assert.deepEqual(copied, ['D:/demo/src/中文 #%.rs:8:1']);
  assert.equal(page.copy().textContent, '已复制');
  assert.equal(controls[1].children[1].textContent, '复制定位');
  assert.equal(controls[1].children[2].textContent, '');
});

test('a changed location discards a pending result and clears success without losing the reused controls', async () => {
  const pending = [];
  const page = browserFixture('file:///D:/demo/docs/diagrams/ecs-source.html', {
    clipboard: { writeText() { const copy = deferred(); pending.push(copy); return copy.promise; } },
  });
  const original = page.field(), click = page.copy().dispatch('click');
  page.editorLink.dataset.vscodeLine = '42';
  page.editor.refreshLinks();
  pending[0].resolve();
  await click;
  assert.equal(page.field(), original);
  assert.equal(page.field().value, 'D:/demo/src/中文 #%.rs:42:1');
  assert.equal(page.copy().textContent, '复制定位');
  const next = page.copy().dispatch('click');
  pending[1].resolve();
  await next;
  assert.equal(page.copy().textContent, '已复制');
  page.editor.configure('E:/changed');
  assert.equal(page.copy().textContent, '复制定位');
  page.advance(2000);
  assert.equal(page.field().value, 'E:/changed/src/中文 #%.rs:42:1');
  assert.equal(page.copy().textContent, '复制定位');
});

test('removed or hidden copy controls discard pending success and rejection without focus or feedback', async () => {
  for (const outcome of ['resolve', 'reject']) for (const state of ['removed', 'hidden']) {
    const pending = deferred();
    const page = browserFixture('file:///D:/demo/docs/diagrams/ecs-source.html', {
      clipboard: { writeText: () => pending.promise },
    });
    const controls = page.container.querySelector('[data-source-location]'), field = page.field(), button = page.copy(), feedback = page.feedback();
    const click = button.dispatch('click');
    if (state === 'removed') page.container.remove();
    else { page.editorLink.hidden = true; page.editor.refreshLinks(); }
    pending[outcome](outcome === 'reject' ? new Error('Permission denied') : undefined);
    await click;
    assert.equal(button.textContent, '复制定位', state + '/' + outcome);
    assert.equal(feedback.textContent, '', state + '/' + outcome);
    assert.notEqual(field.focused, true, state + '/' + outcome);
    if (state === 'hidden') assert.equal(controls.hidden, true);
  }
});

test('repeated copy requests retain only the latest completion and its two-second feedback interval', async () => {
  const pending = [];
  const page = browserFixture('file:///D:/demo/docs/diagrams/ecs-source.html', {
    clipboard: { writeText() { const copy = deferred(); pending.push(copy); return copy.promise; } },
  });
  const earlier = page.copy().dispatch('click'), latest = page.copy().dispatch('click');
  pending[1].resolve();
  await latest;
  assert.equal(page.copy().textContent, '已复制');
  page.advance(1000);
  pending[0].resolve();
  await earlier;
  page.advance(999);
  assert.equal(page.copy().textContent, '已复制');
  page.advance(1);
  assert.equal(page.copy().textContent, '复制定位');
});

test('clipboard rejection keeps feedback beside the current location and a retry clears the old failure', async () => {
  let reject = true;
  const page = browserFixture('file:///D:/demo/docs/diagrams/ecs-source.html', {
    clipboard: { async writeText() { if (reject) throw new Error('Permission denied'); } },
  });
  await page.copy().dispatch('click');
  assert.match(page.feedback().textContent, /请手动复制/);
  assert.equal(page.field().selected, true);
  reject = false;
  await page.copy().dispatch('click');
  assert.equal(page.feedback().textContent, '');
  assert.equal(page.copy().textContent, '已复制');
});

test('shared assets keep only configuration controls and omit the bottom status and explanatory paragraphs', () => {
  const assets = sourceEditorAssets();
  assert.deepEqual(Object.keys(assets), ['style', 'markup', 'script']);
  assert.match(assets.script, /^const sourceEditor =/);
  assert.doesNotMatch(assets.script, /\b(?:fetch|import)\s*\(/);
  assert.doesNotMatch(assets.markup, /<script[^>]+src=/);
  assert.doesNotMatch(assets.markup, /data-workspace-status|source-editor-status/);
  assert.doesNotMatch(assets.style, /source-editor-status/);
  const document = testDocument(assets.markup);
  const dialog = document.querySelector('[data-workspace-dialog]');
  assert.ok(dialog);
  assert.ok(dialog.querySelector('[data-workspace-root]'));
  assert.equal(dialog.querySelectorAll('p').length, 1);
  assert.equal(dialog.querySelector('p').getAttribute('data-workspace-error'), '');
  assert.equal(dialog.querySelectorAll('button').length, 3);
  assert.match(dialog.textContent, /保存目录/);
  assert.match(dialog.textContent, /恢复默认/);
  assert.match(dialog.textContent, /取消/);
});

test('line anchors remain fragment-only instead of reloading the source page with workspace parameters', () => {
  const page = browserFixture('file:///D:/demo/docs/diagrams/ecs-source.html?file=src/main.rs#L1');
  const line = new Element('a', { href: '#L42' });
  page.container.append(line);
  page.editor.refreshLinks();
  assert.equal(line.getAttribute('href'), '#L42');
  page.editor.configure('E:/other-worktree');
  assert.equal(line.getAttribute('href'), '#L42');
});

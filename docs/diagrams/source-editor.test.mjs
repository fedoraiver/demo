import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { inferWorkspaceRoot, normalizeWorkspaceRoot, sourceEditorAssets, vscodeUri } from './source-editor.mjs';

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

function browserFixture(pageUrl, { storage = memoryStorage(), clipboard, storageAccessBlocked = false, historyBlocked = false } = {}) {
  const document = new Element('document');
  document.createElement = name => new Element(name);
  const status = new Element('p', { 'data-workspace-status': '' });
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
  const offlineLink = new Element('a', { href: 'ecs-source.html?file=src%2Fmain.rs#L8' });
  container.append(editorLink, offlineLink);
  document.append(status, dialog, config, container);
  const historyCalls = [];
  const location = { href: pageUrl };
  const context = vm.createContext({ document, URL, location, localStorage: storage,
    navigator: { clipboard }, history: { replaceState: (...args) => {
      if (historyBlocked) throw new Error('History unavailable');
      historyCalls.push(args);
      location.href = args[2];
    } } });
  if (storageAccessBlocked) Object.defineProperty(context, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
  vm.runInContext(sourceEditorAssets().script + '\nglobalThis.editor = sourceEditor;', context);
  return { editor: context.editor, document, editorLink, offlineLink, status, dialog, input, error, form, config,
    container, reset, historyCalls, location, storage, field: () => container.querySelector('[data-source-location]')?.children[0],
    copy: () => container.querySelector('[data-source-location]')?.children[1] };
}

test('HTTP pages require explicit configuration and configure only after a user action', async () => {
  const page = browserFixture('https://example.com/demo/docs/diagrams/ecs-architecture.html');
  assert.equal(page.editor.root, null);
  assert.equal(page.editor.state, 'unconfigured');
  assert.equal(page.field().value, 'src/中文 #%.rs:8:1');
  assert.equal(page.editorLink.href, '#workspace-config');
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
  assert.equal(page.status.dataset.state, 'configured');
  const editorClick = await page.document.dispatch('click', page.editorLink);
  assert.equal(editorClick.defaultPrevented, false);
  assert.equal(page.status.dataset.state, 'editor_requested');
  assert.match(page.status.textContent, /已请求浏览器/);
  assert.match(page.status.textContent, /未安装或拒绝协议/);
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
  assert.match(page.status.textContent, /未保存配置/);
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
  assert.equal(page.status.dataset.state, 'copy_unavailable');
  const copied = [];
  const supported = browserFixture('file:///D:/demo/docs/diagrams/ecs-source.html', { clipboard: { writeText: async value => copied.push(value) } });
  await supported.copy().dispatch('click');
  assert.deepEqual(copied, ['D:/demo/src/中文 #%.rs:8:1']);
  assert.equal(supported.status.dataset.state, 'location_copied');
});

test('assets remain fully inline with snapshot and current-file guidance', () => {
  const assets = sourceEditorAssets();
  assert.deepEqual(Object.keys(assets), ['style', 'markup', 'script']);
  assert.match(assets.script, /^const sourceEditor =/);
  assert.doesNotMatch(assets.script, /\b(?:fetch|import)\s*\(/);
  assert.doesNotMatch(assets.markup, /<script[^>]+src=/);
  assert.match(assets.markup, /离线源码页显示生成时保存的快照/);
  assert.match(assets.markup, /行号可能已经变化/);
  assert.match(assets.markup, /分享前移除个人路径/);
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

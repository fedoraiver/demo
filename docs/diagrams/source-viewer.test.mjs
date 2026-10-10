// 执行生成页中的真实脚本，验证源码定位；最小 DOM 不打开浏览器或外部编辑器。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { writeSourceViewer } from './source-viewer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryRoot = path.join(root, 'tmp', 'source-viewer-tests');
const dataKey = attribute => attribute.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const decode = value => value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity =>
  ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity]);

// 只模拟脚本用到的 DOM 契约，解析实际生成标记，避免复制页面业务逻辑。
class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.className = '';
    this.value = '';
    this.scrollTop = 0;
    this.clientHeight = 200;
    this.offsetHeight = 24;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
    };
  }

  get offsetTop() { return (this.parentElement?.children.indexOf(this) ?? 0) * this.offsetHeight; }
  get href() { return this.getAttribute('href') ?? ''; }
  set href(value) { this.setAttribute('href', value); }
  get textContent() { return (this.text ?? '') + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  get innerHTML() { return this.markup ?? ''; }
  set innerHTML(value) { this.replaceChildren(); this.markup = value; parseMarkup(value, this); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) this.dataset[dataKey(name)] = String(value);
    else if (name === 'id') this.id = String(value);
    else if (name === 'class') this.className = String(value);
    else if (name === 'hidden') this.hidden = true;
  }
  getAttribute(name) {
    if (name.startsWith('data-')) return this.dataset[dataKey(name)] ?? null;
    if (name === 'hidden') return this.hidden ? '' : null;
    if (name === 'id') return this.id ?? null;
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'hidden') this.hidden = false; }
  append(...elements) {
    for (const element of elements) {
      if (element.tagName === '#fragment') this.append(...element.children);
      else { element.parentElement = this; this.children.push(element); }
    }
  }
  replaceChildren(...elements) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.text = ''; this.append(...elements); }
  insertAdjacentElement(position, element) {
    assert.equal(position, 'afterend');
    const siblings = this.parentElement.children;
    element.parentElement = this.parentElement;
    siblings.splice(siblings.indexOf(this) + 1, 0, element);
  }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const match = /^(\w+)?(?:\[([^\]]+)\])?$/.exec(selector);
    assert.ok(match, 'Unsupported test DOM selector: ' + selector);
    return (!match[1] || this.tagName === match[1]) && (!match[2] || this.getAttribute(match[2]) !== null);
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  dispatch(name, event = {}) { for (const callback of this.listeners.get(name) ?? []) callback({ target: this, preventDefault() {}, ...event }); }
  focus() {}
  select() {}
}

function parseMarkup(markup, parent) {
  const stack = [parent];
  const tokens = markup.match(/<[^>]+>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (!token.startsWith('<')) { stack.at(-1).text = (stack.at(-1).text ?? '') + decode(token); continue; }
    const [, tagName, attributes] = /^<(\w+)\b([\s\S]*?)\/?\s*>$/.exec(token) ?? [];
    assert.ok(tagName, 'Unsupported test DOM markup: ' + token);
    const element = new Element(tagName.toLowerCase());
    for (const attribute of attributes.matchAll(/([\w-]+)(?:="([^"]*)"|'([^']*)')?/g)) {
      element.setAttribute(attribute[1], decode(attribute[2] ?? attribute[3] ?? ''));
    }
    stack.at(-1).append(element);
    if (!['meta', 'input', 'br', 'link', 'hr'].includes(element.tagName) && !token.endsWith('/>')) stack.push(element);
  }
}

function scriptsIn(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .map(([, attributes, script]) => ({ attributes, script }));
}

function viewer(sources, url = 'https://example.test/docs/diagrams/ecs-source.html?workspace=D%3A%2Fdemo') {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'case-'));
  const html = fs.readFileSync(writeSourceViewer({ outputDirectory: directory, sources }), 'utf8');
  const document = new Element('#document');
  // 数据块独立注入 textContent，遵循浏览器不把 JSON 当作 HTML 的行为。
  parseMarkup(html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, '$1</script>')
    .replace(/(<style\b[^>]*>)[\s\S]*?<\/style\s*>/gi, '$1</style>'), document);
  document.createElement = name => new Element(name);
  document.createDocumentFragment = () => new Element('#fragment');
  document.getElementById = id => {
    const walk = node => node.id === id ? node : node.children.map(walk).find(Boolean);
    return walk(document);
  };
  const location = new URL(url);
  const events = new Map();
  const animationFrames = [];
  const context = vm.createContext({
    document, location, URL, URLSearchParams,
    localStorage: { getItem: () => null },
    history: { replaceState: (_, __, nextUrl) => { location.href = nextUrl; } },
    navigator: {},
    addEventListener: (name, callback) => { events.set(name, callback); },
    requestAnimationFrame: callback => { animationFrames.push(callback); },
  });
  for (const { attributes, script } of scriptsIn(html)) {
    if (/type="application\/json"/.test(attributes)) document.getElementById('sources').textContent = script;
    else vm.runInContext(script, context, { filename: 'ecs-source.html' });
  }
  return {
    html, document, location, context,
    get: id => document.getElementById(id),
    hash(value) { location.hash = value; events.get('hashchange')(); },
    clickLine(number) {
      const anchor = document.getElementById('code').children[number - 1].children[0];
      // 浏览器默认锚点导航先更新 fragment，再执行下一帧的定位回调。
      document.getElementById('code').dispatch('click', { target: anchor });
      location.href = new URL(anchor.href, location.href).href;
      animationFrames.splice(0).forEach(callback => callback());
    },
  };
}

const selected = page => page.get('code').children.filter(row => row.classList.contains('selected')).map(row => row.id);

test('generated viewer numbers CRLF, lone CR, empty and trailing lines as safe text', () => {
  const page = viewer([{ path: 'src/example.rs', text: 'first\r\n\r\nlast\rend\r\n' }]);
  assert.deepEqual(page.get('code').children.map(row => row.children[1].textContent), ['first', '', 'last', 'end', '']);
  assert.deepEqual(page.get('code').children.map(row => row.id), ['L1', 'L2', 'L3', 'L4', 'L5']);
  assert.deepEqual(page.get('code').children.map(row => new URL(row.children[0].href, page.location.href).hash), ['#L1', '#L2', '#L3', '#L4', '#L5']);
  assert.match(page.get('summary').textContent, /5 行/);
  assert.equal(page.get('editor-open').href, 'vscode://file/D:/demo/src/example.rs:1:1');
});

test('hash navigation and line clicks update the same editor location and remove stale highlight', () => {
  const page = viewer([{ path: 'src/example.rs', text: 'one\ntwo\nthree\n' }],
    'https://example.test/docs/diagrams/ecs-source.html?file=src%2Fexample.rs&workspace=D%3A%2Fdemo#L3');
  assert.deepEqual(selected(page), ['L3']);
  assert.equal(page.get('editor-open').href, 'vscode://file/D:/demo/src/example.rs:3:1');
  page.clickLine(2);
  assert.deepEqual(selected(page), ['L2']);
  assert.equal(page.get('editor-open').dataset.vscodeLine, '2');
  assert.equal(page.get('editor-open').href, 'vscode://file/D:/demo/src/example.rs:2:1');
  page.hash('#L4');
  assert.deepEqual(selected(page), ['L4']);
  assert.equal(page.get('editor-open').href, 'vscode://file/D:/demo/src/example.rs:4:1');
});

test('invalid hashes clear highlight and safely reset editor navigation to the first line', () => {
  const page = viewer([{ path: 'src/example.rs', text: 'one\ntwo' }]);
  for (const hash of ['#L0', '#L-1', '#L01', '#L1.5', '#L3', '#L9007199254740992', '#other', '#L%32']) {
    page.hash('#L2');
    page.hash(hash);
    assert.deepEqual(selected(page), [], hash);
    assert.equal(page.get('editor-open').dataset.vscodeLine, '1', hash);
    assert.equal(page.get('editor-open').href, 'vscode://file/D:/demo/src/example.rs:1:1', hash);
    assert.match(page.get('status').textContent, /定位行不存在/, hash);
  }
  page.hash('');
  assert.equal(page.get('status').textContent, '');
});

test('file changes preserve workspace and unrelated parameters while clearing the old fragment', () => {
  const sources = [{ path: 'src/first.rs', text: 'one\ntwo' }, { path: 'src/中文 #%.rs', text: 'next' }];
  const page = viewer(sources, 'https://example.test/docs/diagrams/ecs-source.html?workspace=D%3A%2Fwork+%E4%B8%AD%23%25&file=src%2Ffirst.rs&theme=light#L2');
  page.get('file').value = sources[1].path;
  page.get('file').dispatch('change');
  assert.equal(page.location.searchParams.get('workspace'), 'D:/work 中#%');
  assert.equal(page.location.searchParams.get('theme'), 'light');
  assert.equal(page.location.searchParams.get('file'), sources[1].path);
  assert.equal(page.location.hash, '');
  const next = viewer(sources, page.location.href);
  assert.equal(next.get('editor-open').dataset.vscodePath, sources[1].path);
  assert.equal(next.get('editor-open').href, 'vscode://file/D:/work%20%E4%B8%AD%23%25/src/%E4%B8%AD%E6%96%87%20%23%25.rs:1:1');
  const back = next.document.querySelectorAll('a[href]').find(anchor => anchor.textContent === '返回架构图');
  assert.equal(new URL(back.href).searchParams.get('workspace'), 'D:/work 中#%');
});

test('unknown or explicitly blank files hide the editor entry instead of reusing a previous file', () => {
  for (const file of ['src/missing.rs', '', '../outside.rs', '</script>']) {
    const page = viewer([{ path: 'src/example.rs', text: 'one' }],
      'https://example.test/docs/diagrams/ecs-source.html?workspace=D%3A%2Fdemo&file=' + encodeURIComponent(file) + '#L1');
    assert.equal(page.get('code').children.length, 0, file);
    assert.equal(page.get('file').value, '', file);
    assert.equal(page.get('editor-open').hidden, true, file);
    assert.equal(page.get('editor-open').getAttribute('href'), null, file);
    assert.equal(page.get('empty').hidden, false, file);
  }
});

test('empty files remain openable at line one and empty snapshots expose no source entry', () => {
  const page = viewer([{ path: 'src/empty.rs', text: '' }],
    'https://example.test/docs/diagrams/ecs-source.html?workspace=D%3A%2Fdemo#L8');
  assert.equal(page.get('code').children.length, 0);
  assert.equal(page.get('empty').textContent, '此文件为空。');
  assert.equal(page.get('editor-open').hidden, false);
  assert.equal(page.get('editor-open').href, 'vscode://file/D:/demo/src/empty.rs:1:1');
  const empty = viewer([]);
  assert.equal(empty.get('empty').textContent, '此快照未包含源码文件。');
  assert.equal(empty.get('editor-open').hidden, true);
  assert.equal(empty.get('editor-open').getAttribute('href'), null);
});

test('embedded script and HTML fragments survive exactly as text without creating executable markup', () => {
  const text = '</script><script>globalThis.sourceInjected = true</script>\n<img src=x onerror="globalThis.sourceInjected = true"> & \u2028 \u2029\n';
  const page = viewer([{ path: 'src/danger.rs', text }]);
  assert.equal(scriptsIn(page.html).length, 3);
  assert.equal(page.context.sourceInjected, undefined);
  assert.equal(page.get('code').children.map(row => row.children[1].textContent).join('\n'), text);
  assert.equal(page.get('code').querySelectorAll('script').length, 0);
  assert.equal(page.get('code').querySelectorAll('img').length, 0);
  assert.deepEqual(JSON.parse(page.get('sources').textContent), [{ path: 'src/danger.rs', text }]);
});

test('actual architecture details retain both source entries and omit entries on nodes without source', () => {
  const html = fs.readFileSync(path.join(root, 'docs', 'diagrams', 'ecs-architecture.html'), 'utf8');
  const script = scriptsIn(html).find(item => item.script.includes('function sourceLink('))?.script;
  assert.ok(script, 'Generated architecture must contain source links');
  // 从交付 HTML 提取真实函数，只替代无关的图形渲染；断言调用产生的详细面板。
  const definitions = script.split(/\r?\n/).filter(line =>
    line.startsWith('const safe=') || line.startsWith('function sourceLink(') || line.startsWith('function showDetail(')).join('\n');
  const details = new Element('aside');
  const clear = {};
  let refreshScope;
  const context = vm.createContext({
    details, DATA: { registry: { source: { name: 'update', source: { path: 'src/中文 #%.rs', line: 8, column: 3 } }, data: { name: 'Resource' } } },
    list: () => '', select() {}, guide() {}, document: { getElementById: () => clear },
    sourceEditor: { refreshLinks(scope) { refreshScope = scope; } },
  });
  vm.runInContext(definitions + '\nshowDetail("source");', context);
  const links = details.querySelectorAll('a');
  assert.equal(links.length, 2);
  const offline = new URL(links[0].href, 'https://example.test/docs/diagrams/ecs-architecture.html');
  assert.equal(offline.searchParams.get('file'), 'src/中文 #%.rs');
  assert.equal(offline.hash, '#L8');
  assert.equal(links[1].dataset.vscodePath, 'src/中文 #%.rs');
  assert.equal(links[1].dataset.vscodeLine, '8');
  assert.equal(links[1].dataset.vscodeColumn, '3');
  assert.equal(refreshScope, details);
  vm.runInContext('showDetail("data");', context);
  assert.equal(details.querySelectorAll('a').length, 0);
  for (const source of [{}, { path: 'src/a.rs' }, { path: 'src/a.rs', line: 0 }, { path: 'src/a.rs', line: 1.5 }]) {
    context.invalidSource = source;
    assert.equal(vm.runInContext('sourceLink(invalidSource)', context), '');
  }
});

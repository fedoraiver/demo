// 执行生成页中的真实脚本，验证源码定位；最小 DOM 不打开浏览器或外部编辑器。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { writeSourceViewer } from '../src/source-viewer.mjs';
import { Element, parseMarkup, scriptsIn } from './test-dom.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const temporaryRoot = path.join(root, 'tmp', 'source-viewer-tests');
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
  assert.equal(page.get('summary').textContent, 'src/example.rs · 5 行');
  assert.equal(page.get('editor-open').href, 'vscode://file/D:/demo/src/example.rs:1:1');
});

test('source headings omit repeated opening and snapshot guidance while keeping file, editor and location controls', () => {
  const page = viewer([{ path: 'src/example.rs', text: 'one\ntwo' }]);
  assert.match(page.html, /<p id="summary"><\/p>/);
  assert.match(page.html, /#summary:empty,#status:empty\{display:none\}/);
  assert.doesNotMatch(page.html, /这是生成架构图时保存的源码快照|点击行号可以更新当前定位链接|VS Code 打开当前工作区文件|快照行号可能不再对应|生成时的源码快照/);
  assert.equal(page.get('summary').textContent, 'src/example.rs · 2 行');
  assert.equal(page.get('file').getAttribute('aria-label'), '选择源码文件');
  assert.equal(page.get('file').value, 'src/example.rs');
  assert.equal(page.get('editor-open').textContent, '在 VS Code 中打开');
  assert.equal(page.get('editor-open').href, 'vscode://file/D:/demo/src/example.rs:1:1');
  assert.ok(page.document.querySelector('[data-workspace-config]'));
  const controls = page.document.querySelector('[data-source-location]');
  assert.ok(controls);
  assert.equal(controls.querySelector('input').value, 'D:/demo/src/example.rs:1:1');
  assert.equal(controls.querySelector('button').textContent, '复制定位');
  assert.equal(page.get('status').getAttribute('role'), 'status');
  assert.equal(page.get('status').getAttribute('aria-live'), 'polite');
  assert.equal(page.get('scroller').getAttribute('aria-label'), '完整源码，可滚动');
});

test('the generated source page omits the shared bottom directory status while preserving line feedback', () => {
  const page = viewer([{ path: 'src/example.rs', text: 'one\ntwo' }]);
  assert.equal(page.document.querySelector('[data-workspace-status]'), null);
  const dialog = page.document.querySelector('[data-workspace-dialog]');
  assert.equal(dialog.querySelectorAll('p').length, 1);
  assert.ok(dialog.querySelector('[data-workspace-error]'));
  assert.equal(dialog.querySelectorAll('button').length, 3);
  page.hash('#L2');
  assert.match(page.get('status').textContent, /已定位到第 2 行/);
  page.hash('#L3');
  assert.match(page.get('status').textContent, /定位行不存在/);
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

test('Cargo snapshots keep their logical file key while line actions use the dependency definition path', () => {
  const dependency = { name: 'avian3d', version: '0.7.0', root: 'C:/Cargo & 中文 #%/avian3d-0.7.0' };
  const path = 'cargo/avian3d-0.7.0/src/中文 #%.rs';
  const snapshot = { path, text: 'one\ntwo\nthree', source: { path: 'src/中文 #%.rs', line: 1, dependency } };
  const sources = [snapshot, { path: 'src/main.rs', text: 'project' }];
  const query = '?file=' + encodeURIComponent(path);
  for (const workspace of ['', '&workspace=E%3A%2Fother-project', '&workspace=relative']) {
    const page = viewer(sources, 'https://example.test/docs/diagrams/ecs-source.html' + query + workspace + '#L3');
    const link = page.get('editor-open'), controls = page.document.querySelector('[data-source-location]');
    assert.equal(page.get('file').value, path);
    assert.equal(page.get('summary').textContent, path + ' · 3 行');
    assert.equal(link.dataset.vscodePath, snapshot.source.path);
    assert.equal(link.dataset.vscodeDependencyName, dependency.name);
    assert.equal(link.dataset.vscodeDependencyVersion, dependency.version);
    assert.equal(link.dataset.vscodeDependencyRoot, dependency.root);
    assert.equal(controls.querySelector('input').value, dependency.root + '/src/中文 #%.rs:3:1');
    assert.equal(link.href, 'vscode://file/C:/Cargo%20%26%20%E4%B8%AD%E6%96%87%20%23%25/avian3d-0.7.0/src/%E4%B8%AD%E6%96%87%20%23%25.rs:3:1');
    assert.deepEqual(selected(page), ['L3']);
    page.clickLine(2);
    assert.ok(link.href.endsWith(':2:1'));
    assert.equal(page.get('status').textContent, '已定位到第 2 行。');
    page.hash('#L99');
    assert.ok(link.href.endsWith(':1:1'));
    assert.deepEqual(selected(page), []);
    // 模拟重新渲染另一文件，确认复用 anchor 不会沿用上一依赖的根目录。
    page.location.searchParams.set('file', 'src/main.rs');
    page.location.hash = '';
    vm.runInContext('showFile()', page.context);
    assert.equal(link.dataset.vscodeDependencyRoot, undefined);
    assert.equal(link.dataset.vscodeDependencyName, undefined);
    assert.equal(link.dataset.vscodeDependencyVersion, undefined);
    assert.equal(link.dataset.vscodePath, 'src/main.rs');
    assert.equal(link.href, workspace.includes('E%3A') ? 'vscode://file/E:/other-project/src/main.rs:1:1' : '#workspace-config');
  }
  const page = viewer(sources, 'https://example.test/docs/diagrams/ecs-source.html' + query + '#L2');
  page.get('file').value = 'src/main.rs';
  page.get('file').dispatch('change');
  assert.equal(page.location.searchParams.get('file'), 'src/main.rs');
  assert.equal(page.location.searchParams.get('workspace'), null);
  assert.equal(page.location.hash, '');
  assert.deepEqual(JSON.parse(page.get('sources').textContent), sources);
});

test('invalid dependency snapshot targets are hidden rather than joined to the project workspace', () => {
  for (const source of [
    { path: '../lib.rs', line: 1, dependency: { name: 'avian3d', version: '0.7.0', root: 'C:/cargo/avian3d-0.7.0' } },
    { path: 'src/lib.rs', line: 1, dependency: { name: 'avian3d', version: '0.7.0', root: 'relative' } },
    { path: 'src/lib.rs', line: 1, dependency: { name: '../avian3d', version: '0.7.0', root: 'C:/cargo/avian3d-0.7.0' } },
  ]) {
    const page = viewer([{ path: 'cargo/avian3d-0.7.0/src/lib.rs', text: 'text', source }]);
    assert.equal(page.get('editor-open').getAttribute('href'), null);
    assert.equal(page.document.querySelector('[data-source-location]'), null);
    assert.equal(page.get('code').children[0].children[1].textContent, 'text');
  }
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
    assert.equal(page.get('summary').textContent, '', file);
  }
});

test('empty files remain openable at line one and empty snapshots expose no source entry', () => {
  const page = viewer([{ path: 'src/empty.rs', text: '' }],
    'https://example.test/docs/diagrams/ecs-source.html?workspace=D%3A%2Fdemo#L8');
  assert.equal(page.get('code').children.length, 0);
  assert.equal(page.get('empty').textContent, '此文件为空。');
  assert.equal(page.get('summary').textContent, 'src/empty.rs · 空文件');
  assert.equal(page.get('editor-open').hidden, false);
  assert.equal(page.get('editor-open').href, 'vscode://file/D:/demo/src/empty.rs:1:1');
  const empty = viewer([]);
  assert.equal(empty.get('empty').textContent, '此快照未包含源码文件。');
  assert.equal(empty.get('editor-open').hidden, true);
  assert.equal(empty.get('editor-open').getAttribute('href'), null);
  assert.equal(empty.get('summary').textContent, '');
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

test('actual architecture details retain only the VS Code source entry and preserve full node descriptions', () => {
  const html = fs.readFileSync(path.join(root, 'docs', 'diagrams', 'generated', 'pages', 'ecs-architecture.html'), 'utf8');
  const script = scriptsIn(html).find(item => item.script.includes('function sourcesList('))?.script;
  assert.ok(script, 'Generated architecture must contain source links');
  // 从交付 HTML 提取真实函数，只替代无关的图形渲染；断言调用产生的详细面板。
  const definitions = script.split(/\r?\n/).filter(line =>
    /^\s*const (safe|canonical)=/.test(line)).join('\n')
    + '\n' + script.slice(script.indexOf('function list('), script.indexOf('function guide('))
    + '\n' + script.slice(script.indexOf('function showDetail('), script.indexOf('function releaseDiagramFocus('));
  const details = new Element('aside');
  const clear = {};
  let refreshScope;
  const context = vm.createContext({
    details, componentEntities: new Map(), view: { nodes: [] }, DATA: { model: { features: [], entities: [] }, registry: { source: { name: 'update', description: '完整节点说明保留注册顺序与生命周期约束。', sourceEntries: [{ role: 'definition', label: '函数定义', path: 'src/中文 #%.rs', line: 8, column: 3 }], source: { path: 'src/legacy.rs', line: 1 } }, data: { name: 'Resource' } } },
    select() {}, guide() {}, objectView: () => null, document: { getElementById: () => clear },
    sourceEditor: { refreshLinks(scope) { refreshScope = scope; } },
  });
  vm.runInContext(definitions + '\nshowDetail("source");', context);
  const links = details.querySelectorAll('a');
  assert.equal(links.length, 1);
  assert.equal(links[0].dataset.vscodePath, 'src/中文 #%.rs');
  assert.equal(links[0].dataset.vscodeLine, '8');
  assert.equal(links[0].dataset.vscodeColumn, '3');
  assert.ok(details.textContent.includes('完整节点说明保留注册顺序与生命周期约束。'));
  assert.doesNotMatch(details.textContent, /离线源码快照/);
  assert.equal(refreshScope, details);
  vm.runInContext('showDetail("data");', context);
  assert.equal(details.querySelectorAll('a').length, 0);
  for (const source of [{}, { path: 'src/a.rs' }, { path: 'src/a.rs', line: 0 }, { path: 'src/a.rs', line: 1.5 }]) {
    context.invalidSource = source;
    assert.equal(vm.runInContext('sourcesList([invalidSource])', context), '');
  }
});

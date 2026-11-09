// 执行生成页中的真实脚本，验证源码定位；最小 DOM 不打开浏览器或外部编辑器。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { writeSourceViewer } from '../src/source-viewer.mjs';
import { dependencyKind, normalizeSourceEntry, normalizeWorkspaceRoot } from '../src/source-editor.mjs';
import { renderArchitectureViewer } from '../src/architecture-viewer.mjs';
import { Element, parseMarkup, scriptsIn, testDocument } from './test-dom.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const temporaryRoot = path.join(root, 'tmp', 'ecs-architecture', 'card-display-fix', 'source');
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

test('source snapshot generation rejects ambiguous logical file keys', () => {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'ambiguous-'));
  const logicalPath = 'cargo/example-1.0.0/src/lib.rs';
  assert.throws(() => writeSourceViewer({ outputDirectory: directory, sources: [
    { path: logicalPath, text: 'first source' }, { path: logicalPath, text: 'different source' },
  ] }), /Ambiguous source snapshot/);
});

test('snapshot generation rejects same-name package origins even when their files differ', () => {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'ambiguous-package-'));
  const entry = (filename, root) => ({ path: 'cargo/example-1.0.0/' + filename, text: 'source',
    source: { path: filename, line: 1, dependency: { name: 'example', version: '1.0.0', root } } });
  assert.throws(() => writeSourceViewer({ outputDirectory: directory, sources: [
    entry('src/lib.rs', '/home/runner/.cargo/registry/src/ci-hash/example-1.0.0'),
    entry('src/git_impl.rs', '/home/runner/.cargo/git/checkouts/example-abcd/123456'),
  ] }), /Ambiguous dependency source roots: example@1\.0\.0/);
  assert.throws(() => writeSourceViewer({ outputDirectory: directory, sources: [
    entry('src/lib.rs', 'relative-one'), entry('src/other.rs', 'relative-two'),
  ] }), /Ambiguous dependency source roots/);
  assert.doesNotThrow(() => writeSourceViewer({ outputDirectory: directory, sources: [
    entry('src/lib.rs', 'E:\\cargo\\example'), entry('src/other.rs', '//?/E:/cargo/example/'),
  ] }));
});

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
  assert.equal(dialog.querySelectorAll('p').length, 2);
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
    assert.ok(page.get('file').children.every(option => !/runner|Cargo &/.test(option.textContent)));
    assert.equal(page.get('summary').textContent, path + ' · 3 行');
    assert.equal(link.dataset.vscodePath, snapshot.source.path);
    assert.equal(link.dataset.vscodeDependencyName, dependency.name);
    assert.equal(link.dataset.vscodeDependencyVersion, dependency.version);
    assert.equal(link.dataset.vscodeDependencyRoot, undefined);
    assert.equal(link.dataset.vscodeDependencyKind, 'package');
    vm.runInContext('sourceEditor.configureCargoPackage({name:"avian3d",version:"0.7.0"}, "C:/local/avian3d")', page.context);
    assert.equal(controls.querySelector('input').value, 'avian3d-0.7.0/src/中文 #%.rs:3:1');
    assert.equal(link.href, 'vscode://file/C:/local/avian3d/src/%E4%B8%AD%E6%96%87%20%23%25.rs:3:1');
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

test('invalid dependency snapshot paths and identities are rejected rather than joined to the project workspace', () => {
  for (const source of [
    { path: '../lib.rs', line: 1, dependency: { name: 'avian3d', version: '0.7.0', root: 'C:/cargo/avian3d-0.7.0' } },
    { path: 'src/lib.rs', line: 1, dependency: { name: '../avian3d', version: '0.7.0', root: 'C:/cargo/avian3d-0.7.0' } },
  ]) {
    const page = viewer([{ path: 'cargo/avian3d-0.7.0/src/lib.rs', text: 'text', source }]);
    assert.equal(page.get('editor-open').getAttribute('href'), null);
    assert.equal(page.document.querySelector('[data-source-location]'), null);
    assert.equal(page.get('code').children[0].children[1].textContent, 'text');
  }
});

test('dependency snapshots with unavailable roots retain safe relative locations and a visible reason', () => {
  for (const root of [undefined, '', 'relative', '//?/GLOBALROOT/Device/HarddiskVolume1']) {
    const dependency = { name: 'bevy_asset', version: '0.20.0', ...(root === undefined ? {} : { root }) };
    const page = viewer([{ path: 'cargo/bevy_asset-0.20.0/src/lib.rs', text: 'one\ntwo', source: { path: 'src/lib.rs', line: 1, dependency } }]);
    const link = page.get('editor-open'), controls = page.document.querySelector('[data-source-location]');
    assert.equal(link.getAttribute('href'), '#workspace-config');
    assert.equal(link.getAttribute('aria-disabled'), null);
    assert.equal(controls.querySelector('input').value, 'bevy_asset-0.20.0/src/lib.rs:1:1');
    assert.match(controls.querySelector('[data-source-unavailable]').textContent, /配置此依赖包/);
    page.hash('#L2');
    assert.equal(controls.querySelector('input').value, 'bevy_asset-0.20.0/src/lib.rs:2:1');
    assert.equal(link.getAttribute('href'), '#workspace-config');
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

function architectureDetails(registry, workspace = 'D:/demo', clipboard) {
  const html = renderArchitectureViewer({ model: { features: [] }, registry, views: [], features: [] });
  const script = scriptsIn(html).find(item => item.script.includes('function sourcesList('))?.script;
  assert.ok(script, 'Generated architecture must contain source links');
  // 从交付 HTML 提取真实函数，只替代无关的图形渲染；断言调用产生的详细面板。
  const definitions = script.split(/\r?\n/).filter(line =>
    /^\s*const (safe|canonical)=/.test(line)).join('\n')
    + '\n' + script.slice(script.indexOf('function list('), script.indexOf('function guide('))
    + '\n' + script.slice(script.indexOf('function showDetail('), script.indexOf('function releaseDiagramFocus('));
  const document = testDocument(html), details = document.getElementById('details');
  const location = new URL('https://example.test/docs/diagrams/ecs-architecture.html');
  if (workspace !== null) location.searchParams.set('workspace', workspace);
  const context = vm.createContext({
    document, details, location, URL, dependencyKind, normalizeSourceEntry, normalizeWorkspaceRoot, navigator: { clipboard },
    localStorage: { getItem: () => null },
    history: { replaceState: (_, __, url) => { location.href = url; } },
    setTimeout: () => 1, clearTimeout() {},
    view: { objectId: 'data' }, DATA: { registry },
    guide() {}, objectView: () => ({}),
  });
  const editorScript = scriptsIn(html).find(item => item.script.startsWith('const sourceEditor ='))?.script;
  assert.ok(editorScript, 'Generated architecture must contain the shared source editor');
  vm.runInContext(editorScript + '\n' + definitions, context);
  return { document, details, context, location, show: id => vm.runInContext('showDetail(' + JSON.stringify(id) + ');', context) };
}

test('generated architecture details keep source locations while leaving analysis gaps in data', () => {
  const page = architectureDetails({ source: { name: 'update', description: '完整节点说明保留注册顺序与生命周期约束。', feature: 'item', owner: '隐藏归属', reads: ['data'], fields: ['隐藏字段'], sourceGaps: ['隐藏缺口'], sourceEntries: [{ role: 'definition', label: '函数定义', path: 'src/中文 #%.rs', line: 8, column: 3 }], source: { path: 'src/legacy.rs', line: 1 } }, data: { name: 'Resource' } });
  const { details, context } = page;
  page.show('source');
  const links = details.querySelectorAll('a');
  assert.equal(links.length, 1);
  assert.equal(links[0].dataset.vscodePath, 'src/中文 #%.rs');
  assert.equal(links[0].dataset.vscodeLine, '8');
  assert.equal(links[0].dataset.vscodeColumn, '3');
  assert.equal(links[0].href, 'vscode://file/D:/demo/src/%E4%B8%AD%E6%96%87%20%23%25.rs:8:3');
  assert.equal(details.querySelector('[data-source-location] input').value, 'D:/demo/src/中文 #%.rs:8:3');
  assert.ok(!details.textContent.includes('完整节点说明保留注册顺序与生命周期约束。'));
  assert.equal(details.textContent.includes('隐藏缺口'), false);
  assert.deepEqual(details.children.map(child => child.tagName), ['h2', 'p', 'button', 'section']);
  assert.equal(details.querySelector('[data-object]').dataset.object, 'source');
  assert.equal(details.querySelector('#clear-selection'), null);
  assert.doesNotMatch(details.textContent, /隐藏归属|隐藏字段|src\/legacy\.rs/);
  assert.doesNotMatch(details.textContent, /离线源码快照/);
  page.show('data');
  assert.equal(details.querySelectorAll('a').length, 0);
  assert.deepEqual(details.children.map(child => child.tagName), ['h2', 'p']);
  for (const source of [{}, { path: 'src/a.rs' }, { path: 'src/a.rs', line: 0 }, { path: 'src/a.rs', line: 1.5 }]) {
    context.invalidSource = source;
    assert.equal(vm.runInContext('sourcesList([invalidSource])', context), '');
  }
});

// 来自真实 runtime 的 assetEventsCondition 定义；仅把本机 Cargo 根替换为脱敏目录。
const nativeSourceEntry = {
  column: 5,
  dependency: { name: 'bevy_asset', root: '//?/C:/Cargo Registry/中文 #%/bevy_asset-0.20.0', version: '0.20.0' },
  expansions: [], label: '定义位置', line: 617, path: 'src/assets.rs', role: 'definition',
  sha256: 'f7f691fee61cccb5a16912afcf576ee2bf758a754fd5389120beeb71986844f4',
};

test('native Cargo sourceEntries use portable labels and local registry mappings across producer platforms', () => {
  for (const root of ['/home/runner/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/bevy_asset-0.20.0',
    '\\\\?\\C:\\Users\\builder\\.cargo\\registry\\src\\another-hash\\bevy_asset-0.20.0']) {
    const source = { ...nativeSourceEntry, dependency: { ...nativeSourceEntry.dependency, root } };
    const original = structuredClone(source);
    const page = architectureDetails({ source: { name: 'assetEventsCondition', sourceEntries: [source] } });
    page.show('source');
    const link = page.details.querySelector('a[data-vscode-path]');
    assert.equal(link.href, '#workspace-config');
    assert.equal(link.dataset.vscodeDependencyRoot, undefined);
    assert.equal(link.dataset.vscodeDependencyKind, 'registry');
    assert.equal(page.details.querySelector('[data-source-location] input').value, 'bevy_asset-0.20.0/src/assets.rs:617:5');
    assert.doesNotMatch(page.details.textContent, /runner|builder|1949cf8c/);
    vm.runInContext('sourceEditor.configureCargoRegistry("C:/Users/local/.cargo/registry/src/local-hash")', page.context);
    assert.equal(link.href, 'vscode://file/C:/Users/local/.cargo/registry/src/local-hash/bevy_asset-0.20.0/src/assets.rs:617:5');
    assert.equal(link.dataset.workspaceState, 'ready');
    assert.equal(page.details.querySelector('[data-source-unavailable]').textContent, '');
    vm.runInContext('sourceEditor.configure("E:/other-project");', page.context);
    assert.ok(link.href.includes('/local-hash/'));
    assert.deepEqual(source, original);
  }
});

test('unknown Cargo source entries require a package mapping while retaining portable copy locations', async () => {
  for (const root of [undefined, '', '/home/runner/.cargo/git/checkouts/bevy-aabb/12345', 'E:/path-dependency']) {
    const dependency = { ...nativeSourceEntry.dependency };
    if (root === undefined) delete dependency.root; else dependency.root = root;
    const copied = [], source = { ...nativeSourceEntry, dependency };
    const page = architectureDetails({ source: { name: 'assetEventsCondition', sourceEntries: [source] } }, 'D:/project', { writeText: async value => copied.push(value) });
    page.show('source');
    const link = page.details.querySelector('a[data-vscode-path]'), controls = page.details.querySelector('[data-source-location]');
    assert.equal(link.getAttribute('href'), '#workspace-config');
    assert.equal(link.dataset.workspaceState, 'unconfigured');
    assert.equal(controls.querySelector('input').value, 'bevy_asset-0.20.0/src/assets.rs:617:5');
    assert.match(controls.querySelector('[data-source-unavailable]').textContent, /配置此依赖包/);
    controls.querySelector('button').dispatch('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(copied, ['bevy_asset-0.20.0/src/assets.rs:617:5']);
    vm.runInContext('sourceEditor.configureCargoRegistry("C:/registry/local-hash")', page.context);
    assert.equal(link.href, '#workspace-config');
    vm.runInContext('sourceEditor.configureCargoPackage({name:"bevy_asset",version:"0.20.0"},"E:/my-checkout")', page.context);
    assert.equal(link.href, 'vscode://file/E:/my-checkout/src/assets.rs:617:5');
  }
});

test('generated architecture links reject unsafe paths and coordinates instead of retaining stale editor targets', () => {
  for (const invalid of [
    { path: '../outside.rs' }, { path: 'C:/outside.rs' }, { path: 'src/../outside.rs' },
    { path: 'src/\ud800.rs' }, { column: 0 }, { column: null }, { column: NaN },
    { column: -1 }, { column: 1.5 }, { column: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const page = architectureDetails({ source: { name: 'assetEventsCondition', sourceEntries: [{ ...nativeSourceEntry, ...invalid }] } });
    page.show('source');
    const link = page.details.querySelector('a[data-vscode-path]');
    assert.equal(link.getAttribute('href'), null);
    assert.equal(link.getAttribute('aria-disabled'), 'true');
    assert.equal(link.dispatch('click').defaultPrevented, true);
    assert.equal(page.details.querySelector('[data-source-location]'), null);
  }
  const source = { ...nativeSourceEntry };
  delete source.column;
  const page = architectureDetails({ source: { name: 'assetEventsCondition', sourceEntries: [source] } });
  page.show('source');
  vm.runInContext('sourceEditor.configureCargoPackage({name:"bevy_asset",version:"0.20.0"},"E:/my-checkout")', page.context);
  assert.ok(page.details.querySelector('a[data-vscode-path]').href.endsWith(':617:1'));
});

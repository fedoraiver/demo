// 执行交付 HTML 的真实内嵌脚本；这里只验证 DOM 交互，不代替浏览器视觉与协议验收。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { scriptsIn, testDocument } from './test-dom.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, selectedFillColor } from './architecture-style.mjs';
import { renderArchitectureViewer } from './architecture-viewer.mjs';
import { INFRASTRUCTURE_FEATURES } from './architecture-infrastructure.mjs';
import { vscodeUri } from './source-editor.mjs';
import { DEPENDENCY_SOURCE_DEFINITIONS } from './architecture-source-definitions.mjs';
import { dependencyDefinitionTargets } from './dependency-sources.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(directory, 'ecs-architecture.html'), 'utf8');
const sourceState = JSON.parse(/<script id="architecture-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
const sourceHtml = renderArchitectureViewer({ ...sourceState, features: sourceState.model.features });
const sourcePageState = JSON.parse(/<script id="architecture-data" type="application\/json">([\s\S]*?)<\/script>/.exec(sourceHtml)[1]);

function viewer(query = '', { historyUnavailable = false, htmlSource = html, pageUrl = 'file:///D:/demo/docs/diagrams/ecs-architecture.html', initialHistoryState = null, runtimeCompile = async () => { throw new Error('This DOM fixture has no dynamic Mermaid compiler'); } } = {}) {
  const html = htmlSource;
  const document = testDocument(html);
  const location = new URL(pageUrl + query);
  const events = new Map(), frames = [], timers = new Map();
  let timerId = 0;
  const entries = [location.href];
  const entryStates = [initialHistoryState];
  let historyIndex = 0;
  const history = {
    get state() { return entryStates[historyIndex]; },
    get length() { return entries.length; },
    pushState(state, __, value) {
      if (historyUnavailable) throw new Error('History is unavailable for this file');
      entries.splice(historyIndex + 1);
      entryStates.splice(historyIndex + 1);
      entries.push(new URL(value, location.href).href);
      entryStates.push(structuredClone(state));
      historyIndex++;
      location.href = entries[historyIndex];
    },
    replaceState(state, __, value) {
      if (historyUnavailable) throw new Error('History is unavailable for this file');
      location.href = new URL(value, location.href).href;
      entries[historyIndex] = location.href;
      entryStates[historyIndex] = structuredClone(state);
    },
  };
  const listen = (name, callback) => {
    if (!events.has(name)) events.set(name, []);
    events.get(name).push(callback);
  };
  const globals = {
    document, location, history, URL, URLSearchParams, Blob, innerWidth: 1440,
    navigator: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: callback => frames.push(callback),
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    architectureEntityRuntime: { compile: runtimeCompile },
    addEventListener: listen,
  };
  globals.window = globals;
  const context = vm.createContext(globals);
  const canvas = document.getElementById('canvas');
  canvas.clientWidth = 960;
  canvas.clientHeight = 620;
  for (const { attributes, script } of scriptsIn(html)) {
    if (/type="application\/json"/.test(attributes)) {
      const id = /\bid="([^"]+)"/.exec(attributes)?.[1];
      document.getElementById(id).textContent = script;
    } else if (!/\bid="architecture-runtime"/.test(attributes)) new vm.Script(script, { filename: 'ecs-architecture.html' }).runInContext(context);
  }
  const data = JSON.parse(document.getElementById('architecture-data').textContent);
  const get = id => document.getElementById(id);
  const flush = () => { while (frames.length) frames.splice(0).forEach(callback => callback()); };
  const emit = name => { for (const callback of events.get(name) || []) callback({ type: name }); flush(); };
  const base = () => data.views.find(view => view.id === vm.runInContext('typeof baseView === "undefined" ? view.id : baseView.id', context));
  const current = () => structuredClone(vm.runInContext('view', context));
  const settle = async () => { for (let turn = 0; turn < 20; turn++) { await Promise.resolve(); flush(); } };
  function click(element) { assert.ok(element, 'The actual page must contain the requested control'); element.click(); flush(); }
  function activate(id) {
    const node = get('diagram').querySelectorAll('[data-id]').find(element => element.dataset.id === id);
    assert.ok(node, 'The current SVG must contain ' + id);
    node.dispatch('keydown', { key: 'Enter' });
    flush();
  }
  flush();
  return {
    document, location, context, data, get, flush, settle, current, base, history, click, activate,
    feature: id => click(document.querySelector('.navigation').querySelector(`[data-feature="${id}"]`)),
    tab: aspect => click(document.querySelector(`[data-aspect="${aspect}"]`)),
    search(value) { get('search').value = value; get('search').dispatch('input'); flush(); },
    back() { assert.ok(historyIndex > 0); location.href = entries[--historyIndex]; emit('popstate'); },
    forward() { assert.ok(historyIndex + 1 < entries.length); location.href = entries[++historyIndex]; emit('popstate'); },
    timers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); },
  };
}

const sourceViewer = (query, options) => viewer(query, { ...options, htmlSource: sourceHtml });

function fixtureViewer(open, query, edit, options = {}) {
  const state = structuredClone(open === sourceViewer ? sourcePageState : sourceState);
  edit(state);
  const htmlSource = (open === sourceViewer ? sourceHtml : html).replace(/(<script id="architecture-data" type="application\/json">)[\s\S]*?(<\/script>)/,
    (_, start, end) => start + JSON.stringify(state).replace(/</g, '\\u003c') + end);
  return viewer(query, { ...options, htmlSource });
}

function entityContextViewer(open, edit = () => {}) {
  return fixtureViewer(open, '?feature=first_person&tab=data', state => {
    const view = state.views.find(view => view.feature === 'first_person' && view.aspect === 'data');
    delete view.entityViews;
    view.entityGroups = [
      { id: 'controller-context', entity: 'entity-controller', components: ['controller.PlayerId', 'controller.GameplayContext', 'controller.ControlsCharacter', 'controller.ControlsCamera'] },
      { id: 'camera-context', entity: 'entity-camera', components: ['camera.FirstPersonCamera', 'camera.MouseLookState'] },
    ];
    edit(state, view);
  }, { initialHistoryState: { architectureEntityModes: { 'plugin-first_person-data': 'all' } } });
}

function entityContainerFixture(open, nested) {
  return fixtureViewer(open, '?feature=first_person&tab=data', state => {
    const view = state.views.find(view => view.feature === 'first_person' && view.aspect === 'data');
    delete view.entityViews;
    const group = view.entityGroups.find(group => group.entity === 'entity-camera');
    const entity = view.nodes.find(node => node.id === group.entity);
    entity.presentation = 'entity-container'; entity.shape = 'rect';
    state.registry[group.entity].description += ' entity-container-mixed';
    state.registry['camera.FirstPersonCamera'].description += ' entity-container-mixed entity-component-only';
    const attribute = node => `class="node${node.id === group.entity ? ' entity-container' : ''}" data-id="${node.id}" data-instance="${node.instance}" data-visual-type="${node.visualType}" tabindex="0" role="button" aria-pressed="false"`;
    const geometry = node => { const style = state.styles.nodes[node.visualType]; return `<rect data-shape-part="${node.instance}" style="fill:${style.fill};stroke:${style.stroke};stroke-width:${style.width}px !important"/>`; };
    const card = node => `<g ${attribute(node)}>${geometry(node)}<g class="label"><text>Component</text></g></g>`;
    const components = view.nodes.filter(node => group.components.includes(node.id)).map(card).join('');
    const nestedEdge = view.links.find(link => link.id === 'write-observe_look-camera.FirstPersonCamera');
    const edge = link => `<path class="edge" data-link-id="${link.id}" tabindex="0" role="button"/>`;
    const header = `<g class="node" data-entity-header="${entity.instance}" data-entity-owner="${entity.id}" aria-hidden="true"><g class="label"><text>Entity header</text></g></g>`;
    view.svg = `<svg id="entity-container-fixture"><g ${attribute(entity)} data-presentation="entity-container" data-entity-group="${group.id}">${geometry(entity)}${nested ? header + components + edge(nestedEdge) : ''}</g>${nested ? '' : header + components + edge(nestedEdge)}${view.nodes.filter(node => node.id !== group.entity && !group.components.includes(node.id)).map(card).join('')}${view.links.filter(link => link !== nestedEdge).map(edge).join('')}</svg>`;
  }, { initialHistoryState: { architectureEntityModes: { 'plugin-first_person-data': 'all' } } });
}

function foldingViewer(open, query = '?feature=first_person&tab=data', options = {}) {
  let compile;
  return fixtureViewer(open, query, state => {
    const base = state.views.find(view => view.feature === 'first_person' && view.aspect === 'data');
    const { entityViews, ...full } = structuredClone(base);
    const owners = new Map(full.entityGroups.flatMap(group => group.components.map(id => [id, group.entity])));
    state.registry['camera.FirstPersonCamera'].description += ' fold-one fold-many';
    state.registry['controller.PlayerId'].description += ' fold-two fold-many';
    function presentation(mode) {
      const expanded = id => mode === 'all' || (Array.isArray(mode) ? mode.includes(id) : mode === id);
      const display = id => owners.has(id) && !expanded(owners.get(id)) ? owners.get(id) : id;
      const nodes = full.nodes.filter(node => display(node.id) === node.id).map((node, index) => {
        const group = full.entityGroups.find(group => group.entity === node.id);
        const toggle = group ? { entity: node.id, expanded: expanded(node.id), count: group.components.length, corner: { size: 24, inset: 8 }, label: (expanded(node.id) ? '收起组件' : '展开组件') + '（' + group.components.length + '）' } : null;
        return { ...node, position: { x: 80 + index * 40 + (mode === 'all' ? 160 : 0), y: 60 + index * 120, width: 260, height: group && expanded(node.id) ? 480 : 100 }, ...(group ? { presentation: expanded(node.id) ? 'entity-container' : undefined, entityToggle: toggle } : {}) };
      });
      const groups = full.entityGroups.map(group => ({ ...group, expanded: expanded(group.entity), bounds: nodes.find(node => node.id === group.entity).position }));
      const links = full.links.map(link => ({ ...link, displayFrom: display(link.from), displayTo: display(link.to) }));
      const svg = '<svg viewBox="10 20 1600 2400">' + nodes.map(node => {
        const style = state.styles.nodes[node.visualType];
        return '<g class="node' + (node.presentation === 'entity-container' ? ' entity-container' : '') + '" data-id="' + node.id + '" data-instance="' + node.instance + '" data-visual-type="' + node.visualType + '" tabindex="0" role="button" aria-pressed="false"><rect data-shape-part="' + node.instance + '" style="fill:' + style.fill + ';stroke:' + style.stroke + ';stroke-width:' + style.width + 'px !important"/><g class="label"><text>' + state.registry[node.id].name + '</text></g></g>';
      }).join('') + links.map(link => '<path class="edge" data-link-id="' + link.id + '" data-connect="' + link.displayFrom + '|' + link.displayTo + '" data-canonical-connect="' + link.from + '|' + link.to + '" tabindex="0" role="button"/>').join('') + '</svg>';
      return { ...full, nodes, links, entityGroups: groups, sections: groups.map(group => ({ label: state.registry[group.entity].name, entityGroup: group.id, ...group.bounds })), bounds: { x: 10, y: 20, width: 1600, height: 2400 }, width: 1600, height: 2400, svg };
    }
    Object.assign(base, presentation('all'));
    base.entityViews = Object.fromEntries(['collapsed', ...full.entityGroups.map(group => group.entity)].map(mode => [mode, presentation(mode)]));
    compile = (_, ids) => Promise.resolve(presentation(ids));
  }, { ...options, runtimeCompile: (base, ids) => options.runtimeCompile ? options.runtimeCompile(base, ids, () => compile(base, ids)) : compile(base, ids) });
}

const expandedIds = page => Array.from(vm.runInContext('entityMode', page.context));

function assertEditorActions(page, source, workspace) {
  const root = source.dependency?.root || workspace;
  const details = page.get('details'), links = details.querySelectorAll('a.source');
  assert.equal(links.length, 1);
  assert.equal(links[0].dataset.vscodePath, source.path);
  assert.equal(links[0].dataset.vscodeLine, String(source.line));
  assert.equal(links[0].href, vscodeUri(workspace, source));
  if (source.dependency) {
    assert.equal(links[0].dataset.vscodeDependencyName, source.dependency.name);
    assert.equal(links[0].dataset.vscodeDependencyVersion, source.dependency.version);
    assert.equal(links[0].dataset.vscodeDependencyRoot, source.dependency.root);
  }
  assert.equal(details.querySelectorAll('a[href]').some(anchor => new URL(anchor.href, page.location.href).pathname.endsWith('/ecs-source.html')), false);
  assert.doesNotMatch(details.textContent, /离线源码快照/);
  const controls = details.querySelectorAll('[data-source-location]');
  assert.equal(controls.length, 1);
  const field = controls[0].querySelector('input'), copy = controls[0].querySelector('button');
  assert.equal(field.value, `${root}/${source.path}:${source.line}:${source.column || 1}`);
  assert.equal(field.readOnly, true);
  assert.equal(copy.textContent, '复制定位');
  assert.equal(copy.getAttribute('aria-live'), 'polite');
  return { field, copy };
}

function outlineState(part) {
  return ['fill', 'stroke', 'stroke-width', 'stroke-dasharray'].map(name => [name, part.style.getPropertyValue(name), part.style.getPropertyPriority(name)]);
}

function ownShapeParts(node) {
  return node.querySelectorAll('[data-shape-part]').filter(part => part.dataset.shapePart === (node.dataset.instance || node.dataset.id) && part.closest('[data-id]') === node);
}

function nativeOutlineRoot(node) {
  let root = ownShapeParts(node)[0];
  while (root.parentElement !== node) root = root.parentElement;
  return root;
}

function assertNativeSelection(page) {
  const diagram = page.get('diagram');
  const originals = new Map(diagram.querySelectorAll('[data-shape-part]').map(part => [part, outlineState(part)]));
  const filters = new Map(diagram.querySelectorAll('[data-id]').map(node => {
    const root = nativeOutlineRoot(node);
    return [node, { root, value: root.style.getPropertyValue('filter'), priority: root.style.getPropertyPriority('filter'), nodeFilter: node.style.getPropertyValue('filter') }];
  }));
  const containers = new Map(diagram.querySelectorAll('[data-schedule-id]').map(group => [group, [...group.children].find(part => part.tagName === 'rect')]).filter(([, part]) => part));
  const containerWidths = new Map([...containers.values()].map(part => [part, [part.style.getPropertyValue('stroke-width'), part.style.getPropertyPriority('stroke-width'), parseFloat(part.style.getPropertyValue('stroke-width') || part.getAttribute('stroke-width') || 1)]]));
  return (selectedNodes = [], selectedSchedules = []) => {
    const scale = canvasTransform(page).scale;
    for (const [part, original] of originals) {
      const node = part.closest('[data-id]'), selected = selectedNodes.includes(node.dataset.id);
      assert.equal(node.classList.contains('selected'), selected, node.dataset.id);
      assert.equal(node.getAttribute('aria-pressed'), String(selected), node.dataset.id);
      const width = original.find(([name]) => name === 'stroke-width')[1];
      if (selected) assert.ok(Math.abs(parseFloat(part.style.getPropertyValue('stroke-width')) - parseFloat(width) - SELECTION_STYLE.strokeExtraPx / scale) < 1e-6, node.dataset.id + ' adds screen pixels');
      else assert.equal(part.style.getPropertyValue('stroke-width'), width, node.dataset.id);
      assert.equal(part.style.getPropertyPriority('stroke-width'), selected ? 'important' : original.find(([name]) => name === 'stroke-width')[2], node.dataset.id);
      const fill = original.find(([name]) => name === 'fill'), stroke = original.find(([name]) => name === 'stroke')[1];
      if (selected && fill[1] && fill[1] !== 'none') {
        assert.equal(part.style.getPropertyValue('fill'), selectedFillColor(stroke || NODE_STYLES[node.dataset.visualType].stroke), node.dataset.id);
        assert.equal(part.style.getPropertyPriority('fill'), 'important');
      } else assert.deepEqual(outlineState(part).find(([name]) => name === 'fill'), fill);
      assert.deepEqual(outlineState(part).filter(([name]) => !['stroke-width', 'fill'].includes(name)), original.filter(([name]) => !['stroke-width', 'fill'].includes(name)), node.dataset.id + ' retains semantic stroke colors and external dashes');
    }
    for (const [node, { root, value: filter, priority, nodeFilter }] of filters) {
      assert.equal(node.style.getPropertyValue('filter'), nodeFilter, 'The label parent keeps its own filter');
      if (selectedNodes.includes(node.dataset.id)) {
        const value = root.style.getPropertyValue('filter');
        assert.match(value, /^url\(#.+\)$/);
        assert.ok(diagram.querySelector(value.slice(4, -1)));
        assert.equal(root.style.getPropertyPriority('filter'), 'important');
      } else {
        assert.equal(root.style.getPropertyValue('filter'), filter);
        assert.equal(root.style.getPropertyPriority('filter'), priority);
      }
    }
    for (const [group, part] of containers) {
      const selected = selectedSchedules.includes(group.dataset.scheduleId), [value, priority, width] = containerWidths.get(part);
      assert.equal(group.classList.contains('selected'), selected);
      if (selected) assert.ok(Math.abs(parseFloat(part.style.getPropertyValue('stroke-width')) - width - SELECTION_STYLE.strokeExtraPx / scale) < 1e-6);
      else assert.equal(part.style.getPropertyValue('stroke-width'), value);
      assert.equal(part.style.getPropertyPriority('stroke-width'), selected ? 'important' : priority);
    }
    assert.equal(diagram.querySelectorAll('[data-shape-part]').length, originals.size, 'Highlighting adds no replacement shapes');
  };
}

function assertCurrentGuide(page) {
  const view = page.current(), details = page.get('details');
  const guide = details.querySelector('.guide');
  assert.ok(guide, view.id + ' has its read guide');
  assert.equal(guide.getAttribute('aria-label'), 'Legend');
  assert.equal(guide.getAttribute('lang'), 'en');
  assert.doesNotMatch(guide.textContent, /\p{Script=Han}/u, view.id + ' has English-only legend text');
  const expectedHeadings = [...(view.nodes.length ? ['Nodes'] : []), ...([...view.links, ...view.scheduleLinks].length ? ['Edges'] : [])];
  assert.deepEqual(guide.querySelectorAll('h3').map(heading => heading.textContent), expectedHeadings, view.id);
  const expectedNodes = [...new Set(view.nodes.map(node => node.visualType))].sort();
  const nodeRows = guide.querySelectorAll('[data-guide-node-type]');
  assert.deepEqual(nodeRows.map(row => row.dataset.guideNodeType).sort(), expectedNodes, view.id);
  for (const row of nodeRows) {
    const type = row.dataset.guideNodeType;
    const sample = row.querySelector('.guide-sample');
    const expected = page.data.guideSamples.nodes[type];
    assert.ok(sample?.querySelector('svg'), view.id + '/' + type);
    assert.ok(details.innerHTML.includes(expected), view.id + '/' + type + ' uses the exact compiled sample');
    assert.equal(sample.querySelector('svg').id, /<svg\b[^>]*\bid="([^"]+)"/.exec(expected)?.[1]);
    assert.equal(sample.querySelector('svg').getAttribute('aria-label'), NODE_STYLES[type].legendLabel);
    assert.equal(row.children[1].textContent, NODE_STYLES[type].legendLabel);
    assert.equal(row.dataset.guideVariant, undefined);
    assert.doesNotMatch(row.textContent, /外部引用/);
  }
  const reference = guide.querySelector('[data-guide-external-reference]');
  assert.equal(Boolean(reference), view.nodes.some(node => node.role === 'external'), view.id);
  if (reference) {
    assert.equal(reference.textContent, 'Dashed node outlines indicate external references.');
    assert.equal(reference.querySelector('svg'), null);
    assert.equal(guide.querySelectorAll('[data-guide-external-reference]').length, 1);
  }
  const expectedEdges = [...new Set([...view.links, ...view.scheduleLinks].map(edge => edge.edgeSemantic))].sort();
  const edgeRows = guide.querySelectorAll('[data-guide-edge-semantic]');
  assert.deepEqual(edgeRows.map(row => row.dataset.guideEdgeSemantic).sort(), expectedEdges, view.id);
  for (const row of edgeRows) {
    const semantic = row.dataset.guideEdgeSemantic, sample = row.querySelector('.guide-sample');
    const expected = page.data.guideSamples.edges[semantic];
    assert.ok(sample?.querySelector('svg'), view.id + '/' + semantic);
    assert.ok(details.innerHTML.includes(expected), view.id + '/' + semantic + ' uses the exact compiled sample');
    assert.equal(sample.querySelector('svg').id, /<svg\b[^>]*\bid="([^"]+)"/.exec(expected)?.[1]);
    assert.equal(sample.querySelector('svg').getAttribute('aria-label'), EDGE_STYLES[semantic].legendLabel);
    assert.equal(row.children[1].textContent, EDGE_STYLES[semantic].legendLabel);
  }
  for (const selector of ['.badge', 'h2', '.helper', '.footnote', 'p']) assert.equal(details.querySelector(selector), null, view.id + ' omits old guide prose');
}

test('every executable script in both generated offline pages compiles as delivered', () => {
  for (const filename of ['ecs-architecture.html', 'ecs-source.html']) {
    const content = fs.readFileSync(path.join(directory, filename), 'utf8');
    for (const [index, item] of scriptsIn(content).entries()) {
      if (!/type="application\/json"/.test(item.attributes)) assert.doesNotThrow(() => new vm.Script(item.script, { filename: `${filename}:${index}` }));
    }
  }
});

test('overview plugin cards select details and only explicit owner or sidebar controls navigate', () => {
  const page = viewer('?workspace=E%3A%2Fwork%20tree&keep=value');
  assert.equal(page.base().id, 'overview');
  assert.equal(page.document.querySelector('.tabs').hidden, true);
  assert.equal(page.get('return-overview').disabled, true);
  const overviewLocation = page.location.href;
  page.activate('plugin-CharacterPlugin');
  assert.equal(page.base().id, 'overview');
  assert.equal(page.location.href, overviewLocation);
  assert.equal(page.document.querySelector('.tabs').hidden, true);
  assert.match(page.get('details').textContent, /CharacterPlugin/);
  assert.equal(page.get('diagram').querySelectorAll('.selected').find(node => node.dataset.id === 'plugin-CharacterPlugin')?.dataset.id, 'plugin-CharacterPlugin');
  page.click(page.get('details').querySelector('[data-owner="character"]'));
  assert.equal(page.current().feature, 'character');
  assert.ok(page.current().nodes.some(node => node.id === 'plugin-CharacterPlugin' && node.role === 'internal'));
  assert.equal(page.location.searchParams.get('node'), 'plugin-CharacterPlugin');
  assert.equal(page.document.querySelector('.tabs').hidden, false);
  assert.equal(page.get('return-overview').disabled, false);
  assert.match(page.get('feature-head').textContent, /CharacterPlugin/);
  assert.equal(page.location.searchParams.get('workspace'), 'E:/work tree');
  assert.equal(page.location.searchParams.get('keep'), 'value');
  for (const aspect of ['data', 'events', 'systems']) {
    page.tab(aspect);
    assert.equal(page.base().id, `plugin-character-${aspect}`);
    assert.equal(page.document.querySelector(`[data-aspect="${aspect}"]`).classList.contains('active'), true);
  }
  page.click(page.get('return-overview'));
  assert.equal(page.base().id, 'overview');
  assert.equal(page.get('return-overview').disabled, true);
  page.back();
  assert.equal(page.base().id, 'plugin-character-systems');
  page.feature('overview');
  assert.equal(page.base().id, 'overview');
  page.feature('character');
  assert.equal(page.base().id, 'plugin-character-systems');
});

test('the fixed feature header retains only its name and identifier across all tabs', () => {
  const page = viewer('?feature=first_person&tab=systems');
  const feature = page.data.model.features.find(item => item.id === 'first_person');
  for (const aspect of ['systems', 'data', 'events']) {
    page.tab(aspect);
    const header = page.get('feature-head');
    assert.ok(header.textContent.includes(feature.label));
    assert.ok(header.textContent.includes(feature.plugin));
    assert.equal(header.querySelector('p'), null);
    assert.ok(feature.description);
    assert.equal(header.querySelectorAll('.contract').length, 0);
    assert.equal(header.querySelectorAll('.feature-meta').length, 0);
    assert.equal(header.querySelectorAll('a').length, 0);
    assert.equal(header.querySelectorAll('button').length, 0);
  }
});

test('every sidebar feature and tab renders its manifest nodes, compact header and empty state', () => {
  const page = viewer();
  assert.equal(page.data.model.features.length, 14);
  const features = [...page.data.model.features, ...INFRASTRUCTURE_FEATURES];
  let combinations = 0;
  for (const feature of features) {
    page.feature(feature.id);
    for (const aspect of ['systems', 'data', 'events']) {
      page.tab(aspect);
      const expectedBase = page.data.views.find(view => view.feature === feature.id && view.aspect === aspect);
      const expected = expectedBase.entityViews?.collapsed || expectedBase;
      const label = feature.id + '/' + aspect;
      assert.ok(expected, label);
      assert.equal(page.base().id, expectedBase.id, label);
      assert.equal(page.current().feature, feature.id, label);
      assert.equal(page.current().aspect, aspect, label);
      assert.equal(page.document.querySelector('.navigation .active').dataset.feature, feature.id, label);
      assert.equal(page.document.querySelector('.tabs .active').dataset.aspect, aspect, label);
      const ids = page.get('diagram').querySelectorAll('[data-id]').map(node => node.dataset.id);
      assert.deepEqual(ids.slice().sort(), expected.nodes.map(node => node.id).sort(), label);
      assert.equal(new Set(ids).size, ids.length, label);
      assert.equal(Boolean(page.get('canvas').querySelector('.empty-state')), !expected.svg, label);
      assert.equal(Boolean(page.get('diagram').querySelector('svg')), Boolean(expected.svg), label);
      assert.equal(page.get('caption'), null, label + ' omits the canvas summary');
      assert.equal(page.get('section').parentElement.classList.contains('caption'), true, label + ' retains group navigation');
      for (const id of ['export', 'export-mermaid', 'legend']) assert.equal(page.get(id), null, label + '/' + id);
      assert.equal(page.get('diagram').querySelector('[data-legend]'), null, label);
      assert.ok(!expected.mermaid || !/\blegend_\w+\b|subgraph legend\[/.test(expected.mermaid), label + ' Mermaid contains only business graph');
      assertCurrentGuide(page);
      const header = page.get('feature-head');
      if (feature.identifier) {
        assert.equal(header.textContent, feature.label + feature.identifier);
        assert.equal(header.querySelector('p'), null);
      } else {
        assert.ok(header.textContent.includes(feature.plugin), label);
        assert.equal(header.querySelector('p'), null, label);
        assert.ok(feature.description, label + ' keeps its model description');
        assert.equal(header.querySelectorAll('.contract').length, 0, label);
        assert.equal(header.querySelectorAll('.feature-meta').length, 0, label);
        assert.equal(header.querySelectorAll('a').length, 0, label);
        assert.equal(header.querySelectorAll('button').length, 0, label);
      }
      combinations++;
    }
  }
  assert.equal(combinations, 57);
});

test('an external contract opens its owner while retaining canonical identity and deep link', () => {
  const page = viewer('?feature=first_person&tab=data&workspace=D%3A%2Fworktree');
  const external = page.current().nodes.find(node => node.role === 'external' && page.data.registry[node.id].feature !== 'first_person');
  assert.ok(external, 'The fixture must exercise a real cross-feature contract');
  const owner = page.data.registry[external.id].feature;
  page.activate(external.id);
  const open = page.get('details').querySelector('[data-owner]');
  assert.equal(open.dataset.target, external.id);
  page.click(open);
  assert.equal(page.current().feature, owner);
  assert.ok(page.current().nodes.some(node => node.id === external.id && node.role === 'internal'));
  assert.equal(page.location.searchParams.get('node'), external.id);
  assert.equal(page.location.searchParams.get('workspace'), 'D:/worktree');
  assert.ok(page.get('diagram').querySelectorAll('.selected').some(node => node.dataset.id === external.id));
});

test('back and forward restore feature, aspect and focused canonical node from the URL', () => {
  const page = viewer();
  page.feature('first_person');
  page.tab('data');
  const external = page.current().nodes.find(node => node.role === 'external');
  page.activate(external.id);
  page.click(page.get('details').querySelector('[data-owner]'));
  const target = page.base().id;
  page.back();
  assert.equal(page.base().id, 'plugin-first_person-data');
  page.back();
  assert.equal(page.base().id, 'plugin-first_person-systems');
  page.forward();
  assert.equal(page.base().id, 'plugin-first_person-data');
  page.forward();
  assert.equal(page.base().id, target);
  assert.ok(page.get('diagram').querySelectorAll('.selected').some(node => node.dataset.id === external.id));
});

test('Mermaid relationships share one canonical node and search result instead of repeating projections', () => {
  const page = viewer('?feature=character&tab=systems');
  for (const view of page.data.views) assert.equal(new Set(view.nodes.map(node => node.id)).size, view.nodes.length, view.id);
  const degree = new Map();
  for (const link of page.current().links) for (const id of [link.from, link.to]) degree.set(id, (degree.get(id) || 0) + 1);
  const id = [...degree].find(([, count]) => count > 1)?.[0];
  assert.ok(id, 'The generated graph must exercise a node shared by several relationships');
  assert.equal(page.get('diagram').querySelectorAll('[data-id]').filter(node => node.dataset.id === id).length, 1);
  page.search(id);
  const expected = new Set(page.current().nodes.filter(node => JSON.stringify(page.data.registry[node.id]).toLowerCase().includes(id.toLowerCase())).map(node => node.id));
  const results = page.get('details').querySelectorAll('.result');
  assert.equal(results.length, expected.size);
  assert.equal(results.filter(result => result.dataset.open === id).length, 1);
  assert.ok(page.get('details').textContent.includes(expected.size + ' 个匹配节点'));
  assert.equal(page.get('diagram').querySelectorAll('.selected').filter(node => node.dataset.id === id).length, 1);
  page.click(results.find(result => result.dataset.open === id));
  assert.ok(page.get('details').textContent.includes(page.data.registry[id].name));
  page.tab('data');
  assert.equal(page.get('search').value, '');
  assert.equal(page.get('details').querySelectorAll('.result').length, 0);
});

function canvasTransform(page) {
  const match = /^translate\(([-+\d.eE]+)px,([-+\d.eE]+)px\) scale\(([-+\d.eE]+)\)$/.exec(page.get('diagram').style.transform);
  assert.ok(match, 'The actual viewer must apply a numeric canvas transform');
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}

test('focused Mermaid nodes center their compiled position while accounting for the SVG viewBox', () => {
  const overview = viewer();
  const targetView = overview.data.views.find(view => view.id === 'plugin-character-systems');
  const id = targetView.nodes.find(node => node.role === 'internal').id;
  const page = viewer('?feature=character&tab=systems&node=' + encodeURIComponent(id));
  const node = page.current().nodes.find(item => item.id === id), transform = canvasTransform(page), bounds = page.current().bounds;
  const rendered = page.get('diagram').querySelectorAll('[data-id]').find(item => item.dataset.id === id);
  assert.equal(rendered.dataset.mermaidId, node.mermaidId);
  assert.equal(rendered.classList.contains('selected'), true);
  const centerX = (node.position.x + node.position.width / 2 - bounds.x) * transform.scale + transform.x;
  const centerY = (node.position.y + node.position.height / 2 - bounds.y) * transform.scale + transform.y;
  assert.ok(Math.abs(centerX - page.get('canvas').clientWidth / 2) < 1e-6);
  assert.ok(Math.abs(centerY - page.get('canvas').clientHeight / 2) < 1e-6);
});

test('the section selector accepts index zero and locates horizontal Schedule columns in both axes', () => {
  const page = viewer('?feature=character&tab=systems');
  const view = page.current(), selector = page.get('section');
  const indexes = view.sections.flatMap((section, index) => section.schedule ? [index] : []);
  assert.ok(indexes.length > 1 && view.sections[indexes[1]].x > view.sections[indexes[0]].x);
  assert.equal(indexes[0], 0, 'The first Schedule exercises the zero-valued selector option');
  for (const index of [indexes.at(-1), 0]) {
    selector.value = String(index);
    selector.dispatch('change');
    const section = view.sections[index], transform = canvasTransform(page);
    assert.ok(Math.abs((section.x - view.bounds.x) * transform.scale + transform.x - 18) < 1e-6);
    assert.ok(Math.abs((section.y - view.bounds.y) * transform.scale + transform.y - 18) < 1e-6);
    const group = view.scheduleGroups.find(item => item.id === section.schedule);
    assert.ok(group);
    assert.ok(page.get('details').textContent.includes(group.label));
    assert.equal(page.get('details').querySelector('.badge'), null);
    assert.equal(page.get('details').querySelector('h2').textContent, group.label);
    for (const note of group.notes) assert.ok(page.get('details').textContent.includes(note));
  }
});

test('ordinary data and event groups locate the selected section rather than the first unclassified group', () => {
  for (const aspect of ['data', 'events']) {
    const page = viewer('?feature=first_person&tab=' + aspect), view = page.current(), selector = page.get('section');
    const indexes = view.sections.flatMap((section, index) => !section.schedule && section.kind !== 'legend' ? [index] : []);
    assert.ok(indexes.length > 1, aspect + ' exposes more than one ordinary group');
    for (const index of [indexes.at(-1), indexes[0]]) {
      selector.value = String(index);
      selector.dispatch('change');
      const section = view.sections[index], transform = canvasTransform(page);
      assert.ok(Math.abs((section.x - view.bounds.x) * transform.scale + transform.x - 18) < 1e-6, aspect + '/' + section.label);
      assert.ok(Math.abs((section.y - view.bounds.y) * transform.scale + transform.y - 18) < 1e-6, aspect + '/' + section.label);
      assert.ok(page.get('details').textContent.includes(section.label));
      assert.equal(page.get('details').querySelector('.badge'), null);
      assert.equal(page.get('details').textContent, section.label);
    }
  }
});

test('ItemInteractionPlugin legacy links focus its single canonical Mermaid node', () => {
  const page = viewer('?feature=item_interaction&tab=events&node=plugin-carry');
  const canonical = 'plugin-ItemInteractionPlugin';
  assert.equal(page.data.model.node_aliases['plugin-carry'], canonical);
  assert.equal(page.data.registry['plugin-carry'].alias_of, canonical);
  const matching = page.current().nodes.filter(node => page.data.registry[node.id].kind === 'Plugin' && page.data.registry[node.id].name === 'ItemInteractionPlugin');
  assert.equal(matching.length, 1);
  assert.equal(matching[0].id, canonical);
  assert.equal(page.get('diagram').querySelectorAll('[data-id]').filter(node => node.dataset.id === canonical).length, 1);
  assert.equal(page.get('diagram').querySelectorAll('[data-id]').some(node => node.dataset.id === 'plugin-carry'), false);
  assert.equal(page.get('diagram').querySelectorAll('.selected').some(node => node.dataset.id === canonical), true);
  assert.match(page.get('details').textContent, /ItemInteractionPlugin/);
});

test('selected nodes retain the VS Code source and copy location without the offline snapshot entry', () => {
  const page = viewer('?feature=character&tab=systems&workspace=E%3A%2Fsource%20%23%25');
  const id = page.current().nodes.find(node => node.role === 'internal' && page.data.registry[node.id].source)?.id;
  assert.ok(id);
  page.activate(id);
  const source = page.data.registry[id].definition_source || page.data.registry[id].source;
  assertEditorActions(page, source, 'E:/source #%');
});

test('empty tabs replace the previous SVG and show only their own empty read guide', () => {
  const page = viewer();
  const empty = page.data.views.find(view => view.svg === null);
  assert.ok(empty, 'The generated manifest must include a real empty tab');
  page.feature(empty.feature);
  page.tab(empty.aspect);
  assert.equal(page.base().id, empty.id);
  assert.equal(page.get('diagram').querySelector('svg'), null);
  assert.match(page.get('canvas').querySelector('.empty-state').textContent, /当前页签没有相关节点/);
  assertCurrentGuide(page);
  assert.equal(page.get('details').querySelectorAll('.guide-row').length, 0);
  for (const id of ['export', 'export-mermaid', 'legend']) assert.equal(page.get(id), null);
  const populated = page.data.views.find(view => view.feature === empty.feature && view.svg);
  page.tab(populated.aspect);
  assert.equal(page.get('canvas').querySelector('.empty-state'), null);
  assertCurrentGuide(page);
});

test('unavailable file History API still permits in-page plugin and tab navigation', () => {
  const page = viewer('?workspace=D%3A%2Fcheckout', { historyUnavailable: true });
  page.feature('character');
  assert.equal(page.base().id, 'plugin-character-systems');
  page.tab('data');
  assert.equal(page.base().id, 'plugin-character-data');
  assert.equal(page.location.searchParams.get('workspace'), 'D:/checkout');
});

test('canvas pointer selection and drag gestures remain distinct and preserve keyboard activation', () => {
  const page = viewer('?feature=character&tab=systems');
  const node = page.get('diagram').querySelector('[data-id]');
  const canvas = page.get('canvas');
  const outline = ['path', 'polygon', 'rect', 'ellipse', 'circle'].map(tag => node.querySelector(tag)).find(Boolean);
  assert.ok(outline, 'The node exposes a real Mermaid outline');
  page.document.elementFromPoint = () => outline;
  canvas.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 20 });
  canvas.dispatch('pointerup', { pointerId: 1, clientX: 10, clientY: 20 });
  assert.equal(node.classList.contains('selected'), true);
  page.click(page.get('details').querySelector('#clear-selection'));
  canvas.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 20 });
  canvas.dispatch('pointermove', { pointerId: 1, clientX: 60, clientY: 70 });
  canvas.dispatch('pointerup', { pointerId: 1, clientX: 60, clientY: 70 });
  assert.equal(node.classList.contains('selected'), false);
  assert.equal(canvas.classList.contains('dragging'), false);
  assert.match(page.get('diagram').style.transform, /^translate\(/);
  const beforeZoom = page.get('zoom-label').textContent;
  canvas.dispatch('wheel', { deltaY: -1, clientX: 200, clientY: 200 });
  assert.notEqual(page.get('zoom-label').textContent, beforeZoom);
  node.dispatch('keydown', { key: ' ' });
  assert.equal(node.classList.contains('selected'), true);
});

test('the delivered panel separator keeps the selected node and canvas world center while resizing', () => {
  const page = viewer('?feature=character&tab=systems');
  const workspace = page.get('workspace'), canvas = page.get('canvas'), separator = page.get('details-resizer');
  workspace.clientWidth = 1200;
  Object.defineProperty(canvas, 'clientWidth', { get: () => workspace.clientWidth - 38 - Number.parseFloat(workspace.style['--details-width']) });
  const id = page.current().nodes.find(node => node.role === 'internal').id;
  page.activate(id);
  page.click(page.get('zoom-in'));
  const before = canvasTransform(page), details = page.get('details').innerHTML;
  const worldCenter = { x: (canvas.clientWidth / 2 - before.x) / before.scale, y: (canvas.clientHeight / 2 - before.y) / before.scale };
  assert.equal(workspace.style['--details-width'], '286px');
  separator.dispatch('pointerdown', { button: 0, pointerId: 9, clientX: 1000 });
  separator.dispatch('pointermove', { pointerId: 9, clientX: 800 });
  separator.dispatch('pointerup', { pointerId: 9, clientX: 800 });
  const after = canvasTransform(page);
  assert.equal(workspace.style['--details-width'], '486px');
  assert.equal(after.scale, before.scale);
  assert.ok(Math.abs((canvas.clientWidth / 2 - after.x) / after.scale - worldCenter.x) < 1e-6);
  assert.ok(Math.abs((canvas.clientHeight / 2 - after.y) / after.scale - worldCenter.y) < 1e-6);
  assert.equal(page.get('details').innerHTML, details);
  assert.ok(page.get('diagram').querySelectorAll('.selected').some(node => node.dataset.id === id));
  assert.equal(workspace.classList.contains('resizing'), false);
  assert.equal(separator.hasPointerCapture(9), false);
  page.tab('data');
  assert.equal(workspace.style['--details-width'], '486px');
  page.feature('audio');
  assert.equal(workspace.style['--details-width'], '486px');
  assert.equal(viewer().get('workspace').style['--details-width'], '286px');
});

test('the read guide renders actual Mermaid samples for current types and omits the old prose', () => {
  const page = viewer('?feature=window_policy&tab=systems');
  assert.deepEqual(page.data.styles.nodes, NODE_STYLES);
  assert.deepEqual(page.data.styles.edges, EDGE_STYLES);
  assertCurrentGuide(page);
  assert.doesNotMatch(page.get('details').textContent, /节点形状与填充表达类型|线上只保留具体契约与约束|0[～…~]N/);
});

test('clearing node or edge selection restores only the current page guide without moving the canvas', () => {
  const page = viewer('?feature=first_person&tab=data');
  assertCurrentGuide(page);
  const node = page.current().nodes.find(item => item.role === 'external');
  assert.ok(node);
  page.activate(node.id);
  assert.equal(page.get('details').querySelector('.guide'), null);
  let before = canvasTransform(page);
  page.click(page.get('clear-selection'));
  assert.deepEqual(canvasTransform(page), before);
  assertCurrentGuide(page);
  assert.equal(page.get('diagram').querySelectorAll('.selected').length, 0);
  const edge = page.get('diagram').querySelector('[data-link-id]');
  assert.ok(edge);
  page.click(edge);
  assert.equal(page.get('details').querySelector('.guide'), null);
  before = canvasTransform(page);
  page.click(page.get('clear-selection'));
  assert.deepEqual(canvasTransform(page), before);
  assertCurrentGuide(page);
  page.tab('systems');
  assertCurrentGuide(page);
  page.feature('window_policy');
  assertCurrentGuide(page);
});

test('a resource cylinder path is clickable and keyboard selection strengthens fill while preserving its semantic stroke', () => {
  const page = viewer('?feature=settings&tab=data');
  const resource = page.current().nodes.find(node => node.visualType === 'resource');
  assert.ok(resource);
  const node = page.get('diagram').querySelectorAll('[data-id]').find(item => item.dataset.id === resource.id);
  const outline = node.querySelector('path');
  assert.ok(outline, 'The resource uses a native Mermaid cylinder path');
  const verify = assertNativeSelection(page);
  page.document.elementFromPoint = () => outline;
  const canvas = page.get('canvas');
  canvas.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 12, clientY: 30 });
  canvas.dispatch('pointerup', { pointerId: 1, clientX: 12, clientY: 30 });
  assert.equal(node.classList.contains('selected'), true);
  assert.ok(page.get('details').textContent.includes(page.data.registry[resource.id].name));
  verify([resource.id]);
  page.click(page.get('clear-selection'));
  verify();
  outline.dispatch('keydown', { key: 'Enter' });
  assert.equal(node.classList.contains('selected'), true);
  verify([resource.id]);
});

test('business edges expose their full relationship, endpoints and source without replacing semantic styles', () => {
  const page = viewer('?feature=first_person&tab=data');
  const link = page.current().links.find(edge => page.data.registry[edge.id]?.cardinality);
  assert.ok(link, 'The real graph includes a relationship with complete constraints');
  const record = page.data.registry[link.id];
  const edge = page.get('diagram').querySelectorAll('[data-link-id]').find(item => item.dataset.linkId === link.id);
  assert.ok(edge);
  const before = ['style', 'stroke', 'stroke-dasharray'].map(name => edge.getAttribute(name));
  page.click(edge);
  assert.equal(edge.classList.contains('focused'), true);
  assert.equal(page.get('diagram').querySelectorAll('.edge.focused').length, 1);
  assert.ok(page.get('details').textContent.includes(EDGE_STYLES[link.edgeSemantic].label));
  assert.ok(page.get('details').textContent.includes(record.cardinality));
  assert.ok(page.get('details').textContent.includes(link.label));
  assert.match(page.get('details').textContent, /反向关系无/);
  assert.match(page.get('details').textContent, /连带生命周期无/);
  assertEditorActions(page, record.source, 'D:/demo');
  assert.ok(page.get('details').textContent.includes(record.description));
  assert.deepEqual(['style', 'stroke', 'stroke-dasharray'].map(name => edge.getAttribute(name)), before);
  const endpoints = page.get('details').querySelectorAll('[data-open]');
  assert.deepEqual(endpoints.map(button => button.dataset.open), [link.from, link.to]);
  page.click(endpoints[1]);
  assert.ok(page.get('details').textContent.includes(page.data.registry[link.to].name));
  assert.ok(page.get('diagram').querySelectorAll('.selected').some(node => node.dataset.id === link.to));
  edge.dispatch('keydown', { key: ' ' });
  assert.equal(page.get('diagram').querySelectorAll('.edge.focused').length, 1);
  page.click(page.get('clear-selection'));
  assert.equal(page.get('diagram').querySelectorAll('.edge.focused').length, 0);
  assert.equal(page.get('diagram').querySelectorAll('.dim').length, 0);
});

test('Schedule arrows reveal phase order and nested driving details through click and keyboard activation', () => {
  for (const semantic of ['schedule', 'nested']) {
    const query = '?feature=infrastructure&tab=systems';
    const page = semantic === 'nested' ? fixtureViewer(viewer, query, state => {
      // 分离后的 Egui 页没有父 Schedule 卡片；复用真实可见箭头验证嵌套语义交互。
      state.views.find(view => view.feature === 'infrastructure' && view.aspect === 'systems').scheduleLinks[0].edgeSemantic = 'nested';
    }) : viewer(query);
    const link = page.current().scheduleLinks.find(edge => edge.edgeSemantic === semantic);
    assert.ok(link, semantic);
    const edge = page.get('diagram').querySelectorAll('[data-schedule-link-id]').find(item => item.dataset.scheduleLinkId === link.id);
    assert.ok(edge, link.id);
    const before = ['style', 'stroke', 'stroke-dasharray'].map(name => edge.getAttribute(name));
    semantic === 'nested' ? edge.dispatch('keydown', { key: 'Enter' }) : page.click(edge);
    assert.equal(edge.classList.contains('focused'), true);
    assert.equal(page.get('diagram').querySelectorAll('.edge.focused').length, 1);
    assert.ok(page.get('details').textContent.includes(EDGE_STYLES[semantic].label));
    assert.equal(page.get('details').querySelector('.footnote'), null);
    assert.doesNotMatch(page.get('details').textContent, /驱动内部 Schedule|可见阶段的真实先后/);
    assert.deepEqual(['style', 'stroke', 'stroke-dasharray'].map(name => edge.getAttribute(name)), before);
    const target = page.get('details').querySelectorAll('[data-schedule]')[1];
    assert.equal(target.dataset.schedule, link.to);
    page.click(target);
    const group = page.current().scheduleGroups.find(group => group.id === link.to);
    assert.equal(page.get('details').querySelector('h2').textContent, group.label);
    assert.equal(page.get('details').querySelector('.badge'), null);
    for (const note of group.notes) assert.ok(page.get('details').textContent.includes(note));
    assert.equal(page.get('diagram').querySelectorAll('.edge.focused').length, 0);
  }
});

for (const [variant, open] of [['source', sourceViewer], ['delivered', viewer]]) {
  test(`${variant} folding defaults to compact Entities with corner controls and no global expansion actions`, async () => {
    const page = foldingViewer(open), diagram = page.get('diagram');
    assert.deepEqual(expandedIds(page), []);
    for (const id of ['entity-actions', 'expand-entities', 'collapse-entities']) assert.equal(page.get(id), null);
    for (const group of page.base().entityGroups) {
      assert.ok(page.current().nodes.some(node => node.id === group.entity));
      assert.ok(group.components.every(id => !page.current().nodes.some(node => node.id === id)));
      const toggle = diagram.querySelectorAll('button[data-entity-toggle]').find(button => button.dataset.entityToggle === group.entity);
      assert.ok(toggle);
      assert.equal(toggle.parentElement, diagram);
      assert.equal(toggle.closest('svg'), null);
      assert.equal(toggle.closest('[data-id]'), null);
      assert.equal(toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(toggle.textContent, '+');
      assert.equal(toggle.getAttribute('aria-label'), page.data.registry[group.entity].name + '：展开组件（' + group.components.length + '）');
    }
    assertCurrentGuide(page);
    page.activate('entity-camera');
    const detailToggle = page.get('details').querySelector('[data-entity-toggle]');
    assert.equal(detailToggle.dataset.entityToggle, 'entity-camera');
    assert.ok(page.get('details').querySelectorAll('[data-open]').some(button => button.dataset.open === 'camera.FirstPersonCamera'));
    detailToggle.focus(); page.click(detailToggle); await page.settle();
    assert.equal(page.document.activeElement, page.get('details').querySelector('[data-entity-toggle]'));
    assert.equal(page.document.activeElement.getAttribute('aria-expanded'), 'true');
    page.tab('systems');
    assert.equal(diagram.querySelectorAll('button[data-entity-toggle]').length, 0);
  });

  test(`${variant} independent folding preserves the Entity screen anchor and zoom, restores outlines and keeps other Entities expanded`, async () => {
    const page = foldingViewer(open), diagram = page.get('diagram'), canvas = page.get('canvas');
    const toggle = id => diagram.querySelectorAll('button[data-entity-toggle]').find(button => button.dataset.entityToggle === id);
    const screen = id => { const box = page.current().nodes.find(node => node.id === id).position, t = canvasTransform(page); return { x: t.x + (box.x - page.current().bounds.x) * t.scale, y: t.y + (box.y - page.current().bounds.y) * t.scale, scale: t.scale }; };
    const assertAnchor = (actual, expected) => { for (const key of ['x', 'y', 'scale']) assert.ok(Math.abs(actual[key] - expected[key]) < 1e-8, key + ' remains stable'); };
    page.click(page.get('zoom-out')); page.activate('entity-camera');
    const before = screen('entity-camera'), href = page.location.href, length = page.history.length;
    const oldNode = diagram.querySelectorAll('[data-id]').find(node => node.dataset.id === 'entity-camera'), oldPart = ownShapeParts(oldNode)[0];
    const button = toggle('entity-camera'); button.focus();
    const key = button.dispatch('keydown', { key: 'Enter' });
    assert.equal(key.defaultPrevented, false, 'Native HTML buttons retain browser keyboard activation');
    const pointer = button.dispatch('pointerdown', { button: 0, pointerId: 7, clientX: 12, clientY: 14 });
    assert.equal(pointer.defaultPrevented, false);
    assert.equal(vm.runInContext('drag', page.context), null);
    const queryAll = diagram.querySelectorAll;
    diagram.querySelectorAll = function (selector) { const result = queryAll.call(this, selector); return selector === 'button[data-entity-toggle]' ? { [Symbol.iterator]: () => result[Symbol.iterator](), length: result.length, item: index => result[index] || null } : result; };
    page.click(button); await page.settle(); diagram.querySelectorAll = queryAll;
    assert.deepEqual(expandedIds(page), ['entity-camera']);
    assertAnchor(screen('entity-camera'), before);
    assert.equal(page.location.href, href); assert.equal(page.history.length, length);
    assert.equal(page.document.activeElement, toggle('entity-camera'));
    assert.equal(toggle('entity-camera').textContent, '−');
    assert.equal(oldPart.style.getPropertyValue('fill'), NODE_STYLES.entity.fill);
    assert.equal(oldPart.style.getPropertyValue('filter'), '');
    assert.deepEqual(diagram.querySelectorAll('.selected').map(node => node.dataset.id), ['entity-camera']);
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 1);
    assert.equal(toggle('entity-camera').classList.contains('selected'), false);
    const second = screen('entity-controller');
    toggle('entity-controller').focus(); page.click(toggle('entity-controller')); await page.settle();
    assert.deepEqual(expandedIds(page), ['entity-controller', 'entity-camera']);
    assertAnchor(screen('entity-controller'), second);
    assert.equal(page.current().nodes.some(node => node.id === 'camera.FirstPersonCamera'), true);
    assert.equal(page.document.activeElement, toggle('entity-controller'));
    page.click(toggle('entity-visual')); await page.settle();
    const opened = ['entity-controller', 'entity-camera', 'entity-visual'];
    assert.deepEqual(expandedIds(page), opened);
    const hidden = new Set(page.base().entityGroups.filter(group => !opened.includes(group.entity)).flatMap(group => group.components));
    assert.deepEqual(page.current().nodes.map(node => node.id), page.base().nodes.filter(node => !hidden.has(node.id)).map(node => node.id));
    page.click(toggle('entity-camera')); await page.settle();
    assert.deepEqual(expandedIds(page), ['entity-controller', 'entity-visual']);
    assert.equal(page.current().nodes.some(node => node.id === 'camera.FirstPersonCamera'), false);
    assert.equal(page.current().nodes.some(node => node.id === 'controller.PlayerId'), true);
    assert.equal(page.document.activeElement === canvas || page.document.activeElement?.closest('[data-entity-toggle]') !== null, true);
    page.click(page.get('clear-selection')); assertCurrentGuide(page);
  });

  test(`${variant} folding a selected Component selects its Entity while edge details keep canonical endpoints`, async () => {
    const page = foldingViewer(open, '?feature=first_person&tab=data&node=camera.FirstPersonCamera&workspace=E%3A%2Fwork%20tree'), diagram = page.get('diagram');
    const toggle = () => diagram.querySelectorAll('button[data-entity-toggle]').find(button => button.dataset.entityToggle === 'entity-camera');
    assert.deepEqual(expandedIds(page), ['entity-camera']);
    page.click(toggle()); await page.settle();
    assert.equal(page.location.searchParams.get('node'), 'entity-camera');
    assert.deepEqual(diagram.querySelectorAll('.selected').map(node => node.dataset.id), ['entity-camera']);
    assert.equal(page.get('details').querySelector('h2').textContent, page.data.registry['entity-camera'].name);
    const id = 'write-observe_look-camera.FirstPersonCamera';
    page.click(diagram.querySelectorAll('[data-link-id]').find(edge => edge.dataset.linkId === id));
    assert.deepEqual(new Set(diagram.querySelectorAll('.selected').map(node => node.dataset.id)), new Set(['observe_look', 'entity-camera']));
    assert.deepEqual(page.get('details').querySelectorAll('[data-open]').map(button => button.dataset.open), ['observe_look', 'camera.FirstPersonCamera']);
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 2);
    page.click(toggle()); await page.settle();
    assert.deepEqual(new Set(diagram.querySelectorAll('.selected').map(node => node.dataset.id)), new Set(['observe_look', 'camera.FirstPersonCamera']));
    assert.deepEqual(page.get('details').querySelectorAll('[data-open]').map(button => button.dataset.open), ['observe_look', 'camera.FirstPersonCamera']);
    page.click(toggle()); page.click(page.get('details').querySelectorAll('[data-open]')[1]); await page.settle();
    assert.deepEqual(expandedIds(page), ['entity-camera']);
    assert.deepEqual(diagram.querySelectorAll('.selected').map(node => node.dataset.id), ['camera.FirstPersonCamera']);
    assertEditorActions(page, page.data.registry['camera.FirstPersonCamera'].definition_source || page.data.registry['camera.FirstPersonCamera'].source, 'E:/work tree');
    page.click(page.get('clear-selection'));
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 0);
  });

  test(`${variant} full-graph search temporarily unions matched owners with the manual set and never persists automatic expansion`, async () => {
    const page = foldingViewer(open), diagram = page.get('diagram'), search = page.get('search');
    const toggle = id => diagram.querySelectorAll('button[data-entity-toggle]').find(button => button.dataset.entityToggle === id);
    page.click(toggle('entity-controller')); search.focus(); page.search('fold-one'); await page.settle();
    assert.deepEqual(expandedIds(page), ['entity-controller', 'entity-camera']);
    assert.equal(page.document.activeElement, search);
    assert.deepEqual(page.get('details').querySelectorAll('[data-open]').map(button => button.dataset.open), ['camera.FirstPersonCamera']);
    assert.deepEqual(diagram.querySelectorAll('.selected').map(node => node.dataset.id), ['camera.FirstPersonCamera']);
    assert.deepEqual(page.history.state.architectureEntityModes[page.base().id], ['entity-controller']);
    page.search('fold-many'); await page.settle();
    assert.deepEqual(expandedIds(page), ['entity-controller', 'entity-camera']);
    assert.equal(page.current().nodes.some(node => node.id === 'visual.Mesh3d'), false);
    assert.deepEqual(new Set(diagram.querySelectorAll('.selected').map(node => node.dataset.id)), new Set(['camera.FirstPersonCamera', 'controller.PlayerId']));
    assert.equal(page.get('details').querySelector('h2').textContent, '2 个匹配节点');
    page.search('nothing-here-at-all'); await page.settle();
    assert.equal(page.get('details').querySelector('h2').textContent, '0 个匹配节点');
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 0);
    page.search(''); await page.settle();
    assert.deepEqual(expandedIds(page), ['entity-controller']);
    assert.equal(diagram.querySelectorAll('.dim').length, 0); assertCurrentGuide(page);
    page.search('fold-one'); await page.settle();
    page.click(toggle('entity-controller')); await page.settle();
    assert.equal(search.value, ''); assert.deepEqual(expandedIds(page), []);
    assert.deepEqual(page.history.state.architectureEntityModes[page.base().id], []);
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 0); assertCurrentGuide(page);
    page.search('fold-many'); await page.settle();
    page.click(toggle('entity-visual')); await page.settle();
    assert.equal(search.value, ''); assert.deepEqual(expandedIds(page), ['entity-visual']);
    assert.deepEqual(page.history.state.architectureEntityModes[page.base().id], ['entity-visual']);
    page.tab('systems'); page.back(); await page.settle();
    assert.deepEqual(expandedIds(page), ['entity-visual']);
  });

  test(`${variant} folding persists per page in history and explicit Component navigation adds its owner without closing others`, async () => {
    const page = foldingViewer(open, '?feature=first_person&tab=data&node=camera.FirstPersonCamera&workspace=E%3A%2Fwork%20tree&keep=yes#folding');
    const toggle = id => page.get('diagram').querySelectorAll('button[data-entity-toggle]').find(button => button.dataset.entityToggle === id);
    const length = page.history.length;
    assert.deepEqual(expandedIds(page), ['entity-camera']);
    page.click(toggle('entity-camera'));
    const collapsedHref = page.location.href;
    assert.equal(page.location.searchParams.get('node'), 'entity-camera'); assert.equal(page.history.length, length);
    assert.deepEqual(page.history.state.architectureEntityModes[page.base().id], []);
    page.tab('systems'); page.back(); await page.settle();
    assert.equal(page.location.href, collapsedHref); assert.deepEqual(expandedIds(page), []);
    assert.deepEqual(page.get('diagram').querySelectorAll('.selected').map(node => node.dataset.id), ['entity-camera']);
    page.click(toggle('entity-controller'));
    const component = page.get('details').querySelectorAll('[data-open]').find(button => button.dataset.open === 'camera.FirstPersonCamera');
    page.click(component); await page.settle();
    assert.deepEqual(expandedIds(page), ['entity-controller', 'entity-camera']);
    const source = page.data.registry['camera.FirstPersonCamera'].definition_source || page.data.registry['camera.FirstPersonCamera'].source;
    assertEditorActions(page, source, 'E:/work tree');
    page.feature('character'); page.back(); await page.settle();
    assert.deepEqual(expandedIds(page), ['entity-controller', 'entity-camera']); assert.equal(page.location.href, collapsedHref);
    assert.deepEqual(page.get('diagram').querySelectorAll('.selected').map(node => node.dataset.id), ['entity-camera']);
    page.forward(); assert.equal(page.current().feature, 'character'); page.back(); await page.settle();
    assert.equal(page.location.searchParams.get('keep'), 'yes'); assert.equal(page.location.hash, '#folding');
    page.click(page.get('details').querySelectorAll('[data-open]').find(button => button.dataset.open === 'camera.FirstPersonCamera'));
    assert.equal(page.current().nodes.some(node => node.id === 'camera.FirstPersonCamera'), true);
  });

  test(`${variant} corner controls stay 24 SVG units at an 8 unit inset through actual zoom transforms`, () => {
    const page = foldingViewer(open), diagram = page.get('diagram'), entity = 'entity-camera';
    const button = diagram.querySelectorAll('button[data-entity-toggle]').find(button => button.dataset.entityToggle === entity);
    const node = page.current().nodes.find(node => node.id === entity), box = node.position, bounds = page.current().bounds;
    for (const id of ['zoom-in', 'zoom-out', 'fit']) {
      page.click(page.get(id));
      assert.equal(parseFloat(button.style.left), box.x - bounds.x + box.width - 24 - 8);
      assert.equal(parseFloat(button.style.top), box.y - bounds.y + 8);
      assert.equal(parseFloat(button.style.width), 24); assert.equal(parseFloat(button.style.height), 24);
      assert.ok(canvasTransform(page).scale > 0);
    }
    assert.equal(diagram.querySelectorAll('[data-entity-toggle-label]').length, 0);
    assert.equal(button.getAttribute('role'), null);
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 0);
  });

  test(`${variant} folding remains usable without file history and invalid saved IDs fall back safely`, async () => {
    const page = foldingViewer(open, '?feature=first_person&tab=data', { historyUnavailable: true, initialHistoryState: { keep: 'other-state', architectureEntityModes: { 'plugin-first_person-data': 'missing-entity' } } });
    const toggle = id => page.get('diagram').querySelectorAll('button[data-entity-toggle]').find(button => button.dataset.entityToggle === id);
    assert.deepEqual(expandedIds(page), []);
    page.click(toggle('entity-controller')); page.click(toggle('entity-camera')); await page.settle();
    assert.deepEqual(expandedIds(page), ['entity-controller', 'entity-camera']);
    page.click(toggle('entity-controller')); await page.settle(); assert.deepEqual(expandedIds(page), ['entity-camera']);
    page.search('fold-many'); await page.settle(); assert.deepEqual(expandedIds(page), ['entity-controller', 'entity-camera']);
    page.search(''); await page.settle(); assert.deepEqual(expandedIds(page), ['entity-camera']);
    page.tab('systems'); assert.equal(page.current().aspect, 'systems');
    assert.equal(page.get('diagram').querySelectorAll('button[data-entity-toggle]').length, 0);
  });

  test(`${variant} refreshing old string and array history entries normalizes manual sets without discarding unrelated state`, async () => {
    for (const mode of ['collapsed', 'all', 'entity-controller', ['entity-camera', 'missing-entity', 'entity-controller', 'entity-camera']]) {
      const page = foldingViewer(open, '?feature=first_person&tab=data&node=camera.FirstPersonCamera&workspace=E%3A%2Fproject#refresh', { initialHistoryState: { unrelated: { keep: true }, architectureEntityModes: { 'plugin-first_person-data': mode } } });
      await page.settle();
      const expected = mode === 'all' ? page.base().entityGroups.map(group => group.entity) : mode === 'collapsed' ? [] : typeof mode === 'string' ? [mode] : ['entity-controller', 'entity-camera'];
      assert.deepEqual(expandedIds(page), expected); assert.deepEqual(page.history.state.unrelated, { keep: true });
      assert.deepEqual(page.history.state.architectureEntityModes[page.base().id], expected);
      const selected = expected.includes('entity-camera') ? 'camera.FirstPersonCamera' : 'entity-camera';
      assert.deepEqual(page.get('diagram').querySelectorAll('.selected').map(node => node.dataset.id), [selected]);
      assert.equal(page.location.searchParams.get('node'), selected); assert.equal(page.location.hash, '#refresh');
    }
  });

  test(`${variant} rapid independent toggles accumulate the newest target and stale layouts cannot replace a new page`, async () => {
    const pending = [];
    const page = foldingViewer(open, '?feature=first_person&tab=data', { runtimeCompile: (base, ids, render) => new Promise(resolve => pending.push({ ids: [...ids], render, resolve })) });
    const toggle = id => page.get('diagram').querySelectorAll('button[data-entity-toggle]').find(button => button.dataset.entityToggle === id);
    page.click(toggle('entity-controller')); page.click(toggle('entity-camera')); await page.settle();
    assert.deepEqual(pending[0].ids, ['entity-controller', 'entity-camera']);
    assert.equal(page.get('canvas').getAttribute('aria-busy'), 'true');
    assert.deepEqual(expandedIds(page), ['entity-controller']);
    page.click(toggle('entity-controller')); assert.deepEqual(expandedIds(page), ['entity-camera']);
    pending[0].resolve(await pending[0].render()); await page.settle();
    assert.deepEqual(expandedIds(page), ['entity-camera']); assert.equal(page.get('entity-layout-status').hidden, true);
    page.click(toggle('entity-visual')); await page.settle();
    const old = pending[1]; assert.deepEqual(old.ids, ['entity-camera', 'entity-visual']);
    page.tab('systems'); old.resolve(await old.render()); await page.settle();
    assert.equal(page.current().aspect, 'systems'); assert.equal(page.get('entity-layout-status').hidden, true);
    assert.equal(page.get('diagram').querySelectorAll('button[data-entity-toggle]').length, 0);
  });

  test(`${variant} dynamic layout failure keeps the committed diagram and manual set while retry restores the requested combination`, async () => {
    let failures = 1;
    const page = foldingViewer(open, '?feature=first_person&tab=data', { runtimeCompile: (_, ids, render) => failures-- > 0 ? Promise.reject(new Error('Geometry blocked')) : render() });
    const toggle = id => page.get('diagram').querySelectorAll('button[data-entity-toggle]').find(button => button.dataset.entityToggle === id);
    page.click(toggle('entity-controller')); const before = page.current();
    toggle('entity-camera').focus(); page.click(toggle('entity-camera')); await page.settle();
    assert.equal(page.current().svg, before.svg); assert.deepEqual(expandedIds(page), ['entity-controller']);
    assert.deepEqual(page.history.state.architectureEntityModes[page.base().id], ['entity-controller']);
    assert.equal(page.document.activeElement, toggle('entity-camera'));
    assert.equal(page.get('canvas').getAttribute('aria-busy'), 'false');
    assert.match(page.get('entity-layout-message').textContent, /Geometry blocked/);
    assert.equal(page.get('retry-entity-layout').hidden, false);
    page.click(page.get('retry-entity-layout')); await page.settle();
    assert.deepEqual(expandedIds(page), ['entity-controller', 'entity-camera']);
    assert.deepEqual(page.history.state.architectureEntityModes[page.base().id], ['entity-controller', 'entity-camera']);
    assert.equal(page.get('entity-layout-status').hidden, true);
    assert.equal(page.document.activeElement, toggle('entity-camera'));
  });

  test(`${variant} an uncached history layout failure rolls back the manual set and retry persists the restored combination`, async () => {
    let failures = 1;
    const page = foldingViewer(open, '?feature=first_person&tab=data&workspace=E%3A%2Fwork%20tree&keep=a&keep=b#restore', {
      initialHistoryState: { unrelated: { keep: true }, architectureEntityModes: { 'plugin-first_person-data': ['entity-controller', 'entity-camera'] } },
      runtimeCompile: (_, ids, render) => failures-- > 0 ? Promise.reject(new Error('History geometry blocked')) : render(),
    });
    const href = page.location.href;
    await page.settle();
    assert.deepEqual(expandedIds(page), []);
    assert.equal(page.current().svg, page.base().entityViews.collapsed.svg);
    assert.deepEqual(page.history.state.architectureEntityModes[page.base().id], []);
    assert.deepEqual(page.history.state.unrelated, { keep: true });
    assert.match(page.get('entity-layout-message').textContent, /History geometry blocked/);
    assert.equal(page.get('retry-entity-layout').hidden, false);
    assert.equal(page.get('canvas').getAttribute('aria-busy'), 'false');
    page.click(page.get('retry-entity-layout')); await page.settle();
    assert.deepEqual(expandedIds(page), ['entity-controller', 'entity-camera']);
    assert.deepEqual(page.history.state.architectureEntityModes[page.base().id], ['entity-controller', 'entity-camera']);
    assert.deepEqual(page.history.state.unrelated, { keep: true });
    assert.equal(page.location.href, href); assert.equal(page.history.length, 1);
    assert.equal(page.location.searchParams.get('workspace'), 'E:/work tree');
    assert.deepEqual(page.location.searchParams.getAll('keep'), ['a', 'b']); assert.equal(page.location.hash, '#restore');
    assert.equal(page.get('entity-layout-status').hidden, true);
  });

  test(`${variant} revealing a hidden Component rolls back a failed owner expansion and retry commits it without closing other Entities`, async () => {
    let failures = 1;
    const page = foldingViewer(open, '?feature=first_person&tab=data&node=entity-camera&workspace=E%3A%2Fwork%20tree&keep=a&keep=b#reveal', {
      initialHistoryState: { unrelated: { keep: true }, architectureEntityModes: { 'plugin-first_person-data': ['entity-controller'] } },
      runtimeCompile: (_, ids, render) => failures-- > 0 ? Promise.reject(new Error('Reveal geometry blocked')) : render(),
    });
    await page.settle();
    const before = page.current(), href = page.location.href;
    assert.deepEqual(expandedIds(page), ['entity-controller']);
    page.click(page.get('details').querySelectorAll('[data-open]').find(button => button.dataset.open === 'camera.FirstPersonCamera'));
    await page.settle();
    assert.equal(page.current().svg, before.svg);
    assert.deepEqual(expandedIds(page), ['entity-controller']);
    assert.deepEqual(page.history.state.architectureEntityModes[page.base().id], ['entity-controller']);
    assert.deepEqual(page.history.state.unrelated, { keep: true });
    assert.match(page.get('entity-layout-message').textContent, /Reveal geometry blocked/);
    assert.equal(page.get('retry-entity-layout').hidden, false);
    assert.equal(page.get('canvas').getAttribute('aria-busy'), 'false');
    page.click(page.get('retry-entity-layout')); await page.settle();
    assert.deepEqual(expandedIds(page), ['entity-controller', 'entity-camera']);
    assert.deepEqual(page.history.state.architectureEntityModes[page.base().id], ['entity-controller', 'entity-camera']);
    assert.deepEqual(page.get('diagram').querySelectorAll('.selected').map(node => node.dataset.id), ['camera.FirstPersonCamera']);
    assert.deepEqual(page.history.state.unrelated, { keep: true });
    assert.equal(page.location.href, href); assert.equal(page.history.length, 1);
    assert.equal(page.location.searchParams.get('workspace'), 'E:/work tree');
    assert.deepEqual(page.location.searchParams.getAll('keep'), ['a', 'b']); assert.equal(page.location.hash, '#reveal');
    assert.equal(page.get('entity-layout-status').hidden, true);
  });

  test(`${variant} Entity container headers, blank areas and nested Components activate their nearest target without inherited filters`, () => {
    for (const nested of [true, false]) {
      const page = entityContainerFixture(open, nested), diagram = page.get('diagram'), canvas = page.get('canvas');
      const node = id => diagram.querySelectorAll('[data-id]').find(node => node.dataset.id === id);
      const entity = node('entity-camera'), component = node('camera.FirstPersonCamera'), sibling = node('camera.MouseLookState');
      const outline = ownShapeParts(entity)[0], header = diagram.querySelector('[data-entity-header]');
      const verify = assertNativeSelection(page), initial = canvasTransform(page);
      const pointer = target => {
        page.document.elementFromPoint = () => target;
        canvas.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 20, clientY: 30 });
        canvas.dispatch('pointerup', { pointerId: 1, clientX: 20, clientY: 30 });
        assert.equal(page.document.activeElement, canvas);
      };
      for (const target of [header.querySelector('text'), outline, header]) {
        pointer(target); verify(['entity-camera']);
        assert.equal(component.classList.contains('dim'), false);
        assert.equal(sibling.classList.contains('dim'), false);
        assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 1);
        assert.equal(entity.style.getPropertyValue('filter'), '');
        assert.equal(header.style.getPropertyValue('filter'), '');
        assert.equal(header.classList.contains('selected'), false);
        assert.equal(header.classList.contains('dim'), false);
        for (const attribute of ['data-id', 'tabindex', 'role', 'aria-pressed']) assert.equal(header.getAttribute(attribute), null);
        assert.equal(ownShapeParts(component)[0].style.getPropertyValue('filter'), '');
        assert.equal(page.get('details').querySelector('h2').textContent, page.data.registry['entity-camera'].name);
        assert.deepEqual(canvasTransform(page), initial);
      }
      const entitySource = page.data.registry['entity-camera'].definition_source || page.data.registry['entity-camera'].source;
      if (entitySource) assertEditorActions(page, entitySource, 'D:/demo');
      else assert.equal(page.get('details').querySelector('a.source'), null, 'An Entity without a source cannot inherit its Component source');
      pointer(ownShapeParts(component)[0]); verify(['camera.FirstPersonCamera']);
      assert.equal(entity.classList.contains('selected'), false);
      assert.equal(entity.classList.contains('dim'), false);
      assert.equal(sibling.classList.contains('dim'), true);
      assert.equal(outline.style.getPropertyValue('filter'), '');
      const componentSource = page.data.registry['camera.FirstPersonCamera'].definition_source || page.data.registry['camera.FirstPersonCamera'].source;
      assertEditorActions(page, componentSource, 'D:/demo');
      component.focus(); component.dispatch('keydown', { key: ' ' }); verify(['camera.FirstPersonCamera']);
      assert.equal(page.document.activeElement, component);
      entity.focus(); entity.dispatch('keydown', { key: 'Enter' }); verify(['entity-camera']);
      assert.equal(page.document.activeElement, entity);
      header.dispatch('keydown', { key: 'Enter' }); verify(['entity-camera']);
      assert.equal(page.document.activeElement, entity, 'A nonfocusable layout header does not become a second focus target');
      page.click(page.get('clear-selection')); verify();
      assert.equal(page.document.activeElement, canvas);
      const link = page.current().links.find(link => link.id === 'write-observe_look-camera.FirstPersonCamera');
      const edge = diagram.querySelectorAll('[data-link-id]').find(edge => edge.dataset.linkId === link.id);
      pointer(edge); verify([link.from, link.to]);
      assert.equal(entity.classList.contains('selected'), false, 'A nested edge takes precedence over its enclosing Entity');
      assert.deepEqual(diagram.querySelectorAll('.edge.focused').map(edge => edge.dataset.linkId), [link.id]);
      page.get('search').focus(); page.search('entity-container-mixed');
      verify(['entity-camera', 'camera.FirstPersonCamera']);
      assert.equal(page.get('details').querySelector('h2').textContent, '2 个匹配节点');
      assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 2);
      page.search('entity-component-only'); verify(['camera.FirstPersonCamera']);
      assert.equal(page.get('details').querySelector('h2').textContent, '1 个匹配节点');
      assert.equal(sibling.classList.contains('dim'), true);
      page.search('no-entity-container-match'); verify();
      assert.equal(entity.classList.contains('dim'), true);
      assert.equal(header.classList.contains('dim'), true);
      assert.equal(entity.style.getPropertyValue('opacity'), '', 'Container dimming cannot set inherited opacity');
      page.search(''); verify();
      assert.equal(diagram.querySelectorAll('.dim').length, 0);
      assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 0);
      assertCurrentGuide(page);
    }
  });

  test(`${variant} Entity context preserves members for pointer and keyboard activation without selecting or focusing them`, () => {
    const page = entityContextViewer(open), verify = assertNativeSelection(page);
    const diagram = page.get('diagram'), canvas = page.get('canvas');
    const node = id => diagram.querySelectorAll('[data-id]').find(node => node.dataset.id === id);
    const clear = id => assert.equal(node(id).classList.contains('dim'), false, id + ' remains clear');
    const dim = id => assert.equal(node(id).classList.contains('dim'), true, id + ' remains unrelated');
    const entity = node('entity-controller'), component = node('controller.PlayerId');
    for (const pointerType of ['mouse', 'touch']) {
      const before = canvasTransform(page);
      page.document.elementFromPoint = () => entity.querySelector('[data-shape-part]');
      canvas.dispatch('pointerdown', { button: 0, pointerType, pointerId: 1, clientX: 20, clientY: 30 });
      canvas.dispatch('pointerup', { pointerType, pointerId: 1, clientX: 20, clientY: 30 });
      assert.equal(page.document.activeElement, canvas);
      verify(['entity-controller']);
      for (const id of page.current().entityGroups[0].components) clear(id);
      clear('entity-camera');
      dim('camera.FirstPersonCamera');
      dim('visual.CharacterVisual');
      assert.equal(diagram.querySelectorAll('[data-link-id]').find(edge => edge.dataset.linkId === 'write-observe_look-camera.FirstPersonCamera').classList.contains('focused'), false);
      assert.deepEqual(canvasTransform(page), before);
      page.click(page.get('clear-selection')); verify();
    }
    component.focus(); component.dispatch('keydown', { key: ' ' });
    verify(['controller.PlayerId']);
    assert.equal(page.document.activeElement, component);
    clear('entity-controller');
    dim('controller.GameplayContext');
    dim('entity-camera');
    assert.equal(diagram.querySelectorAll('.edge.focused').length, 0);
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 1);
    page.click(page.get('clear-selection')); verify();
    assert.equal(page.document.activeElement, canvas);
    assert.equal(diagram.querySelectorAll('.dim').length, 0);
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 0);
    assertCurrentGuide(page);
  });

  test(`${variant} Entity context does not expand search hits or selected edge endpoints and restores every native outline`, () => {
    const hits = ['controller.PlayerId', 'controller.GameplayContext', 'camera.FirstPersonCamera'];
    const page = entityContextViewer(open, state => {
      for (const id of hits) state.registry[id].description += ' entity-context-multi';
    }), verify = assertNativeSelection(page);
    const diagram = page.get('diagram'), search = page.get('search');
    const node = id => diagram.querySelectorAll('[data-id]').find(node => node.dataset.id === id);
    search.focus(); page.search('entity-context-multi');
    verify(hits);
    assert.equal(page.document.activeElement, search);
    assert.deepEqual(page.get('details').querySelectorAll('[data-open]').map(item => item.dataset.open), hits);
    for (const id of ['entity-controller', 'entity-camera']) assert.equal(node(id).classList.contains('dim'), false);
    for (const id of ['controller.ControlsCamera', 'camera.MouseLookState']) assert.equal(node(id).classList.contains('dim'), true);
    assert.equal(diagram.querySelectorAll('.edge.focused').length, 0);
    page.search('no-context-match'); verify();
    assert.equal(diagram.querySelectorAll('[data-id]').filter(node => node.classList.contains('dim')).length, page.current().nodes.length);
    page.search(''); verify();
    const link = page.current().links.find(link => link.id === 'write-observe_look-camera.FirstPersonCamera');
    const edge = diagram.querySelectorAll('[data-link-id]').find(edge => edge.dataset.linkId === link.id);
    page.click(edge);
    verify([link.from, link.to]);
    assert.equal(node('entity-camera').classList.contains('dim'), false);
    assert.equal(node('camera.MouseLookState').classList.contains('dim'), true);
    assert.equal(node('entity-controller').classList.contains('dim'), true);
    assert.deepEqual(diagram.querySelectorAll('.edge.focused').map(edge => edge.dataset.linkId), [link.id]);
    assert.deepEqual(page.get('details').querySelectorAll('[data-open]').map(item => item.dataset.open), [link.from, link.to]);
    page.click(page.get('details').querySelectorAll('[data-open]')[1]);
    verify(['camera.FirstPersonCamera']);
    assert.equal(node('entity-camera').classList.contains('dim'), false);
    page.click(page.get('clear-selection')); verify();
    assert.equal(diagram.querySelectorAll('.dim').length, 0);
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 0);
  });

  test(`${variant} real Entity containers locate without selection and preserve grouped context across history and owner navigation`, () => {
    const page = open('?feature=first_person&tab=data&node=controller.PlayerId&workspace=E%3A%2Fwork%20tree#entity-context');
    const initialHref = page.location.href, diagram = page.get('diagram');
    const group = page.current().entityGroups.find(group => group.components.includes('controller.PlayerId'));
    assert.ok(group);
    const svgStyles = diagram.querySelectorAll('style').map(style => style.textContent).join('\n');
    assert.ok(svgStyles.includes('.node.dim:not(.entity-container),[data-entity-header].dim{opacity:.22}.entity-container.dim>[data-shape-part]{opacity:.22}'));
    assert.ok(svgStyles.includes('[data-id]:focus-visible:not(.selected):not(.entity-container),.entity-container:focus-visible:not(.selected)>[data-shape-part]'));
    const frame = () => diagram.querySelectorAll('[data-entity-group]').find(frame => frame.dataset.entityGroup === group.id);
    const assertFrame = (selected = false) => {
      const outer = frame(); assert.ok(outer);
      assert.equal(outer.dataset.id, group.entity);
      assert.equal(outer.dataset.presentation, 'entity-container');
      assert.equal(outer.dataset.visualType, 'entity');
      assert.equal(diagram.querySelectorAll('[data-id]').filter(node => node.dataset.id === group.entity).length, 1, 'The Entity has one canonical interactive container');
      assert.equal(outer.getAttribute('role'), 'button');
      assert.equal(outer.getAttribute('tabindex'), '0');
      assert.equal(outer.classList.contains('selected'), selected);
      assert.equal(outer.classList.contains('dim'), false);
      assert.equal(outer.style.getPropertyValue('filter'), '');
      const parts = ownShapeParts(outer);
      assert.equal(parts.length, 1);
      assert.equal(parts[0].tagName, 'rect');
      assert.equal(parts[0].parentElement, outer);
      assert.equal(parts[0].dataset.shapePart, outer.dataset.instance);
      const header = diagram.querySelectorAll('[data-entity-header]').find(header => header.dataset.entityHeader === outer.dataset.instance);
      assert.ok(header);
      assert.equal(header.dataset.entityOwner, group.entity);
      assert.equal(header.getAttribute('aria-hidden'), 'true');
      assert.equal(header.style.getPropertyValue('filter'), '');
      assert.equal(header.classList.contains('selected'), false);
      for (const attribute of ['data-id', 'tabindex', 'role', 'aria-pressed']) assert.equal(header.getAttribute(attribute), null);
      if (selected) assert.match(parts[0].style.getPropertyValue('filter'), /^url\(#/);
      else assert.equal(parts[0].style.getPropertyValue('filter'), '');
    };
    const assertContext = () => {
      assert.deepEqual(diagram.querySelectorAll('.selected').map(node => node.dataset.id), ['controller.PlayerId']);
      const owner = diagram.querySelectorAll('[data-id]').find(node => node.dataset.id === group.entity);
      assert.equal(owner.classList.contains('dim'), false);
      assertFrame();
    };
    assertContext();
    const source = page.data.registry['controller.PlayerId'].definition_source || page.data.registry['controller.PlayerId'].source;
    assertEditorActions(page, source, 'E:/work tree');
    page.click(page.get('clear-selection'));
    const verify = assertNativeSelection(page), selector = page.get('section');
    const sectionIndex = page.current().sections.findIndex(section => section.entityGroup === group.id);
    assert.ok(sectionIndex >= 0);
    const section = page.current().sections[sectionIndex];
    for (const key of ['x', 'y', 'width', 'height']) assert.equal(section[key], group.bounds[key]);
    page.activate('controller.PlayerId');
    const canvas = page.get('canvas'), outline = [...frame().children].find(child => child.tagName === 'rect');
    assert.ok(outline);
    page.document.elementFromPoint = () => outline;
    canvas.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    canvas.dispatch('pointerup', { pointerId: 1, clientX: 10, clientY: 10 });
    verify([group.entity]); assertFrame(true);
    assert.equal(page.get('details').querySelector('h2').textContent, page.data.registry[group.entity].name);
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 1);
    for (const id of group.components) assert.equal(diagram.querySelectorAll('[data-id]').find(node => node.dataset.id === id).classList.contains('dim'), false);
    assert.equal(page.document.activeElement, canvas);
    page.activate('controller.PlayerId');
    selector.focus(); selector.value = String(sectionIndex); selector.dispatch('change');
    assert.equal(page.document.activeElement, selector);
    verify(); assertFrame();
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 0);
    assert.equal(page.get('details').querySelector('h2').textContent, page.data.registry[group.entity].name);
    const transform = canvasTransform(page);
    assert.ok(Math.abs((section.x - page.current().bounds.x) * transform.scale + transform.x - 18) < 1e-6);
    assert.ok(Math.abs((section.y - page.current().bounds.y) * transform.scale + transform.y - 18) < 1e-6);
    page.feature('character'); page.back();
    assert.equal(page.location.href, initialHref); assertContext();
    page.forward(); assert.equal(page.current().feature, 'character'); page.back(); assertContext();
    const external = page.current().nodes.find(node => node.role === 'external' && page.data.registry[node.id].feature !== page.current().feature
      && page.data.views.some(view => view.feature === page.data.registry[node.id].feature && view.nodes.some(item => item.id === node.id && item.role === 'internal')));
    assert.ok(external);
    page.activate(external.id);
    const target = page.get('details').querySelector('[data-owner]');
    assert.ok(target); page.click(target);
    assert.equal(page.current().feature, page.data.registry[external.id].feature);
    page.back(); assert.equal(page.location.href, initialHref); assertContext();
    assertEditorActions(page, source, 'E:/work tree');
    page.tab('systems');
    assert.equal(diagram.querySelectorAll('[data-entity-group]').length, 0);
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 0);
    page.back(); assertContext();
  });

  test(`${variant} engine and third-party navigation keeps independent tabs, titles and page-scoped search`, () => {
    const page = open();
    const navigation = page.document.querySelector('.navigation');
    assert.equal(navigation.querySelectorAll('[data-feature]').length, 20);
    const heading = navigation.querySelector('#third-party-heading'), group = navigation.querySelector('.third-party-navigation');
    assert.equal(heading.tagName, 'p');
    assert.equal(heading.textContent, '第三方插件');
    assert.equal(heading.getAttribute('data-feature'), null);
    assert.equal(group.getAttribute('aria-labelledby'), heading.id);
    assert.deepEqual(group.querySelectorAll('[data-feature]').map(button => button.dataset.feature), ['avian', 'enhanced_input', 'kira', 'egui']);
    assert.equal(navigation.querySelector('[data-feature="infrastructure"]').closest('.third-party-navigation'), null);
    assert.equal(navigation.querySelector('[data-feature="third_party"]'), null);
    assert.ok(navigation.children.indexOf(group) < navigation.children.indexOf(navigation.querySelector('[data-feature="infrastructure"]')), 'The four third-party entries precede Bevy');
    const responsiveStyles = variant === 'source' ? sourceHtml : html;
    assert.match(responsiveStyles, /@media\(max-width:900px\)[\s\S]*\.third-party-navigation\{display:flex;flex:none;gap:4px\}/);
    for (const feature of INFRASTRUCTURE_FEATURES) {
      const button = navigation.querySelector(`[data-feature="${feature.id}"]`);
      assert.equal(button.textContent, feature.label + feature.identifier);
      page.feature(feature.id);
      for (const aspect of ['systems', 'data', 'events']) {
        page.tab(aspect);
        assert.equal(page.current().feature, feature.id);
        assert.equal(page.current().aspect, aspect);
        assert.equal(page.get('feature-head').querySelector('h1').textContent, feature.label + feature.identifier);
        assertCurrentGuide(page);
        if (!page.current().nodes.length) continue;
        const id = page.current().nodes.find(node => node.role === 'internal')?.id || page.current().nodes[0].id;
        page.search(id);
        const expected = page.current().nodes.filter(node => JSON.stringify(page.data.registry[node.id]).toLowerCase().includes(id.toLowerCase())).map(node => node.id);
        assert.deepEqual(page.get('details').querySelectorAll('[data-open]').map(result => result.dataset.open), expected);
        assert.ok(expected.includes(id));
        page.search(''); assertCurrentGuide(page);
      }
    }
    page.feature('infrastructure');
    assert.ok(page.current().scheduleGroups.some(group => group.id === 'RenderApp'));
    assert.ok(page.current().scheduleGroups.every(group => !['FixedLast', 'FixedPostUpdate', 'EguiPrimaryContextPass'].includes(group.id)));
    page.feature('egui');
    assert.ok(page.current().scheduleGroups.some(group => group.id === 'EguiPrimaryContextPass'));
    page.feature('avian');
    assert.ok(page.current().scheduleGroups.some(group => group.id === 'FixedPostUpdate'));
    assert.ok(page.current().scheduleGroups.every(group => group.id !== 'EguiPrimaryContextPass'));
    page.activate('physics_step');
    assert.ok(page.get('details').textContent.includes('注册功能：Avian'));
    page.tab('data');
    page.activate('resource.TimePhysics');
    assert.ok(page.get('details').textContent.includes('功能归属：Avian'));
    assert.ok(page.get('details').textContent.includes('定义归属：Bevy 引擎'));
  });

  test(`${variant} node source actions prefer the dependency definition while preserving the project reference`, () => {
    const reference = { path: 'src/physics/mod.rs', line: 24 };
    const definition = { path: 'src/中文 #%.rs', line: 37, dependency: { name: 'avian3d', version: '0.7.0', root: 'C:/Cargo & 中文 #%/avian3d-0.7.0' } };
    for (const workspace of ['', '&workspace=E%3A%2Funrelated', '&workspace=relative']) {
      const page = fixtureViewer(open, '?feature=avian&tab=systems&node=physics_step' + workspace, state => {
        state.registry.physics_step.source = reference;
        state.registry.physics_step.definition_source = definition;
      }, { pageUrl: 'https://example.test/docs/diagrams/ecs-architecture.html' });
      assertEditorActions(page, definition, null);
      assert.deepEqual(page.data.registry.physics_step.source, reference);
      assert.deepEqual(page.data.registry.physics_step.definition_source, definition);
      const link = page.get('details').querySelector('a.source');
      assert.equal(link.dataset.workspaceState, 'ready');
      assert.notEqual(link.href, '#workspace-config');
      page.click(link);
      assert.notEqual(page.document.querySelector('[data-workspace-dialog]').open, true);
      const copy = page.get('details').querySelector('[data-source-location] button');
      page.click(copy);
      assert.match(page.get('details').querySelector('[data-source-copy-feedback]').textContent, /请手动复制/);
    }
  });

  test(`${variant} every delivered dependency definition opens its Cargo source independently of the project directory`, () => {
    const page = open('?workspace=E%3A%2Funrelated-project', { initialHistoryState: { architectureEntityModes: Object.fromEntries(sourceState.views.filter(view => view.entityViews?.collapsed).map(view => [view.id, 'all'])) } });
    const definitions = new Map(Object.values(page.data.registry).filter(record => record.definition_source).map(record => [record.id, record.definition_source]));
    const targets = dependencyDefinitionTargets(page.data.registry);
    assert.deepEqual([...definitions.keys()].sort(), [...targets].sort(), 'Generated definitions cover the current shared target catalog');
    for (const id of targets) assert.ok(DEPENDENCY_SOURCE_DEFINITIONS[id], id + ' has a reviewed declaration');
    for (const kind of ['engine', 'sync', 'Engine SystemSet', 'Engine system', 'Engine system set', 'Engine observers']) {
      const nodes = Object.values(page.data.registry).filter(record => record.kind === kind && INFRASTRUCTURE_FEATURES.some(feature => feature.id === record.feature));
      assert.ok(nodes.length > 0, kind + ' has real engine contracts');
      for (const node of nodes) assert.ok(definitions.has(node.id), kind + '/' + node.id + ' opens its dependency definition');
    }
    const covered = new Set();
    for (const view of page.data.views) {
      const ids = view.nodes.map(node => node.id).filter(id => definitions.has(id) && !covered.has(id));
      if (!ids.length) continue;
      page.feature(view.id === 'overview' ? 'overview' : view.feature);
      if (view.id !== 'overview') page.tab(view.aspect);
      for (const id of ids) {
        const original = page.data.registry[id].source;
        page.activate(id);
        assertEditorActions(page, definitions.get(id), 'E:/unrelated-project');
        assert.deepEqual(page.data.registry[id].source, original);
        covered.add(id);
      }
    }
    assert.deepEqual([...covered].sort(), [...definitions.keys()].sort());
  });

  test(`${variant} Kira playback and all three ApplyDeferred contracts open their real definitions in every visible view`, () => {
    const cases = [
      ['kira-play-typed', 'bevy_kira_audio', '0.26.0', 'src/lib.rs', 195, undefined],
      ['capture_apply', 'bevy_ecs', '0.19.1', 'src/schedule/executor/mod.rs', 160, { path: 'src/first_person/mod.rs', line: 106 }],
      ['held_apply', 'bevy_ecs', '0.19.1', 'src/schedule/executor/mod.rs', 160, { path: 'src/game_flow/mod.rs', line: 67 }],
      ['orphan_apply', 'bevy_ecs', '0.19.1', 'src/schedule/executor/mod.rs', 160, { path: 'src/item_interaction/mod.rs', line: 42 }],
    ];
    for (const [id, packageName, version, path, line, registration] of cases) {
      const declaration = DEPENDENCY_SOURCE_DEFINITIONS[id];
      assert.ok(declaration, id + ' has a reviewed declaration');
      assert.equal(declaration.package, packageName);
      assert.equal(declaration.path, path);
      const views = sourceState.views.filter(view => view.nodes.some(node => node.id === id));
      assert.ok(views.length >= 2, id + ' is visible in its owner and a project view');
      for (const view of views) {
        const page = open(`?feature=${view.feature}&tab=${view.aspect}&node=${id}&workspace=E%3A%2Funrelated-project`);
        const record = page.data.registry[id], definition = record.definition_source;
        assert.ok(definition, view.id + '/' + id);
        assert.equal(definition.dependency.name, packageName);
        assert.equal(definition.dependency.version, version);
        assert.equal(definition.path, path);
        assert.equal(definition.line, line);
        assert.deepEqual(record.source, registration, 'The original project registration remains available as data');
        assertEditorActions(page, definition, 'E:/unrelated-project');
        page.click(page.get('clear-selection'));
        page.activate(id);
        const controls = assertEditorActions(page, definition, 'E:/unrelated-project');
        assert.ok(!controls.field.value.startsWith('E:/unrelated-project/'));
        assert.deepEqual(record.source, registration);
      }
    }
  });

  test(`${variant} all five infrastructure overview cards select details before explicit owner navigation`, () => {
    const page = open('?workspace=E%3A%2Fwork%20tree&keep=value#overview');
    const overviewHref = page.location.href;
    assert.equal(page.current().nodes.length, 19);
    assert.equal(page.data.registry['third-party-plugins'], undefined);
    for (const feature of INFRASTRUCTURE_FEATURES) {
      page.activate(feature.overviewNode);
      assert.equal(page.base().id, 'overview');
      assert.equal(page.location.href, overviewHref);
      assert.ok(page.get('diagram').querySelectorAll('.selected').some(node => node.dataset.id === feature.overviewNode));
      assert.ok(page.get('details').textContent.includes('功能归属：' + feature.label));
      const owner = page.get('details').querySelector('[data-owner]');
      assert.equal(owner.dataset.owner, feature.id);
      page.click(owner);
      assert.equal(page.current().feature, feature.id);
      const hasLocalCard = page.current().nodes.some(node => node.id === feature.overviewNode);
      assert.equal(page.location.searchParams.get('node'), hasLocalCard ? feature.overviewNode : null);
      assert.equal(page.location.searchParams.get('workspace'), 'E:/work tree');
      assert.equal(page.location.hash, '#overview');
      page.back();
      assert.equal(page.base().id, 'overview');
      assert.equal(page.location.href, overviewHref);
    }
  });

  test(`${variant} project external contracts open the correct engine or third-party owner and return normally`, () => {
    for (const feature of INFRASTRUCTURE_FEATURES) {
      const candidates = sourceState.views.filter(view => sourceState.model.features.some(project => project.id === view.feature)).flatMap(view => view.nodes.filter(node => node.role === 'external' && sourceState.registry[node.id].feature === feature.id && sourceState.views.some(owner => owner.feature === feature.id && owner.nodes.some(item => item.id === node.id && item.role === 'internal'))).map(node => ({ view, node })));
      const reference = candidates.find(({ node }) => sourceState.registry[node.id].source) || candidates[0];
      assert.ok(reference, feature.id + ' has a real cross-feature reference');
      const { view: target, node: external } = reference;
      const page = open(`?feature=${target.feature}&tab=${target.aspect}&node=${encodeURIComponent(external.id)}`);
      assert.ok(page.get('details').textContent.includes('功能归属：' + feature.label));
      const source = page.data.registry[external.id].definition_source || page.data.registry[external.id].source;
      if (source) assertEditorActions(page, source, 'D:/demo');
      const owner = page.get('details').querySelector('[data-owner]');
      assert.equal(owner.dataset.owner, feature.id);
      page.click(owner);
      assert.equal(page.current().feature, feature.id);
      assert.ok(page.current().nodes.some(node => node.id === external.id && node.role === 'internal'));
      assert.equal(page.location.searchParams.get('node'), external.id);
      if (source) assertEditorActions(page, source, 'D:/demo');
      page.back();
      assert.equal(page.base().id, target.id);
      assert.equal(page.get('details').querySelector('h2').textContent, page.data.registry[external.id].name);
      assert.ok(page.get('diagram').querySelectorAll('.selected').some(node => node.dataset.id === external.id));
    }
  });

  test(`${variant} legacy third-party links resolve each business node to its internal owner and preserve navigation state`, () => {
    const suffix = '&workspace=E%3A%2Fwork%20%23%25&keep=a&keep=b#anchor';
    for (const feature of INFRASTRUCTURE_FEATURES.filter(feature => feature.section === 'third_party')) {
      const ownerViews = sourceState.views.filter(view => view.feature === feature.id);
      const node = ownerViews.flatMap(view => view.nodes).find(node => node.role === 'internal');
      assert.ok(node, feature.id + ' has an internal business node');
      for (const aspect of ['systems', 'data', 'events']) {
        const expected = ownerViews.find(view => view.aspect === aspect && view.nodes.some(item => item.id === node.id && item.role === 'internal')) || ownerViews.find(view => view.nodes.some(item => item.id === node.id && item.role === 'internal'));
        const page = open(`?feature=third_party&tab=${aspect}&node=${encodeURIComponent(node.id)}` + suffix);
        assert.equal(page.base().id, expected.id);
        assert.equal(page.location.searchParams.get('feature'), feature.id);
        assert.equal(page.location.searchParams.get('tab'), expected.aspect);
        assert.equal(page.location.searchParams.get('node'), node.id);
        assert.equal(page.location.searchParams.get('workspace'), 'E:/work #%');
        assert.deepEqual(page.location.searchParams.getAll('keep'), ['a', 'b']);
        assert.equal(page.location.hash, '#anchor');
        assert.ok(page.get('diagram').querySelectorAll('.selected').some(item => item.dataset.id === node.id));
        if (aspect === 'systems') {
          page.feature('character'); page.back();
          assert.equal(page.base().id, expected.id);
          assert.equal(page.get('details').querySelector('h2').textContent, page.data.registry[node.id].name);
          assert.throws(() => page.back(), 'Normalization replaces the old entry instead of inserting a history step');
          page.forward(); assert.equal(page.current().feature, 'character');
        }
      }
    }
    const alias = fixtureViewer(open, '?feature=third_party&tab=systems&node=legacy-physics-step' + suffix, state => { state.registry['legacy-physics-step'] = { alias_of: 'physics_step' }; });
    assert.equal(alias.current().feature, 'avian');
    assert.equal(alias.location.searchParams.get('node'), 'physics_step');
    const internal = sourceState.views.find(view => view.feature === 'avian' && view.aspect === 'data').nodes.find(node => node.id === 'resource.TimePhysics');
    const externalOnly = fixtureViewer(open, '?feature=third_party&tab=systems&node=resource.TimePhysics' + suffix, state => {
      state.views.find(view => view.feature === 'avian' && view.aspect === 'systems').nodes.push({ ...internal, role: 'external' });
    });
    assert.equal(externalOnly.current().feature, 'avian');
    assert.equal(externalOnly.current().aspect, 'data', 'An external projection in the requested tab is not an owner destination');
    assert.equal(externalOnly.get('details').querySelector('h2').textContent, externalOnly.data.registry['resource.TimePhysics'].name);
  });

  test(`${variant} empty, invalid or removed third-party directory links return to overview without losing unrelated URL state`, () => {
    for (const node of [null, '', '  ', 'not-an-architecture-node', 'third-party-plugins']) {
      const page = open('?feature=third_party&tab=events' + (node === null ? '' : '&node=' + encodeURIComponent(node)) + '&workspace=E%3A%2Fwork%20tree&keep=a&keep=b#anchor');
      assert.equal(page.base().id, 'overview');
      assert.equal(page.location.searchParams.get('feature'), 'overview');
      assert.equal(page.location.searchParams.has('tab'), false);
      assert.equal(page.location.searchParams.has('node'), false);
      assert.equal(page.location.searchParams.get('workspace'), 'E:/work tree');
      assert.deepEqual(page.location.searchParams.getAll('keep'), ['a', 'b']);
      assert.equal(page.location.hash, '#anchor');
      assert.equal(page.document.querySelector('.tabs').hidden, true);
      assertCurrentGuide(page);
    }
  });

  test(`${variant} original infrastructure links retain Bevy targets and migrate missing nodes to their registered owner`, () => {
    const suffix = '&workspace=E%3A%2Fwork%20%23%25&keep=a&keep=b#anchor';
    for (const [node, aspect] of [['physics_step', 'systems'], ['resource.TimePhysics', 'data']]) {
      const page = open('?feature=infrastructure&tab=systems&node=' + node + suffix);
      assert.equal(page.current().feature, 'avian');
      assert.equal(page.current().aspect, aspect);
      assert.equal(page.location.searchParams.get('node'), node);
      assert.equal(page.location.searchParams.get('workspace'), 'E:/work #%');
      assert.deepEqual(page.location.searchParams.getAll('keep'), ['a', 'b']);
      assert.equal(page.location.hash, '#anchor');
      assert.equal(page.get('details').querySelector('h2').textContent, page.data.registry[node].name);
    }
    const alias = fixtureViewer(open, '?feature=infrastructure&tab=systems&node=legacy-physics-step' + suffix, state => { state.registry['legacy-physics-step'] = { alias_of: 'physics_step' }; });
    assert.equal(alias.current().feature, 'avian');
    assert.equal(alias.location.searchParams.get('node'), 'physics_step');
    const engine = sourceState.views.find(view => view.feature === 'infrastructure' && view.aspect === 'systems');
    const bevyNode = engine.nodes.find(node => node.role === 'internal');
    const unchanged = open('?feature=infrastructure&tab=systems&node=' + encodeURIComponent(bevyNode.id) + suffix);
    assert.equal(unchanged.current().id, engine.id);
    assert.equal(unchanged.location.searchParams.get('feature'), 'infrastructure');
    assert.ok(unchanged.get('diagram').querySelectorAll('.selected').some(node => node.dataset.id === bevyNode.id));
  });

  test(`${variant} access categories and their items have distinct sixteen-pixel levels without changing heading semantics`, () => {
    const page = fixtureViewer(open, '?feature=first_person&tab=systems', state => {
      state.registry.facing_fixed.reads = ['character.Transform', 'resource.ColliderTrees', 'local.PickupReservations', 'non_send.NativePolicies'];
      state.registry.facing_fixed.writes = state.registry.facing_fixed.reads.slice();
    });
    page.activate('facing_fixed');
    const source = variant === 'source' ? sourceHtml : html;
    assert.match(source, /\.access-group\{[^}]*padding-inline-start:16px/);
    assert.match(source, /\.side \.access-group ul\{padding-inline-start:16px\}/);
    assert.match(source, /\.access-group\{[^}]*min-width:0/);
    assert.match(source, /\.side\{[^}]*overflow-wrap:anywhere/);
    assert.match(source, /\.side code,\.side \.data-link\{[^}]*max-width:100%/);
    for (const title of ['Read', 'Write']) {
      const section = page.get('details').querySelector('[data-access="' + title + '"]');
      assert.equal(section.children[0].tagName, 'h3');
      assert.equal(section.children[0].textContent, title);
      const groups = section.querySelectorAll('.access-group');
      assert.deepEqual(groups.map(group => group.dataset.accessKind), ['Entity', 'Resource', 'Local', 'NonSend']);
      for (const group of groups) {
        assert.equal(group.parentElement, section);
        assert.equal(group.children[0].tagName, 'h4');
        assert.equal(group.children[1].tagName, 'ul');
        assert.ok(group.children[1].querySelectorAll('li').length > 0);
      }
    }
  });

  test(`${variant} pointer selection after keyboard focus uses only the selected native ring and parks focus on the canvas`, () => {
    const page = open('?feature=first_person&tab=data'), verify = assertNativeSelection(page);
    const canvas = page.get('canvas'), diagram = page.get('diagram');
    assert.equal(canvas.getAttribute('tabindex'), '-1');
    assert.equal(canvas.getAttribute('role'), 'region');
    assert.equal(canvas.getAttribute('aria-label'), '架构图画布');
    assert.match(variant === 'source' ? sourceHtml : html, /\.canvas:focus\{outline:none\}/);
    const nodes = diagram.querySelectorAll('[data-id]');
    const old = nodes.find(node => node.dataset.visualType === 'entity');
    const target = nodes.find(node => node.dataset.role === 'external');
    assert.ok(old && target && old !== target);
    const focusOptions = [], focus = canvas.focus.bind(canvas);
    canvas.focus = options => { focusOptions.push(options); focus(options); };
    let targetFocuses = 0;
    target.focus = () => { targetFocuses++; };
    for (const [index, pointerType] of ['mouse', 'touch'].entries()) {
      old.focus(); old.dispatch('keydown', { key: 'Enter' }); verify([old.dataset.id]);
      const before = canvasTransform(page);
      page.document.elementFromPoint = () => target.querySelector('[data-shape-part]');
      for (let repeat = 0; repeat < 2; repeat++) {
        canvas.dispatch('pointerdown', { button: 0, pointerType, pointerId: index + 1, clientX: 20, clientY: 30 });
        assert.equal(page.document.activeElement, canvas);
        assert.equal(focusOptions.at(-1).preventScroll, true);
        canvas.dispatch('pointerup', { pointerType, pointerId: index + 1, clientX: 20, clientY: 30 });
        assert.equal(page.document.activeElement, canvas);
        verify([target.dataset.id]);
        assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 1);
        assert.deepEqual(canvasTransform(page), before);
      }
      page.document.elementFromPoint = () => null;
      canvas.dispatch('pointerdown', { button: 0, pointerType, pointerId: index + 1, clientX: 5, clientY: 5 });
      canvas.dispatch('pointerup', { pointerType, pointerId: index + 1, clientX: 5, clientY: 5 });
      verify();
      assert.equal(page.document.activeElement, canvas);
      assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 0);
      assertCurrentGuide(page);
    }
    assert.equal(targetFocuses, 0, 'Pointer release never focuses a node');
  });

  test(`${variant} explicit clear relocates diagram or disappearing-button focus while search and group controls keep theirs`, () => {
    const page = open('?feature=first_person&tab=systems'), verify = assertNativeSelection(page);
    const diagram = page.get('diagram'), canvas = page.get('canvas');
    const node = diagram.querySelectorAll('[data-id]').find(node => node.dataset.id === 'facing_fixed');
    for (const focusClearButton of [false, true]) {
      node.focus(); node.dispatch('keydown', { key: ' ' }); verify(['facing_fixed']);
      const clear = page.get('clear-selection');
      if (focusClearButton) clear.focus();
      page.click(clear);
      assert.equal(page.document.activeElement, canvas);
      assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 0);
      verify(); assertCurrentGuide(page);
    }
    node.focus(); node.dispatch('keydown', { key: 'Enter' });
    const selector = page.get('section'); selector.focus(); selector.value = '0'; selector.dispatch('change');
    assert.equal(page.document.activeElement, selector);
    verify();
    node.focus(); node.dispatch('keydown', { key: 'Enter' });
    const search = page.get('search'); search.focus(); page.search('sync_character_facing');
    assert.equal(page.document.activeElement, search);
    page.search('');
    assert.equal(page.document.activeElement, search);
    verify(); assertCurrentGuide(page);
  });

  test(`${variant} keyboard focus remains reachable and activation does not accumulate rings or change the camera`, () => {
    const page = open('?feature=character&tab=systems'), verify = assertNativeSelection(page);
    const diagram = page.get('diagram'), node = diagram.querySelector('[data-id]');
    assert.equal(node.getAttribute('tabindex'), '0');
    node.focus();
    assert.equal(node.dispatch('keydown', { key: 'Tab' }).defaultPrevented, false, 'Native Tab navigation is not intercepted');
    verify();
    const before = canvasTransform(page);
    for (const key of ['Enter', ' ', 'Enter']) {
      assert.equal(node.dispatch('keydown', { key }).defaultPrevented, true);
      assert.equal(page.document.activeElement, node);
      assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 1);
      assert.deepEqual(canvasTransform(page), before);
      verify([node.dataset.id]);
    }
    page.get('clear-selection').focus(); page.click(page.get('clear-selection'));
    assert.equal(page.document.activeElement, page.get('canvas'));
    verify();
    node.focus();
    assert.equal(page.document.activeElement, node);
    verify();
  });

  test(`${variant} pointer drags, cancellation and edge activation leave focus on the canvas without leaking selection filters`, () => {
    const page = open('?feature=infrastructure&tab=systems'), verify = assertNativeSelection(page);
    const diagram = page.get('diagram'), canvas = page.get('canvas'), node = diagram.querySelector('[data-id]');
    node.focus(); node.dispatch('keydown', { key: 'Enter' }); verify([node.dataset.id]);
    const edge = diagram.querySelector('[data-link-id]'), link = page.current().links.find(link => link.id === edge.dataset.linkId);
    page.document.elementFromPoint = () => edge;
    canvas.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    canvas.dispatch('pointermove', { pointerId: 1, clientX: 40, clientY: 60 });
    canvas.dispatch('pointerup', { pointerId: 1, clientX: 40, clientY: 60 });
    assert.equal(page.document.activeElement, canvas);
    verify([node.dataset.id]);
    canvas.dispatch('pointerdown', { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
    canvas.dispatch('pointercancel', { pointerId: 2 });
    assert.equal(canvas.classList.contains('dragging'), false);
    verify([node.dataset.id]);
    canvas.dispatch('pointerdown', { button: 0, pointerId: 3, clientX: 10, clientY: 10 });
    canvas.dispatch('pointerup', { pointerId: 3, clientX: 10, clientY: 10 });
    assert.equal(page.document.activeElement, canvas);
    verify([link.from, link.to]);
    page.click(page.get('clear-selection'));
    verify(); assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 0);
  });

  test(`${variant} concise group titles agree with SVG, Mermaid and locators while their runtime notes remain available`, () => {
    const page = open('?feature=infrastructure&tab=systems');
    const expected = [
      ['avian', 'FixedLast', 'FixedLast'],
      ['avian', 'FixedPostUpdate', 'FixedPostUpdate'],
      ['egui', 'EguiPrimaryContextPass', 'EguiPrimaryContextPass'],
      ['infrastructure', 'RenderApp', 'RenderApp'],
      ['window_policy', 'NativePlatformEvents', '原生平台回调'],
      ['game_flow', 'Explanatory', '约束与说明'],
    ];
    for (const [feature, id, label] of expected) {
      page.feature(feature);
      const view = page.current(), group = view.scheduleGroups.find(item => item.id === id), selector = page.get('section');
      assert.ok(group, feature + '/' + id);
      assert.equal(group.label, label);
      assert.ok(view.mermaid.includes(`subgraph ${group.mermaidId}["${label}"]`));
      const index = view.sections.findIndex(section => section.schedule === id);
      assert.ok(index >= 0);
      assert.equal(selector.querySelectorAll('option')[index + 1].textContent, label);
      const container = page.get('diagram').querySelectorAll('[data-schedule-id]').find(item => item.dataset.scheduleId === id);
      assert.ok(container.textContent.includes(label), 'The compiled SVG contains the same short heading');
      selector.value = String(index); selector.dispatch('change');
      const details = page.get('details');
      assert.equal(details.children[0].tagName, 'h2');
      assert.equal(details.querySelector('h2').textContent, label);
      assert.equal(details.querySelector('.badge'), null);
      assert.equal(details.querySelector('.footnote'), null);
      for (const note of group.notes) assert.ok(details.textContent.includes(note));
      const original = page.data.model.schedule_groups.find(item => item.id === id);
      assert.deepEqual(original, sourceState.model.schedule_groups.find(item => item.id === id));
      assert.notEqual(original.label, label, 'The original descriptive title remains in the inventory');
    }
    page.feature('avian');
    assert.equal(page.current().scheduleGroups.find(item => item.id === 'RunFixedMainLoop.AfterFixedMainLoop').label, 'RunFixedMainLoop · AfterFixedMainLoop');
    page.feature('egui');
    assert.equal(page.current().scheduleGroups.find(group => group.id === 'EguiPrimaryContextPass').parent, 'PostUpdate');
    assert.equal(page.data.registry.inspector_pass.registrations[0].driver_schedule, 'PostUpdate');
    assert.ok(!page.current().scheduleGroups.some(group => group.id === 'PostUpdate'), 'An absent parent does not add an empty Schedule container');
    assert.ok(page.current().scheduleLinks.every(link => !['RenderApp', 'NativePlatformEvents', 'Explanatory'].includes(link.from) && !['RenderApp', 'NativePlatformEvents', 'Explanatory'].includes(link.to)));
  });

  test(`${variant} redundant guidance is absent across navigation, search, empty tabs and source actions`, () => {
    const page = open();
    assert.equal(page.document.querySelector('.canvas-hint'), null);
    assert.equal(page.get('feature-head').querySelector('p'), null);
    assert.equal(page.get('feature-head').querySelector('h1').textContent, '功能模块与依赖总览');
    page.feature('infrastructure');
    assert.equal(page.get('feature-head').querySelector('p'), null);
    assert.equal(page.get('feature-head').querySelector('h1').textContent, 'Bevy 引擎Bevy');
    page.feature('first_person');
    const href = page.location.href, viewId = page.base().id;
    page.search('sync_character_facing');
    assert.equal(page.get('details').querySelector('.badge'), null);
    assert.equal(page.get('details').querySelector('p'), null);
    assert.ok(page.get('details').querySelectorAll('.result').length > 0);
    assert.match(page.get('details').querySelector('h2').textContent, /个匹配节点/);
    assert.equal(page.location.href, href); assert.equal(page.base().id, viewId);
    page.click(page.get('details').querySelector('.result'));
    assert.ok(page.get('details').textContent.includes(page.data.registry.facing_fixed.description));
    assertEditorActions(page, page.data.registry.facing_fixed.source, 'D:/demo');
    assert.doesNotMatch(page.get('details').textContent, /编辑器打开当前工作区文件|快照行号可能不再对应/);
    page.click(page.get('clear-selection')); assertCurrentGuide(page);
    const empty = page.data.views.find(view => !view.svg);
    page.feature(empty.feature); page.tab(empty.aspect);
    const state = page.get('canvas').querySelector('.empty-state');
    assert.equal(state.textContent, '当前页签没有相关节点');
    assert.equal(state.querySelector('p'), null);
    assert.equal(page.get('section').querySelectorAll('option').length, 1);
    assert.deepEqual(page.data.model, sourceState.model);
  });

  test(`${variant} system details start at the name and summarize Read and Write by distinct Entity identities`, () => {
    const page = open('?feature=first_person&tab=systems&workspace=D%3A%2Fdemo');
    page.activate('facing_fixed');
    const details = page.get('details'), system = page.data.registry.facing_fixed;
    assert.equal(details.children[0].tagName, 'h2');
    assert.equal(details.querySelector('.badge'), null);
    assert.equal(details.querySelector('h2').textContent, system.name);
    assert.ok(details.textContent.includes(system.description));
    assert.doesNotMatch(details.textContent, /Schedule 注册|R · 读取|W · 修改|Query · 过滤/);
    const headings = details.querySelectorAll('h3').map(item => item.textContent);
    for (const label of ['Schedule', 'Read', 'Write', 'Query']) assert.ok(headings.includes(label), label);
    const read = details.querySelector('[data-access="Read"]'), write = details.querySelector('[data-access="Write"]');
    assert.deepEqual(read.querySelector('[data-access-kind="Entity"]').querySelectorAll('[data-open]').map(item => item.dataset.open),
      ['entity-controller', 'entity-camera', 'entity-character', 'entity-parcel', 'entity-world', 'entity-held_proxy']);
    assert.deepEqual(write.querySelector('[data-access-kind="Entity"]').querySelectorAll('[data-open]').map(item => item.dataset.open),
      ['entity-camera', 'entity-character', 'entity-parcel', 'entity-held_proxy']);
    assert.deepEqual(read.querySelector('[data-access-kind="Resource"]').querySelectorAll('[data-open]').map(item => item.dataset.open),
      ['resource.ColliderTrees', 'resource.AppState', 'resource.PlayState']);
    assert.deepEqual(write.querySelector('[data-access-kind="Resource"]').querySelectorAll('[data-open]').map(item => item.dataset.open), ['resource.SoundRequestMessages']);
    for (const section of [read, write]) {
      const entities = section.querySelector('[data-access-kind="Entity"]');
      for (const button of entities.querySelectorAll('[data-open]')) {
        assert.equal(button.textContent.trim(), page.data.registry[button.dataset.open].name);
        assert.equal(page.data.registry[button.dataset.open].kind, 'Entity');
      }
      assert.equal(section.querySelectorAll('[data-open]').some(button => page.data.registry[button.dataset.open].kind === 'Component'), false);
    }
    for (const filter of system.filters) assert.ok(details.textContent.includes(filter));
    assert.deepEqual(system.reads, sourceState.registry.facing_fixed.reads);
    assert.deepEqual(system.writes, sourceState.registry.facing_fixed.writes);
    assertEditorActions(page, system.source, 'D:/demo');
  });

  test(`${variant} access summaries preserve canonical ownership, same-name entities and every non-Entity category`, () => {
    const reads = ['character.Transform', 'character.Position', 'parcel.Transform', 'resource.PlayState', 'resource.AppState', 'resource.PlayState', 'local.PickupReservations', 'non_send.NativePolicies'];
    const writes = ['parcel.Transform', 'character.Transform', 'local.PickupReservations', 'resource.PlayState', 'non_send.NativePolicies'];
    const page = fixtureViewer(open, '?feature=first_person&tab=systems', state => {
      state.registry.facing_fixed.reads = reads;
      state.registry.facing_fixed.writes = writes;
      for (const id of ['entity-character', 'entity-parcel']) state.registry[id].name = '同名实体';
      for (const id of ['character.Transform', 'character.Position', 'parcel.Transform']) state.registry[id].owner = '不用于识别身份的显示名';
    });
    page.activate('facing_fixed');
    const read = page.get('details').querySelector('[data-access="Read"]'), write = page.get('details').querySelector('[data-access="Write"]');
    assert.deepEqual(read.querySelectorAll('[data-access-kind]').map(item => item.dataset.accessKind), ['Entity', 'Resource', 'Local', 'NonSend']);
    assert.deepEqual(read.querySelectorAll('h4').map(item => item.textContent), ['Entity', 'Resource', 'Local<T>', 'NonSend<T>']);
    assert.deepEqual(read.querySelector('[data-access-kind="Entity"]').querySelectorAll('[data-open]').map(item => item.dataset.open), ['entity-character', 'entity-parcel']);
    assert.deepEqual(write.querySelector('[data-access-kind="Entity"]').querySelectorAll('[data-open]').map(item => item.dataset.open), ['entity-parcel', 'entity-character']);
    assert.deepEqual(read.querySelectorAll('[data-open]').map(item => item.dataset.open), ['entity-character', 'entity-parcel', 'resource.PlayState', 'resource.AppState', 'local.PickupReservations', 'non_send.NativePolicies']);
    assert.deepEqual(write.querySelectorAll('[data-open]').map(item => item.dataset.open), ['entity-parcel', 'entity-character', 'resource.PlayState', 'local.PickupReservations', 'non_send.NativePolicies']);
    assert.deepEqual(page.data.registry.facing_fixed.reads, reads);
    assert.deepEqual(page.data.registry.facing_fixed.writes, writes);
  });

  test(`${variant} resource-only access and empty Read, Write, Query or Schedule omit empty sections`, () => {
    const page = open('?feature=character&tab=systems');
    page.activate('startup_config');
    let details = page.get('details');
    assert.equal(details.querySelector('[data-access-kind="Entity"]'), null);
    assert.deepEqual(details.querySelector('[data-access="Read"]').querySelectorAll('[data-open]').map(item => item.dataset.open), ['resource.PrototypeConfig']);
    assert.equal(details.querySelector('[data-access="Write"]'), null);
    const empty = fixtureViewer(open, '?feature=first_person&tab=systems', state => {
      Object.assign(state.registry.facing_fixed, { reads: [], writes: [], filters: [], registrations: [] });
    });
    empty.activate('facing_fixed');
    details = empty.get('details');
    assert.equal(details.querySelectorAll('[data-access]').length, 0);
    assert.equal(details.querySelector('.schedule-registrations'), null);
    assert.equal(details.querySelectorAll('h3').some(item => ['Schedule', 'Read', 'Write', 'Query'].includes(item.textContent)), false);
  });

  test(`${variant} each Schedule registration and condition occupies its own DOM row with full values`, () => {
    const registrations = [
      { schedule: 'OnEnter(AppState::MainMenu)', scope: 'runtime', run_if: ['gameplay_running', 'condition<&>'], sets: ['FixedGameplaySystems::Facing', 'OtherSet'], before: ['first', 'second'], after: ['third'], implicit: false },
      { schedule: 'OnEnter(PlayState::Paused)', scope: 'runtime' },
      { schedule: 'OnExit(AppState::InGame)', scope: 'runtime' },
      { schedule: 'OnTransition { exited: PlayState::Running, entered: PlayState::Paused }', scope: 'runtime' },
      { schedule: 'Startup', scope: 'headless-test', after: [] },
    ];
    const page = fixtureViewer(open, '?feature=first_person&tab=systems', state => { state.registry.facing_fixed.registrations = registrations; });
    page.activate('facing_fixed');
    const section = page.get('details').querySelector('.schedule-registrations');
    assert.equal(section.querySelector('h3').textContent, 'Schedule');
    const blocks = section.querySelectorAll('.schedule-registration');
    assert.equal(blocks.length, registrations.length);
    blocks.forEach((block, index) => {
      assert.equal(block.dataset.registrationIndex, String(index));
      const fields = block.querySelectorAll('.registration-field');
      assert.deepEqual(fields.map(field => field.dataset.registrationField), Object.keys(registrations[index]));
      fields.forEach(field => {
        const value = registrations[index][field.dataset.registrationField];
        assert.equal(field.querySelector('dt').textContent, field.dataset.registrationField);
        const expected = Array.isArray(value) ? (value.length ? value : ['[]']) : [value];
        assert.deepEqual(field.querySelector('dd').querySelectorAll('.registration-value').map(row => row.textContent), expected.map(String));
      });
    });
    assert.equal(section.querySelector('condition'), null, 'Registration values are escaped text');
    assert.deepEqual(page.data.registry.facing_fixed.registrations, registrations);
  });

  test(`${variant} shortened state containers retain every complete target in selected system details`, () => {
    const page = open('?feature=first_person&tab=systems');
    const group = page.current().scheduleGroups.find(group => group.id === 'StateTransition');
    assert.equal(group.label, 'OnEnter');
    page.activate('flow_suspend');
    const blocks = page.get('details').querySelectorAll('.schedule-registration');
    assert.deepEqual(blocks.map(block => block.querySelector('[data-registration-field="schedule"]').querySelector('dd').textContent),
      ['OnEnter(AppState::MainMenu)', 'OnEnter(PlayState::Paused)']);
    assert.equal(page.get('details').querySelector('.badge'), null);
    page.activate('flow_suspend');
    assert.equal(page.get('details').querySelectorAll('.schedule-registration').length, 2);
  });

  test(`${variant} Entity summaries retain detail navigation, full components and back-history selection`, () => {
    const page = open('?feature=first_person&tab=systems&node=facing_fixed');
    const entity = page.get('details').querySelector('[data-access="Read"]').querySelector('[data-open="entity-character"]');
    page.click(entity);
    assert.equal(page.current().aspect, 'data');
    assert.equal(page.get('details').querySelector('h2').textContent, page.data.registry['entity-character'].name);
    assert.equal(page.get('details').querySelector('.badge'), null);
    assert.ok(page.get('details').querySelectorAll('[data-open]').some(button => button.dataset.open === 'character.Transform'));
    page.back();
    assert.equal(page.current().feature, 'first_person');
    assert.equal(page.current().aspect, 'systems');
    assert.equal(page.get('details').querySelector('h2').textContent, page.data.registry.facing_fixed.name);
    assert.equal(page.get('diagram').querySelectorAll('[data-id]').find(node => node.dataset.id === 'facing_fixed').classList.contains('selected'), true);
  });

  test(`${variant} data captions and group navigation share the renamed sections without translating node or edge details`, () => {
    const page = open('?feature=first_person&tab=data'), view = page.current();
    const selector = page.get('section');
    for (const label of ['数据与实体', '数据流与关系']) {
      const index = view.sections.findIndex(section => section.label === label);
      assert.ok(index >= 0, label + ' is a real group navigation entry');
      assert.ok(view.mermaid.includes('["' + label + '"]'));
      assert.ok(selector.querySelectorAll('option').some(option => option.textContent === label));
      selector.value = String(index); selector.dispatch('change');
      assert.equal(page.get('details').querySelector('h2').textContent, label);
      const current = canvasTransform(page), section = view.sections[index];
      assert.ok(Math.abs((section.x - view.bounds.x) * current.scale + current.x - 18) < 1e-6);
      assert.ok(Math.abs((section.y - view.bounds.y) * current.scale + current.y - 18) < 1e-6);
    }
    assert.ok(view.sections.some(section => section.label === '系统私有状态'), 'Existing semantic navigation remains available');
    assert.ok(view.sections.every(section => !['数据契约', '关系与约束'].includes(section.label)));
    page.feature('infrastructure');
    const edge = page.current().scheduleLinks.find(link => link.edgeSemantic === 'schedule');
    const element = page.get('diagram').querySelectorAll('[data-schedule-link-id]').find(item => item.dataset.scheduleLinkId === edge.id);
    page.click(element);
    assert.equal(page.get('details').querySelector('.badge').textContent, 'Schedule 先后');
    assert.doesNotMatch(page.get('details').querySelector('.badge').textContent, /Schedule order/);
    page.click(page.get('clear-selection')); assertCurrentGuide(page);
  });

  test(`${variant} compact plugin headers and summary-free canvases preserve every tab and group locator`, () => {
    const page = open(), features = page.data.model.features;
    const descriptions = features.map(feature => [feature.id, feature.description]);
    assert.equal(page.get('feature-head').querySelector('p'), null);
    assert.equal(page.get('caption'), null);
    let tabs = 0, emptyTabs = 0, located = 0;
    for (const feature of [...features, ...INFRASTRUCTURE_FEATURES]) {
      page.feature(feature.id);
      for (const aspect of ['systems', 'data', 'events']) {
        page.tab(aspect);
        const header = page.get('feature-head'), view = page.current(), selector = page.get('section');
        assert.equal(view.feature, feature.id);
        assert.equal(view.aspect, aspect);
        assert.equal(page.get('caption'), null, view.id);
        assert.equal(selector.parentElement.classList.contains('caption'), true, view.id);
        assert.equal(selector.querySelectorAll('option').length, view.sections.length + 1, view.id);
        if (feature.identifier) assert.equal(header.textContent, feature.label + feature.identifier);
        else {
          assert.equal(header.querySelector('p'), null, view.id);
          assert.equal(header.textContent, feature.label + feature.plugin, view.id);
          assert.ok(header.querySelector('h1').textContent.includes(feature.label), view.id);
          assert.equal(header.querySelector('.identifier').textContent, feature.plugin, view.id);
          assert.equal(page.data.model.features.find(item => item.id === feature.id).description, sourceState.model.features.find(item => item.id === feature.id).description);
        }
        if (!view.svg) {
          emptyTabs++;
          assert.ok(page.get('canvas').querySelector('.empty-state'), view.id);
          assert.equal(selector.querySelectorAll('option').length, 1);
        } else {
          assert.equal(page.get('canvas').querySelector('.empty-state'), null, view.id);
          if (view.sections.length) {
            for (const index of [...new Set([view.sections.length - 1, 0])]) {
              selector.value = String(index); selector.dispatch('change');
              const section = view.sections[index], transform = canvasTransform(page);
              assert.ok(Math.abs((section.x - view.bounds.x) * transform.scale + transform.x - 18) < 1e-6, view.id);
              assert.ok(Math.abs((section.y - view.bounds.y) * transform.scale + transform.y - 18) < 1e-6, view.id);
              assert.ok(page.get('details').textContent.includes(section.label), view.id);
            }
            located++;
          }
        }
        tabs++;
      }
    }
    assert.equal(tabs, 57);
    assert.ok(emptyTabs > 0);
    assert.ok(located > 0);
    assert.deepEqual(features.map(feature => [feature.id, feature.description]), descriptions);
    page.feature('overview');
    assert.equal(page.get('feature-head').querySelector('p'), null);
    assert.equal(page.get('caption'), null);
  });

  test(`${variant} node and edge details retain full descriptions with only VS Code and copy actions`, () => {
    const page = open('?feature=session_log&tab=events&workspace=E%3A%2Fsource%20%23%25');
    const workspace = 'E:/source #%', node = page.data.registry['plugin-SessionLogPlugin'];
    page.activate(node.id);
    assert.ok(page.get('details').textContent.includes(node.description));
    assert.equal(node.description, sourceState.registry[node.id].description);
    assert.equal(page.get('feature-head').querySelector('p'), null);
    const controls = assertEditorActions(page, node.source, workspace);
    page.click(controls.copy);
    assert.equal(page.document.activeElement, controls.field);
    assert.match(page.get('details').querySelector('[data-source-copy-feedback]').textContent, /请手动复制/);
    assert.equal(controls.copy.textContent, '复制定位');
    const target = page.data.views.find(view => view.links.some(link => page.data.registry[link.id]?.description && page.data.registry[link.id]?.source));
    assert.ok(target, 'The manifest contains a sourced relationship with a complete description');
    page.feature(target.feature); page.tab(target.aspect);
    const link = page.current().links.find(item => page.data.registry[item.id]?.description && page.data.registry[item.id]?.source);
    const record = page.data.registry[link.id], edge = page.get('diagram').querySelectorAll('[data-link-id]').find(item => item.dataset.linkId === link.id);
    page.click(edge);
    assert.ok(page.get('details').textContent.includes(record.description));
    assert.equal(record.description, sourceState.registry[record.id].description);
    assertEditorActions(page, record.source, workspace);
  });

  test(`${variant} physics exposes the logging producer contract and navigates to the worker-to-file pipeline`, () => {
    const page = open('?feature=physics&tab=events&node=log-producer');
    assert.equal(page.current().nodes.find(node => node.id === 'log-producer')?.role, 'external');
    for (const id of ['physics-file-log', 'log-file-worker', 'log-console-worker']) {
      assert.equal(page.current().nodes.some(node => node.id === id), false, id + ' stays inside the logging plugin');
    }
    page.activate('log-producer');
    const producer = page.data.registry['log-producer'];
    assert.equal(page.get('details').querySelector('h2').textContent, producer.name);
    assert.ok(page.get('details').textContent.includes(producer.description));
    const owner = page.get('details').querySelector('[data-owner]');
    assert.equal(owner.dataset.owner, 'session_log');
    assert.equal(owner.dataset.target, producer.id);
    assertEditorActions(page, producer.source, 'D:/demo');
    page.click(owner);
    assert.equal(page.current().feature, 'session_log');
    assert.equal(page.current().aspect, 'events');
    assert.equal(page.current().nodes.find(node => node.id === producer.id)?.role, 'internal');
    assert.equal(page.location.searchParams.get('node'), producer.id);
    page.click(page.get('clear-selection'));
    const verify = assertNativeSelection(page);
    const link = page.current().links.find(link => link.from === 'log-file-worker' && link.to === 'physics-file-log');
    assert.ok(link, 'The real file worker writes the session log file');
    assert.equal(link.edgeSemantic, 'write');
    const edge = page.get('diagram').querySelectorAll('[data-link-id]').find(edge => edge.dataset.linkId === link.id);
    page.click(edge);
    assert.equal(edge.classList.contains('focused'), true);
    verify([link.from, link.to]);
    const endpoints = page.get('details').querySelectorAll('[data-open]');
    assert.deepEqual(endpoints.map(button => button.dataset.open), [link.from, link.to]);
    page.click(endpoints[1]);
    verify([link.to]);
    const file = page.data.registry['physics-file-log'];
    assert.equal(page.get('details').querySelector('h2').textContent, '会话日志文件');
    assert.ok(page.get('details').textContent.includes(file.description));
    assert.deepEqual(file.source, { path: 'src/session_log/lifecycle.rs', line: 105 });
    assertEditorActions(page, file.source, 'D:/demo');
    page.back();
    assert.equal(page.base().id, 'plugin-physics-events');
    assert.equal(page.get('details').querySelector('h2').textContent, producer.name);
    assert.ok(page.get('diagram').querySelectorAll('.selected').some(node => node.dataset.id === producer.id));
    page.forward();
    assert.equal(page.base().id, 'plugin-session_log-events');
    assert.equal(page.get('details').querySelector('h2').textContent, producer.name);
    const deepLink = open('?feature=session_log&tab=events&node=physics-file-log');
    assert.equal(deepLink.get('details').querySelector('h2').textContent, file.name);
    assert.ok(deepLink.get('diagram').querySelectorAll('.selected').some(node => node.dataset.id === 'physics-file-log'));
  });

  test(`${variant} page header omits removed prose and the current feature remains its single page heading`, () => {
    const page = open('?feature=character&tab=data'), header = page.document.querySelector('header');
    assert.doesNotMatch(header.textContent, /按插件理解当前架构|源码快照\s*·\s*离线文档/);
    assert.equal(header.querySelector('h1'), null);
    assert.equal(page.document.querySelectorAll('h1').length, 1);
    const heading = page.get('feature-head').querySelector('h1');
    assert.ok(heading.textContent.includes(page.data.model.features.find(item => item.id === 'character').label));
    assert.ok(heading.textContent.includes('CharacterPlugin'));
    assert.ok(header.querySelector('[data-workspace-config]'));
  });

  test(`${variant} selection transitions restore real widths across nodes, edges, Schedule endpoints and search`, () => {
    const page = open('?feature=infrastructure&tab=systems');
    const verify = assertNativeSelection(page), node = page.current().nodes[0];
    const edge = page.get('diagram').querySelector('[data-link-id]'), link = page.current().links.find(item => item.id === edge.dataset.linkId);
    const scheduleEdge = page.get('diagram').querySelector('[data-schedule-link-id]'), schedule = page.current().scheduleLinks.find(item => item.id === scheduleEdge.dataset.scheduleLinkId);
    page.activate(node.id); verify([node.id]);
    page.activate(node.id); verify([node.id]);
    page.click(edge); verify([link.from, link.to]);
    scheduleEdge.dispatch('keydown', { key: ' ' }); verify([], [schedule.from, schedule.to]);
    page.search('infrastructure');
    const hits = page.current().nodes.filter(item => JSON.stringify(page.data.registry[item.id]).toLowerCase().includes('infrastructure')).map(item => item.id);
    assert.ok(hits.length > 1);
    verify(hits);
    page.search('no-matching-architecture-node'); verify();
    page.search(''); verify();
    assertCurrentGuide(page);
    page.activate(node.id); verify([node.id]);
    page.click(page.get('clear-selection')); verify();
    assert.equal(page.get('diagram').querySelectorAll('.dim').length, 0);
    assert.equal(page.get('diagram').querySelectorAll('.focused').length, 0);
  });

  test(`${variant} external and multi-part native shapes preserve colors and dashes through pointer and keyboard selection`, () => {
    const page = open('?feature=first_person&tab=systems'), verify = assertNativeSelection(page);
    const external = page.current().nodes.find(item => item.role === 'external');
    const multiPart = page.current().nodes.find(item => ['contract', 'plugin'].includes(item.visualType) && ownShapeParts(page.get('diagram').querySelectorAll('[data-id]').find(node => node.dataset.id === item.id)).length > 1);
    assert.ok(external); assert.ok(multiPart);
    const multiPartElement = page.get('diagram').querySelectorAll('[data-id]').find(item => item.dataset.id === multiPart.id);
    assert.ok(ownShapeParts(multiPartElement).length > 1);
    const externalElement = page.get('diagram').querySelectorAll('[data-id]').find(item => item.dataset.id === external.id);
    page.document.elementFromPoint = () => externalElement.querySelector('[data-shape-part]');
    const canvas = page.get('canvas');
    canvas.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 20, clientY: 30 });
    canvas.dispatch('pointerup', { pointerId: 1, clientX: 20, clientY: 30 });
    verify([external.id]);
    multiPartElement.dispatch('keydown', { key: 'Enter' }); verify([multiPart.id]);
    multiPartElement.focus();
    page.document.elementFromPoint = () => null;
    canvas.dispatch('pointerdown', { button: 0, pointerId: 2, clientX: 5, clientY: 5 });
    canvas.dispatch('pointerup', { pointerId: 2, clientX: 5, clientY: 5 });
    verify();
    assert.equal(page.document.activeElement, canvas, 'Blank-canvas cancellation releases the old node focus');
  });

  test(`${variant} selected fill and true outer ring stay visible while zooming and fitting without moving selection`, () => {
    const page = open('?feature=infrastructure&tab=systems'), verify = assertNativeSelection(page);
    const node = page.current().nodes[0], initial = canvasTransform(page);
    page.activate(node.id); verify([node.id]);
    assert.deepEqual(canvasTransform(page), initial, 'Selecting alone does not change the camera');
    for (const control of ['zoom-out', 'zoom-out', 'zoom-in', 'readable']) {
      page.click(page.get(control)); verify([node.id]);
    }
    page.get('canvas').clientWidth = 380;
    page.get('canvas').clientHeight = 44;
    page.click(page.get('fit'));
    assert.ok(canvasTransform(page).scale < .08, 'fit uses the actual scale even below the wheel zoom floor');
    verify([node.id]);
    const selectedView = canvasTransform(page);
    page.activate(node.id); verify([node.id]);
    assert.deepEqual(canvasTransform(page), selectedView);
    page.click(page.get('clear-selection')); verify();
    assertCurrentGuide(page);
  });

  test(`${variant} node deep links regain real highlighting after tab navigation and browser history`, () => {
    const target = sourceState.views.find(item => item.feature === 'settings' && item.aspect === 'data');
    const resource = target.nodes.find(item => item.visualType === 'resource');
    const page = open('?feature=settings&tab=data&node=' + encodeURIComponent(resource.id));
    // 深链接在首次定位时已高亮，以另一份同页初始 DOM 保存原始宽度。
    const original = open('?feature=settings&tab=data');
    const expected = original.get('diagram').querySelectorAll('[data-id]').find(item => item.dataset.id === resource.id).querySelectorAll('[data-shape-part]').map(part => part.style.getPropertyValue('stroke-width'));
    const verify = () => {
      const selected = page.get('diagram').querySelectorAll('[data-id]').find(item => item.dataset.id === resource.id);
      assert.equal(selected.classList.contains('selected'), true);
      selected.querySelectorAll('[data-shape-part]').forEach((part, index) => assert.ok(Math.abs(parseFloat(part.style.getPropertyValue('stroke-width')) - parseFloat(expected[index]) - SELECTION_STYLE.strokeExtraPx / canvasTransform(page).scale) < 1e-6));
    };
    verify();
    page.tab('events');
    assert.equal(page.get('diagram').querySelectorAll('.selected').length, 0);
    page.back(); verify();
    page.click(page.get('clear-selection'));
    const restored = page.get('diagram').querySelectorAll('[data-id]').find(item => item.dataset.id === resource.id);
    assert.deepEqual(restored.querySelectorAll('[data-shape-part]').map(part => part.style.getPropertyValue('stroke-width')), expected);
    page.forward();
    assert.equal(page.current().aspect, 'events');
  });
}

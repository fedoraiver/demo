import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkArchitecture as checkArchitectureWithDependencies, checkDataSections, checkEntityGroups, checkEntityViewProjections, checkViewRouting, checkGuideSamples } from './check-ecs.mjs';
import { createDependencySourceResolver, dependencySourceKey, attachDependencySources } from './dependency-sources.mjs';
import { checkMermaidGeometry, checkSvgGeometry } from './diagram-geometry.mjs';
import { createSourceLocator } from './source-locator.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, EXTERNAL_REFERENCE_STYLE, visualTypeOf, edgeSemanticOf, displayLabelOf } from './architecture-style.mjs';
import { buildArchitectureModel, isMainPluginRegistration, scheduleGroupLabel } from './architecture-model.mjs';
import { DATA_GROUP_LABELS } from './architecture-renderer.mjs';
import { normalizeMermaidSvg } from './mermaid-compiler.mjs';
import { INFRASTRUCTURE_FEATURES, architectureViewId } from './architecture-infrastructure.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryRoot = path.join(root, 'tmp', 'architecture-check-tests');
const sharedStyles = () => ({ nodes: NODE_STYLES, edges: EDGE_STYLES, selection: SELECTION_STYLE, externalReference: EXTERNAL_REFERENCE_STYLE });
const fixtureViewCount = 1 + 3 * (1 + INFRASTRUCTURE_FEATURES.length);
const fixtureOverviewNodeCount = 2 + INFRASTRUCTURE_FEATURES.length;
const extensionFeature = INFRASTRUCTURE_FEATURES.find(feature => feature.section === 'third_party');
const checkArchitecture = directory => checkArchitectureWithDependencies(directory, { dependencyDefinitions: {}, cargoMetadata: { packages: [] }, requireDependencyDefinitions: false });

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const port = (box, side, slot = 1, count = 1) => ({ box, side, slot, count });
const box = (id, x, y, width = 100, height = 90, container = false) =>
  `<rect data-box-id="${id}" x="${x}" y="${y}" width="${width}" height="${height}"${container ? ' data-box-container="true"' : ''}/>`;
const edge = (points, source, target, arrow = true, extra = '') =>
  `<g class="edge" data-connect="move|observe" data-source-anchor="${escape(JSON.stringify(source))}" data-target-anchor="${escape(JSON.stringify(target))}"><path d="${points.map((point, index) => `${index ? 'L' : 'M'}${point.join(',')}`).join(' ')}" stroke-width="2"${arrow ? ' marker-end="url(#arrow)"' : ''} ${extra}/></g>`;
const svg = body => `<svg xmlns="http://www.w3.org/2000/svg"><defs><marker id="arrow" markerWidth="7" markerHeight="7" viewBox="0 0 10 10" orient="auto"><path d="M0,0 L10,5 L0,10"/></marker></defs>${body}</svg>`;
function checkGeometry(content) {
  // 几何反例也保存于根 tmp，失败后可以独立查看，不覆盖正式产物。
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'geometry-'));
  const filename = path.join(directory, 'fixture.svg');
  fs.writeFileSync(filename, content);
  return checkSvgGeometry(fs.readFileSync(filename, 'utf8'));
}

function fixture() {
  // 测试仅创建根 tmp 下的最小离线产物；保留副本便于检查，不修改真实图或加载游戏。
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'case-'));
  const source = 'fn move_entity() {}\nfn observe_fire() {}\n';
  const model = {
    features: [{ id: 'example', plugin: 'ExamplePlugin', label: '示例功能', description: '最小功能', contracts: [], source: { path: 'src/example.rs', line: 1 } }],
    schedule_groups: [{ id: 'Update', label: 'Update', order: 90 }],
    node_features: { 'app-main': 'infrastructure', 'plugin-ExamplePlugin': 'example', 'event-observe': 'example', 'entity-actor': 'example', 'entity-target': 'example', 'actor.Marker': 'example', 'resource.Value': 'example' },
    systems: [
      { id: 'move', module: 'example', schedule_group: 'Update', name: 'move_entity', kind: 'system', events: [], source: { path: 'src/example.rs', line: 1 } },
      { id: 'observe', module: 'example', schedule_group: 'Update', name: 'observe_fire', kind: 'observer', events: ['响应 EntityEvent：Fire<TestAction>'], source: { path: 'src/example.rs', line: 2 } },
    ],
    observers: [{ system: 'observe', event: 'Fire<TestAction>' }],
    entities: [
      { id: 'actor', name: '角色', features: ['example'], components: [{ id: 'actor.Marker', name: 'Marker' }] },
      { id: 'target', name: '目标', features: ['example'], components: [] },
    ],
    resources: [{ id: 'resource.Value', name: 'Value' }],
    relationships: [{ id: 'actor-target', from: 'actor', to: 'target', kind: 'reference', name: 'Target' }],
    system_links: [{ id: 'move-observe', from: 'move', to: 'observe', kind: 'order', label: '显式依赖' }],
  };
  const registry = Object.fromEntries(model.systems.map(system => [system.id, { ...structuredClone(system), feature: 'example' }]));
  Object.assign(registry, {
    'app-main': { id: 'app-main', name: 'App', kind: 'App', feature: 'infrastructure' },
    'plugin-ExamplePlugin': { id: 'plugin-ExamplePlugin', name: 'ExamplePlugin', kind: 'Plugin', feature: 'example' },
    'event-observe': { id: 'event-observe', schedule_group: 'Update', name: 'Fire<TestAction>', kind: 'EntityEvent', feature: 'example' },
    'entity-actor': { ...model.entities[0], id: 'entity-actor', kind: 'Entity', feature: 'example' },
    'entity-target': { ...model.entities[1], id: 'entity-target', kind: 'Entity', feature: 'example' },
    'actor.Marker': { ...model.entities[0].components[0], kind: 'Component', feature: 'example' },
    'resource.Value': { ...model.resources[0], kind: 'Resource', feature: 'example' },
  });
  for (const feature of INFRASTRUCTURE_FEATURES) {
    registry[feature.overviewNode] = { id: feature.overviewNode, name: feature.identifier, kind: 'Plugin', feature: feature.id };
    model.node_features[feature.overviewNode] = feature.id;
  }
  function makeView(id, feature, aspect, nodes = [], links = []) {
    return { id, feature, aspect, engine: 'mermaid', diagramType: 'flowchart', label: id, summary: id, width: 600, height: 600, bounds: { x: 0, y: 0, width: 600, height: 600 }, nodes: nodes.map((node, index) => ({ id: node.id || node, instance: `${id}--n${index}`, role: node.role || 'internal', mermaidId: `n${index}` })), links, layoutLinks: [], scheduleGroups: [], svg: null, filename: null, mermaid: null, mermaidFilename: null };
  }
  const views = [makeView('overview', null, 'overview', [{ id: 'app-main', role: 'external' }, { id: 'plugin-ExamplePlugin', role: 'plugin' }, ...INFRASTRUCTURE_FEATURES.map(feature => ({ id: feature.overviewNode, role: 'plugin' }))], [{ id: 'overview-dependency', from: 'app-main', to: 'plugin-ExamplePlugin', kind: 'dependency', label: '' }])];
  for (const feature of ['example', ...INFRASTRUCTURE_FEATURES.map(feature => feature.id)]) for (const aspect of ['systems', 'data', 'events']) {
    const id = architectureViewId(feature, aspect);
    if (feature === 'example' && aspect === 'systems') views.push(makeView(id, feature, aspect, ['move', 'event-observe', 'observe'], [
      { id: 'observer-observe', from: 'event-observe', to: 'observe', kind: 'trigger', label: '' },
      ...structuredClone(model.system_links),
    ]));
    else if (feature === 'example' && aspect === 'data') views.push(makeView(id, feature, aspect, ['entity-actor', 'entity-target', 'actor.Marker', 'resource.Value'], [{ id: 'actor-target', from: 'entity-actor', to: 'entity-target', kind: 'reference', label: 'Target' }]));
    else views.push(makeView(id, feature, aspect));
  }
  function render(view) {
    view.layoutLinks = [];
    view.scheduleGroups = [];
    if (!view.nodes.length) { view.svg = null; view.filename = null; view.mermaid = null; view.mermaidFilename = null; return; }
    const declarations = [];
    if (view.aspect === 'systems') view.scheduleGroups = model.schedule_groups.filter(group => view.nodes.some(node => registry[node.id].schedule_group === group.id))
      .sort((a, b) => a.order - b.order).map((group, index) => {
        const nodes = view.nodes.filter(node => registry[node.id].schedule_group === group.id).map(node => node.id);
        return { ...group, label: scheduleGroupLabel({ ...group, nodes }, registry), mermaidId: `sg${index}`, nodes };
      });
    const nodes = view.nodes.map((node, index) => {
      node.mermaidId = `n${index}`;
      node.instance = `${view.id}--${node.mermaidId}`;
      const groupIndex = view.scheduleGroups.findIndex(group => group.nodes.includes(node.id));
      const group = view.scheduleGroups[groupIndex];
      const columns = view.aspect === 'overview' ? 3 : 2;
      const x = view.aspect === 'systems' ? 150 + groupIndex * 300 : 50 + index % columns * 200, y = view.aspect === 'systems' ? 100 + group.nodes.indexOf(node.id) * 150 : 45 + Math.floor(index / columns) * 200;
      node.position = { x: x - 50, y: y - 45, width: 100, height: 90 };
      return `<g class="node" data-id="${escape(node.id)}" data-instance="${escape(node.instance)}" data-feature="${registry[node.id]?.feature}" data-role="${node.role}" data-mermaid-id="${node.mermaidId}" data-center-x="${x}" data-center-y="${y}" transform="translate(${x},${y})">${box(node.instance, -50, -45)}</g>`;
    }).join('');
    const byId = new Map(view.nodes.map(node => [node.id, node]));
    if (view.scheduleGroups.length) for (const group of view.scheduleGroups) {
      declarations.push(`subgraph ${group.mermaidId}["${escape(group.label).replaceAll('\n', '<br/>')}"]`, 'direction TB', ...group.nodes.map(id => `${byId.get(id).mermaidId}["${escape(id)}"]`), 'end');
    } else declarations.push(...view.nodes.map(node => `${node.mermaidId}["${escape(node.id)}"]`));
    const edges = view.links.map((link, index) => {
      link.mermaidId = `e${index}`;
      const from = byId.get(link.from), to = byId.get(link.to);
      declarations.push(`${from.mermaidId} ${link.mermaidId}@-->|"${escape(link.label || '')}"| ${to.mermaidId}`);
      return `<path class="edge ${link.kind}" data-edge="true" data-link-id="${escape(link.id)}" data-connect="${escape(link.from)}|${escape(link.to)}" data-mermaid-id="${link.mermaidId}" d="M${from.position.x + 100},${from.position.y + 45} C160,80 170,80 ${to.position.x},${to.position.y + 45}" marker-end="url(#arrow)"/>`;
    }).join('');
    const cluster = view.scheduleGroups.map((group, index) => `<g class="cluster" data-schedule-id="${group.id}" data-mermaid-id="${group.mermaidId}"><rect x="${index * 300}" y="0" width="250" height="590"/></g>`).join('');
    view.svg = svg(cluster + nodes + edges).replace('<svg ', '<svg viewBox="0 0 600 600" ');
    view.filename = `ecs-${view.id}.svg`;
    view.mermaid = [view.aspect === 'data' ? 'flowchart TB' : 'flowchart LR', ...declarations].join('\n') + '\n';
    view.mermaidFilename = `ecs-${view.id}.mmd`;
  }
  views.forEach(render);
  const snapshots = [{ path: 'src/example.rs', text: source }];
  const presentation = { infrastructureFeatures: structuredClone(INFRASTRUCTURE_FEATURES) };
  const diagrams = path.join(directory, 'docs', 'diagrams');
  fs.mkdirSync(diagrams, { recursive: true });
  fs.mkdirSync(path.join(directory, 'src'));
  fs.writeFileSync(path.join(directory, 'src', 'example.rs'), source);
  function save() {
    fs.writeFileSync(path.join(diagrams, 'ecs-data.json'), JSON.stringify(model));
    fs.writeFileSync(path.join(diagrams, 'ecs-architecture.html'), `<script id="architecture-data" type="application/json">${JSON.stringify({ model, registry, views, ...presentation })}</script>`);
    fs.writeFileSync(path.join(diagrams, 'ecs-source.html'), `<script id="sources" type="application/json">${JSON.stringify(snapshots)}</script>`);
    for (const view of views) if (view.filename) {
      fs.writeFileSync(path.join(diagrams, view.filename), view.svg);
      fs.writeFileSync(path.join(diagrams, view.mermaidFilename), view.mermaid);
    }
  }
  save();
  return { directory, diagrams, model, registry, views, snapshots, presentation, save, render };
}

function dependencyFixture() {
  const data = fixture();
  const dependencyRoot = path.join(data.directory, 'registry', 'fixture_dependency-1.2.3');
  fs.mkdirSync(path.join(dependencyRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dependencyRoot, 'Cargo.toml'), '[package]\nname = "fixture_dependency"\nversion = "1.2.3"\n');
  const text = '// 锁定依赖声明\npub struct FixturePlugin;\npub struct Marker;\n';
  fs.writeFileSync(path.join(dependencyRoot, 'src', 'lib.rs'), text);
  const cargoMetadata = { packages: [{ name: 'fixture_dependency', version: '1.2.3', source: 'registry+https://example.test/index', manifest_path: path.join(dependencyRoot, 'Cargo.toml') }] };
  const definition = { package: 'fixture_dependency', path: 'src/lib.rs', symbol: 'FixturePlugin', kind: 'struct' };
  const dependencyDefinitions = Object.fromEntries(INFRASTRUCTURE_FEATURES.map(feature => [feature.overviewNode, definition]));
  dependencyDefinitions['actor.Marker'] = { ...definition, symbol: 'Marker' };
  data.model.node_features['actor.Marker'] = 'avian';
  Object.assign(data.model.entities[0].components[0], { feature: 'avian', defined_in: 'avian' });
  Object.assign(data.registry['actor.Marker'], { feature: 'avian', defined_in: 'avian' });
  const resolver = createDependencySourceResolver(cargoMetadata);
  attachDependencySources(data.registry, resolver, dependencyDefinitions);
  const source = { ...structuredClone(data.registry['actor.Marker'].definition_source), line: 1 };
  data.snapshots.push({ path: dependencySourceKey(source), text, source });
  data.views.forEach(data.render);
  data.save();
  return { ...data, dependencyRoot, cargoMetadata, dependencyDefinitions, check: () => checkArchitectureWithDependencies(data.directory, { cargoMetadata, dependencyDefinitions }) };
}

function dependencyFunctionFixture() {
  const data = dependencyFixture();
  const filename = path.join(data.dependencyRoot, 'src', 'lib.rs');
  const text = fs.readFileSync(filename, 'utf8') + 'pub fn move_entity() {}\n';
  fs.writeFileSync(filename, text);
  data.snapshots[1].text = text;
  Object.assign(data.model.systems[0], { source: null, defined_in: 'infrastructure' });
  Object.assign(data.registry.move, { source: null, defined_in: 'infrastructure' });
  data.dependencyDefinitions.move = { package: 'fixture_dependency', path: 'src/lib.rs', symbol: 'move_entity', kind: 'fn' };
  attachDependencySources(data.registry, createDependencySourceResolver(data.cargoMetadata), data.dependencyDefinitions);
  data.save();
  return data;
}

function guideSamplesFixture() {
  const label = style => escape(style.legendLabel).replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const nodes = Object.fromEntries(Object.entries(NODE_STYLES).map(([type, style]) => {
    return [type, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 90" aria-label="${label(style)}" data-diagram-engine="mermaid" data-guide-kind="node" data-visual-type="${type}" data-shape="${style.shape}"><path data-guide-shape-part="true" d="M10,10 L130,10 L130,80 L10,80 Z" style="fill:${style.fill};stroke:${style.stroke};stroke-width:${style.width}px"/></svg>`];
  }));
  const edges = Object.fromEntries(Object.entries(EDGE_STYLES).map(([type, style]) => [type,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 50" aria-label="${label(style)}" data-diagram-engine="mermaid" data-guide-kind="edge" data-edge-semantic="${type}"><defs><marker id="guide-${type}-arrow" orient="auto"><path d="M0,0L8,4L0,8" fill="${style.stroke}"/></marker></defs><path data-guide-edge="true" d="M10,25H130" marker-end="url(#guide-${type}-arrow)" style="fill:none;stroke:${style.stroke};stroke-width:${style.width}px${style.dash ? `;stroke-dasharray:${style.dash}` : ''}"/></svg>`,
  ]));
  return { nodes, edges };
}

function normalizedDataFixture({ groups = ['catalog', 'relations'], nodeGroup = '原有定位' } = {}) {
  const view = { id: 'data-locator', aspect: 'data', nodes: [{ id: 'value', instance: 'data-locator--n0', mermaidId: 'n0', role: 'internal', visualType: 'component', shape: 'rect', group: nodeGroup }], links: [], scheduleLinks: [], layoutLinks: [], scheduleGroups: [] };
  const clusters = groups.map(id => `<g class="cluster" id="data-locator-${id}"${id === 'catalog' ? ' transform="translate(250,0)"' : ''}><rect x="${id === 'catalog' ? 5 : 0}" y="${id === 'catalog' ? 7 : 0}" width="200" height="100"/><g class="cluster-label"><text>${DATA_GROUP_LABELS[id]}</text></g></g>`).join('');
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 300"><g transform="translate(20,30)">${clusters}<g class="node" id="flowchart-n0-0" transform="translate(70,70)"><rect x="-50" y="-25" width="100" height="50"/><g class="label"><text>Value</text></g></g></g></svg>`;
  return normalizeMermaidSvg(view, source, { value: { name: 'Value', feature: 'example' } });
}

function entityGroupFixture() {
  const model = { entities: [{ id: 'actor', components: [{ id: 'actor.Marker' }] }] };
  const registry = { 'entity-actor': { name: '角色', kind: 'Entity', feature: 'example' }, 'actor.Marker': { name: 'Marker', kind: 'Component', feature: 'example' } };
  const view = { id: 'entity-fixture', aspect: 'data', nodes: [
    { id: 'entity-actor', instance: 'fixture--entity', mermaidId: 'n0', role: 'external', visualType: 'entity', shape: 'rect', presentation: 'entity-container' },
    { id: 'actor.Marker', instance: 'fixture--component', mermaidId: 'n1', role: 'internal', visualType: 'component', shape: 'rect' },
  ], entityGroups: [{ id: 'entity-group-actor', entity: 'entity-actor', components: ['actor.Marker'], mermaidId: 'n0', headerMermaidId: 'eh0' }], links: [], layoutLinks: [], scheduleLinks: [], scheduleGroups: [] };
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 400"><g transform="translate(20,30)"><g class="cluster" id="entity-fixture-n0" transform="translate(10,10)"><rect id="entity-outline" x="0" y="0" width="300" height="240"/><g class="cluster-label"><text> </text></g>
    <g class="node" id="flowchart-eh0-0"><g class="label"><text>角色</text></g></g>
    <g class="node" id="flowchart-n1-1" transform="translate(150,160)"><rect id="component-card" x="-60" y="-25" width="120" height="50" style="fill:#fff;stroke:#000"/><g class="label"><text>Marker</text></g></g>
  </g></g></svg>`;
  return { model, registry, source, view: normalizeMermaidSvg(view, source, registry, { clusterLabelBounds: { eh0: { x: 120, y: 60, width: 120, height: 20 } } }) };
}

test('Entity validation rejects retired expansion metadata and controls', () => {
  const ordinary = { id: 'plain', nodes: [], entityGroups: [], svg: '<svg/>' };
  assert.deepEqual(checkEntityViewProjections(ordinary), []);
  checkEntityGroups(ordinary);
  for (const extra of [{ entityViews: {} }, { entityExpansion: [] }, { parentViewId: 'old' }, { nodes: [{ entityToggle: {} }] }]) assert.throws(() => checkEntityViewProjections({ ...ordinary, ...extra }), /Obsolete Entity/);
  assert.throws(() => checkEntityGroups({ ...ordinary, entityGroups: [{ entity: 'old' }] }), /Obsolete nested/);
  assert.throws(() => checkEntityGroups({ ...ordinary, svg: '<svg data-entity-toggle="old"/>' }), /Obsolete nested/);
  assert.throws(() => checkEntityGroups({ ...ordinary, svg: '<svg><g class="node entity-container"/></svg>' }), /Obsolete nested/);
  assert.throws(() => checkEntityGroups({ ...ordinary, svg: '<svg><g data-entity-owner="old"/></svg>' }), /Obsolete nested/);
  assert.doesNotThrow(() => checkEntityGroups({ ...ordinary, svg: '<svg><style>[data-entity-owner],.entity-container{cursor:pointer}[data-entity-header].dim{opacity:.22}</style><title>data-entity-toggle is a selector name</title><g data-label="data-entity-group"/></svg>' }), 'Historical selectors and explanatory text are not obsolete Entity geometry');
});

test('all-view routing checks translated native geometry, curves and unrelated card types', () => {
  const fixture = route => ({ id: 'clearance', aspect: 'data', links: [{ id: 'route', from: 'from', to: 'to' }],
    nodes: [{ id: 'component', visualType: 'component', position: { x: 120, y: 80, width: 80, height: 60 } }],
    svg: `<svg xmlns="http://www.w3.org/2000/svg"><g data-id="component" data-instance="component"><rect data-shape-part="component" x="120" y="80" width="80" height="60"/></g><g transform="translate(100,50)"><path data-link-id="route" d="${route}"/></g></svg>` });
  assert.throws(() => checkViewRouting(fixture('M0,60 L120,60')), /Mermaid edge obstructed: clearance\/route\/component/);
  assert.throws(() => checkViewRouting(fixture('M0,0 L120,120')), /Mermaid edge obstructed/);
  assert.doesNotThrow(() => checkViewRouting(fixture('M0,10 H120')));
  assert.doesNotThrow(() => checkViewRouting(fixture('M0,10 C0,-90 120,-90 120,10')));
  assert.throws(() => checkViewRouting(fixture('M0,10 H120 V140')), /must be curved/);
  const observer = fixture('M0,60 L120,60'); observer.aspect = 'events'; observer.nodes[0].visualType = 'observer';
  assert.throws(() => checkViewRouting(observer), /Mermaid edge obstructed/);
  const endpoint = fixture('M0,60 L120,60'); endpoint.links[0].to = 'component';
  assert.doesNotThrow(() => checkViewRouting(endpoint));
});

test('overview and event Mermaid declarations use the same native curve contract as other views', () => {
  for (const aspect of ['overview', 'events']) {
    const fixture = { id: 'shared-curves', aspect, routing: { rule: 'axis-or-curve' }, mermaid: 'e0@{ curve: basis }',
      nodes: [], links: [{ id: 'route', mermaidId: 'e0', from: 'a', to: 'b' }],
      svg: '<svg><path data-link-id="route" data-mermaid-id="e0" d="M0 0C0 60 100 60 100 0"/></svg>' };
    assert.doesNotThrow(() => checkViewRouting(fixture));
    fixture.mermaid = 'e0@{ curve: rounded }';
    assert.throws(() => checkViewRouting(fixture), /Mermaid source curve mismatch/);
  }
});

test('data locators prepend actual translated containers while preserving original node groups', () => {
  const view = normalizedDataFixture();
  assert.deepEqual(view.sections, [
    { label: DATA_GROUP_LABELS.catalog, x: 275, y: 37, width: 200, height: 100 },
    { label: DATA_GROUP_LABELS.relations, x: 20, y: 30, width: 200, height: 100 },
    { label: '原有定位', x: 40, y: 75 },
  ]);
  assert.doesNotThrow(() => checkDataSections(view));
});

test('data locators appear only for existing containers and prefer real bounds over duplicate labels', () => {
  const catalogOnly = normalizedDataFixture({ groups: ['catalog'], nodeGroup: DATA_GROUP_LABELS.catalog });
  assert.deepEqual(catalogOnly.sections, [{ label: DATA_GROUP_LABELS.catalog, x: 275, y: 37, width: 200, height: 100 }]);
  assert.doesNotThrow(() => checkDataSections(catalogOnly));
  const plain = normalizedDataFixture({ groups: [] });
  assert.deepEqual(plain.sections, [{ label: '原有定位', x: 40, y: 75 }]);
  assert.doesNotThrow(() => checkDataSections(plain));
});

test('data locator checks reject missing, duplicate or inaccurate destinations and stale SVG titles', () => {
  for (const corrupt of [
    view => { view.sections.shift(); },
    view => { view.sections.push({ ...view.sections[0] }); },
    view => { view.sections[0].x += 1; },
    view => { view.sections[0].width += 1; },
  ]) {
    const view = normalizedDataFixture();
    corrupt(view);
    assert.throws(() => checkDataSections(view), /Mermaid data locator mismatch: data-locator\/catalog/);
  }
  const stale = normalizedDataFixture();
  stale.svg = stale.svg.replace(`<text>${DATA_GROUP_LABELS.catalog}</text>`, '<text>旧标题</text>');
  assert.throws(() => checkDataSections(stale), /Mermaid data container title mismatch: data-locator\/catalog/);
});

function modernView(data) {
  const view = data.views[0], declarations = ['flowchart TB', 'subgraph diagram_main[" "]', 'direction LR'];
  for (const node of view.nodes) {
    node.visualType = visualTypeOf(data.registry[node.id]);
    const style = NODE_STYLES[node.visualType];
    node.shape = style.shape;
    node.displayLabel = data.registry[node.id].name;
    declarations.push(`${node.mermaidId}@{ shape: ${node.shape}, label: "${escape(node.displayLabel)}" }`);
    const dash = node.role === 'external' ? ';stroke-dasharray:6 4' : '';
    view.svg = view.svg.replace(new RegExp(`<g class="node" data-id="${node.id}"[^>]*>.*?</g>`), group => group.replace('class="node"', `class="node" data-visual-type="${node.visualType}"`)
      .replace(/<rect[^>]*\/>/, `<rect data-shape-part="${node.instance}" x="-50" y="-45" width="100" height="90" style="fill:${style.fill};stroke:${style.stroke};stroke-width:${style.width}px${dash}"/><path data-shape-part="${node.instance}" d="M-40,-45V45 M40,-45V45" style="fill:none;stroke:${style.stroke};stroke-width:${style.width}px${dash}"/>`)
      .replace('</g>', `<g class="label"><text>${escape(node.displayLabel)}</text></g></g>`));
  }
  for (const link of view.links) {
    link.edgeSemantic = edgeSemanticOf(link, data.registry);
    link.displayLabel = displayLabelOf(link, link.edgeSemantic, data.registry);
    const style = EDGE_STYLES[link.edgeSemantic];
    declarations.push(`${view.nodes.find(node => node.id === link.from).mermaidId} ${link.mermaidId}@-->|"${escape(link.displayLabel)}"| ${view.nodes.find(node => node.id === link.to).mermaidId}`);
    view.svg = view.svg.replace(/<path class="edge [^>]+>/, tag => tag.replace(' data-link-id=', ` data-edge-semantic="${link.edgeSemantic}" style="stroke:${style.stroke};stroke-width:${style.width}px${style.dash ? `;stroke-dasharray:${style.dash}` : ''}" data-link-id=`))
      .replace('d="M0,0 L10,5 L0,10"', `d="M0,0 L10,5 L0,10" fill="${style.stroke}"`);
  }
  declarations.push('end');
  view.mermaid = declarations.join('\n') + '\n';
  view.scheduleLinks = [];
  data.presentation.styles = structuredClone(sharedStyles());
  data.presentation.guideSamples = guideSamplesFixture();
  data.save();
  return view;
}

test('accepts matching offline artifacts and reports their counts', () => {
  const data = fixture();
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
});

test('locked dependency declarations and their complete source snapshots are required alongside project sources', () => {
  const data = dependencyFixture();
  assert.deepEqual(data.check(), { systems: 2, sources: 2, views: fixtureViewCount });
  assert.equal(data.registry['actor.Marker'].definition_source.line, 3);
  for (const feature of INFRASTRUCTURE_FEATURES) assert.equal(data.registry[feature.overviewNode].definition_source.line, 2);
});

test('dependency functions use verified attached definitions when the model has no project source', () => {
  const data = dependencyFunctionFixture();
  assert.deepEqual(data.check(), { systems: 2, sources: 2, views: fixtureViewCount });
  assert.equal(data.registry.move.definition_source.dependency.name, 'fixture_dependency');
  assert.equal(data.registry.move.definition_source.line, 4);
  data.model.systems[0].definition_source = structuredClone(data.registry.move.definition_source);
  data.save();
  assert.deepEqual(data.check(), { systems: 2, sources: 2, views: fixtureViewCount });
});

test('dependency function definitions do not promote an original usage source into a declaration', () => {
  const data = dependencyFunctionFixture();
  const usage = { path: 'src/example.rs', line: 2 };
  data.model.systems[0].source = structuredClone(usage);
  data.registry.move.source = structuredClone(usage);
  data.save();
  assert.deepEqual(data.check(), { systems: 2, sources: 2, views: fixtureViewCount });
  assert.deepEqual(data.model.systems[0].source, usage);
  assert.equal(data.registry.move.definition_source.path, 'src/lib.rs');
});

test('dependency functions reject missing, wrong or unverified definitions and mismatched function names', () => {
  for (const [corrupt, expected] of [
    [data => { delete data.registry.move.definition_source; }, /Dependency definition source mismatch: move/],
    [data => { delete data.dependencyDefinitions.move; }, /Missing dependency definition: move/],
    [data => { data.registry.move.definition_source.line = 3; }, /Dependency definition source mismatch: move/],
    [data => { data.registry.move.definition_source.dependency.name = 'another_dependency'; }, /Dependency definition source mismatch: move/],
    [data => { data.registry.move.definition_source.dependency.version = '9.0.0'; }, /Dependency definition source mismatch: move/],
    [data => { data.model.systems[0].definition_source = { ...structuredClone(data.registry.move.definition_source), line: 3 }; }, /Unverified dependency function definition: move_entity/],
    [data => { data.model.systems[0].name = data.registry.move.name = 'another_function'; }, /Function source mismatch: another_function/],
  ]) {
    const data = dependencyFunctionFixture();
    corrupt(data);
    data.save();
    assert.throws(data.check, expected);
  }
});

test('project functions still require their original project declaration source', () => {
  const data = fixture();
  data.model.systems[0].source = null;
  data.registry.move.source = null;
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Missing function source: move_entity/);
});

test('dependency checks reject a missing catalog entry or definition source', () => {
  for (const corrupt of [
    data => { delete data.dependencyDefinitions['actor.Marker']; },
    data => { delete data.registry['actor.Marker'].definition_source; },
  ]) {
    const data = dependencyFixture();
    corrupt(data);
    data.save();
    assert.throws(data.check, /Missing dependency definition: actor.Marker|Dependency definition source mismatch: actor.Marker/);
  }
});

test('dependency checks reject altered version, root, path or declaration line', () => {
  for (const corrupt of [
    source => { source.line = 2; },
    source => { source.path = 'src/other.rs'; },
    source => { source.dependency.name = 'another_dependency'; },
    source => { source.dependency.version = '9.9.9'; },
    source => { source.dependency.root = path.resolve(source.dependency.root, '..').replaceAll('\\', '/'); },
  ]) {
    const data = dependencyFixture();
    corrupt(data.registry['actor.Marker'].definition_source);
    data.save();
    assert.throws(data.check, /Dependency definition source mismatch: actor.Marker/);
  }
});

test('dependency checks reject an unexpected definition on a project plugin', () => {
  const data = dependencyFixture();
  data.registry['plugin-ExamplePlugin'].definition_source = data.registry['actor.Marker'].definition_source;
  data.save();
  assert.throws(data.check, /Unexpected dependency definition source: plugin-ExamplePlugin/);
});

test('dependency snapshots reject missing entries, incomplete text and mismatched logical paths', () => {
  for (const [corrupt, expected] of [
    [data => { data.snapshots.pop(); }, /Missing source snapshot: cargo\/fixture_dependency-1.2.3\/src\/lib.rs/],
    [data => { data.snapshots[1].text = 'pub struct Marker;\n'; }, /Source snapshot mismatch: cargo\/fixture_dependency/],
    [data => { data.snapshots[1].path = 'cargo/fixture_dependency-1.2.3/src/wrong.rs'; }, /Dependency snapshot source mismatch/],
    [data => { data.snapshots[1].source.line = 2; }, /Dependency snapshot source mismatch/],
    [data => { delete data.snapshots[1].source; }, /Missing source file: cargo\/fixture_dependency/],
  ]) {
    const data = dependencyFixture();
    corrupt(data);
    data.save();
    assert.throws(data.check, expected);
  }
});

test('dependency snapshot metadata cannot escape the locked package root', () => {
  for (const [corrupt, expected] of [
    [data => { data.snapshots[1].source.dependency.root = path.resolve(data.dependencyRoot, '..').replaceAll('\\', '/'); }, /Dependency source root mismatch/],
    [data => { data.snapshots[1].source.path = '../outside.rs'; }, /Unsafe dependency source path/],
  ]) {
    const data = dependencyFixture();
    corrupt(data);
    data.save();
    assert.throws(data.check, expected);
  }
});

test('dependency declaration resolution rejects missing or ambiguous source declarations', () => {
  for (const text of ['pub struct Different;\n', 'pub struct Marker;\npub struct Marker;\n']) {
    const data = dependencyFixture();
    fs.writeFileSync(path.join(data.dependencyRoot, 'src', 'lib.rs'), text);
    assert.throws(data.check, /Expected one dependency declaration/);
  }
});

test('rejects missing or altered embedded infrastructure catalog metadata', () => {
  for (const changed of [
    undefined,
    INFRASTRUCTURE_FEATURES.slice(0, 1),
    INFRASTRUCTURE_FEATURES.map(feature => ({ ...feature, label: `${feature.label} changed` })),
    INFRASTRUCTURE_FEATURES.map(feature => ({ ...feature, overviewNode: 'wrong-entrance' })),
    INFRASTRUCTURE_FEATURES.map(feature => ({ ...feature, viewPrefix: 'wrong-prefix' })),
    INFRASTRUCTURE_FEATURES.map(feature => ({ ...feature, section: 'wrong-section' })),
  ]) {
    const data = fixture();
    data.presentation.infrastructureFeatures = changed;
    data.save();
    assert.throws(() => checkArchitecture(data.directory), /Embedded infrastructure catalog does not match the shared catalog/);
  }
});

test('requires separate engine and third-party overview entrances and all three tabs', () => {
  for (const feature of INFRASTRUCTURE_FEATURES) {
    const data = fixture();
    for (const aspect of ['systems', 'data', 'events']) {
      const view = data.views.find(item => item.id === architectureViewId(feature.id, aspect));
      assert.equal(view.feature, feature.id);
      assert.equal(view.aspect, aspect);
    }
    data.views[0].nodes = data.views[0].nodes.filter(node => node.id !== feature.overviewNode);
    data.render(data.views[0]);
    data.save();
    assert.throws(() => checkArchitecture(data.directory), new RegExp(`Infrastructure entrance is missing from overview: ${feature.id}`));
  }
});

test('the shared catalog separates four third-party libraries with canonical Plugin entrances', () => {
  const extensions = INFRASTRUCTURE_FEATURES.filter(feature => feature.section === 'third_party');
  assert.deepEqual(extensions.map(feature => feature.id), ['avian', 'enhanced_input', 'kira', 'egui']);
  assert.equal(INFRASTRUCTURE_FEATURES.length, 5);
  assert.equal(fixtureViewCount, 19);
  for (const feature of INFRASTRUCTURE_FEATURES) {
    const data = fixture();
    data.registry[feature.overviewNode].kind = 'Infrastructure catalog';
    data.save();
    assert.throws(() => checkArchitecture(data.directory), new RegExp(`Infrastructure entrance is missing from overview: ${feature.id}`));
  }
});

test('the legacy third_party route cannot become a project feature or a mixed node owner', () => {
  const reserved = fixture();
  reserved.model.features.push({ ...reserved.model.features[0], id: 'third_party', plugin: 'FakePlugin' });
  reserved.save();
  assert.throws(() => checkArchitecture(reserved.directory), /Invalid or duplicate architecture feature: third_party/);
  const mixedOwner = fixture();
  mixedOwner.registry['resource.Value'].feature = 'third_party';
  mixedOwner.save();
  assert.throws(() => checkArchitecture(mixedOwner.directory), /Invalid node feature: resource.Value/);
});

test('explicit system ownership takes precedence over the project module fallback', () => {
  const data = fixture();
  data.model.systems[0].feature = extensionFeature.id;
  data.registry.move.feature = extensionFeature.id;
  data.views[1].nodes.find(node => node.id === 'move').role = 'external';
  const thirdParty = data.views.find(item => item.id === architectureViewId(extensionFeature.id, 'systems'));
  thirdParty.nodes.push({ id: 'move', role: 'internal' });
  data.render(data.views[1]);
  data.render(thirdParty);
  data.save();
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
  data.model.systems[0].feature = 'infrastructure';
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /System feature mismatch: move/);
  data.model.systems[0].feature = 'unknown';
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /System feature mismatch: move/);
});

test('maintained infrastructure ownership distinguishes Bevy, extensions and project payloads', () => {
  const model = JSON.parse(fs.readFileSync(path.join(root, 'docs/diagrams/ecs-data.json'), 'utf8'));
  const { registry } = buildArchitectureModel(model);
  const expected = {
    infrastructure: ['plugin-DefaultPlugins', 'app-main', 'input_update', 'resource.TimeFixed', 'resource.ButtonInputKeyCode', 'resource.KeyboardInputMessages', 'resource.WindowFocusedMessages', 'character.Transform', 'camera.Camera3d', 'native_pointer_events', 'native_update_hovered', 'native_button_down', 'plugin-UiWidgetsPlugins', 'plugin-DefaultPickingPlugins'],
    avian: ['physics_prepare', 'physics_step', 'physics_writeback', 'resource.TimePhysics', 'resource.CollisionStartMessages', 'physics-messages', 'character.RigidBody', 'character.Collider', 'easing_start', 'character.TranslationInterpolation', 'parcel.TransformInterpolation', 'resource.LastPhysicsTick', 'character.SpeculativeCcd', 'parcel.SpeculativeCcd'],
    enhanced_input: ['plugin-EnhancedInputPlugin', 'enhanced_prepare', 'enhanced_evaluate', 'input_apply', 'input_trigger', 'resource.ActionSources', 'controller.Actions', 'action.ActionOf'],
    kira: ['plugin-kira', 'resource.AudioSources', 'resource.AudioInstances', 'kira-output'],
    egui: ['egui_input', 'egui_begin', 'camera.EguiContext', 'resource.EguiGlobalSettings', 'plugin-inspector-0', 'plugin-inspector-1', 'inspector_pass'],
    first_person: ['event-observe_move', 'event-observe_look'],
    ui: ['event-observe_menu_previous', 'event-observe_menu_confirm', 'event_apply'],
    physics: ['wake_changed_bodies', 'wake_apply'],
    audio: ['audio-output', 'audio-system-sets'],
    window_policy: ['native-window-events'],
  };
  for (const [feature, ids] of Object.entries(expected)) {
    for (const id of ids) assert.equal(registry[id]?.feature, feature, id);
  }
  for (const id of ['resource.CollisionStartMessages', 'resource.CollisionEndMessages', 'resource.TimePhysics', 'resource.AudioSources', 'resource.AudioInstances', 'resource.AudioLoadFailures']) {
    assert.equal(registry[id].feature, id.startsWith('resource.Audio') ? 'kira' : 'avian', id);
    assert.equal(registry[id].defined_in, 'infrastructure', `${id}: Bevy container definition`);
  }
  assert.equal(model.features.length, 14);
  for (const [feature, count] of Object.entries({ avian: 103, enhanced_input: 35, kira: 6, egui: 13 })) {
    assert.equal(Object.values(registry).filter(node => node.feature === feature && !node.alias_of).length, count, feature);
  }
  for (const id of ['wake_apply', 'event_apply']) assert.equal(registry[id].defined_in, 'infrastructure', id);
  assert.equal(registry['resource.EnableMultipassForPrimaryContext'], undefined);
  assert.equal(registry['third-party-plugins'], undefined);
});

test('only the sixteen plugin registrations from main are hidden', () => {
  const model = JSON.parse(fs.readFileSync(path.join(root, 'docs/diagrams/ecs-data.json'), 'utf8'));
  const registry = Object.fromEntries(model.nodes.map(node => [node.id, node]));
  const hidden = model.system_links.filter(link => isMainPluginRegistration(link, registry));
  assert.equal(model.features.length, 14);
  assert.equal(hidden.length, 16);
  assert.deepEqual(new Set(hidden.map(link => registry[link.to].name)), new Set([...model.features.map(feature => feature.plugin), 'DefaultPlugins', 'EnhancedInputPlugin']));
  const link = hidden[0];
  for (const changed of [
    { ...link, kind: 'dependency' },
    { ...link, kind: 'write' },
    { ...link, from: link.to, to: 'app-main' },
    { ...link, from: 'other-app' },
    { ...link, to: 'log-file-worker' },
    { ...link, to: 'missing-plugin' },
  ]) assert.equal(isMainPluginRegistration(changed, registry), false, changed.id);
  assert.equal(isMainPluginRegistration(link, { ...registry, [link.to]: { ...registry[link.to], kind: 'Resource' } }), false);
  for (const changed of [
    { ...registry[link.to], feature: 'infrastructure' },
    { ...registry[link.to], name: 'DifferentPlugin' },
  ]) assert.equal(isMainPluginRegistration(link, { ...registry, [link.to]: changed }), true);
});

test('hidden main plugin registrations remain valid model links without visual entrances', () => {
  const data = fixture();
  data.registry['third-party'] = { id: 'third-party', name: 'DefaultPlugins', kind: 'Plugin', feature: 'infrastructure' };
  data.model.system_links.push(
    { id: 'install-example', from: 'app-main', to: 'plugin-ExamplePlugin', kind: 'registration' },
    { id: 'install-third-party', from: 'app-main', to: 'third-party', kind: 'registration' },
  );
  data.save();
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
  for (const id of ['install-example', 'install-third-party']) {
    assert.equal(data.model.system_links.some(link => link.id === id), true);
    assert.equal(data.views.some(view => view.links.some(link => link.id === id)), false);
  }
});

test('rejects main plugin registrations accidentally retained in any business view', () => {
  for (const target of ['plugin-ExamplePlugin', 'third-party']) {
    const data = fixture();
    if (target === 'third-party') {
      data.registry[target] = { id: target, name: 'EnhancedInputPlugin', kind: 'Plugin', feature: 'infrastructure' };
      data.views[0].nodes.push({ id: target, role: 'external' });
    }
    data.views[0].links.push({ id: 'install-plugin', from: 'app-main', to: target, kind: 'registration' });
    data.render(data.views[0]);
    data.save();
    assert.throws(() => checkArchitecture(data.directory), /Redundant main plugin registration remains in overview: install-plugin/);
  }
});

test('hidden registrations still require unique model IDs and existing endpoints', () => {
  const duplicate = fixture();
  const link = { id: 'install-example', from: 'app-main', to: 'plugin-ExamplePlugin', kind: 'registration' };
  duplicate.model.system_links.push(link, { ...link });
  duplicate.save();
  assert.throws(() => checkArchitecture(duplicate.directory), /Invalid or duplicate system link: install-example/);
  const unknown = fixture();
  unknown.model.system_links.push({ ...link, to: 'missing-plugin' });
  unknown.save();
  assert.throws(() => checkArchitecture(unknown.directory), /Unknown system link endpoint: install-example/);
});

test('non-registration cooperation and plugin-owned third-party assembly still require visible entrances', () => {
  for (const [kind, from, to] of [
    ['dependency', 'app-main', 'plugin-ExamplePlugin'],
    ['registration', 'app-main', 'resource.Value'],
    ['registration', 'plugin-ExamplePlugin', 'third-party'],
    ['write', 'app-main', 'log-file-worker'],
  ]) {
    const data = fixture();
    data.registry['third-party'] = { id: 'third-party', name: 'FrameworkPlugin', kind: 'Plugin', feature: 'infrastructure' };
    data.registry['log-file-worker'] = { id: 'log-file-worker', name: 'File worker', kind: 'External I/O', feature: 'example' };
    data.model.system_links.push({ id: 'preserve-cooperation', from, to, kind });
    data.save();
    assert.throws(() => checkArchitecture(data.directory), /System link is missing from views: preserve-cooperation/, `${kind}: ${from} → ${to}`);
  }
});

test('accepts explicit Mermaid business shapes with an independent sidebar guide library', () => {
  const data = fixture(), view = modernView(data);
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
  assert.deepEqual(checkMermaidGeometry(view.svg, view), { nodes: fixtureOverviewNodeCount, edges: 1, layoutEdges: 0, scheduleEdges: 0, scheduleGroups: 0 });
  view.mermaid += 'rogue@{ shape: rect, label: "未收录节点" }\n';
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Mermaid node declaration count mismatch/);
});

test('checks node styles against actual native shape appearance and preserves external type fill', () => {
  const data = fixture(), view = modernView(data);
  const corrupted = view.svg.replace(`fill:${NODE_STYLES.plugin.fill}`, 'fill:#FFFFFF');
  assert.notEqual(corrupted, view.svg, 'The fixture must actually corrupt the current plugin fill');
  view.svg = corrupted;
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Mermaid node appearance mismatch: app-main/);
  const external = fixture(), target = modernView(external);
  target.svg = target.svg.replace('stroke-dasharray:6 4', 'stroke-dasharray:2 2');
  external.save();
  assert.throws(() => checkArchitecture(external.directory), /Mermaid node appearance mismatch: app-main/);
});

test('requires the source shape, actual node label and visual type to agree', () => {
  const shape = fixture(), first = modernView(shape);
  first.mermaid = first.mermaid.replace('shape: fr-rect', 'shape: cyl');
  shape.save();
  assert.throws(() => checkArchitecture(shape.directory), /Mermaid node style or label mismatch: app-main/);
  const label = fixture(), second = modernView(label);
  second.svg = second.svg.replace('<text>App</text>', '<text>System App</text>');
  label.save();
  assert.throws(() => checkArchitecture(label.directory), /Mermaid rendered node label mismatch: app-main/);
  const swallowed = fixture(), third = modernView(swallowed);
  third.svg = third.svg.replace('<g class="label"><text>App</text></g>', '<title>App</title><g class="label"><text></text></g>');
  swallowed.save();
  assert.throws(() => checkArchitecture(swallowed.directory), /Mermaid rendered node label mismatch: app-main/);
});

test('checks actual edge dashes and target arrow color rather than trusting semantic metadata', () => {
  const data = fixture(), view = modernView(data);
  view.svg = view.svg.replace('stroke:#64748B;stroke-width:1.5px;stroke-dasharray:10 5', 'stroke:#64748B;stroke-width:1.5px;stroke-dasharray:2 2');
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Mermaid edge style mismatch: overview-dependency/);
  const marker = fixture(), other = modernView(marker);
  other.svg = other.svg.replace('fill="#64748B"', 'fill="#000000"');
  marker.save();
  assert.throws(() => checkArchitecture(marker.directory), /Mermaid arrow color mismatch: overview-dependency/);
});

test('business views reject retained legend manifests, declarations and compiled geometry', () => {
  const metadata = fixture(), first = modernView(metadata);
  first.legend = {};
  metadata.save();
  assert.throws(() => checkArchitecture(metadata.directory), /Legend metadata remains in business view/);
  const source = fixture(), second = modernView(source);
  second.mermaid += 'subgraph legend["图例"]\nend\n';
  source.save();
  assert.throws(() => checkArchitecture(source.directory), /Legend declaration remains in business Mermaid/);
  const geometry = fixture(), third = modernView(geometry);
  third.svg = third.svg.replace('</svg>', '<g data-legend-node="legend_node_0"/></svg>');
  geometry.save();
  assert.throws(() => checkArchitecture(geometry.directory), /Legend geometry remains in business SVG/);
});

test('modern style and visible label checks remain mandatory without a view legend', () => {
  const data = fixture(), view = modernView(data);
  assert.equal(Object.hasOwn(view, 'legend'), false);
  view.nodes[0].visualType = 'system';
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Mermaid node style or label mismatch: app-main/);
  const missing = fixture();
  modernView(missing);
  delete missing.presentation.guideSamples;
  missing.save();
  assert.throws(() => checkArchitecture(missing.directory), /Read guide sample catalog mismatch/);
});

test('sidebar guide samples cover the central catalog with one ordinary sample per node type', () => {
  const samples = guideSamplesFixture(), styles = structuredClone(sharedStyles());
  assert.doesNotThrow(() => checkGuideSamples(samples, styles));
  samples.nodes.component = { normal: samples.nodes.component, external: samples.nodes.component };
  assert.throws(() => checkGuideSamples(samples, styles), /Missing read guide sample: node\/component/);
  const missing = guideSamplesFixture();
  delete missing.edges.read;
  assert.throws(() => checkGuideSamples(missing, styles), /Read guide sample catalog mismatch/);
  styles.nodes.resource.fill = '#FFFFFF';
  assert.throws(() => checkGuideSamples(guideSamplesFixture(), styles), /Read guide styles do not match the shared catalog/);
  for (const field of ['selection', 'externalReference']) {
    const incomplete = structuredClone(sharedStyles());
    delete incomplete[field];
    assert.throws(() => checkGuideSamples(guideSamplesFixture(), incomplete), /Read guide styles do not match the shared catalog/);
  }
});

test('sidebar node samples preserve native fill, shape identity and an ordinary outline', () => {
  const styles = sharedStyles(), fill = guideSamplesFixture();
  const corrupted = fill.nodes.resource.replace(`fill:${NODE_STYLES.resource.fill}`, 'fill:#FFFFFF');
  assert.notEqual(corrupted, fill.nodes.resource, 'The fixture must actually corrupt the current resource fill');
  fill.nodes.resource = corrupted;
  assert.throws(() => checkGuideSamples(fill, styles), /Mermaid node appearance mismatch: guide\/node\/resource/);
  const outline = guideSamplesFixture();
  outline.nodes.system = outline.nodes.system.replace('stroke-width:', 'stroke-dasharray:6 4;stroke-width:');
  assert.throws(() => checkGuideSamples(outline, styles), /Mermaid node appearance mismatch: guide\/node\/system/);
  const shape = guideSamplesFixture();
  shape.nodes.resource = shape.nodes.resource.replace('data-shape="cyl"', 'data-shape="rect"');
  assert.throws(() => checkGuideSamples(shape, styles), /Read guide sample identity mismatch: node\/resource/);
  const obsolete = guideSamplesFixture();
  obsolete.nodes.system = obsolete.nodes.system.replace('data-shape=', 'data-guide-variant="normal" data-shape=');
  assert.throws(() => checkGuideSamples(obsolete, styles), /Read guide sample identity mismatch: node\/system/);
});

test('sidebar accessible labels must match the independent English legend vocabulary', () => {
  for (const [catalog, type, kind, legacyLabel] of [
    ['nodes', 'component', 'node', NODE_STYLES.component.label],
    ['edges', 'publish', 'edge', EDGE_STYLES.publish.label],
  ]) {
    const expectedError = new RegExp(`Read guide accessible label mismatch: ${kind}/${type}`);
    for (const value of [legacyLabel, 'Unrelated English label', null]) {
      const samples = guideSamplesFixture();
      samples[catalog][type] = samples[catalog][type].replace(/\baria-label="[^"]*"/, value === null ? '' : `aria-label="${escape(value)}"`);
      assert.throws(() => checkGuideSamples(samples, sharedStyles()), expectedError);
    }
    const styles = structuredClone(sharedStyles());
    delete styles[catalog][type].legendLabel;
    assert.throws(() => checkGuideSamples(guideSamplesFixture(), styles), /Read guide styles do not match the shared catalog/);
  }
});

test('sidebar edge samples validate actual line style and marker color', () => {
  const styles = sharedStyles(), line = guideSamplesFixture();
  line.edges.read = line.edges.read.replace('stroke-dasharray:6 4', 'stroke-dasharray:2 2');
  assert.throws(() => checkGuideSamples(line, styles), /Mermaid edge style mismatch: guide\/edge\/read/);
  const arrow = guideSamplesFixture();
  arrow.edges.order = arrow.edges.order.replace('fill="#334155"', 'fill="#FFFFFF"');
  assert.throws(() => checkGuideSamples(arrow, styles), /Mermaid arrow color mismatch: guide\/edge\/order/);
});

test('sidebar samples cannot retain business identities or clip their native geometry', () => {
  const styles = sharedStyles(), leaked = guideSamplesFixture();
  leaked.nodes.system = leaked.nodes.system.replace('data-guide-shape-part=', 'data-id="move" data-guide-shape-part=');
  assert.throws(() => checkGuideSamples(leaked, styles), /Business identity leaked into read guide: node\/system/);
  const clipped = guideSamplesFixture();
  clipped.nodes.system = clipped.nodes.system.replace('M10,10', 'M-10,10');
  assert.throws(() => checkGuideSamples(clipped, styles), /Read guide geometry is outside its viewBox: node\/system/);
  const missing = guideSamplesFixture();
  missing.nodes.system = missing.nodes.system.replace('data-guide-shape-part="true"', 'data-old-part="true"');
  assert.throws(() => checkGuideSamples(missing, styles), /Missing native Mermaid node outline: guide\/node\/system/);
  const duplicate = guideSamplesFixture();
  duplicate.nodes.system = duplicate.nodes.system.replace('<svg ', '<svg id="shared-guide-id" ');
  duplicate.nodes.contract = duplicate.nodes.contract.replace('<svg ', '<svg id="shared-guide-id" ');
  assert.throws(() => checkGuideSamples(duplicate, styles), /Duplicate read guide SVG ID: shared-guide-id/);
});

test('accepts CRLF and LF source differences without ignoring other text changes', () => {
  const data = fixture();
  const sourceFile = path.join(data.directory, 'src', 'example.rs');
  // 覆盖 Git 的 LF 快照与 Windows 的 CRLF 工作区，以及相反的换行组合。
  fs.writeFileSync(sourceFile, data.snapshots[0].text.replace(/\n/g, '\r\n'));
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
  fs.writeFileSync(sourceFile, data.snapshots[0].text);
  data.snapshots[0].text = data.snapshots[0].text.replace(/\n/g, '\r\n');
  data.save();
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
  data.snapshots[0].text = data.snapshots[0].text.replace('fn move_entity', 'fn  move_entity');
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Source snapshot mismatch: src\/example.rs/);
});

test('rejects a newly listed system omitted from every diagram', () => {
  const data = fixture();
  const system = { ...structuredClone(data.model.systems[0]), id: 'move-update' };
  data.model.systems.push(system);
  data.registry[system.id] = { ...system, feature: 'example' };
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /System is missing from views: move-update/);
});

test('rejects a valid line number pointing at the wrong function', () => {
  const data = fixture();
  data.model.systems[0].source.line = 2;
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Function source mismatch: move_entity/);
});

test('rejects source lines outside the file', () => {
  const data = fixture();
  data.model.systems[0].source.line = 100;
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Invalid source line: src\/example.rs:100/);
});

test('rejects an outdated embedded source snapshot', () => {
  const data = fixture();
  data.snapshots[0].text += '// outdated\n';
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Source snapshot mismatch: src\/example.rs/);
});

test('rejects source paths that escape the fixture repository', () => {
  const data = fixture();
  data.model.systems[0].source.path = '../outside.rs';
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Unsafe source path/);
});

test('rejects unknown diagram connection endpoints', () => {
  const data = fixture();
  data.views[0].svg = data.views[0].svg.replace('app-main|plugin-ExamplePlugin', 'app-main|deleted');
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Unknown connection reference in overview: deleted/);
});

test('rejects an observer registered with a different event', () => {
  const data = fixture();
  data.model.observers[0].event = 'Fire<OtherAction>';
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Observer event mismatch: observe/);
});

test('rejects stale standalone SVG content', () => {
  const data = fixture();
  fs.appendFileSync(path.join(data.diagrams, 'ecs-overview.svg'), '\n');
  assert.throws(() => checkArchitecture(data.directory), /SVG artifact mismatch: overview/);
});

test('preserves empty tabs in the manifest without producing placeholder SVG files', () => {
  const data = fixture();
  assert.equal(data.views.length, fixtureViewCount);
  assert.equal(data.views.filter(view => view.svg === null).length, fixtureViewCount - 3);
  assert.equal(fs.readdirSync(data.diagrams).filter(filename => filename.endsWith('.svg')).length, 3);
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
});

test('rejects a stale global SVG outside the dynamic artifact manifest', () => {
  const data = fixture();
  fs.writeFileSync(path.join(data.diagrams, 'ecs-schedules.svg'), svg(''));
  assert.throws(() => checkArchitecture(data.directory), /SVG file set does not match view manifest/);
});

test('rejects missing tabs and view metadata assigned to another feature', () => {
  const missing = fixture();
  missing.views.pop();
  missing.save();
  assert.throws(() => checkArchitecture(missing.directory), new RegExp(`Expected ${fixtureViewCount} architecture views`));
  const mismatched = fixture();
  mismatched.views[1].feature = 'infrastructure';
  mismatched.save();
  assert.throws(() => checkArchitecture(mismatched.directory), /Architecture view metadata mismatch/);
});

test('rejects a supposedly empty view that retains graph nodes', () => {
  const data = fixture();
  data.views[1].svg = null;
  data.views[1].filename = null;
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Invalid empty architecture view/);
});

test('rejects duplicate features and an overview that omits its plugin entrance', () => {
  const duplicate = fixture();
  duplicate.model.features.push(structuredClone(duplicate.model.features[0]));
  duplicate.save();
  assert.throws(() => checkArchitecture(duplicate.directory), /Invalid or duplicate architecture feature: example/);
  const missing = fixture();
  missing.views[0].nodes[1].role = 'external';
  missing.render(missing.views[0]);
  missing.save();
  assert.throws(() => checkArchitecture(missing.directory), /Plugin is missing from overview: ExamplePlugin/);
});

test('rejects a registry owner that disagrees with the maintained ownership map', () => {
  const data = fixture();
  data.registry['resource.Value'].feature = 'infrastructure';
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Node feature mismatch: resource.Value/);
});

test('preserves declared container definitions independently of browsing ownership', () => {
  const data = fixture();
  data.model.resources[0].defined_in = 'infrastructure';
  data.registry['resource.Value'].defined_in = 'infrastructure';
  data.save();
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
  data.registry['resource.Value'].defined_in = extensionFeature.id;
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Type definition ownership mismatch: resource.Value/);
});

test('foreign systems may appear as external references but cannot become local implementation', () => {
  const data = fixture();
  const view = data.views.find(item => item.id === 'infrastructure-systems');
  view.nodes.push({ id: 'move', instance: 'infrastructure-move-reference', role: 'external' });
  data.render(view);
  data.save();
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
  view.nodes[0].role = 'internal';
  data.render(view);
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Foreign internal node in infrastructure-systems: move/);
});

test('entity composition projections preserve canonical data ownership', () => {
  const data = fixture();
  const view = data.views.find(item => item.id === 'infrastructure-data');
  view.nodes.push({ id: 'entity-actor', instance: 'infrastructure-actor-projection', role: 'internal' }, { id: 'actor.Marker', instance: 'infrastructure-marker-projection', role: 'internal' });
  data.model.entities[0].features.push('infrastructure');
  data.render(view);
  data.save();
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
  assert.equal(data.registry['actor.Marker'].feature, 'example');
  data.model.entities[0].features.pop();
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Foreign internal node in infrastructure-data: entity-actor/);
});

test('each Mermaid view declares a canonical node once and may not reuse a visual instance', () => {
  const data = fixture();
  const view = data.views[1];
  assert.equal(view.nodes.filter(node => node.id === 'observe').length, 1);
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
  view.nodes[2].instance = view.nodes[1].instance;
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Invalid or duplicate visual instance/);
  const repeated = fixture();
  repeated.views[1].nodes.push({ id: 'observe', instance: 'distinct-instance', role: 'internal' });
  repeated.render(repeated.views[1]);
  repeated.save();
  assert.throws(() => checkArchitecture(repeated.directory), /Duplicate canonical node/);
});

test('checks actual SVG role and ownership against canonical metadata', () => {
  const data = fixture();
  data.views[1].svg = data.views[1].svg.replace('data-feature="example"', 'data-feature="infrastructure"');
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Visual node metadata mismatch/);
});

test('external references cannot replace the only internal system registration', () => {
  const data = fixture();
  const view = data.views[1];
  view.nodes.find(node => node.id === 'move').role = 'external';
  data.render(view);
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /System has no internal view: move/);
});

test('rejects an unrendered entity component even if it remains in the registry', () => {
  const data = fixture();
  const view = data.views[2];
  view.nodes = view.nodes.filter(node => node.id !== 'actor.Marker');
  data.render(view);
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Data node has no internal view or component type projection: actor.Marker/);
});

test('checks typed link identity against the actual Mermaid declarations', () => {
  const data = fixture();
  const view = data.views[1];
  Object.assign(view.links[0], { from: 'observe', to: 'event-observe' });
  view.svg = view.svg.replace('event-observe|observe', 'observe|event-observe');
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Mermaid edge declaration mismatch/);
});

test('rejects changed visual link types even when endpoint metadata still agrees', () => {
  const data = fixture();
  data.views[1].svg = data.views[1].svg.replace('class="edge order"', 'class="edge write"');
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Visual link metadata mismatch/);
});

test('requires maintained entity relationships and system links to remain visible with their types', () => {
  const missing = fixture();
  missing.views[2].links = [];
  missing.render(missing.views[2]);
  missing.save();
  assert.throws(() => checkArchitecture(missing.directory), /Entity relationship is missing from views: actor-target/);
  const changed = fixture();
  changed.model.system_links[0].kind = 'write';
  changed.save();
  assert.throws(() => checkArchitecture(changed.directory), /System link metadata mismatch: move-observe/);
});

test('requires observer trigger cards to name the actual registered event', () => {
  const data = fixture();
  data.registry['event-observe'].name = 'Fire<OtherAction>';
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Observer trigger is missing from views: observe/);
});

test('requires every delivered view to use Mermaid and its disk source to match', () => {
  const engine = fixture();
  engine.views[0].engine = 'custom-svg';
  engine.save();
  assert.throws(() => checkArchitecture(engine.directory), /Architecture view must use Mermaid: overview/);
  const stale = fixture();
  fs.appendFileSync(path.join(stale.diagrams, 'ecs-overview.mmd'), '%% outdated\n');
  assert.throws(() => checkArchitecture(stale.directory), /Mermaid source artifact mismatch: overview/);
  const extra = fixture();
  fs.writeFileSync(path.join(extra.diagrams, 'ecs-removed.mmd'), 'flowchart LR\n');
  assert.throws(() => checkArchitecture(extra.directory), /Mermaid file set does not match view manifest/);
});

test('checks the actual Mermaid declaration set rather than trusting a node manifest', () => {
  const data = fixture();
  data.views[0].mermaid += 'rogue["unlisted node"]\n';
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Mermaid node declaration count mismatch/);
});

test('native Mermaid edge data-id attributes must not masquerade as canonical nodes', () => {
  const data = fixture();
  data.views[0].svg = data.views[0].svg.replace('data-link-id=', 'data-id="e0" data-link-id=');
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Invalid or duplicate visual instance/);
});

test('accepts Mermaid curves without imposing the old hand-routed port rules', () => {
  const data = fixture();
  assert.deepEqual(checkMermaidGeometry(data.views[1].svg, data.views[1]), { nodes: 3, edges: 2, layoutEdges: 0, scheduleEdges: 0, scheduleGroups: 1 });
  const view = data.views[0];
  view.bounds.x = -20;
  view.bounds.y = -10;
  view.svg = view.svg.replace('viewBox="0 0 600 600"', 'viewBox="-20 -10 600 600"');
  assert.deepEqual(checkMermaidGeometry(view.svg, view), { nodes: fixtureOverviewNodeCount, edges: 1, layoutEdges: 0, scheduleEdges: 0, scheduleGroups: 0 });
});

test('derives Mermaid node bounds from the actual rectangle and ancestor transforms', () => {
  const data = fixture();
  const view = data.views[0];
  view.svg = view.svg.replace('</defs>', '</defs><g transform="translate(20 30)">').replace('</svg>', '</g></svg>')
    .replace(/data-center-x="(\d+)"/g, (_, value) => `data-center-x="${Number(value) + 20}"`)
    .replace(/data-center-y="(\d+)"/g, (_, value) => `data-center-y="${Number(value) + 30}"`);
  view.nodes.forEach(node => { node.position.x += 20; node.position.y += 30; });
  assert.deepEqual(checkMermaidGeometry(view.svg, view), { nodes: fixtureOverviewNodeCount, edges: 1, layoutEdges: 0, scheduleEdges: 0, scheduleGroups: 0 });
  view.nodes[0].position.x -= 20;
  assert.throws(() => checkMermaidGeometry(view.svg, view), /Mermaid node position mismatch/);
});

test('rejects a Mermaid node clipped by the actual SVG viewport', () => {
  const view = fixture().views[0];
  view.width = view.bounds.width = 250;
  view.svg = view.svg.replace('viewBox="0 0 600 600"', 'viewBox="0 0 250 600"');
  assert.throws(() => checkMermaidGeometry(view.svg, view), /Mermaid node is outside the SVG viewport: plugin-ExamplePlugin/);
});

test('rejects overlapping Mermaid node rectangles even when positions match their metadata', () => {
  const view = fixture().views[0];
  view.nodes[1].position.x = 95;
  view.svg = view.svg.replace(/<g class="node" data-id="plugin-ExamplePlugin"[^>]*>/, value => value
    .replace('data-center-x="250"', 'data-center-x="145"').replace('translate(250,45)', 'translate(145,45)'));
  assert.throws(() => checkMermaidGeometry(view.svg, view), /Mermaid node rectangles overlap: app-main \/ plugin-ExamplePlugin/);
});

test('layout-only Mermaid edges remain separate from semantic relationships and must be declared', () => {
  const data = fixture();
  const view = data.views[0];
  view.layoutLinks.push({ mermaidId: 'layout_0', from: 'n0', to: 'n1' });
  view.mermaid += 'n0 layout_0@~~~ n1\n';
  view.svg = view.svg.replace('</svg>', '<path data-edge="true" data-layout-link="layout_0" d="M50,45 Q100,10 200,45"/></svg>');
  data.save();
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
  view.mermaid = view.mermaid.replace('n0 layout_0@~~~ n1\n', '');
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Mermaid layout edge declaration count mismatch/);
});

test('directed layout constraints are permitted only as explicitly declared invisible paths', () => {
  const data = fixture(), view = data.views[0];
  view.layoutLinks.push({ mermaidId: 'layout_0', from: 'n0', to: 'n1', directed: true });
  view.mermaid += 'n0 layout_0@--> n1\n';
  view.svg = view.svg.replace('</svg>', '<path data-edge="true" data-layout-link="layout_0" d="M50,45L200,45" style="opacity:0;stroke:transparent;stroke-width:0px"/></svg>');
  data.save();
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
  const visible = view.svg.replace('opacity:0;stroke:transparent;stroke-width:0px', 'opacity:1;stroke:#000;stroke-width:2px');
  assert.throws(() => checkMermaidGeometry(visible, view), /Directed Mermaid layout edge must be invisible/);
  delete view.layoutLinks[0].directed;
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Mermaid layout edge declaration mismatch/);
});

test('rejects Mermaid edge paths with missing coordinates or unidentified semantic edges', () => {
  const data = fixture();
  const view = data.views[0];
  assert.throws(() => checkMermaidGeometry(view.svg.replace('C160,80 170,80', 'C160,80'), view), /Invalid Mermaid edge coordinates/);
  const unknown = view.svg.replace('</svg>', '<path data-edge="true" d="M0,0 L20,30"/></svg>');
  assert.throws(() => checkMermaidGeometry(unknown, view), /Unidentified Mermaid edge path/);
});

function twoSchedules() {
  const data = fixture();
  data.model.schedule_groups.push({ id: 'PostUpdate', label: 'PostUpdate', order: 110 });
  const system = { ...structuredClone(data.model.systems[0]), id: 'after', schedule_group: 'PostUpdate' };
  data.model.systems.push(system);
  data.registry.after = { ...system, feature: 'example' };
  data.views[1].nodes.push({ id: 'after', role: 'internal' });
  data.render(data.views[1]);
  data.save();
  return data;
}

function stateSchedules() {
  const data = fixture();
  data.model.schedule_groups[0] = { id: 'StateTransition', label: '状态入口', order: 30 };
  for (const node of [data.registry.move, data.registry.observe, data.registry['event-observe'], ...data.model.systems]) node.schedule_group = 'StateTransition';
  const registrations = [
    { scope: 'runtime', schedule: 'OnEnter(AppState::MainMenu)' },
    { scope: 'runtime', schedule: 'OnExit(AppState::InGame)' },
    { scope: 'runtime', schedule: 'OnTransition { exited: AppState::MainMenu, entered: AppState::InGame }' },
    { scope: 'runtime', schedule: 'OnExit(AppState::InGame)' },
    { scope: 'headless-test', schedule: 'Startup' },
  ];
  data.model.systems[0].registrations = structuredClone(registrations);
  data.registry.move.registrations = structuredClone(registrations);
  data.render(data.views[1]);
  data.save();
  return data;
}

test('Schedule title checks derive unique runtime state Schedule types without changing group identity', () => {
  const data = stateSchedules(), group = data.views[1].scheduleGroups[0];
  assert.equal(group.id, 'StateTransition');
  assert.deepEqual(group.nodes, ['move', 'event-observe', 'observe']);
  assert.equal(group.label, 'OnEnter\nOnExit\nOnTransition');
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
  for (const label of ['OnEnter', 'OnEnter(AppState::MainMenu)\nOnExit(AppState::InGame)\nOnTransition { exited: AppState::MainMenu, entered: AppState::InGame }']) {
    group.label = label;
    data.save();
    assert.throws(() => checkArchitecture(data.directory), /Invalid or unordered Schedule group/);
  }
});

test('Schedule titles cannot fall back to static state group labels', () => {
  const data = stateSchedules();
  data.views[1].scheduleGroups[0].label = data.model.schedule_groups[0].label;
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Invalid or unordered Schedule group/);
});

test('Schedule title checks use concise display names while retaining original definitions', () => {
  for (const [id, originalLabel, label] of [
    ['FixedLast', 'FixedLast · 固定步结束', 'FixedLast'],
    ['FixedPostUpdate', 'FixedPostUpdate · Avian 物理步', 'FixedPostUpdate'],
    ['EguiPrimaryContextPass', 'EguiPrimaryContextPass · PostUpdate 内驱动', 'EguiPrimaryContextPass'],
    ['RenderApp', 'RenderApp · 独立渲染子应用', 'RenderApp'],
    ['NativePlatformEvents', '原生平台回调 · 调度外', '原生平台回调'],
    ['EventTriggered', 'Observer · 匹配事件触发', 'Observer'],
    ['Explanatory', '约束与说明 · 非调度系统', '约束与说明'],
  ]) {
    const data = fixture();
    data.model.schedule_groups[0] = { id, label: originalLabel, order: 90, notes: ['原始生命周期说明'] };
    for (const node of [data.registry.move, data.registry.observe, data.registry['event-observe'], ...data.model.systems]) node.schedule_group = id;
    data.render(data.views[1]);
    data.save();
    const group = data.views[1].scheduleGroups[0];
    assert.equal(group.id, id);
    assert.equal(group.label, label);
    assert.deepEqual(group.nodes, ['move', 'event-observe', 'observe']);
    assert.equal(data.model.schedule_groups[0].label, originalLabel);
    assert.deepEqual(data.model.schedule_groups[0].notes, ['原始生命周期说明']);
    assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
    group.label = originalLabel;
    data.save();
    assert.throws(() => checkArchitecture(data.directory), /Invalid or unordered Schedule group/, id);
  }
});

test('Schedule arrows have separate identities and cannot masquerade as semantic or layout edges', () => {
  const data = twoSchedules(), view = data.views[1];
  view.scheduleLinks = [{ id: 'schedule-Update-PostUpdate', from: 'Update', to: 'PostUpdate', edgeSemantic: 'schedule', mermaidId: 'sc0', displayLabel: '' }];
  view.mermaid += 'sg0 sc0@--> sg1\n';
  view.svg = view.svg.replace('</svg>', '<path data-edge="true" data-schedule-link-id="schedule-Update-PostUpdate" data-schedule-connect="Update|PostUpdate" data-edge-semantic="schedule" data-mermaid-id="sc0" d="M250,50L300,50" marker-end="url(#arrow)"/></svg>');
  data.save();
  assert.deepEqual(checkArchitecture(data.directory), { systems: 3, sources: 1, views: fixtureViewCount });
  assert.equal(checkMermaidGeometry(view.svg, view).scheduleEdges, 1);
  const reversed = view.svg.replace('data-schedule-connect="Update|PostUpdate"', 'data-schedule-connect="PostUpdate|Update"');
  assert.throws(() => checkMermaidGeometry(reversed, view), /Mermaid Schedule edge identity mismatch/);
  const doubled = view.svg.replace('data-schedule-link-id=', 'data-layout-link="layout_fake" data-schedule-link-id=');
  assert.throws(() => checkMermaidGeometry(doubled, view), /Unidentified Mermaid edge path/);
  view.mermaid = view.mermaid.replace('sg0 sc0@--> sg1\n', '');
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Mermaid Schedule edge declaration mismatch/);
});

test('validates Schedule identity and source order against the shared Schedule definitions', () => {
  const data = twoSchedules();
  assert.deepEqual(checkArchitecture(data.directory), { systems: 3, sources: 1, views: fixtureViewCount });
  data.views[1].scheduleGroups.reverse();
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Invalid or unordered Schedule group/);
  const wrongNode = fixture();
  wrongNode.registry.move.schedule_group = 'First';
  wrongNode.save();
  assert.throws(() => checkArchitecture(wrongNode.directory), /Invalid Schedule node membership: move/);
});

test('checks compiled Schedule columns instead of merely accepting flowchart LR source text', () => {
  const data = twoSchedules();
  const view = data.views[1];
  view.svg = view.svg.replace('<rect x="300"', '<rect x="-300"');
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Mermaid Schedule columns are not left to right/);
});

test('permits horizontal routing drift but rejects parallel nodes within one Schedule column', () => {
  const data = fixture();
  const view = data.views[1];
  view.nodes[1].position.x += 20;
  view.svg = view.svg.replace(/<g class="node" data-id="event-observe"[^>]*>/, value => value.replace('data-center-x="150"', 'data-center-x="170"').replace('translate(150,250)', 'translate(170,250)'));
  data.save();
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
  view.nodes[1].position.y = 55;
  view.svg = view.svg.replace(/<g class="node" data-id="event-observe"[^>]*>/, value => value.replace('data-center-y="250"', 'data-center-y="100"').replace('translate(170,250)', 'translate(170,100)'));
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Mermaid Schedule nodes are not top to bottom/);
});

test('checks actual top-to-bottom order inside a Schedule without creating execution edges', () => {
  const data = fixture();
  const view = data.views[1];
  view.nodes[1].position.y = 35;
  view.svg = view.svg.replace(/<g class="node" data-id="event-observe"[^>]*>/, value => value.replace('data-center-y="250"', 'data-center-y="80"').replace('translate(150,250)', 'translate(150,80)'));
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Mermaid Schedule nodes are not top to bottom/);
});

function legacyPluginAlias() {
  const data = fixture();
  data.model.node_aliases = { 'legacy-plugin': 'plugin-ExamplePlugin' };
  data.model.node_features['legacy-plugin'] = 'example';
  data.registry['legacy-plugin'] = { ...data.registry['plugin-ExamplePlugin'], id: 'legacy-plugin', alias_of: 'plugin-ExamplePlugin' };
  data.model.required_nodes = ['legacy-plugin'];
  data.model.system_links.push({ ...data.views[0].links[0], to: 'legacy-plugin' });
  data.save();
  return data;
}

test('legacy plugin aliases share canonical rendering and resolve maintained link endpoints', () => {
  const data = legacyPluginAlias();
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
  assert.equal(data.views[0].nodes.filter(node => node.id === 'plugin-ExamplePlugin').length, 1);
  assert.equal(data.views[0].nodes.some(node => node.id === 'legacy-plugin'), false);
});

test('hidden main registration coverage resolves aliases without removing other aliased relations', () => {
  const data = legacyPluginAlias();
  data.model.system_links.push({ id: 'install-legacy', from: 'app-main', to: 'legacy-plugin', kind: 'registration' });
  data.save();
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
  data.views[0].links = [];
  data.render(data.views[0]);
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /System link is missing from views: overview-dependency/);
});

test('preserves declared legacy explanation projections separately from visual node aliases', () => {
  const data = fixture();
  const node = { id: 'legacy-explanation', feature: 'infrastructure', kind: 'Component write', name: '解释入口', alias_of: 'actor.Marker', aspects: [] };
  data.model.nodes = [node];
  data.registry[node.id] = structuredClone(node);
  data.save();
  assert.deepEqual(checkArchitecture(data.directory), { systems: 2, sources: 1, views: fixtureViewCount });
  data.registry[node.id].alias_of = 'resource.Value';
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Node alias metadata mismatch: legacy-explanation/);
});

test('rejects undeclared or unknown alias targets and aliases crossing feature boundaries', () => {
  const undeclared = legacyPluginAlias();
  undeclared.registry['legacy-plugin'].alias_of = 'app-main';
  undeclared.save();
  assert.throws(() => checkArchitecture(undeclared.directory), /Node alias metadata mismatch: legacy-plugin/);
  const unknown = legacyPluginAlias();
  unknown.model.node_aliases['legacy-plugin'] = 'missing-node';
  unknown.registry['legacy-plugin'].alias_of = 'missing-node';
  unknown.save();
  assert.throws(() => checkArchitecture(unknown.directory), /Unknown node alias target: legacy-plugin/);
  const foreign = legacyPluginAlias();
  foreign.registry['legacy-plugin'].feature = 'infrastructure';
  foreign.model.node_features['legacy-plugin'] = 'infrastructure';
  foreign.save();
  assert.throws(() => checkArchitecture(foreign.directory), /Node alias crosses feature boundaries: legacy-plugin/);
});

test('rejects cyclic aliases and preserves system registration and entity component identities', () => {
  const cyclic = legacyPluginAlias();
  cyclic.model.node_aliases.other = 'legacy-plugin';
  cyclic.model.node_aliases['legacy-plugin'] = 'other';
  cyclic.registry['legacy-plugin'].alias_of = 'other';
  cyclic.registry.other = { ...cyclic.registry['legacy-plugin'], id: 'other', alias_of: 'legacy-plugin' };
  cyclic.save();
  assert.throws(() => checkArchitecture(cyclic.directory), /Cyclic architecture node alias/);
  for (const id of ['move', 'actor.Marker', 'entity-actor']) {
    const data = fixture();
    data.model.node_aliases = { [id]: 'plugin-ExamplePlugin' };
    data.registry[id].alias_of = 'plugin-ExamplePlugin';
    data.save();
    assert.throws(() => checkArchitecture(data.directory), /System or entity identity cannot be aliased/);
  }
});

test('rejects rendering a legacy alias as another box or retaining an unaliased duplicate plugin', () => {
  const alias = legacyPluginAlias();
  alias.views[0].nodes[1].id = 'legacy-plugin';
  alias.save();
  assert.throws(() => checkArchitecture(alias.directory), /Alias must render its canonical node/);
  const duplicate = legacyPluginAlias();
  delete duplicate.model.node_aliases;
  delete duplicate.registry['legacy-plugin'].alias_of;
  duplicate.save();
  assert.throws(() => checkArchitecture(duplicate.directory), /Duplicate semantic project plugin: ExamplePlugin/);
});

test('accepts actual centered ports after an SVG translation', () => {
  const content = svg(`<g transform="translate(12 24)">${box('a', 0, 0)}${box('b', 200, 0)}${edge([[100, 45], [200, 45]], port('a', 'right'), port('b', 'left'))}</g>`);
  assert.deepEqual(checkGeometry(content), { boxes: 2, edges: 1, ports: 2, junctions: 0 });
});

test('rejects a lone connection away from the side center despite correct metadata', () => {
  const content = svg(box('a', 0, 0) + box('b', 200, 0)
    + edge([[100, 30], [200, 30]], port('a', 'right'), port('b', 'left')));
  assert.throws(() => checkGeometry(content), /Anchor position mismatch/);
});

test('accepts two thirds and counts incoming and outgoing lines on the same side together', () => {
  const content = svg(box('a', 0, 0) + box('b', 200, 0) + box('c', 200, 200)
    + edge([[100, 30], [150, 30], [150, 45], [200, 45]], port('a', 'right', 1, 2), port('b', 'left'))
    + edge([[200, 245], [150, 245], [150, 60], [100, 60]], port('c', 'left'), port('a', 'right', 2, 2)));
  assert.deepEqual(checkGeometry(content), { boxes: 3, edges: 2, ports: 4, junctions: 0 });
});

test('rejects metadata that leaves an incoming line out of the side count', () => {
  const content = svg(box('a', 0, 0) + box('b', 200, 0) + box('c', 200, 200)
    + edge([[100, 45], [200, 45]], port('a', 'right'), port('b', 'left'))
    + edge([[200, 245], [150, 245], [150, 45], [100, 45]], port('c', 'left'), port('a', 'right')));
  assert.throws(() => checkGeometry(content), /Anchor count mismatch/);
});

test('rejects a declared second slot when only one actual line exists', () => {
  const content = svg(box('a', 0, 0) + box('b', 200, 0)
    + edge([[100, 30], [200, 30]], port('a', 'right', 1, 2), port('b', 'left', 1, 2)));
  assert.throws(() => checkGeometry(content), /Anchor count mismatch/);
});

test('rejects two lines at quarter points instead of thirds', () => {
  const content = svg(box('a', 0, 0, 100, 120) + box('b', 200, 0, 100, 120)
    + edge([[100, 30], [200, 30]], port('a', 'right', 1, 2), port('b', 'left', 1, 2))
    + edge([[100, 90], [200, 90]], port('a', 'right', 2, 2), port('b', 'left', 2, 2)));
  assert.throws(() => checkGeometry(content), /Anchor position mismatch/);
});

test('rejects overlapping independent lines that reuse a slot', () => {
  const content = svg(box('a', 0, 0) + box('b', 200, 0)
    + edge([[100, 30], [200, 30]], port('a', 'right', 1, 2), port('b', 'left', 1, 2))
    + edge([[100, 30], [200, 30]], port('a', 'right', 1, 2), port('b', 'left', 1, 2)));
  assert.throws(() => checkGeometry(content), /Duplicate anchor slot/);
});

test('rejects a connection group or arrow path without endpoint metadata', () => {
  assert.throws(() => checkGeometry(svg('<g class="edge"><path d="M0,0 L30,0"/></g>')), /Missing connection anchor metadata/);
  assert.throws(() => checkGeometry(svg('<path d="M0,0 L30,0" marker-end="url(#arrow)"/>')), /missing connection metadata/);
  const valid = edge([[100, 45], [200, 45]], port('a', 'right'), port('b', 'left'));
  assert.throws(() => checkGeometry(svg(valid.replace(/ data-target-anchor="[^"]*"/, ''))), /Missing connection anchor metadata: target/);
  assert.throws(() => checkGeometry(svg(valid.replace('class="edge"', ''))), /missing an edge group/);
});

test('rejects invented box metadata and mismatching actual rectangle dimensions', () => {
  const connection = edge([[100, 45], [200, 45]], port('a', 'right'), port('b', 'left'));
  assert.throws(() => checkGeometry(svg(box('b', 200, 0) + connection)), /Unknown anchor box: a/);
  assert.throws(() => checkGeometry(svg(box('a', 0, 0, 120) + box('b', 200, 0) + connection)), /Anchor position mismatch/);
});

test('rejects tangential or inward departures and target approaches', () => {
  const boxes = box('a', 0, 0) + box('b', 200, 0);
  const cases = [
    [[100, 45], [100, 60], [150, 60], [150, 45], [200, 45]],
    [[100, 45], [80, 45], [80, 100], [150, 100], [150, 45], [200, 45]],
    [[100, 45], [150, 45], [150, 100], [200, 100], [200, 45]],
  ];
  for (const points of cases) {
    assert.throws(() => checkGeometry(svg(boxes + edge(points, port('a', 'right'), port('b', 'left')))), /Anchor normal mismatch/);
  }
});

test('rejects zero-length and diagonal connection segments', () => {
  const boxes = box('a', 0, 0) + box('b', 200, 0);
  assert.throws(() => checkGeometry(svg(boxes + edge([[100, 45], [100, 45], [200, 45]], port('a', 'right'), port('b', 'left')))), /zero-length segment/);
  assert.throws(() => checkGeometry(svg(boxes + edge([[100, 45], [150, 60], [200, 45]], port('a', 'right'), port('b', 'left')))), /non-orthogonal segment/);
});

test('rejects marker heads on junctions or non-terminal path positions', () => {
  const boxes = box('a', 0, 0) + box('b', 200, 0);
  assert.throws(() => checkGeometry(svg(boxes + edge([[100, 45], [150, 45]], port('a', 'right'), null))), /Arrow cannot target a junction/);
  assert.throws(() => checkGeometry(svg(boxes + edge([[100, 45], [200, 45]], port('a', 'right'), port('b', 'left'), true, 'marker-mid="url(#arrow)"'))), /Arrow is only allowed at the target/);
  assert.throws(() => checkGeometry(svg(boxes + edge([[100, 45], [200, 45]], port('a', 'right'), port('b', 'left'), true, 'marker-start="url(#arrow)"'))), /Arrow is only allowed at the target/);
});

test('rejects a terminal segment hidden entirely by its arrow head', () => {
  const content = svg(box('a', 0, 0) + box('b', 114, 0)
    + edge([[100, 45], [114, 45]], port('a', 'right'), port('b', 'left')));
  assert.throws(() => checkGeometry(content), /terminal segment is too short/);
});

test('rejects an arrow marker that does not follow the actual terminal segment', () => {
  const content = svg(box('a', 0, 0) + box('b', 200, 0)
    + edge([[100, 45], [200, 45]], port('a', 'right'), port('b', 'left'))).replace('orient="auto"', 'orient="90"');
  assert.throws(() => checkGeometry(content), /must follow the terminal segment/);
});

test('rejects SVG 2 start reversal for terminal-only arrows that older renderers cannot rotate', () => {
  const content = svg(box('a', 0, 0) + box('b', 200, 0)
    + edge([[100, 45], [200, 45]], port('a', 'right'), port('b', 'left')))
    .replace('orient="auto"', 'orient="auto-start-reverse"');
  assert.throws(() => checkGeometry(content), /must follow the terminal segment/);
});

test('accepts a shared trunk and T-junctions without multiplying its box port count', () => {
  const content = svg(box('lane', -20, -20, 500, 400, true) + box('a', 0, 0) + box('b', 250, 0) + box('c', 250, 180)
    + edge([[100, 45], [150, 45], [150, 225]], port('a', 'right'), null, false)
    + edge([[150, 45], [250, 45]], null, port('b', 'left'))
    + edge([[150, 225], [250, 225]], null, port('c', 'left')));
  assert.deepEqual(checkGeometry(content), { boxes: 4, edges: 3, ports: 3, junctions: 3 });
});

test('rejects disconnected junctions and node boundaries or interiors disguised as junctions', () => {
  const boxes = box('a', 0, 0) + box('b', 200, 0);
  assert.throws(() => checkGeometry(svg(boxes + edge([[100, 45], [150, 45]], port('a', 'right'), null, false))), /Disconnected junction/);
  assert.throws(() => checkGeometry(svg(boxes + edge([[100, 45], [200, 45]], port('a', 'right'), null, false))), /Junction disguises a box anchor/);
  assert.throws(() => checkGeometry(svg(boxes + edge([[100, 45], [220, 45]], port('a', 'right'), null, false))), /Junction is inside a node/);
});

test('rejects an isolated junction ring whose lines have no actual box anchor', () => {
  const content = svg(edge([[0, 0], [40, 0]], null, null, false)
    + edge([[40, 0], [40, 40]], null, null, false)
    + edge([[40, 40], [0, 40]], null, null, false)
    + edge([[0, 40], [0, 0]], null, null, false));
  assert.throws(() => checkGeometry(content), /Connection group has no box anchor/);
});

test('architecture validation rejects false Mermaid positions even when SVG artifacts agree', () => {
  const data = fixture();
  data.views[0].nodes[0].position.x += 20;
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Invalid Mermaid geometry in overview: Mermaid node position mismatch/);
});

// 插件和日志拓扑不可因路径迁移或文本扫描失败而悄悄从图中消失。
test('rejects a required plugin or logging node removed from the registry', () => {
  const data = fixture();
  data.model.required_nodes = ['log-file-worker'];
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Missing required architecture node: log-file-worker/);
});

test('rejects a required registered node that has no visible card', () => {
  const data = fixture();
  data.model.required_nodes = ['log-file-worker'];
  data.registry['log-file-worker'] = { id: 'log-file-worker', feature: 'infrastructure', name: 'File worker', kind: 'External I/O' };
  data.save();
  assert.throws(() => checkArchitecture(data.directory), /Required architecture node is missing from views: log-file-worker/);
});

test('source lookup rejects a missing or ambiguous declaration', () => {
  const data = fixture();
  const locateSource = createSourceLocator(data.directory);
  assert.deepEqual(locateSource('src/example.rs', /^fn move_entity\b/), { path: 'src/example.rs', line: 1 });
  assert.throws(() => locateSource('src/example.rs', 'QueuedWriter'), /found 0/);
  assert.throws(() => locateSource('src/example.rs', 'fn '), /found 2/);
});

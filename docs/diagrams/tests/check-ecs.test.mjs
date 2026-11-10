import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkArchitecture as checkArchitectureWithDependencies, checkDataSections, checkEntityGroups, checkEntityViewProjections, checkViewRouting, checkGuideSamples, checkScheduleGuideSamples, checkObjectViews, checkObserverTriggerProjections, checkMermaidLayout, checkMermaidSource } from '../src/check-ecs.mjs';
import { instance as graphvizInstance } from '@viz-js/viz';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { compileScheduleGuideSamples } from '../src/schedule-legend-compiler.mjs';
import { checkMermaidGeometry, checkSvgGeometry } from '../src/diagram-geometry.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, EXTERNAL_REFERENCE_STYLE, visualTypeOf, edgeSemanticOf, displayLabelOf } from '../src/architecture-style.mjs';
import { isMainPluginRegistration, scheduleGroupLabel, isUnscheduledTriggerNode } from '../src/architecture-model.mjs';
import { DATA_GROUP_LABELS, renderGraphView } from '../src/architecture-renderer.mjs';
import { normalizeMermaidSvg } from '../src/mermaid-compiler.mjs';
import { INFRASTRUCTURE_FEATURES as infrastructureDefinitions, architectureViewId } from '../src/architecture-infrastructure.mjs';
import { artifactFile, pathsForRepository } from '../src/paths.mjs';

const INFRASTRUCTURE_FEATURES = infrastructureDefinitions.map(feature => ({ ...feature, overviewNode: 'fixture-plugin-' + feature.id }));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const temporaryRoot = path.join(root, 'tmp', 'architecture-check-tests');
const sharedStyles = () => ({ nodes: NODE_STYLES, edges: EDGE_STYLES, selection: SELECTION_STYLE, externalReference: EXTERNAL_REFERENCE_STYLE });
const fixtureViewCount = 1 + 3 * (1 + INFRASTRUCTURE_FEATURES.length);
const fixtureOverviewNodeCount = 2 + INFRASTRUCTURE_FEATURES.length;
const extensionFeature = INFRASTRUCTURE_FEATURES.find(feature => feature.section === 'third_party');

test('Schedule guides require uniform dashed shafts, solid arrows and no visible edge text', async () => {
  const samples = compileScheduleGuideSamples(await graphvizInstance(), { DOMParser, XMLSerializer });
  assert.doesNotThrow(() => checkScheduleGuideSamples(samples));
  for (const kind of ['order', 'set_membership']) {
    const changed = structuredClone(samples);
    assert.ok(changed.edges[kind].includes('stroke-dasharray="6 4"'));
    changed.edges[kind] = changed.edges[kind].replace('stroke-dasharray="6 4"', 'stroke-dasharray="1 1"');
    assert.throws(() => checkScheduleGuideSamples(changed), /Schedule guide edge style mismatch/);
  }
  const text = structuredClone(samples);
  text.edges.order = text.edges.order.replace('</svg>', '<text>排序说明</text></svg>');
  assert.throws(() => checkScheduleGuideSamples(text), /Unexpected visible text/);
  const arrow = structuredClone(samples), document = new DOMParser().parseFromString(arrow.edges.order, 'image/svg+xml');
  const edge = [...document.getElementsByTagName('g')].find(element => element.getAttribute('class') === 'edge');
  edge.getElementsByTagName('polygon')[0].setAttribute('stroke-dasharray', '6 4');
  arrow.edges.order = new XMLSerializer().serializeToString(document);
  assert.throws(() => checkScheduleGuideSamples(arrow), /Schedule guide edge style mismatch/);
});

test('Mermaid source checks decode node YAML escapes without decoding literal entity names twice', () => {
  const registry = {
    'entity-982861bbae8d50e84ce84440': { kind: 'Entity', feature: 'ui', name: 'format!("Menu small button: {title}")' },
    'observer-047dad1ad3396d088fb4a662': { kind: 'Observer', feature: 'ui', name: 'avian3d::collider_tree::update::{impl#1}::build::{closure#2}' },
    'literal-entities': { kind: 'Entity', feature: 'ui', name: 'literal #35; #quot; #amp; &amp;' },
    'literal-escapes': { kind: 'Entity', feature: 'ui', name: String.raw`literal \u0022 \u0023 \n \\` },
  };
  const graph = { centerNodeId: Object.keys(registry)[0], nodes: Object.keys(registry).map(id => ({ id, role: 'internal' })), links: [] };
  const view = renderGraphView({ id: 'source-native-yaml-labels', aspect: 'object', objectId: graph.centerNodeId,
    label: 'Source label contract', summary: '节点原文与YAML标签。' }, graph, registry, [{ id: 'ui', label: 'ui' }]);
  assert.doesNotThrow(() => checkMermaidSource(view, registry, new Map()));
  assert.throws(() => checkMermaidSource({ ...view, mermaid: view.mermaid.replace('Menu', 'Other') }, registry, new Map()), /node style or label mismatch/);
  assert.throws(() => checkMermaidSource({ ...view, mermaid: view.mermaid.replace('\\u0022Menu', '\\u0023Menu') }, registry, new Map()), /node style or label mismatch/);
  assert.throws(() => checkMermaidSource({ ...view, mermaid: view.mermaid.replace('\\u0022Menu', '\\qMenu') }, registry, new Map()), /Invalid Mermaid node YAML escape/);
});

test('independent object checks reject Component geometry for Entity and System centers while allowing Observer reverse access', () => {
  for (const kind of ['Entity', 'System', 'Observer']) {
    const objects = [{ id: 'owner', kind, viewId: 'object-owner', feature: 'fixture' },
      { id: 'component', kind: 'Component', viewId: 'object-component', feature: 'fixture' }];
    const relation = { id: 'access', from: 'component', to: 'owner', kind: 'read' };
    const views = objects.map(object => ({ id: object.viewId, objectId: object.id, centerNodeId: object.id,
      aspect: 'object', feature: object.feature, nodes: objects.map(({ id }) => ({ id, role: 'internal' })), links: [relation] }));
    const catalog = { objects, graphFor: id => views.find(view => view.objectId === id) };
    if (kind === 'Observer') assert.equal(checkObjectViews(views, catalog), 2);
    else assert.throws(() => checkObjectViews(views, catalog), new RegExp(kind + ' object view contains Component geometry'));
  }
});

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
    const declarations = view.aspect === 'systems' ? ['subgraph diagram_main[" "]', 'direction LR'] : [];
    if (view.aspect === 'systems') view.scheduleGroups = model.schedule_groups.filter(group => view.nodes.some(node => !isUnscheduledTriggerNode(registry[node.id]) && registry[node.id].schedule_group === group.id))
      .sort((a, b) => a.order - b.order).map((group, index) => {
        const nodes = view.nodes.filter(node => !isUnscheduledTriggerNode(registry[node.id]) && registry[node.id].schedule_group === group.id).map(node => node.id);
        const visualAttachments = index === 0 ? view.nodes.filter(node => isUnscheduledTriggerNode(registry[node.id])).map(node => node.id) : [];
        return { ...group, label: scheduleGroupLabel({ ...group, nodes }, registry), mermaidId: `sg${index}`, nodes, visualAttachments };
      });
    const nodes = view.nodes.map((node, index) => {
      node.mermaidId = `n${index}`;
      node.instance = `${view.id}--${node.mermaidId}`;
      const groupIndex = view.scheduleGroups.findIndex(group => group.nodes.includes(node.id) || group.visualAttachments.includes(node.id));
      const group = view.scheduleGroups[groupIndex];
      const columns = view.aspect === 'overview' ? 3 : 2;
      const x = view.aspect === 'systems' ? 150 + Math.max(0, groupIndex) * 300 : 50 + index % columns * 200, y = view.aspect === 'systems' ? 100 + (group ? [...group.nodes, ...group.visualAttachments].indexOf(node.id) : index) * 150 : 45 + Math.floor(index / columns) * 200;
      node.position = { x: x - 50, y: y - 45, width: 100, height: 90 };
      return `<g class="node" data-id="${escape(node.id)}" data-instance="${escape(node.instance)}" data-feature="${registry[node.id]?.feature}" data-role="${node.role}" data-mermaid-id="${node.mermaidId}" data-center-x="${x}" data-center-y="${y}" transform="translate(${x},${y})">${box(node.instance, -50, -45)}</g>`;
    }).join('');
    const byId = new Map(view.nodes.map(node => [node.id, node]));
    if (view.scheduleGroups.length) {
      for (const group of view.scheduleGroups) declarations.push(`subgraph ${group.mermaidId}["${escape(group.label).replaceAll('\n', '<br/>')}"]`, 'direction TB', ...[...group.nodes, ...group.visualAttachments].map(id => `${byId.get(id).mermaidId}["${escape(id)}"]`), 'end');
      declarations.push(...view.nodes.filter(node => !view.scheduleGroups.some(group => group.nodes.includes(node.id) || group.visualAttachments.includes(node.id))).map(node => `${node.mermaidId}["${escape(node.id)}"]`));
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
    if (view.aspect === 'systems') declarations.push('end');
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

function guideSamplesFixture() {
  const label = style => escape(style.legendLabel).replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const nodes = Object.fromEntries(Object.entries(NODE_STYLES).map(([type, style]) => {
    return [type, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 90" aria-label="${label(style)}" data-diagram-engine="mermaid" data-guide-kind="node" data-visual-type="${type}" data-shape="${style.shape}"><path data-guide-shape-part="true" d="M10,10 L130,10 L130,80 L10,80 Z" style="fill:${style.fill};stroke:${style.stroke};stroke-width:${style.width}px"/></svg>`];
  }));
  const edges = Object.fromEntries(Object.entries(EDGE_STYLES).map(([type, style]) => [type,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 50" aria-label="${label(style)}" data-diagram-engine="mermaid" data-guide-kind="edge" data-edge-semantic="${type}"><defs><marker id="guide-${type}-arrow" orient="auto"><path d="M0,0L8,4L0,8" fill="${style.stroke}"/></marker></defs><path data-guide-edge="true" d="M10,25H130" marker-end="url(#guide-${type}-arrow)"${type === 'read_write' ? ` marker-start="url(#guide-${type}-arrow)"` : ''} style="fill:none;stroke:${style.stroke};stroke-width:${style.width}px${style.dash ? `;stroke-dasharray:${style.dash}` : ''}"/></svg>`,
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

test('Observer trigger systems retain shared Dagre layout without obsolete vertical layout metadata', () => {
  const configuration = layout => `---\n${JSON.stringify({ config: { layout } })}\n---\nflowchart TB\n`;
  for (const [aspect, layout] of [['systems', undefined], ['overview', 'app-schedule']]) {
    const trigger = { id: 'trigger-view', aspect, layout, links: [{ projection: 'observer-trigger' }], mermaid: configuration('dagre') };
    assert.equal(checkMermaidLayout(trigger), 'dagre');
    trigger.mermaid = configuration('elk');
    assert.throws(() => checkMermaidLayout(trigger), /Expected shared Dagre layout/);
    trigger.scheduleOrientation = 'vertical';
    assert.throws(() => checkMermaidLayout(trigger), /Obsolete Schedule orientation metadata/);
  }
  const ordinary = { id: 'ordinary', aspect: 'systems', links: [], mermaid: configuration('dagre') };
  assert.equal(checkMermaidLayout(ordinary), 'dagre');
  ordinary.mermaid = configuration('elk');
  assert.throws(() => checkMermaidLayout(ordinary), /Expected shared Dagre layout/);
  ordinary.aspect = 'object';
  ordinary.links = [{ projection: 'observer-trigger' }];
  assert.throws(() => checkMermaidLayout(ordinary), /Expected shared Dagre layout/);
});

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
  const endpoint = fixture('M-20,60 L120,60'); endpoint.links[0].to = 'component';
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
  duplicate.nodes.system_set = duplicate.nodes.system_set.replace('<svg ', '<svg id="shared-guide-id" ');
  assert.throws(() => checkGuideSamples(duplicate, styles), /Duplicate read guide SVG ID: shared-guide-id/);
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

test('rejects Mermaid edge paths with missing coordinates or unidentified semantic edges', () => {
  const data = fixture();
  const view = data.views[0];
  assert.throws(() => checkMermaidGeometry(view.svg.replace('C160,80 170,80', 'C160,80'), view), /Invalid Mermaid edge coordinates/);
  const unknown = view.svg.replace('</svg>', '<path data-edge="true" d="M0,0 L20,30"/></svg>');
  assert.throws(() => checkMermaidGeometry(unknown, view), /Unidentified Mermaid edge path/);
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

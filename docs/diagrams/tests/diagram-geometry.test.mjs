import assert from 'node:assert/strict';
import test from 'node:test';
import { checkMermaidGeometry } from '../src/diagram-geometry.mjs';

test('event attachments remain within their source region while Schedule columns retain horizontal order', () => {
  const observer = { id: 'observer', instance: 'o', mermaidId: 'n0', position: { x: 130, y: 30, width: 40, height: 20 } };
  const view = { bounds: { x: 0, y: 0, width: 300, height: 150 }, width: 300, height: 150,
    nodes: [observer], links: [], scheduleGroups: [{ id: 'First', mermaidId: 'sg0', nodes: [] }, { id: 'PreUpdate', mermaidId: 'sg1', nodes: [], visualAttachments: ['observer'] }] };
  view.svg = '<svg viewBox="0 0 300 150"><g class="cluster" data-schedule-id="First" data-mermaid-id="sg0"><rect x="10" y="10" width="90" height="80"/></g>'
    + '<g class="cluster" data-schedule-id="PreUpdate" data-mermaid-id="sg1"><rect x="120" y="10" width="90" height="80"/>'
    + '<g class="node" data-id="observer" data-instance="o" data-visual-type="observer" data-mermaid-id="n0" data-center-x="150" data-center-y="40"><rect data-shape-part="o" x="130" y="30" width="40" height="20"/></g></g></svg>';
  assert.equal(checkMermaidGeometry(view.svg, view).scheduleGroups, 2);
  assert.throws(() => checkMermaidGeometry(view.svg, { ...view, scheduleGroups: [...view.scheduleGroups].reverse() }), /columns are not left to right/);
  observer.position.x = 205;
  const outside = view.svg.replace('data-center-x="150"', 'data-center-x="225"').replace('x="130"', 'x="205"');
  assert.throws(() => checkMermaidGeometry(outside, view), /event attachment is outside its source region/);
});

function composed() {
  const entity = { id: 'entity', instance: 'e', mermaidId: 'n0', presentation: 'entity-container', position: { x: 10, y: 20, width: 140, height: 150 } };
  const component = { id: 'component', instance: 'c', mermaidId: 'n1', position: { x: 30, y: 80, width: 100, height: 40 } };
  const view = { bounds: { x: 0, y: 0, width: 300, height: 200 }, width: 300, height: 200, nodes: [entity, component], links: [],
    entityGroups: [{ id: 'group', entity: 'entity', components: ['component'] }] };
  view.svg = '<svg viewBox="0 0 300 200"><g class="cluster" data-presentation="entity-container" data-id="entity" data-instance="e" data-visual-type="entity" data-mermaid-id="n0" data-center-x="80" data-center-y="95"><rect data-shape-part="e" x="10" y="20" width="140" height="150"/><g class="node" data-id="component" data-instance="c" data-visual-type="component" data-mermaid-id="n1" data-center-x="80" data-center-y="100"><rect data-shape-part="c" x="30" y="80" width="100" height="40"/></g></g></svg>';
  return view;
}

test('geometry permits only canonical Component containment inside native Entity cards', () => {
  const view = composed();
  assert.equal(checkMermaidGeometry(view.svg, view).nodes, 2);
  view.entityGroups[0].components = [];
  assert.throws(() => checkMermaidGeometry(view.svg, view), /Mermaid node rectangles overlap: entity \/ component/);
});

test('canonical Entity membership cannot excuse a Component outside its actual card', () => {
  const view = composed();
  view.nodes[1].position.x = 100;
  view.svg = view.svg.replace('data-center-x="80" data-center-y="100"', 'data-center-x="150" data-center-y="100"').replace('x="30" y="80"', 'x="100" y="80"');
  assert.throws(() => checkMermaidGeometry(view.svg, view), /Mermaid Component is outside its Entity card/);
});

function reverseComponent() {
  const markerId = 'v_flowchart-v2-pointStart', css = `#v-e0{marker-start:url(#${markerId})!important}`;
  const view = { id: 'v', aspect: 'component', componentNodeId: 'component', bounds: { x: 0, y: 0, width: 140, height: 60 }, width: 140, height: 60,
    nodes: ['entity', 'component', 'system'].map((id, index) => ({ id, instance: id, mermaidId: `n${index}`, visualType: ['entity', 'component', 'system'][index], position: { x: index * 60, y: 20, width: 20, height: 20 } })),
    links: [{ id: 'read', mermaidId: 'e0', from: 'component', to: 'system', nativeReverse: true }],
    mermaid: `---\n${JSON.stringify({ config: { themeCSS: css } })}\n---\nflowchart RL\n n2 e0@--- n1\n`,
  };
  view.svg = `<svg id="v" viewBox="0 0 140 60"><style>#v ${css}</style><defs><marker id="${markerId}"><path d="M0 5L10 10L10 0Z"/></marker></defs>`
    + view.nodes.map(node => `<g class="node" data-id="${node.id}" data-instance="${node.instance}" data-visual-type="${node.visualType}" data-mermaid-id="${node.mermaidId}" data-center-x="${node.position.x + 10}" data-center-y="30"><rect data-shape-part="${node.instance}" x="${node.position.x}" y="20" width="20" height="20"/></g>`).join('')
    + '<path id="v-e0" data-link-id="read" data-mermaid-id="e0" data-native-reverse="true" d="M120 30H80"/></svg>';
  return view;
}

test('marker-start requires exact native reverse source, metadata and actual stylesheet evidence', () => {
  const view = reverseComponent();
  assert.equal(checkMermaidGeometry(view.svg, view).edges, 1);
  for (const mutate of [
    value => { delete value.links[0].nativeReverse; },
    value => { value.svg = value.svg.replace('data-native-reverse="true"', ''); },
    value => { value.mermaid = value.mermaid.replace('n2 e0@--- n1', 'n1 e0@--- n2'); },
    value => { value.mermaid = value.mermaid.replace('themeCSS', 'otherCSS'); },
    value => { value.svg = value.svg.replace('d="M120 30H80"', 'marker-end="url(#v_flowchart-v2-pointStart)" d="M120 30H80"'); },
    value => { value.svg = value.svg.replace('d="M120 30H80"', 'marker-mid="url(#v_flowchart-v2-pointStart)" d="M120 30H80"'); },
  ]) {
    const invalid = reverseComponent(); mutate(invalid);
    assert.throws(() => checkMermaidGeometry(invalid.svg, invalid), /arrow|direction metadata/);
  }
});

test('Component geometry rejects correctly routed Systems or Entities on the wrong side of the center', () => {
  for (const id of ['system', 'entity']) {
    const view = reverseComponent(), node = view.nodes.find(node => node.id === id), other = view.nodes.find(node => node.id === (id === 'system' ? 'entity' : 'system'));
    [node.visualType, other.visualType] = [other.visualType, node.visualType];
    assert.throws(() => checkMermaidGeometry(view.svg, view), /Component columns/);
  }
});

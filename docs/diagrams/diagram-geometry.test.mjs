import assert from 'node:assert/strict';
import test from 'node:test';
import { checkMermaidGeometry } from './diagram-geometry.mjs';

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

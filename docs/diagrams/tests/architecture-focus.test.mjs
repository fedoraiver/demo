import assert from 'node:assert/strict';
import test from 'node:test';
import { computeObjectFocus } from '../src/architecture-focus.mjs';
import { createArchitectureInteraction } from '../src/architecture-interaction.mjs';
import { NODE_STYLES } from '../src/architecture-style.mjs';
import { testDocument } from './test-dom.mjs';

const viewOf = (ids, links) => ({ aspect: 'object', nodes: ids.map(id => ({ id })), links });
const edge = (id, from, to, overrides = {}) => ({ id, from, to, ...overrides });
const values = focus => Object.fromEntries(Object.entries(focus).map(([name, ids]) => [name, [...ids].sort()]));
const expected = (selectedNodes = [], dimNodes = [], focusedEdges = [], dimEdges = []) => values({
  selectedNodes, dimNodes, focusedEdges, dimEdges,
});
const star = viewOf(['s1', 's2', 's3', 'resource', 'condition'], [
  ...['s1', 's2', 's3'].map(id => edge(id + '-resource', id, 'resource')),
  edge('resource-condition', 'resource', 'condition'),
]);

test('selecting the right condition dims all three systems and their resource edges in the five-card star', () => {
  assert.deepEqual(values(computeObjectFocus(star, { kind: 'node', id: 'condition' })),
    expected(['condition'], ['s1', 's2', 's3'], ['resource-condition'], ['s1-resource', 's2-resource', 's3-resource']));
  assert.deepEqual(values(computeObjectFocus(star, { kind: 'node', id: 'resource' })),
    expected(['resource'], [], star.links.map(link => link.id)));
});

test('node focus includes direct incoming and outgoing edges without traversing neighbors or their connecting edges', () => {
  const view = viewOf(['a', 'b', 'c', 'd', 'e'], [edge('ab', 'a', 'b'), edge('ca', 'c', 'a'), edge('bd', 'b', 'd'), edge('bc', 'b', 'c'), edge('de', 'd', 'e')]);
  Object.defineProperty(view, 'registry', { get() { throw new Error('Shared access metadata must not influence visible focus'); } });
  assert.deepEqual(values(computeObjectFocus(view, { kind: 'node', id: 'a' })),
    expected(['a'], ['d', 'e'], ['ab', 'ca'], ['bd', 'bc', 'de']));
});

test('edge focus selects exactly that edge and its endpoints while parallel and reverse edges stay dim', () => {
  const view = viewOf(['a', 'b', 'c'], [edge('ab', 'a', 'b'), edge('parallel', 'a', 'b'), edge('reverse', 'b', 'a'), edge('bc', 'b', 'c')]);
  assert.deepEqual(values(computeObjectFocus(view, { kind: 'edge', id: 'ab' })),
    expected(['a', 'b'], ['c'], ['ab'], ['parallel', 'reverse', 'bc']));
});

test('a self-loop has one selected endpoint and does not focus another edge', () => {
  const view = viewOf(['a', 'b'], [edge('loop', 'a', 'a'), edge('ab', 'a', 'b')]);
  assert.deepEqual(values(computeObjectFocus(view, { kind: 'edge', id: 'loop' })), expected(['a'], ['b'], ['loop'], ['ab']));
  assert.deepEqual(values(computeObjectFocus(view, { kind: 'node', id: 'a' })), expected(['a'], [], ['loop', 'ab']));
});

test('display endpoints take precedence over canonical endpoints and hidden endpoint relations do not expand focus', () => {
  const view = viewOf(['a', 'b', 'c', 'isolated'], [
    edge('display', 'hidden-system', 'hidden-resource', { displayFrom: 'a', displayTo: 'b' }),
    edge('other', 'a', 'c', { displayFrom: 'b' }),
    edge('hidden', 'a', 'missing'),
    edge('hidden-display', 'a', 'b', { displayFrom: 'missing' }),
  ]);
  assert.deepEqual(values(computeObjectFocus(view, { kind: 'node', id: 'a' })), expected(['a'], ['c', 'isolated'], ['display'], ['other']));
  assert.deepEqual(values(computeObjectFocus(view, { kind: 'edge', id: 'display' })), expected(['a', 'b'], ['c', 'isolated'], ['display'], ['other']));
  assert.deepEqual(values(computeObjectFocus(view, { kind: 'edge', id: 'hidden-display' })), expected());
  const emptyEndpoint = viewOf(['', 'b'], [edge('empty', 'hidden', 'b', { displayFrom: '' })]);
  assert.deepEqual(values(computeObjectFocus(emptyEndpoint, { kind: 'node', id: '' })), expected([''], [], ['empty']));
});

test('an isolated card remains selected while every unrelated visible edge and card dims', () => {
  const view = viewOf(['a', 'b', 'isolated'], [edge('ab', 'a', 'b')]);
  assert.deepEqual(values(computeObjectFocus(view, { kind: 'node', id: 'isolated' })), expected(['isolated'], ['a', 'b'], [], ['ab']));
});

test('unknown selections and clear return empty paint state without mutating the view or previous results', () => {
  const original = JSON.stringify(star), selected = computeObjectFocus(star, { kind: 'node', id: 'condition' });
  const snapshot = values(selected);
  for (const selection of [{ kind: 'none' }, { kind: 'node', id: 'missing' }, { kind: 'edge', id: 'missing' }, { kind: 'invalid', id: 'condition' }, undefined]) {
    assert.deepEqual(values(computeObjectFocus(star, selection)), expected());
    assert.deepEqual(values(selected), snapshot);
  }
  for (let repeat = 0; repeat < 3; repeat++) {
    const next = computeObjectFocus(star, { kind: 'node', id: 'condition' });
    assert.deepEqual(values(next), snapshot); assert.notEqual(next.selectedNodes, selected.selectedNodes);
  }
  assert.equal(JSON.stringify(star), original);
});

test('the object focus model leaves Schedule and other view types unmodified', () => {
  for (const aspect of ['schedule', 'data', undefined]) {
    assert.deepEqual(values(computeObjectFocus({ ...star, aspect }, { kind: 'node', id: 'resource' })), expected());
  }
  assert.deepEqual(values(computeObjectFocus(undefined)), expected());
});

test('the focus model can be serialized into the generated browser script without module dependencies', () => {
  const browserCompute = new Function('return (' + computeObjectFocus.toString() + ')')();
  assert.deepEqual(values(browserCompute(star, { kind: 'node', id: 'condition' })), values(computeObjectFocus(star, { kind: 'node', id: 'condition' })));
});

test('paint dims only the exact Entity title owner and clears titles with their card while native Schedule paint leaves them intact', () => {
  const document = testDocument('<svg id="diagram"><g class="node entity-container" data-id="entity"><rect data-shape-part="entity"/><g class="node" data-id="component"><rect data-shape-part="component"/></g></g>'
    + '<g data-entity-header="instance-1" data-entity-owner="entity"><text>same title</text></g><g data-entity-header="instance-2" data-entity-owner="other"><text>same title</text></g></svg>');
  const diagram = document.getElementById('diagram'), interaction = createArchitectureInteraction({ diagram, nodeStyles: NODE_STYLES });
  const headers = diagram.querySelectorAll('[data-entity-owner]'), entity = diagram.querySelector('[data-id="entity"]'), component = diagram.querySelector('[data-id="component"]');
  interaction.paint({ dimNodes: new Set(['entity', 'component']) });
  assert.ok(entity.classList.contains('dim')); assert.ok(component.classList.contains('dim'));
  assert.ok(headers[0].classList.contains('dim')); assert.equal(headers[1].classList.contains('dim'), false);
  assert.equal(entity.style.getPropertyValue('opacity'), '', 'Container opacity must remain governed by its outline-only CSS');
  interaction.paint({ nativeOnly: true }); assert.ok(headers[0].classList.contains('dim'));
  interaction.paint(); assert.ok(headers.every(header => !header.classList.contains('dim')));
  assert.equal(entity.classList.contains('dim'), false); assert.equal(component.classList.contains('dim'), false);
});

test('paint synchronizes edge label wrappers by link identity and restores them without changing native styles', () => {
  const document = testDocument('<svg id="diagram"><path class="edge" data-link-id="a" style="stroke:#123"/><g class="edge-label" data-link-id="a"><rect/><text>same text</text></g>'
    + '<path class="edge" data-link-id="b"/><g class="edge-label" data-link-id="b"><rect/><text>same text</text></g></svg>');
  const diagram = document.getElementById('diagram'), interaction = createArchitectureInteraction({ diagram, nodeStyles: NODE_STYLES });
  const labels = diagram.querySelectorAll('.edge-label'), paths = diagram.querySelectorAll('.edge');
  interaction.paint({ focusedEdges: new Set(['a']), dimEdges: new Set(['b']) });
  assert.ok(paths[0].classList.contains('focused')); assert.ok(labels[0].classList.contains('focused'));
  assert.ok(paths[1].classList.contains('dim')); assert.ok(labels[1].classList.contains('dim'));
  assert.equal(labels[0].classList.contains('dim'), false); assert.equal(labels[1].classList.contains('focused'), false);
  assert.equal(paths[0].style.getPropertyValue('stroke'), '#123');
  interaction.paint();
  for (const element of [...paths, ...labels]) { assert.equal(element.classList.contains('dim'), false); assert.equal(element.classList.contains('focused'), false); }
});

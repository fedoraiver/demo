import assert from 'node:assert/strict';
import test from 'node:test';
import { createVisualEdgeGroups, isVisibleRelation, visualEdgesOf } from '../src/architecture-visual-edges.mjs';

function fixture() {
  const system = (id, schedule = 'Update') => ({ id, kind: 'System', callableIds: ['callable-system'],
    registrations: [{ application: 'main', schedule, scope: 'runtime' }] });
  const registry = { data: { id: 'data', kind: 'Resource' }, a: system('a'), b: system('b') };
  const access = (id, owner = 'a', extra = {}) => ({ id, from: 'data', to: owner, displayTo: 'a', kind: 'read',
    evidence: 'parameter', scope: 'current', sourceEntries: [{ path: 'src/system.rs', line: 3, column: 5, role: 'parameter' }],
    parameterAccesses: [{ callableId: 'callable-system', typeInstanceId: 'data', parameter: '1', storage: 'Resource',
      scope: 'current', directRoot: true, registeredOwner: owner }], ...extra });
  return { registry, access };
}

test('parameter duplicates share one display edge while retaining every canonical member', () => {
  const { registry, access } = fixture();
  const links = [access('read-b', 'b'), access('read-a')], original = structuredClone(links);
  assert.deepEqual(createVisualEdgeGroups(links, registry), [{ id: 'visual-edge-read-a', from: 'data', to: 'a',
    forwardIds: ['read-a', 'read-b'], backwardIds: [], edgeSemantic: 'read', displayLabel: '读访问' }]);
  assert.deepEqual(createVisualEdgeGroups([...links].reverse(), registry), createVisualEdgeGroups(links, registry));
  assert.deepEqual(links, original);
});

test('application, Schedule, World, slot, type, conditions and deferred context keep accesses separate', () => {
  for (const change of [
    (link, registry) => { registry.b.registrations[0].application = 'RenderApp'; },
    (link, registry) => { registry.b.registrations[0].schedule = 'PostUpdate'; },
    (link, registry) => { registry.b.worldAccessScope = 'render'; },
    link => { link.parameterAccesses[0].scope = 'main'; },
    link => { link.parameterAccesses[0].parameter = '2'; },
    link => { link.parameterAccesses[0].typeInstanceId = 'other-instance'; },
    link => { link.conditions = [{ expression: 'enabled', guardKind: 'condition' }]; },
    link => { link.deferred = true; },
  ]) {
    const { registry, access } = fixture();
    const changed = access('read-b', 'b');
    change(changed, registry);
    assert.equal(createVisualEdgeGroups([access('read-a'), changed], registry).length, 2);
  }
});

test('one compatible read group and one reverse mutable group form a single bidirectional edge', () => {
  const { registry, access } = fixture();
  const read = access('a-read');
  const mutable = access('b-mutable', 'a', { from: 'a', to: 'data', displayTo: 'data', kind: 'write', factKind: 'mutable_access' });
  mutable.parameterAccesses[0].parameter = '2';
  mutable.parameterAccesses[0].storage = 'Resource';
  const groups = createVisualEdgeGroups([mutable, read], registry);
  assert.deepEqual(groups, [{ id: 'visual-edge-a-read', from: 'data', to: 'a', forwardIds: ['a-read'],
    backwardIds: ['b-mutable'], edgeSemantic: 'read_write', displayLabel: '读写访问' }]);
  assert.deepEqual(createVisualEdgeGroups([read, mutable], registry), groups);
  read.label = 'R guard A';
  mutable.label = '可变访问 guard B';
  assert.equal(createVisualEdgeGroups([read, mutable], registry)[0].displayLabel, '读写访问 · guard A / guard B');
  const differentWorld = structuredClone(mutable);
  differentWorld.parameterAccesses[0].scope = 'main';
  assert.equal(createVisualEdgeGroups([read, differentWorld], registry).length, 2);
});

test('the same concrete type in Component and Resource storage keeps separate directed accesses', () => {
  const { registry, access } = fixture();
  const read = access('component-read');
  read.parameterAccesses[0].storage = 'Component';
  const mutable = access('resource-write', 'a', { from: 'a', to: 'data', displayTo: 'data',
    kind: 'write', factKind: 'mutable_access' });
  mutable.parameterAccesses[0].parameter = '2';
  mutable.parameterAccesses[0].storage = 'Resource';
  const groups = createVisualEdgeGroups([read, mutable], registry);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.edgeSemantic).sort(), ['mutable_access', 'read']);
  assert.ok(groups.every(group => group.backwardIds.length === 0));
  assert.deepEqual(groups.flatMap(group => group.forwardIds).sort(), ['component-read', 'resource-write']);
});

test('multiple parameter slots do not pair greedily with one reverse access', () => {
  const { registry, access } = fixture();
  const first = access('a-read'), second = access('b-read');
  second.parameterAccesses[0].parameter = '2';
  const mutable = access('c-mutable', 'a', { from: 'a', to: 'data', displayTo: 'data', kind: 'write', factKind: 'mutable_access' });
  assert.equal(createVisualEdgeGroups([first, second, mutable], registry).length, 3);
});

test('same-direction accesses and display self loops never acquire an invented reverse direction', () => {
  const { registry, access } = fixture();
  const read = access('read');
  const sameDirection = access('mutable', 'a', { kind: 'write', factKind: 'mutable_access' });
  assert.equal(createVisualEdgeGroups([read, sameDirection], registry).length, 2);
  read.displayFrom = 'a';
  sameDirection.displayFrom = 'a';
  assert.equal(createVisualEdgeGroups([read, sameDirection], registry).length, 2);
});

test('body facts and non-access semantics retain independent display edges', () => {
  const { registry, access } = fixture();
  const links = [access('read-a', 'a', { evidence: 'body', parameterAccesses: undefined }),
    access('read-b', 'a', { evidence: 'body', parameterAccesses: undefined }),
    { id: 'insert-a', from: 'a', to: 'data', kind: 'write', factKind: 'insert' },
    { id: 'insert-b', from: 'a', to: 'data', kind: 'write', factKind: 'insert' }];
  const groups = createVisualEdgeGroups(links, registry);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups.flatMap(group => [...group.forwardIds, ...group.backwardIds]).sort(), links.map(link => link.id).sort());
  assert.deepEqual(groups.map(group => group.edgeSemantic), ['insert', 'insert', 'read', 'read']);
});

test('assignments are filtered explicitly and invalid or duplicate canonical identities fail', () => {
  const { registry, access } = fixture();
  const modify = { id: 'assignment', from: 'a', to: 'data', kind: 'write', factKind: 'modify' };
  assert.equal(isVisibleRelation(modify), false);
  assert.throws(() => createVisualEdgeGroups([modify], registry), /Hidden assignment/);
  assert.throws(() => createVisualEdgeGroups([access('same'), access('same')], registry), /duplicate visual relation/);
  const view = { links: [access('read')] };
  assert.equal(visualEdgesOf(view), view.links);
  view.visualEdgeGroups = [];
  assert.equal(visualEdgesOf(view), view.visualEdgeGroups);
});

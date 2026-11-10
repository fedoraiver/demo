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

test('same-direction access summaries retain members with different registration and parameter contexts', () => {
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
    const links = [access('read-a'), changed], original = structuredClone(links);
    const groups = createVisualEdgeGroups(links, registry);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].forwardIds, ['read-a', 'read-b']);
    assert.deepEqual(links, original);
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

test('multiple slots with the same complete context form one bidirectional summary', () => {
  const { registry, access } = fixture();
  const first = access('a-read'), second = access('b-read');
  second.parameterAccesses[0].parameter = '2';
  const mutable = access('c-mutable', 'a', { from: 'a', to: 'data', displayTo: 'data', kind: 'write', factKind: 'mutable_access' });
  const groups = createVisualEdgeGroups([first, second, mutable], registry);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].forwardIds, ['a-read', 'b-read']);
  assert.deepEqual(groups[0].backwardIds, ['c-mutable']);
});

test('bidirectional summaries require the complete context sets from every member to match', () => {
  for (const change of [
    (link, registry) => { registry.b.registrations[0].application = 'RenderApp'; },
    (link, registry) => { registry.b.registrations[0].schedule = 'PostUpdate'; },
    (link, registry) => { registry.b.worldAccessScope = 'render'; },
    (link, registry) => { registry.b.runConditions = ['enabled']; },
    link => { link.parameterAccesses[0].scope = 'main'; },
    link => { link.parameterAccesses[0].storage = 'Component'; },
    link => { link.parameterAccesses[0].typeInstanceId = 'other-instance'; },
    link => { link.parameterAccesses[0].callableId = 'other-callable'; },
    link => { link.parameterAccesses[0].directRoot = false; },
    link => { link.parameterAccesses[0].worldId = 'other-world'; },
    link => { link.parameterAccesses[0].conditions = [{ expression: 'enabled' }]; },
    link => { link.parameterAccesses[0].deferred = true; },
    link => { link.world = 'other-world'; },
    link => { link.conditions = [{ expression: 'enabled', guardKind: 'condition' }]; },
    link => { link.deferred = true; },
    link => { link.sourceEntries.push({ path: 'src/system.rs', line: 4, guardKind: 'if', expression: 'enabled' }); },
  ]) {
    const { registry, access } = fixture();
    const changed = access('b-read', 'b');
    change(changed, registry);
    const mutable = access('c-mutable', 'a', { from: 'a', to: 'data', displayTo: 'data', kind: 'mutable_access' });
    const groups = createVisualEdgeGroups([access('a-read'), changed, mutable], registry);
    assert.equal(groups.length, 2);
    assert.ok(groups.every(group => group.backwardIds.length === 0));
    assert.deepEqual(groups.flatMap(group => group.forwardIds).sort(), ['a-read', 'b-read', 'c-mutable']);
  }
});

test('all parameter proofs are compared as a set independently of canonical partition and input order', () => {
  const { registry, access } = fixture();
  const first = access('a-read'), second = access('b-read');
  second.parameterAccesses[0].scope = 'main';
  const mutable = access('c-mutable', 'a', { from: 'a', to: 'data', displayTo: 'data', kind: 'mutable_access',
    parameterAccesses: [...first.parameterAccesses, ...second.parameterAccesses].map(proof => ({ ...proof, parameter: 'other-slot' })) });
  const links = [first, second, mutable], groups = createVisualEdgeGroups(links, registry);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].forwardIds, ['a-read', 'b-read']);
  assert.deepEqual(groups[0].backwardIds, ['c-mutable']);
  assert.deepEqual(createVisualEdgeGroups([...links].reverse(), registry), groups);
  mutable.parameterAccesses.reverse();
  assert.deepEqual(createVisualEdgeGroups(links, registry), groups);
});

test('a body access among parameter members prevents a bidirectional parameter claim', () => {
  const { registry, access } = fixture();
  const links = [access('a-read'), access('b-body', 'a', { evidence: 'body', parameterAccesses: undefined }),
    access('c-mutable', 'a', { from: 'a', to: 'data', displayTo: 'data', kind: 'mutable_access' })];
  const groups = createVisualEdgeGroups(links, registry);
  assert.equal(groups.length, 2);
  assert.ok(groups.every(group => group.backwardIds.length === 0));
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

test('body and operation facts share only their directed endpoint and semantic summary', () => {
  const { registry, access } = fixture();
  const links = [access('read-a', 'a', { evidence: 'body', parameterAccesses: undefined }),
    access('read-b', 'a', { evidence: 'body', parameterAccesses: undefined }),
    { id: 'insert-a', from: 'a', to: 'data', kind: 'write', factKind: 'insert',
      bodyOperations: [{ operationId: 'operation-a', registeredOwner: 'a', entity: 'entity-a', deferred: true, conditions: ['branch-a'] }] },
    { id: 'insert-b', from: 'b', displayFrom: 'a', to: 'data', kind: 'write', factKind: 'insert', worldId: 'other-world',
      bodyOperations: [{ operationId: 'operation-b', registeredOwner: 'b', entity: 'entity-b', deferred: false, conditions: ['branch-b'] }] }];
  const original = structuredClone(links);
  const groups = createVisualEdgeGroups(links, registry);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.flatMap(group => [...group.forwardIds, ...group.backwardIds]).sort(), links.map(link => link.id).sort());
  assert.deepEqual(groups.map(group => group.edgeSemantic), ['insert', 'read']);
  assert.deepEqual(groups[0].forwardIds, ['insert-a', 'insert-b']);
  assert.ok(groups.every(group => group.backwardIds.length === 0));
  assert.deepEqual(links, original);
  assert.deepEqual(createVisualEdgeGroups([...links].reverse(), registry), groups);
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

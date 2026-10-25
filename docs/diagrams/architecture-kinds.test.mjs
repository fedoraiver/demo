import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { NODE_KINDS, nodeKindOf } from './architecture-kinds.mjs';
import { buildArchitectureModel } from './architecture-model.mjs';

const model = JSON.parse(fs.readFileSync(new URL('./ecs-data.json', import.meta.url), 'utf8'));

test('every canonical semantic category resolves independently of source package or presentation', () => {
  const policies = {
    System: 'system', Observer: 'observer', Entity: 'entity', Component: 'component', Resource: 'resource',
    Local: 'local', NonSend: 'non_send', Message: 'message', 'Messages<T>': 'message_buffer', EntityEvent: 'event',
    SystemSet: 'system_set', SystemParam: 'system_param', QueryData: 'query_data',
    'Scheduling constraint': 'scheduling_constraint', 'Shared data contract': 'shared_data_contract',
    Synchronization: 'sync', 'System group': 'system_group', 'Observer group': 'observer_group',
    'Engine flow': 'engine_flow', Plugin: 'plugin', PluginGroup: 'plugin_group', App: 'app',
    'Registration helper': 'registration_helper', 'External I/O': 'external_io',
    'Platform API': 'platform_api', 'Platform event': 'platform_event', Note: 'note',
    'Lifecycle note': 'lifecycle_note', 'BSN layout': 'bsn_layout', 'Operation result': 'operation_result',
    Relationship: 'relationship', 'Entity reference': 'entity_reference',
  };
  assert.deepEqual(Object.keys(NODE_KINDS), Object.keys(policies));
  for (const [kind, policy] of Object.entries(policies)) {
    assert.equal(nodeKindOf(kind), kind);
    assert.equal(nodeKindOf('  ' + kind.toUpperCase() + '  '), kind);
    assert.equal(NODE_KINDS[kind].sourcePolicyKind, policy, kind);
    for (const feature of ['project', 'infrastructure', 'avian']) {
      assert.equal(nodeKindOf({ id: 'same-id', kind, name: 'Unrelated display text', feature, shape: 'rounded' }), kind);
    }
  }
});

test('only explicit equivalent legacy kinds normalize to the same canonical identity', () => {
  const aliases = {
    system: 'System', observer: 'Observer', 'Engine system': 'System', 'Engine observers': 'Observer group',
    'Engine SystemSet': 'SystemSet', 'Engine system set': 'SystemSet', sync: 'Synchronization',
    'Scheduling contract': 'Scheduling constraint', 'Native platform bridge': 'Platform API',
    'Native platform event': 'Platform event', 'Component write': 'Operation result', 'Data write': 'Operation result',
  };
  for (const [input, expected] of Object.entries(aliases)) {
    const record = { id: 'stable-projection', kind: input, registrations: [{ schedule: 'Update' }], notes: ['full text'] };
    const original = structuredClone(record);
    assert.equal(nodeKindOf(record), expected, input);
    assert.equal(nodeKindOf(input), expected, input);
    assert.deepEqual(record, original, 'classification cannot rewrite the original kind or identity');
  }
});

test('legacy aggregates and missing kinds fail instead of guessing from IDs, names or source policy', () => {
  for (const kind of ['engine', 'Engine', 'Contract', 'Plugin / App', 'External I/O / Platform API', 'unknown', '', undefined, null]) {
    const record = { id: 'input_update', kind, name: 'InputSystems', visualType: 'system_set', sourcePolicyKind: 'system_set' };
    assert.throws(() => nodeKindOf(record), /Unknown architecture node kind:.*input_update/, String(kind));
  }
  assert.throws(() => nodeKindOf(), /Unknown architecture node kind/);
  assert.equal(nodeKindOf({ id: 'inspector_pass', kind: 'Note', name: 'SystemSet', sourcePolicyKind: 'system' }), 'Note');
  assert.equal(nodeKindOf({ kind: 'Plugin', name: 'DefaultPlugins' }), 'Plugin', 'a display name is not type evidence');
  assert.equal(nodeKindOf({ kind: 'Resource', name: 'Messages<SoundRequest>' }), 'Resource', 'buffer kind must be explicit');
});

test('relationship and ordinary Entity reference records have source identities without drawable categories', () => {
  assert.deepEqual(NODE_KINDS.Relationship, { visualType: null, sourcePolicyKind: 'relationship' });
  assert.deepEqual(NODE_KINDS['Entity reference'], { visualType: null, sourcePolicyKind: 'entity_reference' });
  const registry = buildArchitectureModel(model).registry;
  for (const relation of model.relationships) {
    const record = registry[relation.id], expected = relation.kind === 'relationship' ? 'Relationship' : 'Entity reference';
    assert.equal(record.kind, expected, relation.id);
    assert.equal(record.relationship_kind, relation.kind);
    assert.equal(NODE_KINDS[nodeKindOf(record)].visualType, null);
    assert.equal(record.from, relation.from); assert.equal(record.to, relation.to);
  }
  const unknown = structuredClone(model);
  unknown.relationships[0].kind = 'unknown';
  assert.throws(() => buildArchitectureModel(unknown), /未知的实体关系类别/);
});

test('normalizing the manifest preserves every stable identity and the real QueryData declaration', () => {
  const before = JSON.stringify(model), architecture = buildArchitectureModel(model);
  const expectedIds = new Set([
    ...model.systems.map(node => node.id), ...model.resources.map(node => node.id),
    ...model.entities.flatMap(entity => ['entity-' + entity.id, ...entity.components.map(component => component.id)]),
    ...model.nodes.map(node => node.id), ...model.relationships.map(relation => relation.id),
  ]);
  assert.deepEqual(new Set(Object.keys(architecture.registry)), expectedIds);
  for (const [id, node] of Object.entries(architecture.registry)) {
    assert.equal(node.id, id); assert.equal(node.kind, nodeKindOf(node), id);
  }
  assert.ok(NODE_KINDS.QueryData.visualType);
  const query = architecture.registry['param-recoverable-body'];
  assert.equal(query.kind, 'QueryData');
  assert.equal(query.name, 'RecoverableBody');
  assert.equal(query.source.path, 'src/bounds_recovery/recovery.rs');
  const lines = fs.readFileSync(new URL('../../' + query.source.path, import.meta.url), 'utf8').split(/\r?\n/);
  assert.match(lines[query.source.line - 1], /^pub\(super\) struct RecoverableBody\s*\{/);
  assert.ok(lines.slice(query.source.line - 4, query.source.line - 1).some(line => line === '#[derive(QueryData)]'));
  assert.equal(JSON.stringify(model), before);
});

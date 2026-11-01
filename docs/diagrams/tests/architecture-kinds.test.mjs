import assert from 'node:assert/strict';
import test from 'node:test';
import { NODE_KINDS, nodeKindOf } from '../src/architecture-kinds.mjs';

test('every canonical semantic category resolves independently of source package or presentation', () => {
  const policies = {
    System: 'system', Observer: 'observer', Entity: 'entity', Component: 'component', Resource: 'resource',
    Local: 'local', NonSend: 'non_send', Message: 'message', 'Messages<T>': 'message_buffer', EntityEvent: 'event', Event: 'event',
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

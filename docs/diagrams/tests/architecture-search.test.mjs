import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { architectureSearchAssets, createArchitectureSearch } from '../src/architecture-search.mjs';

function fixture() {
  const registry = {
    'resource.TimeFixed': { kind: 'Resource', name: 'Time<Fixed>' },
    'resource.TimeVirtual': { kind: 'Resource', name: 'Time<Virtual>' },
    'resource.Time': { kind: 'Resource', name: 'Time' },
    'system.clock': { kind: 'System', name: 'log_simulation_timestep', registrations: [{ scope: 'runtime' }] },
    'system.unrelated': { kind: 'System', name: 'apply_settings', description: 'Time<Fixed>', reads: ['resource.TimeFixed'],
      fields: ['Time<Fixed>'], usageContexts: ['Time<Fixed>'], sourceEntries: [{ path: 'src/time.rs' }], registrations: [{ scope: 'runtime' }] },
    'set.time': { kind: 'SystemSet', name: 'TimeSystems' },
    'component.timer': { kind: 'Component', name: 'SleepTimer' },
    'component.clock-a': { kind: 'Component', name: 'FrameTime' },
    'component.clock-b': { kind: 'Component', name: 'FrameTime' },
    'component.position': { kind: 'Component', name: '位置', componentRustType: 'game::Position' },
    'system.advance': { kind: 'System', name: 'advance', scheduleFullName: 'game::clock::advance' },
    'system.resolution': { kind: 'System', name: 'Resolution' },
  };
  return { registry, objects: Object.entries(registry).map(([id, record]) => ({ id, kind: record.kind })) };
}

test('identity search excludes runtime, descriptions, source paths and referenced objects', () => {
  const search = createArchitectureSearch(fixture());
  assert.deepEqual(search.search('Time<Fixed>'), ['resource.TimeFixed']);
  assert.deepEqual(search.search('runtime'), []);
  assert.deepEqual(search.search('src/time.rs'), []);
  assert.ok(!search.search('Time').includes('system.unrelated'));
  assert.ok(search.search('Time').indexOf('resource.TimeFixed') < search.search('Time').indexOf('system.clock'));
});

test('name and complete type exact matches precede prefixes, words, substrings and qualified paths', () => {
  const registry = {
    exact: { kind: 'Resource', name: 'Time' },
    type: { kind: 'Component', name: 'Zed', componentRustType: 'Time' },
    prefix: { kind: 'Resource', name: 'Time<Fixed>' },
    word: { kind: 'Component', name: 'FrameTime' },
    substring: { kind: 'System', name: 'log_timestep' },
    path: { kind: 'System', name: 'advance', scheduleFullName: 'game::time::advance' },
  };
  const search = createArchitectureSearch({ registry, objects: Object.keys(registry).reverse().map(id => ({ id })) });
  assert.deepEqual(search.search('time'), ['exact', 'type', 'prefix', 'word', 'substring', 'path']);
  assert.deepEqual(search.search('game::time::advance'), ['path']);
  assert.deepEqual(search.search('gaME :: time :: advance'), ['path']);
});

test('ordinary terms use AND with snake case, CamelCase and acronym boundaries', () => {
  const data = fixture();
  data.registry['system.http'] = { kind: 'System', name: 'HTTPServerUpdate' }; data.objects.push({ id: 'system.http' });
  const search = createArchitectureSearch(data);
  assert.deepEqual(search.search('simulation log'), ['system.clock']);
  assert.deepEqual(search.search('frame time'), ['component.clock-a', 'component.clock-b']);
  assert.deepEqual(search.search('FrameTime'), ['component.clock-a', 'component.clock-b']);
  assert.deepEqual(search.search('frame_time'), ['component.clock-a', 'component.clock-b']);
  assert.deepEqual(search.search('http update'), ['system.http']);
  assert.deepEqual(search.search('frame fixed'), []);
});

test('generic identity keeps punctuation, argument order and nested arguments', () => {
  const data = fixture();
  data.registry.nested = { kind: 'Resource', name: 'Pair<Time<Fixed>, Time<Virtual>>' }; data.objects.push({ id: 'nested' });
  const search = createArchitectureSearch(data);
  assert.deepEqual(search.search(' Time < Fixed > '), ['resource.TimeFixed', 'nested']);
  assert.deepEqual(search.search('time fixed'), ['nested', 'resource.TimeFixed']);
  assert.deepEqual(search.search('Time<Virtual>'), ['resource.TimeVirtual', 'nested']);
  assert.deepEqual(search.search('Pair<Time<Fixed>,Time<Virtual>>'), ['nested']);
  assert.deepEqual(search.search('Pair<Time<Virtual>,Time<Fixed>>'), []);
  assert.deepEqual(search.search('Time<Fi'), ['resource.TimeFixed', 'nested']);
});

test('canonical multi-kind selections form a union and Res access syntax intersects Resource', () => {
  const search = createArchitectureSearch(fixture());
  assert.deepEqual(search.kinds, ['Component', 'Resource', 'System', 'SystemSet']);
  assert.deepEqual(search.search('Time', ['Component', 'Resource']), ['resource.Time', 'resource.TimeFixed', 'resource.TimeVirtual', 'component.clock-a', 'component.clock-b', 'component.timer']);
  assert.deepEqual(search.search('Time', ['missing']), []);
  for (const query of ['Res Time<Fixed>', 'resmut Time<Fixed>', 'Res<Time<Fixed>>', 'ResMut < Time < Fixed > >', 'Res<Time<Fixed>']) {
    assert.deepEqual(search.search(query), ['resource.TimeFixed'], query);
    assert.deepEqual(search.search(query, ['Component', 'Resource']), ['resource.TimeFixed'], query);
    assert.deepEqual(search.search(query, ['Component', 'System']), [], query);
  }
  assert.deepEqual(search.search('Resolution'), ['system.resolution']);
});

test('empty effective queries stay empty and IDs only match in full', () => {
  const search = createArchitectureSearch(fixture());
  for (const query of ['', ' ', 'Res', 'ResMut ', 'Res<>', 'ResMut< >']) assert.deepEqual(search.search(query), [], query);
  assert.deepEqual(search.search('resource.TimeFixed'), ['resource.TimeFixed']);
  assert.deepEqual(search.search('resource.TimeFi'), []);
  assert.deepEqual(search.search('component.clock'), []);
});

test('equal names keep independent identities in deterministic name and ID order without mutating input', () => {
  const data = fixture(), before = structuredClone(data), search = createArchitectureSearch(data);
  assert.deepEqual(search.search('FrameTime'), ['component.clock-a', 'component.clock-b']);
  const reversed = createArchitectureSearch({ registry: data.registry, objects: [...data.objects].reverse() });
  assert.deepEqual(search.search('time'), reversed.search('time'));
  assert.deepEqual(data, before);
});

test('embedded self-contained factory matches imported search without module globals', () => {
  const data = fixture(), direct = createArchitectureSearch(data), context = vm.createContext({ data });
  vm.runInContext(architectureSearchAssets().script + '\nvar search = createArchitectureSearch(data);', context);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(search.kinds)', context)), direct.kinds);
  for (const [query, kinds] of [['Time', []], ['Time<Fixed>', ['Resource']], ['ResMut<Time<Fixed>>', []], ['frame time', ['Component']], ['resource.TimeFixed', []], ['runtime', []], ['', []]]) {
    context.query = query; context.kinds = kinds;
    assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(search.search(query, kinds))', context)), direct.search(query, kinds));
  }
});

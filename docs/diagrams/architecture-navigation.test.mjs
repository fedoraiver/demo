import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { architectureNavigationAssets, architectureUrl, createArchitectureNavigation, resolveArchitectureSelection } from './architecture-navigation.mjs';
import { INFRASTRUCTURE_FEATURES } from './architecture-infrastructure.mjs';

const features = [{ id: 'character' }, { id: 'first_person' }, { id: 'ui' }];
const schedules = [
  { id: 'schedule-startup', application: 'main', scheduleLabel: 'Startup', systemCount: 1 },
  { id: 'schedule-update', application: 'main', scheduleLabel: 'Update', systemCount: 2 },
  { id: 'schedule-render', application: 'RenderApp', scheduleLabel: 'Render', systemCount: 1 },
];

test('selects main Update by default and otherwise the first nonempty exported Schedule', () => {
  const navigation = createArchitectureNavigation(features, schedules);
  assert.deepEqual(navigation.resolve(''), { schedule: 'schedule-update', node: null });
  assert.deepEqual(navigation.resolve('?schedule=schedule-render'), { schedule: 'schedule-render', node: null });
  assert.deepEqual(navigation.resolve('?schedule=deleted'), { schedule: 'schedule-update', node: null });
  assert.equal(resolveArchitectureSelection('', features, schedules.filter(view => view.scheduleLabel !== 'Update')).schedule, 'schedule-startup');
  assert.equal(resolveArchitectureSelection('', features, schedules.map(view => ({ ...view, systemCount: view.scheduleLabel === 'Render' ? 1 : 0 }))).schedule, 'schedule-render');
  assert.equal(resolveArchitectureSelection('', features, []).schedule, null);
});

test('retains known legacy feature and exact node identities for object migration', () => {
  for (const feature of [...features.map(feature => feature.id), ...INFRASTRUCTURE_FEATURES.map(feature => feature.id), 'third_party', 'overview']) {
    for (const aspect of ['systems', 'data', 'events']) {
      assert.deepEqual(resolveArchitectureSelection(`?feature=${feature}&tab=${aspect}&node=shared`, features, schedules), { schedule: 'schedule-update', node: 'shared', legacyFeature: feature, ...(aspect === 'systems' ? {} : { legacyAspect: aspect }) });
    }
  }
  assert.deepEqual(resolveArchitectureSelection('?feature=deleted&tab=data&node=old', features, schedules), { schedule: 'schedule-update', node: null, legacyAspect: 'data' });
  assert.equal(resolveArchitectureSelection('?feature=ui&node=%20%20', features, schedules).node, null);
});

test('object URLs retain precise projections and registration IDs and migrate legacy component', () => {
  const navigation = createArchitectureNavigation(features, schedules);
  assert.equal(navigation.resolve('?component=character.Transform').object, 'character.Transform');
  assert.equal(navigation.resolve('?object=character.Transform&component=item.Transform').object, 'character.Transform');
  assert.equal(navigation.resolve('?component=%20%20').object, undefined);
  const selection = { schedule: 'schedule-render', object: 'generic<Component>', node: 'system-fixed' };
  const url = new URL(navigation.url(selection, 'file:///D:/demo/ecs-architecture.html?feature=ui&tab=data&component=old&workspace=E%3A%2Fwork&keep=1#anchor'));
  assert.equal(url.searchParams.get('schedule'), 'schedule-render');
  assert.equal(url.searchParams.get('object'), 'generic<Component>');
  assert.equal(url.searchParams.get('node'), 'system-fixed');
  for (const key of ['feature', 'tab', 'component']) assert.equal(url.searchParams.has(key), false);
  assert.equal(url.searchParams.get('workspace'), 'E:/work'); assert.equal(url.searchParams.get('keep'), '1'); assert.equal(url.hash, '#anchor');
  const cleared = new URL(navigation.url({ schedule: 'schedule-startup' }, url.href));
  assert.equal(cleared.searchParams.has('object'), false); assert.equal(cleared.searchParams.has('node'), false);
});

test('inline navigation uses the same rules and escapes all embedded identifiers', () => {
  const dangerousFeatures = [...features, { id: '</script><script>danger()</script>' }];
  const dangerousSchedules = [...schedules, { id: 'schedule-danger', application: '</script>', scheduleLabel: 'Update', systemCount: 1 }];
  const assets = architectureNavigationAssets(dangerousFeatures, dangerousSchedules);
  assert.doesNotMatch(assets.script, /<\/script>|\b(?:fetch|import)\s*\(/);
  const context = vm.createContext({ URL, URLSearchParams }); vm.runInContext(assets.script, context);
  for (const search of ['', '?schedule=schedule-render', '?feature=character&tab=events&node=observe_move', '?object=character.Transform']) {
    context.search = search;
    assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(architectureNavigation.resolve(search))', context)), resolveArchitectureSelection(search, dangerousFeatures, dangerousSchedules));
  }
  context.href = 'file:///D:/demo/ecs-architecture.html?workspace=D%3A%2Fdemo&keep=1';
  assert.equal(vm.runInContext('architectureNavigation.url({schedule:"schedule-render",object:"shared"},href)', context), architectureUrl({ schedule: 'schedule-render', object: 'shared' }, context.href, dangerousFeatures, dangerousSchedules));
});

test('Schedule filters survive exact object routes and round-trip without changing unrelated URL state', () => {
  const selection = resolveArchitectureSelection('?schedule=schedule-render&scheduleInclude=character%2Cui&scheduleExclude=bevy_render&object=system-fixed', features, schedules);
  assert.equal(selection.scheduleInclude, 'character,ui');
  assert.equal(selection.scheduleExclude, 'bevy_render');
  const url = new URL(architectureUrl(selection, 'file:///D:/demo/ecs-architecture.html?workspace=D:/demo&keep=1#source', features, schedules));
  assert.equal(url.searchParams.get('scheduleInclude'), 'character,ui');
  assert.equal(url.searchParams.get('scheduleExclude'), 'bevy_render');
  assert.equal(url.searchParams.get('workspace'), 'D:/demo');assert.equal(url.hash, '#source');
  const cleared = new URL(architectureUrl({ ...selection, scheduleInclude: '', scheduleExclude: '' }, url.href, features, schedules));
  assert.equal(cleared.searchParams.has('scheduleInclude'), false);assert.equal(cleared.searchParams.has('scheduleExclude'), false);
});

test('exact Schedule names use repeated parameters without splitting commas, generics or special characters', () => {
  const names = ['demo::sync::<(Foo, Bar)>', 'demo::名称<&T, "value&x">', ' another::system '];
  const selection = { schedule: 'schedule-render', scheduleIncludeSystems: [...names, names[0]], scheduleExcludeSystems: [names[1]], scheduleInclude: 'legacy,condition', object: 'system-fixed' };
  const url = new URL(architectureUrl(selection, 'file:///D:/demo/ecs-architecture.html?workspace=E:/work&keep=1#anchor', features, schedules));
  assert.deepEqual(url.searchParams.getAll('scheduleIncludeSystem'), names);
  assert.deepEqual(url.searchParams.getAll('scheduleExcludeSystem'), [names[1]]);
  const resolved = resolveArchitectureSelection(url.search, features, schedules);
  assert.deepEqual(resolved.scheduleIncludeSystems, names);assert.deepEqual(resolved.scheduleExcludeSystems, [names[1]]);
  assert.equal(resolved.scheduleInclude, 'legacy,condition');assert.equal(url.searchParams.get('workspace'), 'E:/work');assert.equal(url.hash, '#anchor');
  const assets = architectureNavigationAssets(features, schedules), context = vm.createContext({ URL, URLSearchParams, search: url.search });vm.runInContext(assets.script, context);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(architectureNavigation.resolve(search))', context)), resolved);
  const cleared = new URL(architectureUrl({ schedule: 'schedule-update', scheduleIncludeSystems: [], scheduleExcludeSystems: [] }, url.href, features, schedules));
  for (const key of ['scheduleIncludeSystem', 'scheduleExcludeSystem', 'scheduleInclude']) assert.equal(cleared.searchParams.has(key), false);
});

test('Plugin filters preserve exact IDs alongside legacy filters, object routes and unrelated URL state', () => {
  const plugins = ['plugin-GameUiPlugin', 'plugin-名称<&T, "value&x">'];
  const selection = {
    schedule: 'schedule-render', object: 'system-fixed',
    scheduleIncludePlugins: [...plugins, '', plugins[0]], scheduleExcludePlugins: [plugins[1], ''],
    scheduleIncludeSystems: ['demo::sync::<(Foo, Bar)>'], scheduleExcludeSystems: ['engine::old_system'],
    scheduleInclude: 'legacy,condition', scheduleExclude: 'legacy_exclude',
  };
  const url = new URL(architectureUrl(selection, 'file:///D:/demo/ecs-architecture.html?workspace=E:/work&keep=1#anchor', features, schedules));
  assert.deepEqual(url.searchParams.getAll('scheduleIncludePlugin'), plugins);
  assert.deepEqual(url.searchParams.getAll('scheduleExcludePlugin'), [plugins[1]]);
  const resolved = resolveArchitectureSelection(url.search, features, schedules);
  assert.deepEqual(resolved, { ...selection, node: null, scheduleIncludePlugins: plugins, scheduleExcludePlugins: [plugins[1]] });
  assert.equal(url.searchParams.get('workspace'), 'E:/work');assert.equal(url.searchParams.get('keep'), '1');assert.equal(url.hash, '#anchor');
  const assets = architectureNavigationAssets(features, schedules), context = vm.createContext({ URL, URLSearchParams, search: url.search, selection, href: url.href });
  vm.runInContext(assets.script, context);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(architectureNavigation.resolve(search))', context)), resolved);
  assert.equal(vm.runInContext('architectureNavigation.url(selection,href)', context), url.href);
  const cleared = new URL(architectureUrl({ schedule: 'schedule-update', scheduleIncludePlugins: [], scheduleExcludePlugins: [] }, url.href, features, schedules));
  for (const key of ['scheduleIncludePlugin', 'scheduleExcludePlugin', 'scheduleIncludeSystem', 'scheduleExcludeSystem', 'scheduleInclude', 'scheduleExclude']) assert.equal(cleared.searchParams.has(key), false);
  assert.equal(cleared.searchParams.get('workspace'), 'E:/work');assert.equal(cleared.searchParams.get('keep'), '1');assert.equal(cleared.hash, '#anchor');
  assert.equal(resolveArchitectureSelection('?scheduleIncludePlugin=&scheduleExcludePlugin=', features, schedules).scheduleIncludePlugins, undefined);
  assert.equal(resolveArchitectureSelection('?scheduleIncludePlugin=&scheduleExcludePlugin=', features, schedules).scheduleExcludePlugins, undefined);
});

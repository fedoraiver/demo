import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { architectureNavigationAssets, architectureUrl, createArchitectureNavigation, resolveArchitectureSelection } from './architecture-navigation.mjs';
import { INFRASTRUCTURE_FEATURES } from './architecture-infrastructure.mjs';

const features = [{ id: 'character' }, { id: 'first_person' }, { id: 'ui' }];

test('resolves only systems while retaining legacy tab information for precise object migration', () => {
  const navigation = createArchitectureNavigation(features);
  assert.deepEqual(navigation.resolve(''), { feature: 'overview', aspect: 'overview', node: null });
  assert.deepEqual(navigation.resolve('?feature=character&tab=data&node=character.Transform'), { feature: 'character', aspect: 'systems', node: 'character.Transform', legacyAspect: 'data' });
  assert.deepEqual(navigation.resolve('?feature=infrastructure&tab=events'), { feature: 'infrastructure', aspect: 'systems', node: null, legacyAspect: 'events' });
  for (const feature of ['avian', 'enhanced_input', 'kira', 'egui']) {
    for (const aspect of ['systems', 'data', 'events']) {
      assert.deepEqual(navigation.resolve(`?feature=${feature}&tab=${aspect}&node=external-node`), { feature, aspect: 'systems', node: 'external-node', ...(aspect === 'systems' ? {} : { legacyAspect: aspect }) });
    }
  }
  assert.deepEqual(navigation.resolve('?feature=third_party&tab=data&node=physics-step'), { feature: 'third_party', aspect: 'systems', node: 'physics-step', legacyAspect: 'data' });
  assert.deepEqual(navigation.resolve('?feature=overview&tab=events&node=plugin-CharacterPlugin'), { feature: 'overview', aspect: 'overview', node: 'plugin-CharacterPlugin', legacyAspect: 'events' });
});

test('uses safe defaults for stale feature and tab links and removes blank node selections', () => {
  assert.deepEqual(resolveArchitectureSelection('?feature=deleted&tab=data&node=old', features), { feature: 'overview', aspect: 'overview', node: null, legacyAspect: 'data' });
  assert.deepEqual(resolveArchitectureSelection('?feature=ui&tab=deleted&node=%20%20', features), { feature: 'ui', aspect: 'systems', node: null });
  assert.deepEqual(resolveArchitectureSelection('?feature=first_person', features), { feature: 'first_person', aspect: 'systems', node: null });
});

test('changes only navigation parameters and encodes node identities exactly once', () => {
  const href = 'file:///D:/work%20tree/docs/diagrams/ecs-architecture.html?workspace=E%3A%2F%E4%B8%AD%E6%96%87%20%23%25&keep=a&keep=b&feature=ui&tab=events&node=old#anchor';
  const url = new URL(architectureUrl({ feature: 'character', aspect: 'data', node: 'character.中文 #%&' }, href, features));
  assert.equal(url.searchParams.get('workspace'), 'E:/中文 #%');
  assert.deepEqual(url.searchParams.getAll('keep'), ['a', 'b']);
  assert.equal(url.searchParams.get('feature'), 'character');
  assert.equal(url.searchParams.get('tab'), 'systems');
  assert.equal(url.searchParams.get('node'), 'character.中文 #%&');
  assert.equal(url.hash, '#anchor');
  assert.equal(url.pathname, '/D:/work%20tree/docs/diagrams/ecs-architecture.html');
});

test('switching feature clears old node and overview removes irrelevant tab state', () => {
  const href = 'https://example.test/ecs-architecture.html?feature=character&tab=data&node=character.Transform&workspace=%2Ftmp%2Fcheckout';
  const featureUrl = new URL(architectureUrl({ feature: 'ui', aspect: 'events' }, href, features));
  assert.equal(featureUrl.searchParams.has('node'), false);
  assert.equal(featureUrl.searchParams.get('tab'), 'systems');
  const overview = new URL(architectureUrl({ feature: 'overview' }, featureUrl.href, features));
  assert.equal(overview.searchParams.get('feature'), 'overview');
  assert.equal(overview.searchParams.has('tab'), false);
  assert.equal(overview.searchParams.get('workspace'), '/tmp/checkout');
});

test('object routes preserve exact projection identity, originating feature and unrelated URL state', () => {
  const href = 'file:///D:/demo/docs/diagrams/ecs-architecture.html?feature=character&tab=data&workspace=D%3A%2Fdemo&keep=1#source';
  const next = { feature: 'character', aspect: 'systems', node: 'system-update', object: 'character.Transform' };
  const url = new URL(architectureUrl(next, href, features));
  assert.deepEqual(resolveArchitectureSelection(url.search, features), next);
  assert.equal(url.searchParams.get('workspace'), 'D:/demo');
  assert.equal(url.searchParams.get('keep'), '1');
  assert.equal(url.hash, '#source');
  const cleared = new URL(architectureUrl({ feature: 'ui', aspect: 'systems' }, url.href, features));
  assert.equal(cleared.searchParams.has('object'), false);
  assert.equal(cleared.searchParams.has('component'), false);
  assert.equal(cleared.searchParams.has('node'), false);
  assert.deepEqual(resolveArchitectureSelection('?feature=character&tab=data&component=%20%20', features), { feature: 'character', aspect: 'systems', node: null, legacyAspect: 'data' });
});

test('inline assets run the same pure rules and cannot close their script element', () => {
  const dangerousFeatures = [...features, { id: '</script><script>danger()</script>' }];
  const assets = architectureNavigationAssets(dangerousFeatures);
  assert.deepEqual(Object.keys(assets), ['script']);
  assert.doesNotMatch(assets.script, /<\/script>|\b(?:fetch|import)\s*\(/);
  const context = vm.createContext({ URL, URLSearchParams });
  vm.runInContext(assets.script, context);
  const selection = vm.runInContext('architectureNavigation.resolve("?feature=character&tab=events&node=observe_move")', context);
  assert.deepEqual(JSON.parse(JSON.stringify(selection)), { feature: 'character', aspect: 'systems', node: 'observe_move', legacyAspect: 'events' });
  for (const feature of [...INFRASTRUCTURE_FEATURES.map(feature => feature.id), 'third_party']) {
    for (const aspect of ['systems', 'data', 'events']) {
      const search = `?feature=${feature}&tab=${aspect}&node=external-node`;
      context.search = search;
      assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(architectureNavigation.resolve(search))', context)), resolveArchitectureSelection(search, features));
    }
  }
  const href = 'file:///D:/demo/docs/diagrams/ecs-architecture.html?workspace=D%3A%2Fdemo&keep=1';
  context.href = href;
  assert.equal(vm.runInContext('architectureNavigation.url({feature:"ui",aspect:"data"},href)', context), architectureUrl({ feature: 'ui', aspect: 'data' }, href, dangerousFeatures));
});

test('legacy component URLs migrate their exact projection to object and prefer an explicit object', () => {
  const old = resolveArchitectureSelection('?feature=character&tab=data&component=character.Transform', features);
  assert.equal(old.object, 'character.Transform');
  const next = new URL(architectureUrl(old, 'file:///D:/demo/ecs-architecture.html?component=old&keep=1#anchor', features));
  assert.equal(next.searchParams.get('object'), 'character.Transform');
  assert.equal(next.searchParams.has('component'), false);
  assert.equal(next.searchParams.get('tab'), 'systems');
  assert.equal(next.searchParams.get('keep'), '1');
  assert.equal(next.hash, '#anchor');
  assert.equal(resolveArchitectureSelection('?object=character.Transform&component=parcel.Transform', features).object, 'character.Transform');
});

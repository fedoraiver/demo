import assert from 'node:assert/strict';
import test from 'node:test';
import { createArchitectureEntities } from './architecture-entities.mjs';

const base = { id: 'test', entityGroups: ['a', 'b', 'c', 'd'].map(entity => ({ entity })), entityViews: { collapsed: { name: 'none' }, a: { name: 'a' }, b: { name: 'b' }, c: { name: 'c' }, d: { name: 'd' } } };
test('Entity sets normalize old history values, ignore stale IDs and use canonical group order', () => {
  const state = createArchitectureEntities({ compile() {} });
  assert.deepEqual(state.normalize(base, 'collapsed'), []);
  assert.deepEqual(state.normalize(base, 'all'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(state.normalize(base, 'b'), ['b']);
  assert.deepEqual(state.normalize(base, ['d', 'b', 'b', 'unknown']), ['b', 'd']);
  assert.equal(state.key(base, ['b', 'a']), state.key(base, ['a', 'b']));
  assert.equal(state.resolve(base, []), base.entityViews.collapsed);
  assert.equal(state.resolve(base, ['a']), base.entityViews.a);
  assert.equal(state.resolve(base, 'all'), base);
});
test('New combinations compile once, serialize Mermaid work and cache only eight extra layouts', async () => {
  const calls = []; let running = 0, maximum = 0;
  const state = createArchitectureEntities({ compile: async (view, ids) => {
    maximum = Math.max(maximum, ++running); calls.push(ids);
    await Promise.resolve(); --running; return { ids };
  } });
  const first = state.resolve(base, ['b', 'a']);
  assert.equal(first, state.resolve(base, ['a', 'b']));
  await Promise.all([first, state.resolve(base, ['a', 'c'])]);
  assert.equal(maximum, 1); assert.equal(calls.length, 2);
  assert.deepEqual(state.resolve(base, ['a', 'b']).ids, ['a', 'b']);
  const many = { ...base, entityGroups: Array.from({ length: 12 }, (_, i) => ({ entity: String(i) })) };
  for (let i = 1; i <= 9; ++i) await state.resolve(many, ['0', String(i)]);
  assert.equal(state.get(many, ['0', '1']), undefined);
  assert.ok(state.get(many, ['0', '2']));
});
test('A failed layout does not enter the cache or poison later compilation and can be retried', async () => {
  let fail = true;
  const state = createArchitectureEntities({ compile: async (_, ids) => { if (fail) throw new Error('blocked route'); return { ids }; } });
  await assert.rejects(state.resolve(base, ['a', 'b']), /blocked route/);
  assert.equal(state.get(base, ['a', 'b']), undefined);
  fail = false;
  assert.deepEqual((await state.resolve(base, ['a', 'b'])).ids, ['a', 'b']);
});

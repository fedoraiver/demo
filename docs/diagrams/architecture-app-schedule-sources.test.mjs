import assert from 'node:assert/strict';
import test from 'node:test';
import { attachAppScheduleSources } from './architecture-app-schedule-sources.mjs';

test('fixed-loop source details distinguish collection configuration, driver registration and actual execution', () => {
  const definitions = [];
  const resolver = { resolve(definition) { definitions.push(definition); return { path: definition.path, line: definitions.length, dependency: { name: definition.package } }; } };
  const view = { layout: 'app-schedule', scheduleGroups: [], phaseLinks: [], scheduleLinks: [{ id: 'app-fixed-enter' }] };
  attachAppScheduleSources(view, resolver);
  const entry = view.scheduleLinks[0];
  assert.equal(entry.sourceGaps.length, 0);
  assert.deepEqual(entry.sourceEntries.map(source => source.role), ['configure', 'configure', 'implementation', 'implementation']);
  assert.equal(definitions[0].package, 'bevy_app');
  assert.equal(definitions[1].package, 'bevy_time');
  assert.equal(definitions[2].symbol, 'run_fixed_main_schedule');
  assert.equal(definitions[3].symbol, 'run_fixed_main');
});

test('unresolved phase implementations remain explicit gaps without inventing Schedule entries for observers', () => {
  const view = { layout: 'app-schedule', scheduleGroups: [{ id: 'First', track: 'frame' }, { id: 'EventTriggered', track: 'external' }], scheduleLinks: [{ id: 'app-egui-pass' }] };
  attachAppScheduleSources(view, { resolve() { throw new Error('source unavailable'); } });
  assert.equal(view.scheduleGroups[0].sourceEntries.length, 0);
  assert(view.scheduleGroups[0].sourceGaps.every(gap => gap.includes('待核实') && gap.includes('source unavailable')));
  assert.equal(view.scheduleLinks[0].sourceEntries.length, 0);
  assert.equal(view.scheduleLinks[0].sourceGaps.length, 2);
  assert.deepEqual(view.scheduleGroups[1].sourceEntries, []);
  assert.deepEqual(view.scheduleGroups[1].sourceGaps, []);
  const local = { layout: undefined, scheduleLinks: [{ id: 'app-egui-pass' }] }, before = structuredClone(local);
  attachAppScheduleSources(local, { resolve() { throw new Error('must not resolve'); } });
  assert.deepEqual(local, before);
});

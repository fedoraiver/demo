import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { orderScheduleOptions } from '../src/architecture-viewer.mjs';

test('schedule picker orders known main phases and keeps independent schedules stable', () => {
  const labels = ['OnEnter(Running)', 'FixedLast', 'Update', 'First', 'Startup', 'FixedUpdate', 'PreStartup', 'PostUpdate', 'FixedFirst', 'OnEnter(InGame)', 'Custom', 'Main', 'FixedMain'];
  const views = labels.map(label => ({ id: label, application: 'main', scheduleLabel: label }));
  views.push({ id: 'render-update', application: 'RenderApp', scheduleLabel: 'Update' }, { id: 'render-extract', application: 'RenderApp', scheduleLabel: 'ExtractSchedule' });
  assert.deepEqual(orderScheduleOptions(views, 'main').map(view => view.id), ['Main', 'PreStartup', 'Startup', 'First', 'FixedMain', 'FixedFirst', 'FixedUpdate', 'FixedLast', 'Update', 'PostUpdate', 'Custom', 'OnEnter(InGame)', 'OnEnter(Running)']);
  assert.deepEqual(orderScheduleOptions(views, 'RenderApp').map(view => view.id), ['render-extract', 'render-update']);
  assert.equal(views[0].id, 'OnEnter(Running)');
});
